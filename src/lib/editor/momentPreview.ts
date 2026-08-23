import type { TextMoment } from "@/types/editor";

/**
 * The canvas equivalent of the drawtext chain in server/editor/textOverlay.ts.
 *
 * Kept deliberately in step with it: same fade-in and fade-out, same travel
 * time, same smoothstep easing, same rest position. A preview that puts the
 * text somewhere the export won't is worse than no preview, because it is
 * believed.
 */
const FADE_IN = 0.35;
const FADE_OUT = 0.45;
const TRAVEL = 0.55;

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
    const fade = clamp01(
      Math.min((time - moment.start) / FADE_IN, (end - time) / FADE_OUT)
    );
    if (fade <= 0) continue;

    context.save();

    const darken = Math.max(0, Math.min(0.8, moment.darken));
    if (darken > 0.001) {
      context.globalAlpha = darken * fade;
      context.fillStyle = "#000000";
      context.fillRect(0, 0, width, height);
    }

    const size = Math.max(8, height * moment.size);
    context.globalAlpha = fade;
    context.font = `700 ${size}px "Helvetica Neue", Arial, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";

    const from = travelFrom(moment.animation);
    const centre = height / 2;
    const y =
      from === null
        ? centre
        : height * from + (centre - height * from) * smoothstep(clamp01((time - moment.start) / TRAVEL));

    // Rim then fill, the same order drawtext composites them.
    context.lineWidth = Math.max(1, height / 360) * 2;
    context.strokeStyle = "rgba(0,0,0,0.75)";
    context.lineJoin = "round";
    context.strokeText(moment.text, width / 2, y);
    context.fillStyle = "#ffffff";
    context.fillText(moment.text, width / 2, y);

    context.restore();
  }
}
