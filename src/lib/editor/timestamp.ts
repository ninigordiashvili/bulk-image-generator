/**
 * Turns an image filename into the second it should appear at.
 *
 * The generator names its output for the cue — `0-00`, `0-08`, `1-24` — because
 * a colon can't go in a filename on Windows and won't survive a round trip
 * through most file pickers. So minutes and seconds are separated by a dash or
 * an underscore, and everything here is built around that.
 */

// Anchored forms, tried first because they can't be misread.
const HMS = /^(\d{1,3})[-_](\d{1,2})[-_](\d{1,2}(?:[.,]\d{1,3})?)$/;
const MS = /^(\d{1,3})[-_](\d{1,2}(?:[.,]\d{1,3})?)$/;
const BARE = /^(\d{1,6})$/;

/**
 * Last resort: a cue tacked onto the end of a longer name, e.g. `shot-04_1-12`.
 * Only reached when the whole basename isn't a timestamp, and the UI always
 * shows what a name resolved to, so a false positive here is visible.
 */
const TRAILING = /(?:^|[^\d])(\d{1,3})[-_](\d{1,2}(?:[.,]\d{1,3})?)$/;

const num = (value: string) => Number(value.replace(",", "."));

/** Strips any directory prefix and the extension, leaving the bare name. */
export function baseName(filename: string): string {
  const last = filename.split(/[\\/]/).pop() ?? "";
  return last.replace(/\.[^.]+$/, "").trim();
}

/**
 * Returns the cue in seconds, or null when the name doesn't encode one.
 * Minutes are not capped at 60 — `0-90` means ninety seconds, which is a
 * reasonable thing to have typed and an unreasonable thing to reject.
 */
export function parseTimestamp(filename: string): number | null {
  const base = baseName(filename);
  if (!base) return null;

  let match = base.match(HMS);
  if (match) return num(match[1]) * 3600 + num(match[2]) * 60 + num(match[3]);

  match = base.match(MS);
  if (match) return num(match[1]) * 60 + num(match[2]);

  match = base.match(BARE);
  if (match) {
    // 3+ digits reads as mmss (`0130` = 1:30); 1-2 digits is just seconds.
    if (base.length >= 3) {
      return num(base.slice(0, -2)) * 60 + num(base.slice(-2));
    }
    return num(base);
  }

  match = base.match(TRAILING);
  if (match) return num(match[1]) * 60 + num(match[2]);

  return null;
}

/**
 * The inverse: 95 seconds becomes "1-35". Used to name a clip after the point
 * in a longer recording it was cut from, in the same form `parseTimestamp`
 * reads back — so those clips drop onto the editor's timeline unaided.
 */
export function secondsToCue(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}-${String(whole % 60).padStart(2, "0")}`;
}
