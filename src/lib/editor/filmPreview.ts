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
  flicker: {
    a1: number; p1: number;
    a2: number; p2: number;
    pulse: number; every: number; width: number;
  };
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
  subtle: { grainAlpha: 0.045, grainPasses: 1, tileScale: 1, vignette: 0.28, saturate: 0.9, contrast: 1.03,
    flicker: { a1: 0.004, p1: 12.7, a2: 0.003, p2: 7.3, pulse: 0.016, every: 9.1, width: 0.13 } },
  medium: { grainAlpha: 0.11, grainPasses: 1, tileScale: 1, vignette: 0.42, saturate: 0.76, contrast: 1.08,
    flicker: { a1: 0.006, p1: 11.3, a2: 0.004, p2: 6.7, pulse: 0.026, every: 7.3, width: 0.13 } },
  heavy: { grainAlpha: 0.2, grainPasses: 2, tileScale: 1.5, vignette: 0.56, saturate: 0.55, contrast: 1.14,
    flicker: { a1: 0.007, p1: 10.1, a2: 0.004, p2: 6.1, pulse: 0.040, every: 5.9, width: 0.14 } },
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

  // Flicker: a slow exposure drift with an occasional pulse riding on top.
  // This used to be two fast oscillators and it strobed — see the note on
  // filmChain in server/editor/render.ts, which this mirrors exactly so the
  // preview and the export show the same thing.
  const f = preset.flicker;
  const sincePulse = ((time % f.every) + f.every) % f.every;
  const flicker =
    1 +
    f.a1 * Math.sin((2 * Math.PI * time) / f.p1) +
    f.a2 * Math.sin((2 * Math.PI * time) / f.p2) +
    f.pulse * Math.exp(-(((sincePulse - f.every / 2) / f.width) ** 2));

  // No gate weave. A projector really does drift a pixel or two, but over a
  // slideshow it reads as camera shake rather than as film.
  const frame = Math.round(time * 24);

  context.save();
  context.filter = `saturate(${preset.saturate}) contrast(${preset.contrast}) brightness(${flicker.toFixed(4)})`;
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
