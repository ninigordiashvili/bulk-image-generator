import { NextResponse } from "next/server";
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

  const maxGap = clamp(Number(body.maxGap) || 1, 0.2, 10);
  // A pause can't be shortened to longer than the cap that flagged it.
  const keepGap = clamp(Number(body.keepGap) || 0.8, 0.05, maxGap);
  const options = {
    maxGap,
    keepGap,
    // Measured from the recording unless a number was sent deliberately. The
    // old default of -35 was the bug: a take whose room tone sat above it had
    // none of its pauses found at all.
    thresholdDb:
      body.thresholdDb === undefined || body.thresholdDb === null
        ? null
        : clamp(Number(body.thresholdDb), -80, -10),
    // Nor can the run-up be longer than the pause it has to fit inside.
    leadIn: clamp(
      body.leadIn === undefined ? 0.2 : Number(body.leadIn) || 0,
      0,
      keepGap
    ),
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
