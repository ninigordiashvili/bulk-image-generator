import { rampOf } from "./textOverlay";
import type { ShapeElement } from "@/types/editor";

/**
 * Laying the shape elements over the picture.
 *
 * There is deliberately no geometry in this file. Each shape arrives as a
 * frame-sized transparent PNG that the browser painted at the export's own
 * resolution — the same canvas code that painted the preview — so the renderer
 * only has to composite it at 0,0. Nothing here can put a shape somewhere the
 * preview did not, because nothing here knows where the shape is.
 *
 * The alternative was drawing them with filters. `drawbox` covers a rectangle
 * and nothing else, and `geq` — the only general primitive — measured 139x
 * slower than the baseline encode when the backdrop plates were designed. The
 * same reasoning applies, so the same answer does.
 */

const fixed = (value: number) => value.toFixed(3);

/**
 * Filter links that overlay every shape showing during a segment.
 *
 * `inputs` maps a stored plate name to the ffmpeg input index it was added as,
 * shared with the backdrop plates so the two never collide. Returns null when
 * this segment has no shapes, leaving the simple path untouched.
 */
export function shapeGraph(
  shapes: ShapeElement[],
  segmentStart: number,
  segmentEnd: number,
  inLabel: string,
  outLabel: string,
  inputs: Map<string, number>,
  frameWidth: number,
  frameHeight: number
): string | null {
  const wanted = shapes
    .filter((shape) => shape.image && inputs.has(shape.image))
    .filter((shape) => {
      const end = shape.start + shape.duration;
      return end > segmentStart && shape.start < segmentEnd;
    })
    // Rebased onto the segment's own clock, which may put the start before zero
    // when a shape carries across a change of picture. That is correct: the
    // shape must not restart because the image under it did.
    .map((shape) => ({ shape, start: shape.start - segmentStart }));

  if (wanted.length === 0) return null;

  const parts: string[] = [];

  // A plate is normally used once, but two shapes pointing at one file would
  // read the same input twice, which ffmpeg refuses. Splitting costs nothing
  // when the count is one and rules the failure out entirely.
  const perInput = new Map<string, number>();
  for (const { shape } of wanted) {
    const key = shape.image!;
    perInput.set(key, (perInput.get(key) ?? 0) + 1);
  }
  const taken = new Map<string, number>();
  for (const [file, count] of perInput) {
    const index = inputs.get(file)!;
    const tags = Array.from({ length: count }, (_, k) => `[sh${index}_${k}]`).join("");
    parts.push(
      count === 1 ? `[${index}:v]null${tags}` : `[${index}:v]split=${count}${tags}`
    );
    taken.set(file, 0);
  }

  let carry = inLabel;
  wanted.forEach(({ shape, start }, order) => {
    const file = shape.image!;
    const index = inputs.get(file)!;
    const nth = taken.get(file)!;
    taken.set(file, nth + 1);

    const fade = rampOf(shape.fadeIn, shape.fadeOut, shape.duration);
    const end = start + shape.duration;
    const opacity = Math.max(0, Math.min(1, shape.opacity ?? 1));

    const chain = [
      "format=rgba",
      // A safety net rather than a resize: the plate was painted at exactly this
      // size. It costs nothing when the dimensions already match, and it stops a
      // stale plate — one rasterised before the export resolution was changed —
      // from landing at the wrong scale.
      `scale=${frameWidth}:${frameHeight}:flags=bicubic`,
      fade.in > 0.001
        ? `fade=t=in:st=${fixed(Math.max(0, start))}:d=${fixed(fade.in)}:alpha=1`
        : "",
      fade.out > 0.001
        ? `fade=t=out:st=${fixed(end - fade.out)}:d=${fixed(fade.out)}:alpha=1`
        : "",
      // After the fade, which ramps alpha back to the plate's own — the same
      // order the backdrop plates use, and the reason the preview multiplies
      // fade by opacity rather than baking one into the other.
      opacity < 0.999 ? `colorchannelmixer=aa=${opacity.toFixed(3)}` : "",
    ]
      .filter(Boolean)
      .join(",");

    const next = order === wanted.length - 1 ? outLabel : `shl${order}`;
    parts.push(`[sh${index}_${nth}]${chain}[shs${order}]`);
    parts.push(
      `[${carry}][shs${order}]overlay=x=0:y=0:format=auto` +
        `:enable='between(t,${fixed(Math.max(0, start))},${fixed(end)})'[${next}]`
    );
    carry = next;
  });

  return parts.join(";");
}

/** The shapes that touch a segment at all — what decides if it needs inputs. */
export function shapesInSegment(
  shapes: ShapeElement[],
  segmentStart: number,
  segmentEnd: number
): ShapeElement[] {
  return shapes.filter((shape) => {
    const end = shape.start + shape.duration;
    return end > segmentStart && shape.start < segmentEnd;
  });
}
