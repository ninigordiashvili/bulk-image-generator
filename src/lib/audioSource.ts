"use client";

import type { AudioUploadResponse, ErrorResponse } from "@/types";

/**
 * Well under the 10 MB the proxy will buffer for a single request — the same
 * constraint the editor's uploads work around.
 */
const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Waveform resolution. At 200 buckets a second a two-minute track is 24,000
 * of them, which is small enough to hold and fine enough that zooming to a
 * ten-second window still has more detail than the canvas has pixels.
 */
export const PEAKS_PER_SECOND = 200;

export interface Waveform {
  min: Float32Array;
  max: Float32Array;
  perSecond: number;
}

export interface AudioSource {
  /** SHA-256 of the file — also its name on the server. */
  id: string;
  /** Filename without extension: half of a generated clip's name. */
  name: string;
  fileName: string;
  duration: number;
  /** Object URL, for scrubbing and previewing in the trimmer. */
  url: string;
  waveform: Waveform | null;
}

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Content hash, computed here so an already-uploaded track skips the transfer. */
export async function hashFile(file: File): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
}

/**
 * Min/max per bucket across the whole file. Both are kept rather than a single
 * amplitude because drawing the true envelope is what makes speech legible —
 * an RMS bar chart turns every pause into the same grey block.
 */
export async function buildWaveform(file: File): Promise<{ waveform: Waveform; duration: number }> {
  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioCtx();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const buckets = Math.max(1, Math.ceil(buffer.duration * PEAKS_PER_SECOND));
    const min = new Float32Array(buckets).fill(0);
    const max = new Float32Array(buckets).fill(0);
    const perBucket = buffer.length / buckets;

    // Mixing the channels down as we go: the trimmer draws one waveform, and
    // holding a second copy of a long track buys nothing.
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let bucket = 0; bucket < buckets; bucket++) {
        const from = Math.floor(bucket * perBucket);
        const to = Math.min(data.length, Math.floor((bucket + 1) * perBucket));
        let low = 0;
        let high = 0;
        for (let i = from; i < to; i++) {
          const value = data[i];
          if (value < low) low = value;
          if (value > high) high = value;
        }
        if (low < min[bucket]) min[bucket] = low;
        if (high > max[bucket]) max[bucket] = high;
      }
    }

    return {
      waveform: { min, max, perSecond: PEAKS_PER_SECOND },
      duration: buffer.duration,
    };
  } finally {
    void context.close();
  }
}

/**
 * Sends the track to the server if it isn't already there. Returns the duration
 * the server measured, which is the one the cut will actually be taken against.
 */
export async function uploadAudioSource(
  file: File,
  id: string,
  onProgress?: (sent: number, total: number) => void,
  signal?: AbortSignal
): Promise<number> {
  let offset = 0;
  let duration = 0;

  do {
    const chunk = file.slice(offset, offset + CHUNK_BYTES);
    const query = new URLSearchParams({
      id,
      name: file.name,
      offset: String(offset),
      size: String(file.size),
    });

    const response = await fetch(`/api/audio/upload?${query}`, {
      method: "POST",
      body: chunk,
      headers: { "Content-Type": "application/octet-stream" },
      signal,
    });
    const payload = (await response.json().catch(() => null)) as
      | AudioUploadResponse
      | ErrorResponse
      | null;

    if (!response.ok || !payload?.ok) {
      throw new Error(
        payload && "error" in payload
          ? payload.error
          : `Upload of ${file.name} failed (${response.status}).`
      );
    }

    duration = payload.duration || duration;
    // The server already had these exact bytes; nothing left to send.
    if (payload.complete) break;
    offset += chunk.size;
    onProgress?.(offset, file.size);
  } while (offset < file.size);

  onProgress?.(file.size, file.size);
  return duration;
}
