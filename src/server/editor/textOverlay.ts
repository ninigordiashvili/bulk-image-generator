import { existsSync } from "node:fs";
import { displayText, styleOf } from "@/lib/editor/textStyles";
import type { TextMoment } from "@/types/editor";

/**
 * Drawing text moments over the picture.
 *
 * Two filters do the work. `drawtext` animates its own `y` and `alpha` from
 * expressions, so the rise and the fade are exact. The dimming behind it is
 * `drawbox`, whose alpha *cannot* be an expression — so the fade is stepped
 * instead, a handful of boxes each enabled for a slice of the ramp.
 *
 * The obvious alternative for the dim, `eq=brightness` with an expression,
 * looks wrong: brightness is additive, so it subtracts a fixed number of levels
 * rather than scaling. At a 0.35 setting it took a mid-grey field from 80 down
 * to 4 — black, not dimmed. The stepped box scales, and takes the same field to
 * 54 and back.
 */

/** How many slices the dim ramp is cut into. */
const STEPS = 5;
const FADE_IN = 0.35;
const FADE_OUT = 0.45;
/** How long the text takes to travel to the centre. */
const TRAVEL = 0.55;

/**
 * A font file for a style.
 *
 * ffmpeg can fall back on fontconfig, but the bundled build has no fontconfig
 * file, so what it picks is whatever it finds — different on each machine and
 * silently different between a preview and an export. Naming a file makes the
 * result the same everywhere the file exists; the lists in `textStyles` cover
 * macOS, Windows and a typical Linux install.
 */
const resolved = new Map<string, string | null>();

export function fontFileFor(candidates: string[]): string | null {
  const key = candidates.join("|");
  if (!resolved.has(key)) {
    resolved.set(key, candidates.find((path) => existsSync(path)) ?? null);
  }
  return resolved.get(key) ?? null;
}

/**
 * Makes a string safe to sit inside a single-quoted drawtext option.
 *
 * The apostrophe is swapped for a typographic one rather than escaped. Escaping
 * a quote inside a quoted filter option means closing and reopening the quote
 * mid-word, which is easy to get wrong and impossible to read; the curly
 * apostrophe is what the text should have looked like anyway.
 */
export function escapeDrawText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\u2019")
    .replace(/%/g, "\\%")
    .replace(/:/g, "\\:")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

const fixed = (value: number) => value.toFixed(3);

/** Where the text sits before it has finished arriving, as a fraction of height. */
function travelFrom(animation: TextMoment["animation"]): number | null {
  if (animation === "rise") return 0.7;
  if (animation === "drop") return 0.3;
  return null; // "fade" arrives in place
}

/**
 * The filters for one moment, in a segment's own timeline.
 *
 * `start` has already been rebased, and may be negative or run past the end of
 * the segment when a moment straddles a cut — that is correct, and is what lets
 * the same moment continue across a change of picture without restarting.
 */
export function momentChain(
  moment: TextMoment,
  start: number,
  height: number
): string[] {
  const end = start + moment.duration;
  const parts: string[] = [];

  // --- the dim behind it -------------------------------------------------
  const darken = Math.max(0, Math.min(0.8, moment.darken));
  if (darken > 0.001) {
    const box = (alpha: number, from: number, to: number) =>
      alpha <= 0.001 || to - from <= 0.0005
        ? null
        : `drawbox=x=0:y=0:w=iw:h=ih:color=black@${alpha.toFixed(3)}:t=fill` +
          `:enable='between(t,${fixed(from)},${fixed(to)})'`;

    const steps: (string | null)[] = [];
    for (let k = 1; k <= STEPS; k++) {
      steps.push(box(
        (darken * k) / STEPS,
        start + ((k - 1) * FADE_IN) / STEPS,
        start + (k * FADE_IN) / STEPS
      ));
    }
    steps.push(box(darken, start + FADE_IN, end - FADE_OUT));
    for (let k = STEPS - 1; k >= 1; k--) {
      steps.push(box(
        (darken * k) / STEPS,
        end - FADE_OUT + ((STEPS - 1 - k) * FADE_OUT) / STEPS,
        end - FADE_OUT + ((STEPS - k) * FADE_OUT) / STEPS
      ));
    }
    parts.push(...steps.filter((step): step is string => step !== null));
  }

  // --- the text itself ---------------------------------------------------
  const from = travelFrom(moment.animation);
  const centre = "((h-text_h)/2)";
  const y =
    from === null
      ? centre
      : `st(0,min(1,max(0,(t-${fixed(start)})/${TRAVEL})));` +
        `st(1,ld(0)*ld(0)*(3-2*ld(0)));` +
        // Smoothstep, so it settles rather than stopping dead.
        `(h*${from})+(${centre}-(h*${from}))*ld(1)`;

  const alpha =
    `min(1,min((t-${fixed(start)})/${FADE_IN},(${fixed(end)}-t)/${FADE_OUT}))`;

  const look = styleOf(moment.style);
  const font = fontFileFor(look.files);
  // Sizes are whole pixels, worked out from the output height here: drawtext
  // takes expressions for x, y and alpha, but `fontsize`, `borderw` and
  // `shadowy` are plain integers and reject one.
  const fontSize = Math.max(8, Math.round(height * moment.size));
  const border = look.rim > 0 ? Math.max(1, Math.round(height * look.rim)) : 0;
  const shadow = look.shadow > 0 ? Math.max(1, Math.round(height * look.shadow)) : 0;

  parts.push(
    [
      "drawtext=",
      font ? `fontfile='${font}':` : "",
      `text='${escapeDrawText(displayText(moment.text, moment.style))}'`,
      `:fontsize=${fontSize}`,
      `:fontcolor=0x${look.colour}`,
      // A dark rim keeps it legible over a bright frame without a solid box —
      // the styles that use a box instead ask for no rim.
      border > 0 ? `:borderw=${border}:bordercolor=black@${look.rimAlpha}` : "",
      shadow > 0 ? `:shadowx=0:shadowy=${shadow}:shadowcolor=black@${look.shadowAlpha}` : "",
      look.box
        ? `:box=1:boxcolor=black@${look.boxAlpha}:boxborderw=${Math.round(fontSize * 0.35)}`
        : "",
      ":x=(w-text_w)/2",
      `:y='${y}'`,
      `:alpha='${alpha}'`,
      `:enable='between(t,${fixed(start)},${fixed(end)})'`,
    ].join("")
  );

  return parts;
}

/**
 * Every moment that shows during a segment, rebased onto the segment's clock.
 *
 * A moment overlapping the segment at all is included, even if it started
 * before the segment did: the picture changing underneath must not interrupt
 * the text on top of it.
 */
export function overlayChain(
  moments: TextMoment[],
  segmentStart: number,
  segmentEnd: number,
  height: number
): string {
  const parts: string[] = [];
  for (const moment of moments) {
    const end = moment.start + moment.duration;
    if (end <= segmentStart || moment.start >= segmentEnd) continue;
    parts.push(...momentChain(moment, moment.start - segmentStart, height));
  }
  return parts.join(",");
}
