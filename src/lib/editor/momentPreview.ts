import { displayText, styleOf } from "./textStyles";
import type { TextMoment } from "@/types/editor";

/**
 * The canvas equivalent of the drawtext chain in server/editor/textOverlay.ts.
 *
 * Kept deliberately in step with it: same fade-in and fade-out, same travel
 * time, same smoothstep easing, same rest position. A preview that puts the
 * text somewhere the export won't is worse than no preview, because it is
 * believed.
 */
const TRAVEL = 0.55;

/** Mirrors fadesOf in server/editor/textOverlay.ts; see the note there. */
function fadesOf(moment: TextMoment): { in: number; out: number } {
  const fadeIn = Math.max(0, moment.fadeIn ?? 0.35);
  const fadeOut = Math.max(0, moment.fadeOut ?? 0.45);
  const room = Math.max(0.02, moment.duration - 0.02);
  const scale = fadeIn + fadeOut > room ? room / (fadeIn + fadeOut) : 1;
  return { in: fadeIn * scale, out: fadeOut * scale };
}

const smoothstep = (p: number) => p * p * (3 - 2 * p);
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Where the text starts from, as a fraction of height, or null for "in place". */
function travelFrom(animation: TextMoment["animation"]): number | null {
  if (animation === "rise") return 0.7;
  if (animation === "drop") return 0.3;
  return null;
}

/** The moments showing at `time`, in the order they were added. */
export function momentsAt(moments: TextMoment[], time: number): TextMoment[] {
  return moments.filter(
    (moment) => time >= moment.start && time <= moment.start + moment.duration
  );
}

/**
 * Draws whatever is on screen at `time` over an already-painted frame.
 * Does nothing when no moment is showing, which is almost always.
 */
export function drawMoments(
  context: CanvasRenderingContext2D,
  moments: TextMoment[],
  time: number,
  width: number,
  height: number
): void {
  for (const moment of momentsAt(moments, time)) {
    if (!moment.text.trim()) continue;
    const end = moment.start + moment.duration;
    const ramp = fadesOf(moment);
    const fade = clamp01(
      Math.min(
        (time - moment.start) / Math.max(ramp.in, 0.001),
        (end - time) / Math.max(ramp.out, 0.001)
      )
    );
    if (fade <= 0) continue;

    context.save();

    const darken = Math.max(0, Math.min(0.8, moment.darken));
    if (darken > 0.001) {
      context.globalAlpha = darken * fade;
      context.fillStyle = "#000000";
      context.fillRect(0, 0, width, height);
    }

    const look = styleOf(moment.style);
    const words = displayText(moment.text, moment.style);
    const size = Math.max(8, height * moment.size);
    context.globalAlpha = fade;
    context.font = `${look.weight} ${size}px ${look.css}`;
    context.textAlign = "center";
    context.textBaseline = "middle";

    const from = travelFrom(moment.animation);
    const centre = height / 2;
    const y =
      from === null
        ? centre
        : height * from + (centre - height * from) * smoothstep(clamp01((time - moment.start) / TRAVEL));

    // The bar first, sized to the words, so the rest lands on top of it.
    if (look.box) {
      const pad = size * 0.35;
      const measured = context.measureText(words).width;
      context.fillStyle = `rgba(0,0,0,${look.boxAlpha})`;
      context.fillRect(
        width / 2 - measured / 2 - pad,
        y - size / 2 - pad,
        measured + pad * 2,
        size + pad * 2
      );
    }

    // Shadow, then rim, then fill — the order drawtext composites them.
    if (look.shadow > 0) {
      context.shadowColor = `rgba(0,0,0,${look.shadowAlpha})`;
      context.shadowOffsetY = Math.max(1, height * look.shadow);
      context.shadowBlur = size * 0.06;
    }
    if (look.rim > 0) {
      // Canvas strokes centred on the path, so half the width lands inside the
      // glyph; doubling matches drawtext's outward-only border.
      context.lineWidth = Math.max(1, height * look.rim) * 2;
      context.strokeStyle = `rgba(0,0,0,${look.rimAlpha})`;
      context.lineJoin = "round";
      context.strokeText(words, width / 2, y);
    }
    context.shadowColor = "transparent";
    context.shadowOffsetY = 0;
    context.shadowBlur = 0;
    context.fillStyle = `#${look.colour}`;
    context.fillText(words, width / 2, y);

    context.restore();
  }
}
