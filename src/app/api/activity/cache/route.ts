import { listJobs } from "@/server/editor/jobs";
import { SegmentCache } from "@/server/editor/segmentCache";

export const runtime = "nodejs";

export async function DELETE() {
  if (listJobs().some((job) => job.controller || ["preparing", "rendering", "muxing"].includes(job.status.phase))) {
    return Response.json({ ok: false, error: "A video export is active. Clear the render cache after it finishes." }, { status: 409 });
  }
  try {
    const result = await new SegmentCache().clear();
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Could not clear render cache." }, { status: 500 });
  }
}
