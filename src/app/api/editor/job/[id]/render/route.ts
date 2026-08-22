import { NextResponse } from "next/server";
import { getJob, snapshot } from "@/server/editor/jobs";
import { renderJob } from "@/server/editor/render";
import {
  FPS_CHOICES,
  MAX_IMAGES,
  type ErrorResponse,
  type JobStatus,
  type RenderClip,
  type RenderRequest,
  type RenderSettings,
} from "@/types/editor";

function fail(error: string, status = 400) {
  return NextResponse.json<ErrorResponse>({ ok: false, error }, { status });
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

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
    clips.push({ file, start, end, zoom });
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
    audioFadeOut: clamp(Number(raw.audioFadeOut) || 0, 0, 30),
    fileName: "output.mp4",
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
    },
  };
}
