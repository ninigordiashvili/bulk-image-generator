"use client";

/**
 * Working out what a dropped video clip actually is, in the browser.
 *
 * Three questions, all answerable without a server round trip:
 *
 *  - How long is it, and what shape? A `<video>` element's metadata.
 *  - Is it a talking avatar or a silent motion clip? Whether it has an audio
 *    track at all, and if it does, whether that audio is a piece of the
 *    narration bed.
 *  - Where exactly does it belong, and where does the talking stop?
 *    Cross-correlation against the bed, and the tail of its own envelope.
 *
 * The alignment matters more than it sounds. A filename says `0-14`, but the
 * cut it was generated from started at 14.37, and half a second of drift is
 * the difference between lips that match and lips that don't.
 */

import type { ClipKind } from "@/types/editor";

/** Envelope resolution. 10 ms is finer than any misalignment worth chasing. */
export const ENVELOPE_HZ = 100;

/** Below this correlation, a clip's audio isn't from the bed. */
export const AVATAR_CONFIDENCE = 0.55;

/** How far either side of the filename's cue to look for the true position. */
const SEARCH_SECONDS = 6;

/** Quiet enough to count as "stopped talking". Insensitive over ±10 dB. */
const SILENCE_FLOOR_DB = -35;

/** Ignore a gap shorter than this — it's a breath, not the end of a sentence. */
const MIN_TAIL_SECONDS = 0.25;

export interface Envelope {
  /** Loudness per 10 ms, log-scaled so quiet detail survives. */
  values: Float32Array;
  perSecond: number;
}

export interface ClipFacts {
  duration: number;
  width: number;
  height: number;
  /** Null when the file has no audio track — which makes it a motion clip. */
  envelope: Envelope | null;
  /** Where the talking stops. Equals `duration` when nothing is trimmed. */
  speechEnd: number;
}

export interface Placement {
  start: number;
  /** 0-1. Below AVATAR_CONFIDENCE the clip isn't from this bed. */
  confidence: number;
}

/** Loudness envelope of decoded audio, mixed to mono. */
export function envelopeOf(buffer: AudioBuffer): Envelope {
  const hop = Math.max(1, Math.round(buffer.sampleRate / ENVELOPE_HZ));
  const count = Math.floor(buffer.length / hop);
  const values = new Float32Array(count);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
    buffer.getChannelData(c)
  );

  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) {
      let mixed = 0;
      for (const channel of channels) mixed += channel[j];
      mixed /= channels.length;
      sum += mixed * mixed;
    }
    // Log scale: speech rhythm lives in the quiet parts as much as the loud.
    values[i] = Math.log10(1 + Math.sqrt(sum / hop) * 32767);
  }

  return { values, perSecond: ENVELOPE_HZ };
}

async function decodeAudio(file: Blob): Promise<AudioBuffer | null> {
  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioCtx();
  try {
    return await context.decodeAudioData(await file.arrayBuffer());
  } catch {
    // No audio track, or one this browser can't read. Either way the clip is
    // treated as silent, which is exactly right for a generated motion clip.
    return null;
  } finally {
    void context.close();
  }
}

function videoMetadata(
  file: Blob
): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const element = document.createElement("video");
    element.preload = "metadata";
    element.muted = true;
    const done = (value: { duration: number; width: number; height: number } | null) => {
      URL.revokeObjectURL(url);
      element.removeAttribute("src");
      if (value) resolve(value);
      else reject(new Error("That video couldn't be read by this browser."));
    };
    element.onloadedmetadata = () =>
      done(
        Number.isFinite(element.duration) && element.duration > 0
          ? {
              duration: element.duration,
              width: element.videoWidth,
              height: element.videoHeight,
            }
          : null
      );
    element.onerror = () => done(null);
    element.src = url;
  });
}

/**
 * The moment the talking stops, from the clip's own envelope.
 *
 * Only a run of quiet that reaches the end of the clip counts: a pause in the
 * middle of a sentence is not the end of the performance.
 */
export function speechEndOf(envelope: Envelope, duration: number): number {
  const { values, perSecond } = envelope;
  if (values.length === 0) return duration;

  let peak = 0;
  for (const value of values) if (value > peak) peak = value;
  if (peak <= 0) return duration;

  // The envelope is log10(1 + rms), so the threshold has to be taken there too.
  const floor = Math.log10(1 + Math.pow(10, SILENCE_FLOOR_DB / 20) * 32767);
  const threshold = Math.min(floor, peak * 0.5);

  let last = values.length - 1;
  while (last >= 0 && values[last] < threshold) last--;
  if (last < 0) return duration;

  const end = (last + 1) / perSecond;
  const trimmed = duration - end;
  return trimmed >= MIN_TAIL_SECONDS ? end : duration;
}

/**
 * Finds where `clip` sits inside `bed`, searching around `hintSeconds`.
 *
 * Normalised cross-correlation, so it doesn't care that the avatar model
 * re-encoded the audio at a different level and sample rate — only that the
 * pattern of loud and quiet still matches.
 */
export function locate(
  bed: Envelope,
  clip: Envelope,
  hintSeconds: number | null,
  searchSeconds = SEARCH_SECONDS
): Placement {
  const bedValues = bed.values;
  const clipValues = clip.values;
  if (clipValues.length === 0 || bedValues.length <= clipValues.length) {
    return { start: Math.max(0, hintSeconds ?? 0), confidence: 0 };
  }

  const limit = bedValues.length - clipValues.length;
  const [from, to] =
    hintSeconds === null
      ? [0, limit]
      : [
          Math.max(0, Math.round((hintSeconds - searchSeconds) * bed.perSecond)),
          Math.min(limit, Math.round((hintSeconds + searchSeconds) * bed.perSecond)),
        ];

  let clipMean = 0;
  for (const value of clipValues) clipMean += value;
  clipMean /= clipValues.length;
  let clipVariance = 0;
  for (const value of clipValues) clipVariance += (value - clipMean) ** 2;
  const clipNorm = Math.sqrt(clipVariance) || 1;

  let bestScore = -Infinity;
  let bestAt = Math.max(0, from);

  for (let at = from; at <= to; at++) {
    let mean = 0;
    for (let i = 0; i < clipValues.length; i++) mean += bedValues[at + i];
    mean /= clipValues.length;

    let dot = 0;
    let variance = 0;
    for (let i = 0; i < clipValues.length; i++) {
      const centred = bedValues[at + i] - mean;
      dot += centred * (clipValues[i] - clipMean);
      variance += centred * centred;
    }
    const score = dot / ((Math.sqrt(variance) || 1) * clipNorm);
    if (score > bestScore) {
      bestScore = score;
      bestAt = at;
    }
  }

  return { start: bestAt / bed.perSecond, confidence: Math.max(0, bestScore) };
}

/** The envelope up to `seconds`, for comparing only the part that has sound. */
function trimTo(envelope: Envelope, seconds: number): Envelope {
  const count = Math.max(1, Math.round(seconds * envelope.perSecond));
  return count >= envelope.values.length
    ? envelope
    : { values: envelope.values.subarray(0, count), perSecond: envelope.perSecond };
}

/** Everything the timeline needs to know about a dropped video file. */
export async function analyseClip(file: Blob): Promise<ClipFacts> {
  const [meta, audio] = await Promise.all([videoMetadata(file), decodeAudio(file)]);
  const envelope = audio ? envelopeOf(audio) : null;
  return {
    ...meta,
    envelope,
    speechEnd: envelope ? speechEndOf(envelope, meta.duration) : meta.duration,
  };
}

/** The bed's envelope, so clips have something to be located against. */
export async function analyseBed(file: Blob): Promise<Envelope | null> {
  const audio = await decodeAudio(file);
  return audio ? envelopeOf(audio) : null;
}

/**
 * Decides what a clip is and where it goes.
 *
 * A clip with no audio is a motion clip and keeps its filename's cue. A clip
 * whose audio matches the bed is an avatar and takes the matched position. A
 * clip with audio that *doesn't* match is left as a motion clip at its cue —
 * with a confidence low enough for the UI to say so.
 */
export function classify(
  facts: ClipFacts,
  bed: Envelope | null,
  cueSeconds: number | null
): { kind: ClipKind; start: number; confidence: number } {
  if (!facts.envelope || !bed) {
    return { kind: "motion", start: cueSeconds ?? 0, confidence: 0 };
  }

  // Match on the talking only. A clip usually ends with a beat of silence that
  // the bed does not have at that moment, and letting that tail into the
  // comparison drags a genuine match down — far enough, on a short clip, to
  // look like no match at all.
  const speech = trimTo(facts.envelope, facts.speechEnd);
  const placement = locate(bed, speech, cueSeconds);
  if (placement.confidence < AVATAR_CONFIDENCE) {
    return { kind: "motion", start: cueSeconds ?? placement.start, confidence: placement.confidence };
  }
  return { kind: "avatar", start: placement.start, confidence: placement.confidence };
}
