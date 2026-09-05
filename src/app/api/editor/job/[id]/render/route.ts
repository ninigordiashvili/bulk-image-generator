import { NextResponse } from "next/server";
import { getJob, snapshot } from "@/server/editor/jobs";
import { renderJob } from "@/server/editor/render";
import {
  FPS_CHOICES,
  MAX_IMAGES,
  MAX_MOMENTS,
  MAX_SHAPES,
  MOMENT_ANIMATIONS,
  MOMENT_DEFAULTS,
  SHAPE_DEFAULTS,
  SHAPE_KINDS,
  type FilmLook,
  type ErrorResponse,
  type JobStatus,
  type RenderClip,
  type RenderRequest,
  type RenderSettings,
  type MomentAnimation,
  type ShapeElement,
  type ShapeKind,
  type TextMoment,
} from "@/types/editor";
import { STYLE_ORDER, type MomentStyle } from "@/lib/editor/textStyles";

const FILM_LOOKS: FilmLook[] = ["off", "subtle", "medium", "heavy"];

function fail(error: string, status = 400) {
  return NextResponse.json<ErrorResponse>({ ok: false, error }, { status });
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/**
 * A 0-to-1 field that is allowed to be absent, and means something different
 * when it is: a missing `x` centres the text, a missing `backdropHeight` lets
 * the plate keep its own aspect. So a non-number stays `undefined` rather than
 * being coerced to 0, which every one of those fields would read as a value.
 */
const fraction = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, 0, 1) : undefined;
};

/**
 * Starts the render and returns immediately. A ten-minute export takes over a
 * minute of wall clock, which is far longer than anything should hold a request
 * open for, so the client polls the job's status instead.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/editor/job/[id]/render">
) {
  const { id } = await context.params;
  const job = getJob(id);
  if (!job) return fail("No such editing session — reload the page.", 404);
  if (job.controller) return fail("This session is already rendering.", 409);

  let body: RenderRequest;
  try {
    body = (await request.json()) as RenderRequest;
  } catch {
    return fail("Malformed render request.");
  }

  const validated = validate(body);
  if ("error" in validated) return fail(validated.error);

  // Deliberately not awaited: the render outlives this request, and its
  // progress is read back through GET /api/editor/job/[id].
  void renderJob(job, validated.request);

  return NextResponse.json<{ ok: true; status: JobStatus }>({
    ok: true,
    status: snapshot(job),
  });
}

function validate(
  body: RenderRequest
): { request: RenderRequest } | { error: string } {
  if (!Array.isArray(body?.clips) || body.clips.length === 0) {
    return { error: "The timeline is empty." };
  }
  if (body.clips.length > MAX_IMAGES + 1) {
    return { error: `Too many clips — the limit is ${MAX_IMAGES} images.` };
  }

  const clips: RenderClip[] = [];
  let previousEnd = -1;

  for (const [index, clip] of body.clips.entries()) {
    const start = Number(clip?.start);
    const end = Number(clip?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) {
      return { error: `Clip ${index + 1} has an impossible time range.` };
    }
    if (start < previousEnd) {
      return { error: `Clip ${index + 1} starts before the previous one ends.` };
    }
    previousEnd = end;

    const file = clip.file === null ? null : String(clip.file);
    const zoom =
      clip.zoom === "in" || clip.zoom === "out" || clip.zoom === "none"
        ? clip.zoom
        : "none";
    const kind =
      clip.kind === "avatar" || clip.kind === "motion" ? clip.kind : "still";
    const sourceSeconds = Number(clip.sourceSeconds);
    clips.push({
      file,
      kind,
      start,
      end,
      // Belt to the client's braces: a talking clip never zooms and never
      // wears the film look, whatever the request claims.
      zoom: kind === "avatar" ? "none" : zoom,
      film: kind === "avatar" ? false : Boolean(clip.film),
      sourceSeconds: Number.isFinite(sourceSeconds) && sourceSeconds > 0 ? sourceSeconds : undefined,
    });
  }

  const raw = body.settings ?? ({} as RenderSettings);
  const fps = FPS_CHOICES.includes(Number(raw.fps) as (typeof FPS_CHOICES)[number])
    ? Number(raw.fps)
    : 30;

  const settings: RenderSettings = {
    // Even dimensions are a hard requirement of H.264's chroma subsampling.
    width: clamp(Math.round(Number(raw.width) / 2) * 2 || 1920, 256, 3840),
    height: clamp(Math.round(Number(raw.height) / 2) * 2 || 1080, 144, 2160),
    fps,
    encoder: raw.encoder === "h264_videotoolbox" ? "h264_videotoolbox" : "libx264",
    zoomAmount: clamp(Number(raw.zoomAmount) || 0, 0, 0.5),
    zoomAmountMotion: clamp(Number(raw.zoomAmountMotion) || 0, 0, 0.5),
    audioFadeOut: clamp(Number(raw.audioFadeOut) || 0, 0, 30),
    fileName: "output.mp4",
    film: FILM_LOOKS.includes(raw.film as FilmLook) ? (raw.film as FilmLook) : "off",
    effectsOnStills: raw.effectsOnStills !== false,
    effectsOnMotion: raw.effectsOnMotion !== false,
    minVisualSeconds: clamp(Number(raw.minVisualSeconds) || 2, 0.2, 30),
    maxStretch: clamp(Number(raw.maxStretch) || 2.5, 1, 6),
  };

  const total = Number(body.total);
  if (!Number.isFinite(total) || total <= 0) {
    return { error: "The timeline has no duration." };
  }

  return {
    request: {
      clips,
      audio: body.audio ? String(body.audio) : null,
      total,
      settings,
      moments: validateMoments(body.moments),
      shapes: validateShapes(body.shapes),
    },
  };
}

/**
 * The shape elements, rebuilt field by field like everything else in here.
 *
 * A shape with no `image` is dropped rather than defaulted: the plate is the
 * shape — there is nothing to draw without it — so one that arrives unreferenced
 * means an upload did not happen, and silently rendering nothing at all is the
 * failure this function exists to avoid repeating.
 */
function validateShapes(raw: unknown): ShapeElement[] {
  if (!Array.isArray(raw)) return [];
  const shapes: ShapeElement[] = [];

  for (const entry of raw.slice(0, MAX_SHAPES)) {
    const image = entry?.image ? String(entry.image) : "";
    if (!image) continue;
    const start = Number(entry?.start);
    const duration = Number(entry?.duration);
    if (!Number.isFinite(start) || start < 0) continue;
    if (!Number.isFinite(duration) || duration <= 0) continue;

    shapes.push({
      id: String(entry?.id ?? `s${shapes.length}`),
      kind: SHAPE_KINDS.includes(entry?.kind as ShapeKind)
        ? (entry.kind as ShapeKind)
        : "rect",
      image,
      start,
      duration: clamp(duration, 0.2, 600),
      // Geometry is carried for completeness and for anything that reads a
      // request back; the renderer does not consult it. The plate was painted
      // at the export's own size with all of this already applied — see
      // server/editor/shapeOverlay.ts.
      x: fraction(entry?.x) ?? SHAPE_DEFAULTS.x,
      y: fraction(entry?.y) ?? SHAPE_DEFAULTS.y,
      width: fraction(entry?.width) ?? SHAPE_DEFAULTS.width,
      height: fraction(entry?.height) ?? SHAPE_DEFAULTS.height,
      rotation: Number.isFinite(Number(entry?.rotation)) ? Number(entry.rotation) : 0,
      colour: /^#[0-9a-f]{6}$/i.test(String(entry?.colour ?? ""))
        ? String(entry.colour)
        : SHAPE_DEFAULTS.colour,
      opacity: fraction(entry?.opacity) ?? 1,
      stroke: fraction(entry?.stroke) ?? 0,
      fadeIn: clamp(Number(entry?.fadeIn ?? SHAPE_DEFAULTS.fadeIn), 0, 5),
      fadeOut: clamp(Number(entry?.fadeOut ?? SHAPE_DEFAULTS.fadeOut), 0, 5),
    });
  }

  return shapes.sort((a, b) => a.start - b.start);
}

/**
 * The text moments, checked one field at a time.
 *
 * This is rebuilt rather than passed through because every other part of the
 * request is — and forgetting it here is precisely how the feature came to be
 * drawn in the preview and absent from every export: the preview reads the
 * store, the render reads this.
 */
function validateMoments(raw: unknown): TextMoment[] {
  if (!Array.isArray(raw)) return [];
  const moments: TextMoment[] = [];

  for (const entry of raw.slice(0, MAX_MOMENTS)) {
    const text = String(entry?.text ?? "").trim();
    if (!text) continue;
    const start = Number(entry?.start);
    const duration = Number(entry?.duration);
    if (!Number.isFinite(start) || start < 0) continue;
    if (!Number.isFinite(duration) || duration <= 0) continue;

    moments.push({
      id: String(entry?.id ?? `m${moments.length}`),
      text,
      start,
      duration: clamp(duration, 0.2, 60),
      animation: MOMENT_ANIMATIONS.includes(entry?.animation as MomentAnimation)
        ? (entry.animation as MomentAnimation)
        : "rise",
      style: STYLE_ORDER.includes(entry?.style as MomentStyle)
        ? (entry.style as MomentStyle)
        : "modern",
      darken: clamp(Number(entry?.darken) || 0, 0, 0.9),
      size: clamp(Number(entry?.size) || MOMENT_DEFAULTS.size, 0.02, 0.5),
      fadeIn: clamp(Number(entry?.fadeIn ?? MOMENT_DEFAULTS.fadeIn), 0, 5),
      fadeOut: clamp(Number(entry?.fadeOut ?? MOMENT_DEFAULTS.fadeOut), 0, 5),
      // Left out once already, which is what made dragging and the backdrop
      // plate preview-only features: the renderer reads them, but they never
      // survived this function to reach it. `undefined` rather than a default,
      // because absent means "centred" and "no plate" downstream — writing 0.5
      // in here would be the same answer, but writing 0 for a height would not.
      x: fraction(entry?.x),
      y: fraction(entry?.y),
      backdropImage: entry?.backdropImage ? String(entry.backdropImage) : undefined,
      backdropHeight: fraction(entry?.backdropHeight),
      backdropOpacity: fraction(entry?.backdropOpacity),
    });
  }

  return moments.sort((a, b) => a.start - b.start);
}
