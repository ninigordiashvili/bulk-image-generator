"use client";
import Link from "next/link";
import type { WorkStatus } from "@/types/work";
export function durationLabel(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
export function WorkTiming({ status }: { status: WorkStatus | null }) {
  if (!status) return null;
  if (status.execution === "vertex-batch") return <div className="mt-2 text-xs text-muted">
    <p>{status.phase === "uploading" ? `Saving prompts and references ${status.uploaded}/${status.total}. Keep this page open until the upload finishes.` :
      `Vertex batch: ${(status.providerState ?? "Preparing").replace(/^JOB_STATE_/, "").replaceAll("_", " ").toLowerCase()} · ${durationLabel(status.elapsedMs)} elapsed. ${status.finishedAt ? "" : "Google schedules processing; the queue can take up to 72 hours. You can close this browser."}`}</p>
    {status.providerMessage && <p className="text-amber-400">{status.providerMessage}</p>}
    <Link className="text-accent underline" href={`/activity?batch=${status.id}`}>Open batch in Activity</Link>
  </div>;
  return <p className="mt-2 text-xs text-muted">
    {status.phase === "uploading" ? `Saving inputs ${status.uploaded}/${status.total}. Keep this page open until generation starts.` : <>
      Elapsed {durationLabel(status.elapsedMs)} · {status.finishedAt ? "Finished" : status.remainingMs === null ? "Estimating completion after the first result…" : <>
        About {durationLabel(status.remainingMs)} remaining · estimated finish {new Date(status.estimatedFinishAt!).toLocaleTimeString()}
      </>}. You can close this browser once generation has started.
    </>}{" "}<Link className="text-accent underline" href={`/activity?batch=${status.id}`}>Open batch in Activity</Link>
  </p>;
}
