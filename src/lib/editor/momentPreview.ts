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

/**
 * How far the text travels before settling, as a fraction of height, signed:
 * positive starts below the rest position and moves up. Null is "in place".
 *
 * Relative to where the text rests rather than absolute, which matters now that
 * it can rest anywhere. Rising used to mean "start at 0.7 and stop at 0.5"; if
 * the text is dragged to 0.85 that would have it starting *above* its rest and
 * travelling down, which is not a rise. The old numbers are this offset applied
 * at the centre, so nothing moves for a moment that was never dragged.
 */
function travelOffset(animation: TextMoment["animation"]): number | null {
  if (animation === "rise") return 0.2;
  if (animation === "drop") return -0.2;
  return null;
}

/** Where a moment rests, defaulting to the centre for anything never dragged. */
export function restOf(moment: TextMoment): { x: number; y: number } {
  return { x: moment.x ?? 0.5, y: moment.y ?? 0.5 };
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
  height: number,
  /** Loaded plates by `backdropId`. Missing ones simply don't draw. */
  backdrops?: Map<string, CanvasImageSource>
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

    // The attached plate. Drawn after the flat dim and before the text, which
    // is the order the export composites them — see server/editor/textOverlay.ts,
    // where the same three go base, overlay, drawtext.
    const plate = moment.backdropId ? backdrops?.get(moment.backdropId) : undefined;
    if (plate) {
      // Full width, sat against the bottom edge — matching `overlay=y=H-h`. The
      // height either follows the setting or the plate's own aspect, the same
      // choice the export makes with `scale=W:h or -2`.
      const natural =
        "naturalHeight" in plate
          ? { w: plate.naturalWidth, h: plate.naturalHeight }
          : { w: width, h: height };
      const band = moment.backdropHeight;
      const drawnHeight =
        band && band > 0.001
          ? height * Math.min(1, band)
          : (width * natural.h) / Math.max(1, natural.w);
      context.globalAlpha = fade * Math.max(0, Math.min(1, moment.backdropOpacity ?? 1));
      context.drawImage(plate, 0, height - drawnHeight, width, drawnHeight);
    }

    const look = styleOf(moment.style);
    const words = displayText(moment.text, moment.style);
    const size = Math.max(8, height * moment.size);
    context.globalAlpha = fade;
    context.font = `${look.weight} ${size}px ${look.css}`;
    context.textAlign = "center";
    context.textBaseline = "middle";

    const rest = restOf(moment);
    const restX = width * rest.x;
    const restY = height * rest.y;
    const offset = travelOffset(moment.animation);
    const y =
      offset === null
        ? restY
        : restY +
          height * offset * (1 - smoothstep(clamp01((time - moment.start) / TRAVEL)));

    // The bar first, sized to the words, so the rest lands on top of it.
    if (look.box) {
      const pad = size * 0.35;
      const measured = context.measureText(words).width;
      context.fillStyle = `rgba(0,0,0,${look.boxAlpha})`;
      context.fillRect(
        restX - measured / 2 - pad,
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
      context.strokeText(words, restX, y);
    }
    context.shadowColor = "transparent";
    context.shadowOffsetY = 0;
    context.shadowBlur = 0;
    context.fillStyle = `#${look.colour}`;
    context.fillText(words, restX, y);

    context.restore();
  }
}
