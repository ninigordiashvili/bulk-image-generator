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
 */

export interface PaceOptions {
  /** A pause longer than this is too long. */
  maxGap: number;
  /** What a too-long pause is shortened to. */
  keepGap: number;
  /** How quiet counts as a pause. -35 to -45 dB covers most recordings. */
  thresholdDb: number;
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
}

interface Silence {
  start: number;
  end: number;
}

/** Every stretch of quiet ffmpeg can find, in order. */
export async function findSilences(
  file: string,
  thresholdDb: number,
  minimum: number,
  signal?: AbortSignal
): Promise<Silence[]> {
  const { stderr } = await run(
    FFMPEG,
    ["-hide_banner", "-nostats", "-i", file,
     "-af", `silencedetect=noise=${thresholdDb}dB:d=${minimum.toFixed(3)}`,
     "-f", "null", "-"],
    { signal }
  ).catch((error) => {
    if (error instanceof FfmpegError) return { stdout: "", stderr: error.stderr };
    throw error;
  });

  const silences: Silence[] = [];
  let open: number | null = null;
  // The two are reported on separate lines, in order, so pairing is positional.
  for (const line of stderr.split("\n")) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (start) {
      open = Math.max(0, Number(start[1]));
      continue;
    }
    const end = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (end && open !== null) {
      silences.push({ start: open, end: Number(end[1]) });
      open = null;
    }
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

    // A pause has to be at least `maxGap` to be worth reporting at all.
    const silences = await findSilences(joined, options.thresholdDb, options.maxGap, signal);
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
      (longest, silence) =>
        Math.max(longest, Math.min(silence.end - silence.start, options.keepGap)),
      0
    );

    return {
      stored: path.basename(output),
      storedMp3: path.basename(outputMp3),
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
