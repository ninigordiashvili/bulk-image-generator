"use client";

/**
 * Cutting a voice track, entirely in the browser.
 *
 * This used to happen on the server, which was wrong for a deployed copy:
 * serverless instances don't share a disk, so a track uploaded by one request
 * was simply absent for the next one. Cutting here removes the shared state
 * altogether — the generate call carries the finished bytes — and it's a shade
 * more accurate too, since slicing decoded samples is exact where seeking a
 * compressed file is not.
 */

/** Waveform resolution: fine enough that a ten-second zoom still out-resolves the canvas. */
export const PEAKS_PER_SECOND = 200;

export interface Waveform {
  min: Float32Array;
  max: Float32Array;
  perSecond: number;
}

/** The track as mono 16-bit samples — what every cut is taken from. */
export interface DecodedAudio {
  pcm: Int16Array;
  sampleRate: number;
  duration: number;
}

export interface EncodedCut {
  base64: string;
  mimeType: string;
  bytes: number;
  seconds: number;
}

/**
 * Decodes once and keeps the result, because both the waveform and every later
 * cut need the same samples and a seventeen-minute file is not something to
 * decode twice. Held as mono Int16 rather than the browser's stereo Float32:
 * a quarter of the memory, and the exact shape both encoders want.
 */
export async function decodeTrack(
  file: File
): Promise<{ decoded: DecodedAudio; waveform: Waveform }> {
  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioCtx();

  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const { length, numberOfChannels, sampleRate } = buffer;
    const pcm = new Int16Array(length);
    const channels = Array.from({ length: numberOfChannels }, (_, c) =>
      buffer.getChannelData(c)
    );

    const buckets = Math.max(1, Math.ceil(buffer.duration * PEAKS_PER_SECOND));
    const min = new Float32Array(buckets);
    const max = new Float32Array(buckets);
    const perBucket = length / buckets;

    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (const channel of channels) sum += channel[i];
      const value = sum / numberOfChannels;

      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));

      const bucket = Math.min(buckets - 1, Math.floor(i / perBucket));
      if (value < min[bucket]) min[bucket] = value;
      if (value > max[bucket]) max[bucket] = value;
    }

    return {
      decoded: { pcm, sampleRate, duration: buffer.duration },
      waveform: { min, max, perSecond: PEAKS_PER_SECOND },
    };
  } finally {
    void context.close();
  }
}

/**
 * How many bytes of base64 audio a generate request can carry. A serverless
 * host caps the whole body at 4.5 MB and the portrait travels in there too.
 */
export const CUT_BUDGET_BYTES = 2.5 * 1024 * 1024;

/** Sample rates to fall back through when a cut is too long to send at source rate. */
const RATE_LADDER = [32000, 24000, 16000];

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

/**
 * Encodes `duration` seconds from `start`.
 *
 * WAV first, even though AAC is ten times smaller. A WAV header states its own
 * length; raw AAC does not, and a reader that estimates rather than decodes
 * gets it badly wrong — ffprobe reads a correct 15-second AAC cut as 28
 * seconds. The avatar model bills by the length of the audio, so a
 * misread there is an overcharge, and that is not a risk worth ten times the
 * bandwidth on a fifteen-second clip.
 *
 * Longer cuts step down the sample rate to stay inside the request budget, and
 * only reach for AAC when even 16 kHz won't fit.
 */
export async function encodeCut(
  decoded: DecodedAudio,
  start: number,
  duration: number
): Promise<EncodedCut> {
  const { pcm, sampleRate } = decoded;
  const from = Math.max(0, Math.min(Math.round(start * sampleRate), pcm.length - 1));
  const to = Math.min(pcm.length, from + Math.max(1, Math.round(duration * sampleRate)));
  const slice = pcm.subarray(from, to);
  const seconds = (to - from) / sampleRate;

  for (const rate of [sampleRate, ...RATE_LADDER]) {
    if (rate > sampleRate) continue;
    const samples = rate === sampleRate ? slice : downsample(slice, sampleRate, rate);
    const bytes = 44 + samples.length * 2;
    if (base64Length(bytes) > CUT_BUDGET_BYTES) continue;
    const wav = encodeWav(samples, rate);
    return {
      base64: toBase64(wav),
      mimeType: "audio/wav",
      bytes: wav.byteLength,
      seconds,
    };
  }

  // Nothing uncompressed fits — a cut of several minutes. AAC or nothing.
  const aac = await encodeAac(slice, sampleRate).catch(() => null);
  if (aac && base64Length(aac.byteLength) <= CUT_BUDGET_BYTES) {
    return {
      base64: toBase64(aac),
      mimeType: "audio/aac",
      bytes: aac.byteLength,
      seconds,
    };
  }

  throw new Error(
    `A ${Math.round(seconds)}s cut is too large to send in one request. ` +
      `Shorten it to about a minute.`
  );
}

/**
 * Rate reduction by averaging each source window — a crude low-pass, but the
 * right kind of crude: plain decimation would alias speech sibilance down into
 * the vowels, which is exactly what a lip-sync model is listening to.
 */
function downsample(samples: Int16Array, from: number, to: number): Int16Array {
  const ratio = from / to;
  const out = new Int16Array(Math.max(1, Math.floor(samples.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const begin = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.max(begin + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = begin; j < end; j++) sum += samples[j];
    out[i] = Math.round(sum / (end - begin));
  }
  return out;
}

/** ADTS sampling-frequency indices. A rate outside this table can't be framed. */
const ADTS_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/**
 * AAC via WebCodecs, framed as ADTS.
 *
 * Worth the trouble because it's about a tenth of WAV's size, and the whole cut
 * travels inside the generate request — where a deployed copy caps the body at
 * 4.5 MB. Returns null wherever WebCodecs isn't available, and the WAV path
 * takes over.
 */
async function encodeAac(
  samples: Int16Array,
  sampleRate: number
): Promise<Uint8Array | null> {
  const Encoder = (
    globalThis as unknown as { AudioEncoder?: typeof AudioEncoder }
  ).AudioEncoder;
  const Frames = (globalThis as unknown as { AudioData?: typeof AudioData }).AudioData;
  if (!Encoder || !Frames) return null;

  const rateIndex = ADTS_RATES.indexOf(sampleRate);
  if (rateIndex < 0) return null;

  const config: AudioEncoderConfig = {
    codec: "mp4a.40.2",
    sampleRate,
    numberOfChannels: 1,
    bitrate: 128_000,
  };
  const support = await Encoder.isConfigSupported(config).catch(() => null);
  if (!support?.supported) return null;

  const parts: Uint8Array[] = [];
  let failed = false;

  const encoder = new Encoder({
    output: (chunk) => {
      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
      parts.push(adtsHeader(payload.byteLength, rateIndex), payload);
    },
    error: () => {
      failed = true;
    },
  });
  encoder.configure(config);

  // WebCodecs takes float planar; the block size is the AAC frame size.
  const BLOCK = 1024;
  const block = new Float32Array(BLOCK);
  for (let offset = 0; offset < samples.length; offset += BLOCK) {
    const count = Math.min(BLOCK, samples.length - offset);
    for (let i = 0; i < count; i++) block[i] = samples[offset + i] / 32768;
    if (count < BLOCK) block.fill(0, count);

    const frame = new Frames({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: BLOCK,
      numberOfChannels: 1,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: block,
    });
    encoder.encode(frame);
    frame.close();
  }

  await encoder.flush();
  encoder.close();

  if (failed || parts.length === 0) return null;
  return concat(parts);
}

/** The 7-byte ADTS frame header, no CRC, AAC-LC, one channel. */
function adtsHeader(payloadBytes: number, rateIndex: number): Uint8Array {
  const total = payloadBytes + 7;
  const header = new Uint8Array(7);
  header[0] = 0xff;
  // MPEG-4, layer 0, protection absent.
  header[1] = 0xf1;
  // Profile AAC-LC (2) is written as 1, then the rate index and channel config.
  header[2] = ((1 & 0x03) << 6) | ((rateIndex & 0x0f) << 2) | ((1 >> 2) & 0x01);
  header[3] = ((1 & 0x03) << 6) | ((total >> 11) & 0x03);
  header[4] = (total >> 3) & 0xff;
  header[5] = ((total & 0x07) << 5) | 0x1f;
  header[6] = 0xfc;
  return header;
}

/** Uncompressed mono 16-bit PCM. Always available, roughly ten times the size. */
function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  new Int16Array(out.buffer, 44).set(samples);

  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Chunked so a multi-megabyte cut doesn't blow the argument limit. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
