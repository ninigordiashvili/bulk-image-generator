import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SPEECH_GUARD } from "@/lib/editor/pacing";
import { FFMPEG, FfmpegError, probeDuration, run } from "./ffmpeg";
import { resolveInside, type Job } from "./jobs";

/**
 * Joining a set of voiceover files into one narration bed, and tightening the
 * pauses while it's at it.
 *
 * THE RULE: nothing anyone said is ever altered, cut or shortened. Not a word,
 * not a syllable, not the attack of a consonant or the tail of a vowel. The
 * only thing this file is allowed to remove is the room — dead air in the
 * middle of a long pause between sentences. Every decision below that could go
 * either way goes the way that keeps audio. A pause left too long is a setting
 * the user can turn down; a word with its middle missing is not recoverable,
 * and it is what "like" turning into "lk" was.
 *
 * The obvious filter for this is `silenceremove`, and it is the wrong one: its
 * `stop_duration` is a threshold, not a cap. Set it to one second and a
 * two-second pause doesn't become one second, it very nearly disappears —
 * measured at 11.4s where 13.4s was wanted, with the one-second pauses deleted
 * outright at a 0.8 setting.
 *
 * So the pauses are found first and only the *excess* is cut: a gap longer than
 * `maxGap` loses everything past `keepGap`, and a gap shorter than that is left
 * exactly as recorded.
 *
 * Finding them is the part that has to be right. A fixed threshold does not
 * work: a pause in a real recording is not silence, it is the room, the preamp
 * and the microphone, and where that sits varies by tens of decibels between
 * one setup and another. Measured on takes whose only difference was the noise
 * floor, a fixed -35dB found every pause at -45dB and *none at all* at -28dB —
 * which is exactly the complaint that the long pauses survive. So the level is
 * measured from the recording itself; see `pickThreshold`.
 *
 * Measuring is never trusted on its own, though, because the rule cannot depend
 * on getting a level right. Three separate things enforce it, and a cut has to
 * survive all three: `SPEECH_GUARD` keeps every cut a clear distance away from
 * the audio either side of it, `detectSilences` refuses to treat any sound long
 * enough to be part of a word as room however quiet it is, and `keepIslands`
 * cuts around whatever survived that test rather than through it.
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
   *
   * This is a preference, not the safety margin. Whatever it is set to, no cut
   * comes closer to the next word than `SPEECH_GUARD`.
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

/**
 * How far above the silence line a bridged blip has to be before it is treated
 * as something someone said rather than as the room misbehaving. Only ever
 * consulted for a blip too short to be speech in the first place — see
 * `ISLAND_MIN_SECONDS`.
 */
const ISLAND_MARGIN_DB = 6;

/**
 * A sound this long is a person, whatever level it came in at.
 *
 * The old rule was level alone: anything less than 6dB over the line was
 * absorbed into the pause and cut. That is what ate the middle of a word —
 * "like" came back as "lk", because the vowel between the l and the k was a
 * hair too quiet to clear the bar and short enough to be bridged, so it was
 * classed as room and removed with the dead air around it. Nothing 60ms long
 * with quiet either side of it is a click or a chair; the shortest real word
 * runs to twice this. So duration decides first and level only breaks the tie
 * for the 20 or 40ms flickers that a room genuinely does produce.
 */
const ISLAND_MIN_SECONDS = 0.06;

/**
 * How far above the floor the room is still allowed to be.
 *
 * Room tone measured in 20ms frames spreads a couple of dB; a room that swells —
 * a fan cycling, traffic — maybe twice that. Six is comfortably past both and
 * still nowhere near the twenty-odd dB that separates a room from the quietest
 * thing a person says. See `silenceThreshold` for what goes wrong without it.
 */
const ROOM_SPREAD_DB = 6;

/** Below this a frame is not quiet room, it is nothing at all. */
const DIGITAL_SILENCE_DB = -90;

/**
 * The shortest hole worth making.
 *
 * Below this a cut saves no meaningful time and risks a tick at the join, and
 * the pieces this size are the slivers left either side of something protected.
 * Leaving them in place is free.
 */
const MIN_CUT = 0.15;

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
 * Otsu's method: of every possible threshold, the one that leaves the quiet
 * frames and the loud frames each as tightly clustered as it can. Used here to
 * separate the two populations, not as the cutting line itself — see
 * `roomCeiling` for why the line goes somewhere else.
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
 * The loudest the room itself ever gets.
 *
 * Otsu's split lands roughly midway between the room and the voice, and that is
 * the wrong place to cut. On a take whose room sat 22dB under the speech, the
 * midpoint was 10dB above the room — so a soft aside, or the tail of a sentence
 * trailing off, read as silence and was removed. Measured: a 1.6s aside cut
 * away in full.
 *
 * So the line goes just above the room instead. Everything below it is the room
 * and may go; everything above it is presumed to be someone talking and is kept,
 * however quietly they are doing it. The cost is the other direction — a room
 * that swells above its own ceiling keeps a little of a pause — and that is the
 * right way round to be wrong.
 *
 * The ceiling is a high percentile of the quiet population rather than its
 * maximum, because the frames either side of every word sit in that population
 * while a word is fading in or out, and the maximum would be one of those.
 */
export function roomCeiling(levels: number[], split: number): number {
  const quiet = levels.filter((db) => db < split);
  if (quiet.length === 0) return split;
  return percentileOf(quiet, 0.97);
}

/**
 * The frames that carry something, which are the only ones worth measuring.
 *
 * A take exported with a digitally silent lead-in, or joined from files with
 * silence padded onto their ends, has frames at -120dB that are not room tone
 * and are not a voice. Left in, they wreck the measurement rather than skew it:
 * Otsu sees the true gap as the one between digital silence and everything
 * else, splits there, and `roomCeiling` then measures the population of nothing
 * at all. Measured on a take with a 2s silent head, the line came out at -119dB
 * — under the room, so no pause was found anywhere and nothing was tightened.
 *
 * They need no measuring anyway: digital silence is below any line that could
 * be drawn, so it reads as room at cutting time whatever this returns.
 */
function audible(levels: number[]): number[] {
  const real = levels.filter((db) => db > DIGITAL_SILENCE_DB);
  return real.length > 0 ? real : levels;
}

/**
 * The quietest the recording ever really is.
 *
 * A low percentile, so contaminating the quiet population with soft speech
 * cannot lift it — which is the whole reason it is worth measuring separately
 * from the ceiling. See `silenceThreshold`.
 */
export function noiseFloor(levels: number[]): number {
  return percentileOf(audible(levels), 0.05);
}

/**
 * The level below which audio is the room and not a voice.
 *
 * Never above Otsu's split, so a recording with no real pauses cannot end up
 * cutting into speech, and never within 6dB of the speech itself — and never
 * more than `ROOM_SPREAD_DB` above the floor the recording actually sits on,
 * which is the one that matters and the one that was missing.
 *
 * `roomCeiling` measures the quiet population, and on a mostly-soft take that
 * population is not the room: Otsu's split rises to sit between the loud speech
 * and the soft speech, so the soft speech falls in with the room and sets the
 * ceiling itself. Measured on a take reading at -20dB with soft passages at
 * -40dB over a -50dB room, the line landed at -39.8dB — above the soft passages
 * — and 3.7 of their 5 seconds were removed as dead air. Nothing downstream can
 * catch that, because everything that protects a word keys off the word being
 * louder than the line, and this put the line above the word.
 *
 * The floor is not fooled the same way: it is a low percentile, so contaminating
 * the quiet population with soft speech cannot lift it. Room tone measured in
 * 20ms frames spreads a couple of dB, a room that swells maybe twice that; the
 * gap between a room and even a murmured word is far wider. So the line is held
 * within `ROOM_SPREAD_DB` of the floor, and a room noisier than that keeps a
 * little of its pauses instead of a voice quieter than that losing syllables.
 */
export function silenceThreshold(levels: number[]): number {
  const real = audible(levels);
  const split = pickThreshold(real);
  const speech = percentileOf(real, 0.95);
  // A decibel of room to spare: the ceiling is a percentile, so a few frames
  // sit above it by design.
  return Math.min(
    roomCeiling(real, split) + 1,
    split,
    speech - 6,
    percentileOf(real, 0.05) + ROOM_SPREAD_DB
  );
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
  return detectSilences(levels, thresholdDb, minimum, bridge).silences;
}

/**
 * The same, plus the sounds that were bridged over.
 *
 * The islands matter to the caller: bridging is what stops a click splitting a
 * pause in two, but the click itself must survive the cut — it might be a short
 * word rather than a chair, and the rule is that nothing anyone said is removed.
 */
export function detectSilences(
  levels: number[],
  thresholdDb: number,
  minimum: number,
  bridge = 0.12
): { silences: Silence[]; islands: Silence[] } {
  const quiet = levels.map((db) => db < thresholdDb);
  const islands: Silence[] = [];

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
      let peak = -Infinity;
      for (let k = i; k < end; k++) peak = Math.max(peak, levels[k]);
      for (let k = i; k < end; k++) quiet[k] = true;
      // Bridged for measuring, protected for cutting — unless it is both too
      // short to be a word and too quiet to be anything but the room. A room
      // does flicker over the line, often enough that sparing every flicker
      // would leave the cut in slivers, so those two conditions together are
      // the only way a bridged sound is allowed to go. Either one on its own
      // keeps it: length wins over level, because a syllable can be quiet but
      // a tick cannot be long.
      const spansAWord = (end - i) * FRAME_SECONDS >= ISLAND_MIN_SECONDS;
      if (spansAWord || peak > thresholdDb + ISLAND_MARGIN_DB) {
        islands.push({ start: i * FRAME_SECONDS, end: end * FRAME_SECONDS });
      }
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
  return { silences, islands };
}

/**
 * How much of an over-long pause is kept, and how it is split between the two
 * words either side of it.
 *
 * `keepGap` is the length asked for, but never less than a guard at each end:
 * the hole goes in the dead middle of the pause and both edges stay a clear
 * `SPEECH_GUARD` away from real audio. `leadIn` decides how the kept time is
 * shared — more of it in front of the next word, less of it trailing the last
 * one — and it can move the split but not close either guard.
 */
function keptPause({ keepGap, leadIn }: PaceOptions): { head: number; tail: number } {
  const total = Math.max(keepGap, SPEECH_GUARD * 2);
  const tail = Math.min(Math.max(leadIn, SPEECH_GUARD), total - SPEECH_GUARD);
  return { head: total - tail, tail };
}

/** The whole of what an over-long pause is shortened to. */
export function keptLength(options: PaceOptions): number {
  const { head, tail } = keptPause(options);
  return head + tail;
}

/**
 * The stretches to cut out of each over-long pause.
 *
 * The pause ends up `keepGap` long, but it is taken from both ends: the
 * beginning, which is the tail of the word just spoken, and the end, which is
 * the run-up to the word about to be spoken. Only the dead middle goes. Taking
 * it all from the front would leave the cut butted against the next word and
 * shave its attack off.
 *
 * Both ends are guarded whatever the settings say. `keepGap` and `leadIn` are
 * sliders, and a slider is allowed to be dragged somewhere silly; the rule that
 * speech is never touched is not a slider, so it is applied here rather than
 * trusted to the values that arrive.
 */
export function excessOf(silences: Silence[], options: PaceOptions): Silence[] {
  const { maxGap } = options;
  const { head, tail } = keptPause(options);

  const cuts: Silence[] = [];
  for (const silence of silences) {
    const length = silence.end - silence.start;
    // Never shortened below the two guards, so a pause that is already inside
    // them is left exactly as recorded however low the cap was set.
    if (length <= maxGap || length <= head + tail) continue;

    const from = silence.start + head;
    const to = silence.end - tail;
    if (to - from >= MIN_CUT) cuts.push({ start: from, end: to });
  }
  return cuts;
}

/**
 * Takes the islands, and a guard around each of them, back out of the ranges to
 * be removed.
 *
 * A pause with a click in it is one pause, which is why the click is bridged
 * over when the pause is measured. But the click itself is not silence, and if
 * it turns out to be a short word — "no", "right", a name — removing it would
 * be cutting speech. So the cut is split around it: the quiet either side goes,
 * the loud bit stays.
 *
 * With `SPEECH_GUARD` either side of it, for the same reason the ends of a cut
 * are guarded. Butting a cut straight up against an island would take that
 * word's run-up and its tail off even though the word itself survived, which is
 * the clipped sound this is all here to avoid.
 */
export function keepIslands(cuts: Silence[], islands: Silence[]): Silence[] {
  if (islands.length === 0) return cuts;

  let pieces = cuts;
  for (const island of islands) {
    const from = island.start - SPEECH_GUARD;
    const to = island.end + SPEECH_GUARD;
    const next: Silence[] = [];
    for (const cut of pieces) {
      if (to <= cut.start || from >= cut.end) {
        next.push(cut);
        continue;
      }
      if (from > cut.start) next.push({ start: cut.start, end: from });
      if (to < cut.end) next.push({ start: to, end: cut.end });
    }
    pieces = next;
  }
  // A sliver either side of an island is not worth a cut of its own: it saves
  // nothing and a hole that small is heard as a tick rather than as tightening.
  return pieces.filter((piece) => piece.end - piece.start >= MIN_CUT);
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

    // Measured from this recording, not assumed: see silenceThreshold.
    const levels = await frameLevels(joined, signal);
    // Both measured over the audible frames, so a silent lead-in doesn't report
    // a -120dB room and a 100dB dynamic range that isn't there.
    const noiseFloorDb = noiseFloor(levels);
    const speechDb = percentileOf(audible(levels), 0.95);
    // Never at or above the speech itself. Otsu will not put it there, but a
    // manual override can, and the result is not "a few pauses missed" — it is
    // the entire recording classified as silence and deleted. Measured with the
    // old fixed -35dB against a take whose speech sat at -35dB: 1206 seconds
    // became 0.9. A floor under the answer costs nothing and rules that out.
    const ceiling = speechDb - 6;
    const thresholdDb = Math.min(
      options.thresholdDb ?? silenceThreshold(levels),
      ceiling
    );

    // A pause has to be at least `maxGap` to be worth reporting at all.
    const { silences, islands } = detectSilences(levels, thresholdDb, options.maxGap);
    const cuts = keepIslands(excessOf(silences, options), islands);
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
    // What the longest pause ends up as: untouched if it was short enough to
    // leave alone, otherwise shortened to the kept length — which is the two
    // guards when `keepGap` was set below them.
    const kept = keptLength(options);
    const longestGap = silences.reduce((longest: number, silence: Silence) => {
      const length = silence.end - silence.start;
      return Math.max(longest, length > options.maxGap ? Math.min(length, kept) : length);
    }, 0);

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
