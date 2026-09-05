"use client";

import { rampOf } from "./momentPreview";
import type { ShapeElement, ShapeKind } from "@/types/editor";

/**
 * Drawing the shape elements — for the preview, and for the export.
 *
 * Both come out of `paintShape` below. That is the point of the file: the
 * preview canvas and the PNG the renderer overlays are painted by the same
 * code at different sizes, so a shape cannot land somewhere in the export that
 * it did not land in the preview. Nothing about position, rotation or size is
 * recomputed on the server — see the note on `ShapeElement`.
 */

/** The arrow, in a unit box centred on the origin, pointing right at 0°. */
const ARROW: [number, number][] = [
  [-0.5, -0.15],
  [0.15, -0.15],
  [0.15, -0.5],
  [0.5, 0],
  [0.15, 0.5],
  [0.15, 0.15],
  [-0.5, 0.15],
];

/**
 * Paints one shape at full strength. `alpha` is the caller's business: the
 * preview passes the fade, the rasteriser passes 1 and lets ffmpeg ramp it.
 */
export function paintShape(
  context: CanvasRenderingContext2D,
  shape: ShapeElement,
  frameWidth: number,
  frameHeight: number,
  alpha: number
): void {
  const w = Math.max(1, frameWidth * shape.width);
  const h = Math.max(1, frameHeight * shape.height);

  context.save();
  context.globalAlpha = Math.max(0, Math.min(1, alpha));
  context.translate(frameWidth * shape.x, frameHeight * shape.y);
  context.rotate((shape.rotation * Math.PI) / 180);

  // Stroke width is a fraction of frame height for the same reason every other
  // size here is: a 4px outline drawn against a 960-wide preview is a hairline
  // in a 4K export.
  const line = shape.stroke > 0 ? Math.max(1, frameHeight * shape.stroke) : 0;
  context.lineWidth = line;
  context.strokeStyle = shape.colour;
  context.fillStyle = shape.colour;
  context.lineJoin = "round";

  context.beginPath();
  if (shape.kind === "circle") {
    // Inset by half the stroke, so an outlined shape stays inside the size it
    // was given rather than growing by its own line width.
    context.ellipse(0, 0, Math.max(0.5, w / 2 - line / 2), Math.max(0.5, h / 2 - line / 2), 0, 0, Math.PI * 2);
  } else if (shape.kind === "arrow") {
    ARROW.forEach(([px, py], index) => {
      const point: [number, number] = [px * w, py * h];
      if (index === 0) context.moveTo(...point);
      else context.lineTo(...point);
    });
    context.closePath();
  } else {
    context.rect(-w / 2 + line / 2, -h / 2 + line / 2, Math.max(1, w - line), Math.max(1, h - line));
  }

  if (line > 0) context.stroke();
  else context.fill();

  context.restore();
}

/** The shapes showing at `time`. */
export function shapesAt(shapes: ShapeElement[], time: number): ShapeElement[] {
  return shapes.filter(
    (shape) => time >= shape.start && time <= shape.start + shape.duration
  );
}

/** How visible a shape is at `time`, fade and its own opacity together. */
export function shapeAlpha(shape: ShapeElement, time: number): number {
  const end = shape.start + shape.duration;
  const ramp = rampOf(shape.fadeIn, shape.fadeOut, shape.duration);
  const fade = Math.max(
    0,
    Math.min(
      1,
      Math.min(
        (time - shape.start) / Math.max(ramp.in, 0.001),
        (end - time) / Math.max(ramp.out, 0.001)
      )
    )
  );
  return fade * Math.max(0, Math.min(1, shape.opacity));
}

/** Draws everything showing at `time`, in the order the shapes were added. */
export function drawShapes(
  context: CanvasRenderingContext2D,
  shapes: ShapeElement[],
  time: number,
  width: number,
  height: number
): void {
  for (const shape of shapesAt(shapes, time)) {
    const alpha = shapeAlpha(shape, time);
    if (alpha <= 0.001) continue;
    paintShape(context, shape, width, height, alpha);
  }
}

/**
 * Whether a point in frame fractions is inside a shape.
 *
 * The shape's own box, rotated — not its outline. Grabbing a circle by the
 * corner of the square around it is close enough to what was meant, and an
 * exact test would make a thin arrow almost impossible to pick up.
 */
export function hitShape(shape: ShapeElement, x: number, y: number): boolean {
  const dx = x - shape.x;
  const dy = y - shape.y;
  const angle = (-shape.rotation * Math.PI) / 180;
  const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
  const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
  // A generous minimum, so a shape scaled down small can still be grabbed.
  const halfW = Math.max(shape.width, 0.03) / 2;
  const halfH = Math.max(shape.height, 0.03) / 2;
  return Math.abs(localX) <= halfW && Math.abs(localY) <= halfH;
}

/** The topmost shape under a point at `time`, or null. */
export function shapeUnder(
  shapes: ShapeElement[],
  time: number,
  x: number,
  y: number
): ShapeElement | null {
  const showing = shapesAt(shapes, time);
  // Backwards: the last one drawn is the one on top, so it is the one grabbed.
  for (let i = showing.length - 1; i >= 0; i--) {
    if (hitShape(showing[i], x, y)) return showing[i];
  }
  return null;
}

/**
 * The shape as a frame-sized transparent PNG, ready to be uploaded and
 * overlaid at 0,0.
 *
 * Painted at full alpha: the fade and the opacity are applied by the renderer,
 * exactly as they are for a backdrop plate, so a shape that is half-faded in
 * the preview is half-faded by the same arithmetic in the export rather than
 * by two different ones.
 */
export async function rasteriseShape(
  shape: ShapeElement,
  width: number,
  height: number
): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser would not give the editor a canvas.");

  paintShape(context, shape, width, height, 1);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png")
  );
  if (!blob) throw new Error("The browser could not encode a shape.");

  // The name is what the renderer refers to it by, and `.png` is what keeps the
  // alpha channel through the upload — a jpeg would arrive with the transparent
  // frame filled in black.
  return new File([blob], `shape-${shape.id}.png`, { type: "image/png" });
}

export const SHAPE_LABELS: Record<ShapeKind, string> = {
  rect: "Rectangle",
  circle: "Circle",
  arrow: "Arrow",
};
