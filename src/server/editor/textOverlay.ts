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
/** How long the text takes to travel to the centre. */
const TRAVEL = 0.55;

/**
 * A fade can be set to zero, and can also be longer than the moment it belongs
 * to. Both ends are clamped so the two halves never overlap and the text is
 * always fully up for at least an instant.
 */
function fadesOf(moment: TextMoment): { in: number; out: number } {
  const fadeIn = Math.max(0, moment.fadeIn ?? 0.35);
  const fadeOut = Math.max(0, moment.fadeOut ?? 0.45);
  const room = Math.max(0.02, moment.duration - 0.02);
  const scale = fadeIn + fadeOut > room ? room / (fadeIn + fadeOut) : 1;
  return { in: fadeIn * scale, out: fadeOut * scale };
}

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

/**
 * How far the text travels before settling, as a fraction of height, signed:
 * positive starts below the rest position and moves up. Null arrives in place.
 *
 * An offset rather than an absolute point, because the text can now rest
 * anywhere. "Rise" used to mean start at 0.7 and stop at 0.5; text dragged to
 * 0.85 would then have started *above* its rest and moved down, which is not a
 * rise. These are the old numbers expressed as the distance they covered, so a
 * moment that was never dragged behaves exactly as before.
 *
 * Mirrors `travelOffset` in lib/editor/momentPreview.ts — the two must agree or
 * the preview shows the text somewhere the export will not put it.
 */
function travelOffset(animation: TextMoment["animation"]): number | null {
  if (animation === "rise") return 0.2;
  if (animation === "drop") return -0.2;
  return null;
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
  const fade = fadesOf(moment);
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
        start + ((k - 1) * fade.in) / STEPS,
        start + (k * fade.in) / STEPS
      ));
    }
    steps.push(box(darken, start + fade.in, end - fade.out));
    for (let k = STEPS - 1; k >= 1; k--) {
      steps.push(box(
        (darken * k) / STEPS,
        end - fade.out + ((STEPS - 1 - k) * fade.out) / STEPS,
        end - fade.out + ((STEPS - k) * fade.out) / STEPS
      ));
    }
    parts.push(...steps.filter((step): step is string => step !== null));
  }

  // --- the text itself ---------------------------------------------------
  // Fractions of the frame, so a position set against the preview lands in the
  // same place whatever the export size. Absent means centred, which is where
  // every moment sat before this was draggable.
  const restX = moment.x ?? 0.5;
  const restY = moment.y ?? 0.5;
  // `text_h` is only known inside drawtext, so the anchor is written as an
  // expression rather than a number: the fraction addresses the centre of the
  // text, and half its height comes back off here.
  const rest = `(h*${restY.toFixed(4)}-text_h/2)`;
  const offset = travelOffset(moment.animation);
  const y =
    offset === null
      ? rest
      : `st(0,min(1,max(0,(t-${fixed(start)})/${TRAVEL})));` +
        `st(1,ld(0)*ld(0)*(3-2*ld(0)));` +
        // Smoothstep, so it settles rather than stopping dead. The travel is an
        // offset from the rest position, not a fixed point, so it reads as a
        // rise wherever the text has been dragged to.
        `${rest}+(h*${offset.toFixed(4)})*(1-ld(1))`;

  // A zero fade would divide by zero; it becomes a single frame instead, which
  // is a snap to anyone watching.
  const alpha =
    `min(1,min((t-${fixed(start)})/${fixed(Math.max(fade.in, 0.001))},` +
    `(${fixed(end)}-t)/${fixed(Math.max(fade.out, 0.001))}))`;

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
      `:x=(w*${restX.toFixed(4)}-text_w/2)`,
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
/**
 * The backdrop overlays for the moments in a segment, as filter_complex links.
 *
 * Why an overlay rather than something drawn in the chain: `drawbox` cannot
 * make a gradient — its alpha takes no expression — and `geq` measured 139x
 * slower than the baseline encode, which would turn a sixteen-minute render
 * into a day. Overlaying a prepared image measured 0.02s over the same 120
 * frames, so the plate is supplied rather than generated.
 *
 * `inputs` maps a stored backdrop filename to the ffmpeg input index it was
 * added as. Moments sharing one plate share one input, split as many ways as
 * they need — a batch that uses the same gradient throughout decodes it once.
 *
 * Returns null when nothing in this segment has a backdrop, so the ordinary
 * single-chain path is left exactly as it was.
 */
export function scrimGraph(
  moments: TextMoment[],
  segmentStart: number,
  segmentEnd: number,
  inLabel: string,
  outLabel: string,
  inputs: Map<string, number>,
  frameWidth: number,
  frameHeight: number
): string | null {
  const wanted = moments
    .filter((moment) => moment.backdropImage && inputs.has(moment.backdropImage))
    .filter((moment) => {
      const end = moment.start + moment.duration;
      return end > segmentStart && moment.start < segmentEnd;
    })
    .map((moment) => ({ moment, start: moment.start - segmentStart }));

  if (wanted.length === 0) return null;

  const parts: string[] = [];

  // One split per input, sized to how many moments draw from it.
  const perInput = new Map<string, number>();
  for (const { moment } of wanted) {
    const key = moment.backdropImage!;
    perInput.set(key, (perInput.get(key) ?? 0) + 1);
  }
  const taken = new Map<string, number>();
  for (const [file, count] of perInput) {
    const index = inputs.get(file)!;
    const tags = Array.from({ length: count }, (_, k) => `[bd${index}_${k}]`).join("");
    parts.push(
      count === 1
        ? `[${index}:v]null${tags}`
        : `[${index}:v]split=${count}${tags}`
    );
    taken.set(file, 0);
  }

  let carry = inLabel;
  wanted.forEach(({ moment, start }, order) => {
    const file = moment.backdropImage!;
    const index = inputs.get(file)!;
    const nth = taken.get(file)!;
    taken.set(file, nth + 1);

    const fade = fadesOf(moment);
    const end = start + moment.duration;
    const height = moment.backdropHeight;
    const opacity = Math.max(0, Math.min(1, moment.backdropOpacity ?? 1));

    // Whole pixels, worked out from the output size here rather than left as an
    // expression: the plate is scaled once at init, and `scale` wants numbers.
    // Full width always — a backdrop that did not span the frame would show its
    // own edges against the picture.
    const bandPx =
      height && height > 0.001
        ? Math.max(2, Math.round(frameHeight * Math.min(1, height)))
        : null;

    const chain = [
      "format=rgba",
      // -2 keeps the plate's own aspect at an even height, which the encoder
      // needs; a stated height overrides it.
      `scale=${frameWidth}:${bandPx ?? -2}:flags=bicubic`,
      fade.in > 0.001
        ? `fade=t=in:st=${fixed(Math.max(0, start))}:d=${fixed(fade.in)}:alpha=1`
        : "",
      fade.out > 0.001
        ? `fade=t=out:st=${fixed(end - fade.out)}:d=${fixed(fade.out)}:alpha=1`
        : "",
      // `fade` ramps alpha to full; this scales the plate down to the opacity
      // asked for without flattening the gradient inside it.
      opacity < 0.999 ? `colorchannelmixer=aa=${opacity.toFixed(3)}` : "",
    ]
      .filter(Boolean)
      .join(",");

    const next = order === wanted.length - 1 ? outLabel : `bdl${order}`;
    parts.push(`[bd${index}_${nth}]${chain}[bds${order}]`);
    parts.push(
      `[${carry}][bds${order}]overlay=x=0:y=H-h:format=auto` +
        `:enable='between(t,${fixed(Math.max(0, start))},${fixed(end)})'[${next}]`
    );
    carry = next;
  });

  return parts.join(";");
}

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
