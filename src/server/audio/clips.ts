import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FFMPEG, FfmpegError, probeDuration, run } from "@/server/editor/ffmpeg";

/**
 * Voice tracks the video storyboard cuts avatar clips out of.
 *
 * A source is stored under the SHA-256 of its bytes, which makes the store
 * self-deduplicating: attaching the same recording to twenty rows uploads it
 * once, and re-attaching it tomorrow uploads it not at all. That also means
 * there is no registry to keep in sync — the id *is* the filename, and a
 * missing file is simply a cache miss.
 */
const ROOT = path.join(os.tmpdir(), "bulk-generator-audio");

/** Sources older than this are swept on the next upload. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Formats kie's avatar models accept, so a cut never has to be transcoded twice. */
export const AUDIO_EXTENSIONS = new Set([
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "mp4",
]);

export const SOURCE_ID = /^[0-9a-f]{64}$/;

/** The whole recording, not the cut: generous, since only the cut reaches kie. */
export const MAX_SOURCE_BYTES = 200 * 1024 * 1024;

/**
 * kie caps avatar audio at five minutes. Enforced here as well as in the
 * trimmer, because the trimmer's limit is a UI convenience and this one is the
 * contract with the model.
 */
export const MAX_CUT_SECONDS = 300;
export const MIN_CUT_SECONDS = 0.5;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Absolute path for a source, or null if the id or extension is unacceptable. */
export function sourcePath(id: string, extension: string): string | null {
  if (!SOURCE_ID.test(id) || !AUDIO_EXTENSIONS.has(extension)) return null;
  return path.join(ROOT, `${id}.${extension}`);
}

/** Finds a stored source by id whatever extension it was saved under. */
export async function findSource(id: string): Promise<string | null> {
  if (!SOURCE_ID.test(id)) return null;
  const entries = await fs.readdir(ROOT).catch(() => []);
  const match = entries.find((name) => name.startsWith(`${id}.`));
  return match ? path.join(ROOT, match) : null;
}

export async function ensureRoot(): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true });
}

/**
 * Drops recordings nothing has touched in a day. A two-minute voice track is
 * only a couple of megabytes, but a week of batches adds up and nothing here
 * is worth keeping once the clips are generated.
 */
export async function sweep(): Promise<void> {
  const cutoff = Date.now() - MAX_AGE_MS;
  const entries = await fs.readdir(ROOT).catch(() => []);
  for (const name of entries) {
    const full = path.join(ROOT, name);
    const stat = await fs.stat(full).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.rm(full, { force: true }).catch(() => {});
  }
}

export interface AudioCut {
  base64: string;
  mimeType: string;
  seconds: number;
}

/**
 * Cuts `duration` seconds starting at `start` and re-encodes to AAC.
 *
 * Re-encoding rather than stream-copying is deliberate: a copy can only cut on
 * a frame boundary, so the clip would start up to a frame early or late and the
 * lip-sync would inherit that error. AAC at 128k also puts a fifteen-second cut
 * around 240 KB, which matters when every row uploads one.
 */
export async function cutAudio(
  id: string,
  start: number,
  duration: number,
  signal?: AbortSignal
): Promise<AudioCut> {
  const source = await findSource(id);
  if (!source) {
    throw new Error("That voice track is no longer on the server — re-attach it.");
  }

  const total = await probeDuration(source, signal);
  if (total <= 0) throw new Error("Could not read a duration from that audio.");

  const from = Math.max(0, Math.min(start, Math.max(0, total - MIN_CUT_SECONDS)));
  const length = Math.min(
    Math.max(duration, MIN_CUT_SECONDS),
    Math.min(MAX_CUT_SECONDS, total - from)
  );

  const out = path.join(
    ROOT,
    `cut-${id.slice(0, 16)}-${Math.round(from * 1000)}-${Math.round(length * 1000)}.m4a`
  );

  try {
    await run(
      FFMPEG,
      [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-ss", from.toFixed(3),
        "-t", length.toFixed(3),
        "-i", source,
        "-vn",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "1",
        "-movflags", "+faststart",
        out,
      ],
      { signal }
    );

    const bytes = await fs.readFile(out);
    return {
      base64: bytes.toString("base64"),
      mimeType: "audio/mp4",
      seconds: length,
    };
  } catch (error) {
    if (error instanceof FfmpegError) {
      const tail = error.stderr.trim().split("\n").filter(Boolean).slice(-2).join(" · ");
      throw new Error(`Could not cut that audio${tail ? ` — ${tail}` : "."}`);
    }
    throw error;
  } finally {
    await fs.rm(out, { force: true }).catch(() => {});
  }
}
