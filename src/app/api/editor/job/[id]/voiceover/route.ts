import { NextResponse } from "next/server";
import { clampPacing } from "@/lib/editor/pacing";
import { NO_RENDER_REASON, canRender } from "@/server/editor/host";
import { getJob } from "@/server/editor/jobs";
import { joinVoiceovers } from "@/server/editor/voiceover";
import type { ErrorResponse, PaceResponse } from "@/types/editor";

/** Joining seventeen minutes of audio is quick, but not instant. */
export const maxDuration = 300;

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

function fail(error: string, status = 400) {
  return NextResponse.json<ErrorResponse>({ ok: false, error }, { status });
}

/**
 * Joins the uploaded voice tracks into one narration bed and shortens any pause
 * longer than the cap. Runs to completion in the request: unlike a render this
 * is seconds of work, and the client has nothing useful to do until it lands.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/editor/job/[id]/voiceover">
) {
  if (!canRender()) return fail(NO_RENDER_REASON, 501);

  const { id } = await context.params;
  const job = getJob(id);
  if (!job) return fail("No such editing session — reload the page.", 404);
  if (job.controller) return fail("This session is busy rendering.", 409);

  let body: {
    files?: unknown;
    maxGap?: unknown;
    keepGap?: unknown;
    thresholdDb?: unknown;
    leadIn?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return fail("Malformed request.");
  }

  const files = Array.isArray(body.files) ? body.files.map(String) : [];
  if (files.length === 0) return fail("No voice tracks were named.");
  if (files.length > 100) return fail("That's more tracks than this will join at once.");

  // The cap, what a capped pause becomes and how the kept time is split — each
  // held to its floor and to the others. The floors are shared with the sliders
  // so the numbers on screen are the numbers that get used.
  const pacing = clampPacing({
    maxGap: Number(body.maxGap),
    keepGap: Number(body.keepGap),
    leadIn: body.leadIn === undefined ? Number.NaN : Number(body.leadIn),
  });
  const options = {
    ...pacing,
    // Measured from the recording unless a number was sent deliberately. The
    // old default of -35 was the bug: a take whose room tone sat above it had
    // none of its pauses found at all.
    thresholdDb:
      body.thresholdDb === undefined || body.thresholdDb === null
        ? null
        : clamp(Number(body.thresholdDb), -80, -10),
  };

  try {
    // Joined in the order given. The client sorts by the names the user chose;
    // the stored names only record what arrived first.
    const report = await joinVoiceovers(job, files, options, request.signal);
    return NextResponse.json<PaceResponse>({ ok: true, report });
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "Could not join those tracks.",
      500
    );
  }
}
