import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { FFMPEG, FfmpegError, probeDuration, run } from "./ffmpeg";
import { resolveInside, type Job } from "./jobs";

/**
 * Joining a set of voiceover files into one narration bed, and tightening the
 * pauses while it's at it.
 *
 * The obvious filter for the second part is `silenceremove`, and it is the
 * wrong one: its `stop_duration` is a threshold, not a cap. Set it to one
 * second and a two-second pause doesn't become one second, it very nearly
 * disappears — measured at 11.4s where 13.4s was wanted, with the one-second
 * pauses deleted outright at a 0.8 setting.
 *
 * So the pauses are found first and only the *excess* is cut: a gap longer than
 * `maxGap` loses everything past `keepGap`, and a gap shorter than that is left
 * exactly as recorded. Speech is never touched.
 *
 * Finding them is the part that has to be right. A fixed threshold does not
 * work: a pause in a real recording is not silence, it is the room, the preamp
 * and the microphone, and where that sits varies by tens of decibels between
 * one setup and another. Measured on takes whose only difference was the noise
 * floor, a fixed -35dB found every pause at -45dB and *none at all* at -28dB —
 * which is exactly the complaint that the long pauses survive. So the level is
 * measured from the recording itself; see `pickThreshold`.
 */

export interface PaceOptions {
  /** A pause longer than this is too long. */
  maxGap: number;
  /** What a too-long pause is shortened to. */
  keepGap: number;
  /**
   * How quiet counts as a pause. Null — the normal case — measures it from the
   * recording. A number overrides that, for the rare take the measurement gets
   * wrong.
   */
  thresholdDb: number | null;
  /**
   * Real audio kept immediately before speech resumes.
   *
   * A detector calls the pause over only once the level crosses the threshold,
   * which is *after* the word has begun — measured at 22ms late on a soft
   * attack at -35 dB, and worse on a real consonant, which starts far quieter
   * than a vowel. Cutting up to that point takes the front off the word: the
   * clipped "s" or "f" that makes a tightened read sound wrong. So the cut
   * stops short, and the last of the pause is the original run-up to the word.
   */
  leadIn: number;
}

export interface PaceReport {
  /** Stored basename of the joined track, as m4a. */
  stored: string;
  /** And as mp3, for anything that would rather have one. */
  storedMp3: string;
  duration: number;
  originalDuration: number;
  /** How many pauses were long enough to shorten. */
  tightened: number;
  /** Seconds of dead air removed. */
  removed: number;
  /** Longest pause left, for a sanity check in the UI. */
  longestGap: number;
  parts: number;
  /** The level the recording's own quiet sits at. */
  noiseFloorDb: number;
  /** And where its speech sits. */
  speechDb: number;
  /** The line drawn between the two, measured unless it was overridden. */
  thresholdDb: number;
  /**
   * True when the two are too close to tell apart — a heavily compressed or
   * noisy take. The cuts are still made, but they are worth listening to.
   */
  uncertain: boolean;
}

interface Silence {
  start: number;
  end: number;
}

/** 20ms of audio, which is fine enough to place a cut and coarse enough to be cheap. */
const FRAME_SECONDS = 0.02;
const LEVEL_RATE = 8000;
const FRAME_SAMPLES = LEVEL_RATE * FRAME_SECONDS;

/**
 * The loudness of every 20ms of the recording, in dBFS.
 *
 * Streamed and reduced as it arrives: half an hour decodes to about 29MB of
 * samples but only 90,000 numbers, and there is no reason to hold the samples.
 */
export function frameLevels(file: string, signal?: AbortSignal): Promise<number[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Cancelled."));
      return;
    }
    const child = spawn(
      FFMPEG,
      ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file,
       "-ac", "1", "-ar", String(LEVEL_RATE), "-f", "s16le", "-"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    const levels: number[] = [];
    let sum = 0;
    let count = 0;
    let carry: Buffer | null = null;

    child.stdout.on("data", (chunk: Buffer) => {
      let buffer = chunk;
      if (carry) {
        buffer = Buffer.concat([carry, chunk]);
        carry = null;
      }
      // A chunk can split a sample in half; the odd byte waits for the next one.
      const usable = buffer.length - (buffer.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const value = buffer.readInt16LE(i) / 32768;
        sum += value * value;
        if (++count === FRAME_SAMPLES) {
          const rms = Math.sqrt(sum / FRAME_SAMPLES);
          levels.push(rms > 0 ? 20 * Math.log10(rms) : -120);
          sum = 0;
          count = 0;
        }
      }
      if (usable < buffer.length) carry = buffer.subarray(usable);
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });

    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error: Error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code: number | null) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new Error("Cancelled."));
      else if (code === 0) resolve(levels);
      else reject(new FfmpegError(`ffmpeg exited with ${code}`, stderr));
    });
  });
}

/** A percentile of the frame levels, for reporting what was measured. */
export function percentileOf(levels: number[], p: number): number {
  if (levels.length === 0) return -120;
  const sorted = [...levels].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[at];
}

/**
 * Where to draw the line between the room and the voice.
 *
 * Otsu's method: of every possible threshold, the one that leaves the quiet
 * frames and the loud frames each as tightly clustered as it can. There is no
 * constant to guess and nothing to tune — it reads whatever floor the recording
 * happens to have. Measured across takes from a -70dB floor to a -28dB one, it
 * landed between the floor and the speech every time, and found every pause at
 * its true length in all of them.
 */
export function pickThreshold(levels: number[], lo = -100, hi = 0, bins = 200): number {
  const histogram = new Array<number>(bins).fill(0);
  for (const db of levels) {
    const bin = Math.floor(((db - lo) / (hi - lo)) * bins);
    histogram[Math.max(0, Math.min(bins - 1, bin))]++;
  }

  const total = levels.length;
  let weighted = 0;
  for (let i = 0; i < bins; i++) weighted += i * histogram[i];

  let best = 0;
  let bestVariance = -1;
  let quietWeight = 0;
  let quietSum = 0;
  for (let i = 0; i < bins; i++) {
    quietWeight += histogram[i];
    if (quietWeight === 0) continue;
    const loudWeight = total - quietWeight;
    if (loudWeight === 0) break;
    quietSum += i * histogram[i];
    const quietMean = quietSum / quietWeight;
    const loudMean = (weighted - quietSum) / loudWeight;
    const between = quietWeight * loudWeight * (quietMean - loudMean) ** 2;
    if (between > bestVariance) {
      bestVariance = between;
      best = i;
    }
  }
  return lo + ((best + 0.5) / bins) * (hi - lo);
}

/**
 * The stretches of quiet, from measured levels.
 *
 * `bridge` is what keeps a pause whole. A click, a lip smack or a chair is not
 * speech resuming, but it crosses the threshold — and a detector without this
 * splits a three-second pause into two shorter ones, neither long enough to be
 * worth cutting, so the pause survives intact. Anything loud that lasts less
 * than this, with quiet either side, is absorbed.
 */
export function silencesFrom(
  levels: number[],
  thresholdDb: number,
  minimum: number,
  bridge = 0.12
): Silence[] {
  const quiet = levels.map((db) => db < thresholdDb);

  const bridgeFrames = Math.round(bridge / FRAME_SECONDS);
  for (let i = 0; i < quiet.length; ) {
    if (quiet[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < quiet.length && !quiet[end]) end++;
    const isBlip = end - i <= bridgeFrames;
    const surrounded = i > 0 && quiet[i - 1] && end < quiet.length && quiet[end];
    if (isBlip && surrounded) {
      for (let k = i; k < end; k++) quiet[k] = true;
    }
    i = end;
  }

  const silences: Silence[] = [];
  for (let i = 0; i < quiet.length; ) {
    if (!quiet[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < quiet.length && quiet[end]) end++;
    const from = i * FRAME_SECONDS;
    const to = end * FRAME_SECONDS;
    if (to - from >= minimum) silences.push({ start: from, end: to });
    i = end;
  }
  return silences;
}

/**
 * The stretches to cut out of each over-long pause.
 *
 * The pause still ends up `keepGap` long, but it is taken from both ends: the
 * beginning, which is the tail of the word just spoken, and `leadIn` from the
 * end, which is the run-up to the word about to be spoken. Only the dead middle
 * goes. Taking it all from the front would leave the cut butted against the
 * next word and shave its attack off.
 */
export function excessOf(
  silences: Silence[],
  { maxGap, keepGap, leadIn }: PaceOptions
): Silence[] {
  const cuts: Silence[] = [];
  for (const silence of silences) {
    const length = silence.end - silence.start;
    if (length <= maxGap) continue;

    // The lead can't be longer than the pause we're keeping, or the cut would
    // start before the pause does.
    const lead = Math.min(leadIn, keepGap);
    const from = silence.start + (keepGap - lead);
    const to = silence.end - lead;
    if (to - from > 0.02) cuts.push({ start: from, end: to });
  }
  return cuts;
}

/**
 * An `aselect` expression that drops `cuts` and keeps everything else.
 * `asetpts` afterwards closes the holes so the result plays continuously.
 */
export function selectExpression(cuts: Silence[]): string {
  if (cuts.length === 0) return "";
  const terms = cuts
    .map((cut) => `between(t,${cut.start.toFixed(4)},${cut.end.toFixed(4)})`)
    .join("+");
  return `aselect='not(${terms})',asetpts=N/SR/TB`;
}

/**
 * Joins `files` in order and tightens the pauses across the whole thing.
 *
 * Joined first, then tightened: the silence at the end of one file and the
 * start of the next are one pause to a listener, and capping them separately
 * would leave two.
 */
export async function joinVoiceovers(
  job: Job,
  files: string[],
  options: PaceOptions,
  signal?: AbortSignal
): Promise<PaceReport> {
  if (files.length === 0) throw new Error("No voice tracks to join.");

  const paths: string[] = [];
  for (const name of files) {
    const full = resolveInside(job, "", name);
    if (!full) throw new Error(`Rejected file name "${name}".`);
    await fs.access(full).catch(() => {
      throw new Error(`"${name}" was never uploaded.`);
    });
    paths.push(full);
  }

  const joined = path.join(job.dir, "voice-joined.wav");
  const output = path.join(job.dir, "voice-bed.m4a");
  const outputMp3 = path.join(job.dir, "voice-bed.mp3");

  try {
    // Normalised to one rate and channel count first, or concat refuses a set
    // that mixes them — which a folder of separately exported takes often does.
    const inputs = paths.flatMap((file) => ["-i", file]);
    const chains = paths
      .map((_, i) => `[${i}:a]aresample=44100,aformat=channel_layouts=mono[n${i}]`)
      .join(";");
    const merged = paths.map((_, i) => `[n${i}]`).join("");

    await run(
      FFMPEG,
      ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
       ...inputs,
       "-filter_complex", `${chains};${merged}concat=n=${paths.length}:v=0:a=1[out]`,
       "-map", "[out]", "-c:a", "pcm_s16le", joined],
      { signal }
    );

    const originalDuration = await probeDuration(joined, signal);

    // Measured from this recording, not assumed: see pickThreshold.
    const levels = await frameLevels(joined, signal);
    const noiseFloorDb = percentileOf(levels, 0.05);
    const speechDb = percentileOf(levels, 0.95);
    // Never at or above the speech itself. Otsu will not put it there, but a
    // manual override can, and the result is not "a few pauses missed" — it is
    // the entire recording classified as silence and deleted. Measured with the
    // old fixed -35dB against a take whose speech sat at -35dB: 1206 seconds
    // became 0.9. A floor under the answer costs nothing and rules that out.
    const ceiling = speechDb - 6;
    const thresholdDb = Math.min(
      options.thresholdDb ?? pickThreshold(levels),
      ceiling
    );

    // A pause has to be at least `maxGap` to be worth reporting at all.
    const silences: Silence[] = silencesFrom(levels, thresholdDb, options.maxGap);
    const cuts = excessOf(silences, options);
    const removed = cuts.reduce((sum, cut) => sum + (cut.end - cut.start), 0);
    const select = selectExpression(cuts);

    // Both formats from the same tightened audio, so they can't drift apart.
    // Encoding twice costs a second or two on a track of any realistic length.
    await run(
      FFMPEG,
      ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
       "-i", joined,
       ...(select ? ["-af", select] : []),
       "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "1",
       "-movflags", "+faststart", output],
      { signal }
    );
    await run(
      FFMPEG,
      ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
       "-i", joined,
       ...(select ? ["-af", select] : []),
       "-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100", "-ac", "1",
       outputMp3],
      { signal }
    );

    const duration = await probeDuration(output, signal);
    const longestGap = silences.reduce(
      (longest: number, silence: Silence) =>
        Math.max(longest, Math.min(silence.end - silence.start, options.keepGap)),
      0
    );

    return {
      stored: path.basename(output),
      storedMp3: path.basename(outputMp3),
      noiseFloorDb,
      speechDb,
      thresholdDb,
      // Under about 12dB between the room and the voice there is no line to
      // draw that does not cut one or keep the other.
      uncertain: speechDb - noiseFloorDb < 12,
      duration,
      originalDuration,
      tightened: cuts.length,
      removed,
      longestGap,
      parts: paths.length,
    };
  } catch (error) {
    if (error instanceof FfmpegError) {
      const tail = error.stderr.trim().split("\n").filter(Boolean).slice(-2).join(" · ");
      throw new Error(`Could not join those tracks${tail ? ` — ${tail}` : "."}`);
    }
    throw error;
  } finally {
    await fs.rm(joined, { force: true }).catch(() => {});
  }
}
