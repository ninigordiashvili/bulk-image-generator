import { startRetention } from "@/server/retention";
import { deleteWorkHistory, listWork } from "@/server/work";
import { deleteJobHistory, listJobs, snapshot } from "@/server/editor/jobs";
import type { ActivityEntry } from "@/types/work";
export const runtime = "nodejs";
export async function GET() {
  startRetention();
  const entries: ActivityEntry[] = (await listWork()).map(batch => ({
    id: batch.id, kind: batch.kind, label: `${batch.execution === "vertex-batch" ? "Batch images" : batch.kind === "image" ? "Images" : "Videos"} · ${batch.accountId}`,
    phase: batch.phase, done: batch.progress.completed, total: batch.total, elapsedMs: batch.elapsedMs,
    succeeded: batch.progress.succeeded, failed: batch.progress.failed,
    remainingMs: batch.remainingMs, createdAt: batch.createdAt, href: `/activity?batch=${batch.id}`, error: batch.error,
  }));
  for (const job of listJobs()) {
    const status = snapshot(job);
    const active = ["preparing", "rendering", "muxing"].includes(status.phase);
    entries.push({ id: job.id, kind: "render", label: "Video export", phase: status.phase,
      done: status.done, total: status.total, elapsedMs: status.elapsedMs,
      remainingMs: active && status.done > 0 && status.done < status.total ? Math.round(status.elapsedMs / status.done * (status.total - status.done)) : null,
      createdAt: job.startedAt, href: `/activity?render=${job.id}`, error: status.error ?? undefined,
      ...(status.phase === "done" ? { outputUrl: `/api/editor/job/${job.id}/output?download=1` } : {}),
    });
  }
  return Response.json({ ok: true, entries: entries.sort((a, b) => b.createdAt - a.createdAt) }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request) {
  const params = new URL(request.url).searchParams;
  const id = params.get("id");
  const kind = params.get("kind");
  if (!id || !["image", "video", "render"].includes(kind ?? "")) {
    return Response.json({ ok: false, error: "Select an Activity entry to delete." }, { status: 400 });
  }
  try {
    if (kind === "render") await deleteJobHistory(id);
    else await deleteWorkHistory(id);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Could not delete history." }, { status: 409 });
  }
}
