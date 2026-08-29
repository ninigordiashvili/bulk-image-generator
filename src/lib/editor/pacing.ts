/**
 * The pause settings, and the floors under them.
 *
 * Shared because the sliders, the request handler and the cutter all have to
 * agree on what is allowed. The cutter enforces the guard whatever arrives, so
 * these floors are not what makes the output safe — they are what stops the UI
 * promising something the cutter is going to refuse, which is its own kind of
 * bug report.
 */

/**
 * The distance every cut keeps from any audio that is not room.
 *
 * The frame levels the cutter works from are 20ms averages, so a pause boundary
 * is already ±20ms uncertain, and the level crosses the line some way into the
 * word at either end — later still on a consonant, which is where the audible
 * damage shows. That is about 42ms of real uncertainty; this is 3.6x it. It
 * applies at both ends of every hole and around anything a hole has to step
 * over, and no setting can shrink it: see `excessOf` and `keepIslands` in
 * `server/editor/voiceover.ts`.
 *
 * This is the *second* line of defence, not the first. `toRoom` locates the
 * true end of a word by walking each pause end inward until 60ms of frames sit
 * within 3dB of the noise floor, and it does that regardless of this value —
 * so the guard is margin on top of an already conservative boundary. That is
 * what makes 0.15 safe where a naive 0.15 would not be.
 *
 * Measured on the real detector's output for a 2.26s gap: the cut lands 0.11s
 * clear of the previous word's audio and 0.15s clear of the next word's run-up.
 * It was 0.25 until 2026-08-29; the extra 0.10 bought nothing but a longer
 * pause, and left every gap at 1.22s when 1.02s was reachable.
 *
 * Where the remaining risk lives: not ordinary speech, but a take whose noise
 * floor is mis-estimated, which is what leaves `toRoom` in the wrong place. A
 * bigger guard buys forgiveness there — so if `PaceReport.uncertain` is set,
 * listen to the word ends before trusting the output.
 */
export const SPEECH_GUARD = 0.15;

/** A pause is only ever shortened to the two guards or longer. */
export const MIN_KEEP_GAP = SPEECH_GUARD * 2;

/**
 * And only a pause longer than this counts as a pause at all.
 *
 * Below about half a second the quiet between two sounds is the read, not a gap
 * in it: the beat inside a sentence, the closure before a hard consonant. Only
 * silence between sentences is on the table, so the cap cannot be dragged down
 * to where it would start hunting for gaps between words.
 */
export const MIN_MAX_GAP = 0.6;

export interface Pacing {
  maxGap: number;
  keepGap: number;
  leadIn: number;
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

const orElse = (value: number, fallback: number) =>
  Number.isFinite(value) ? value : fallback;

/** The three settings made consistent with each other and with the floors. */
export function clampPacing({ maxGap, keepGap, leadIn }: Pacing): Pacing {
  const cap = clamp(orElse(maxGap, 1), MIN_MAX_GAP, 10);
  // A pause can't be shortened to longer than the cap that caught it.
  const keep = clamp(orElse(keepGap, 0.8), MIN_KEEP_GAP, Math.max(cap, MIN_KEEP_GAP));
  // The run-up has to fit inside the kept pause and still leave the guard on
  // the other side of it.
  const lead = clamp(orElse(leadIn, SPEECH_GUARD), SPEECH_GUARD, keep - SPEECH_GUARD);
  return { maxGap: cap, keepGap: keep, leadIn: lead };
}
