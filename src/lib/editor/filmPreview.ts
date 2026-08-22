"use client";

import type { FilmLook } from "@/types/editor";

/**
 * The old-film treatment, approximated on a canvas so the preview shows what
 * the export will do.
 *
 * It isn't the ffmpeg chain — it can't be, and doesn't need to be. What it has
 * to get right is the *decision*: whether a shot reads as filmic at this
 * strength, and whether the grain is too heavy over a given image. The render
 * remains the authority on exact pixels.
 *
 * Grain is pre-rendered into a few tiles and blitted at a random offset each
 * frame rather than generated per pixel. Generating a megapixel of noise in JS
 * sixty times a second would cost more than the whole rest of the preview.
 */

interface Preset {
  grainAlpha: number;
  /**
   * Alpha blending saturates, so past a point more opacity stops adding
   * variance. A second pass compounds it instead — which is the only way heavy
   * lands meaningfully coarser than medium rather than a fraction above it.
   */
  grainPasses: number;
  tileScale: number;
  vignette: number;
  weave: number;
  flicker: number;
  saturate: number;
  contrast: number;
}

/**
 * Grain strengths are calibrated against the render, not chosen by eye: the
 * ffmpeg chain's `noise=alls=` values work out around sigma 3.5 / 7.5 / 13 on
 * an eight-bit channel before the encoder smooths them. A preview grainier than
 * the export misleads exactly as much as one with no grain at all.
 */
const PRESETS: Record<Exclude<FilmLook, "off">, Preset> = {
  subtle: { grainAlpha: 0.045, grainPasses: 1, tileScale: 1, vignette: 0.28, weave: 1, flicker: 0.012, saturate: 0.9, contrast: 1.03 },
  medium: { grainAlpha: 0.11, grainPasses: 1, tileScale: 1, vignette: 0.42, weave: 2, flicker: 0.022, saturate: 0.76, contrast: 1.08 },
  heavy: { grainAlpha: 0.2, grainPasses: 2, tileScale: 1.5, vignette: 0.56, weave: 3, flicker: 0.038, saturate: 0.55, contrast: 1.14 },
};

const TILE = 256;
const TILE_COUNT = 5;

interface GrainTile {
  bright: HTMLCanvasElement;
  dark: HTMLCanvasElement;
}

let tiles: GrainTile[] | null = null;

/**
 * Noise tiles, cycled so the grain never visibly repeats.
 *
 * Split into a bright half and a dark half rather than one mid-grey tile
 * blended with `overlay`. Overlay leaves midtones alone and all but vanishes on
 * a dark image — which is precisely where film grain should be most visible.
 * Adding the bright half and subtracting the dark half approximates the signed,
 * additive noise ffmpeg applies, and stays visible whatever the picture.
 */
function grainTiles(): GrainTile[] {
  if (tiles) return tiles;
  tiles = Array.from({ length: TILE_COUNT }, () => {
    const make = (sign: 1 | -1) => {
      const canvas = document.createElement("canvas");
      canvas.width = TILE;
      canvas.height = TILE;
      const context = canvas.getContext("2d");
      if (!context) return canvas;
      const image = context.createImageData(TILE, TILE);
      const shade = sign > 0 ? 255 : 0;
      for (let i = 0; i < image.data.length; i += 4) {
        // Two draws from one noise field would need the field kept around;
        // independent fields look the same and cost nothing to hold.
        const noise = Math.random();
        image.data[i] = shade;
        image.data[i + 1] = shade;
        image.data[i + 2] = shade;
        image.data[i + 3] = Math.round(noise * noise * 255);
      }
      context.putImageData(image, 0, 0);
      return canvas;
    };
    return { bright: make(1), dark: make(-1) };
  });
  return tiles;
}

/**
 * Runs `paint` with the look applied around it: tone and weave going in, grain
 * and vignette coming out. `paint` draws the picture and nothing else.
 */
export function applyLook(
  context: CanvasRenderingContext2D,
  look: FilmLook,
  time: number,
  paint: () => void
): void {
  const width = context.canvas.width / (context.getTransform().a || 1);
  const height = context.canvas.height / (context.getTransform().d || 1);

  if (look === "off") {
    paint();
    return;
  }
  const preset = PRESETS[look];

  // Flicker, from two oscillators out of phase so it never settles into a
  // rhythm the eye can predict.
  const flicker =
    1 + preset.flicker * Math.sin(time * 13.1) + preset.flicker * 0.6 * Math.sin(time * 29.7);

  // Gate weave. Whole pixels on purpose: real weave is a mechanical judder,
  // not a glide, and rounding it is what makes it read as a projector.
  const frame = Math.round(time * 24);
  const weaveX = Math.round(preset.weave * Math.sin(frame * 0.7));
  const weaveY = Math.round(preset.weave * Math.cos(frame * 0.53));

  context.save();
  context.filter = `saturate(${preset.saturate}) contrast(${preset.contrast}) brightness(${flicker.toFixed(4)})`;
  context.translate(weaveX, weaveY);
  paint();
  context.restore();

  // Grain over the top, at an offset that moves every frame.
  const size = TILE * preset.tileScale;
  const offsetX = -((frame * 37) % size);
  const offsetY = -((frame * 61) % size);

  context.save();
  for (let pass = 0; pass < preset.grainPasses; pass++) {
    // A different tile per pass, or the second would reinforce the first
    // exactly and add nothing but brightness.
    const layerTile = grainTiles()[(frame + pass * 2) % TILE_COUNT];
    const shift = pass * 91;
    for (const [layer, mode] of [
      [layerTile.bright, "lighter"],
      [layerTile.dark, "source-over"],
    ] as const) {
      context.globalCompositeOperation = mode;
      context.globalAlpha = preset.grainAlpha;
      for (let y = offsetY - shift; y < height; y += size) {
        for (let x = offsetX - shift; x < width; x += size) {
          context.drawImage(layer, x, y, size, size);
        }
      }
    }
  }
  context.restore();

  // Vignette last, so the grain is darkened at the edges along with the image.
  const gradient = context.createRadialGradient(
    width / 2, height / 2, Math.min(width, height) * 0.25,
    width / 2, height / 2, Math.max(width, height) * 0.72
  );
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(1, `rgba(0,0,0,${preset.vignette})`);
  context.save();
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.restore();
}
