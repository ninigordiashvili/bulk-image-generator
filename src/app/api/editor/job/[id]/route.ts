import { NextResponse } from "next/server";
import { cancelJob, discardJob, getJob, snapshot } from "@/server/editor/jobs";
import type { ErrorResponse, JobStatus } from "@/types/editor";

/** Polled by the editor while a render runs. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/editor/job/[id]">
) {
  const { id } = await context.params;
  const job = getJob(id);
  if (!job) {
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: "No such editing session — reload the page." },
      { status: 404 }
    );
  }
  return NextResponse.json<{ ok: true; status: JobStatus }>(
    { ok: true, status: snapshot(job) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * `?keep=1` stops a running render but leaves the uploads in place so the next
 * attempt doesn't have to send a hundred images again. Without it the whole
 * session is thrown away.
 */
export async function DELETE(
  request: Request,
  context: RouteContext<"/api/editor/job/[id]">
) {
  const { id } = await context.params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ ok: true });

  if (new URL(request.url).searchParams.get("keep") === "1") {
    cancelJob(job);
    return NextResponse.json({ ok: true, status: snapshot(job) });
  }

  await discardJob(id);
  return NextResponse.json({ ok: true });
}
