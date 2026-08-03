"use client";

import { useState } from "react";
import { useGenerationStore } from "@/store/generationStore";
import type { JobStatus } from "@/types";

const STATUS_META: Record<JobStatus, { icon: string; className: string }> = {
  queued: { icon: "○", className: "text-muted" },
  generating: { icon: "◐", className: "text-accent animate-pulse" },
  retrying: { icon: "↻", className: "text-amber-400" },
  success: { icon: "✓", className: "text-emerald-400" },
  error: { icon: "✕", className: "text-red-400" },
  cancelled: { icon: "–", className: "text-muted" },
};

export function QueuePanel() {
  const jobs = useGenerationStore((state) => state.jobs);
  const retryJob = useGenerationStore((state) => state.retryJob);
  const retryFailedJobs = useGenerationStore((state) => state.retryFailedJobs);
  const haltReason = useGenerationStore((state) => state.haltReason);
  const [filter, setFilter] = useState<"all" | "error">("all");

  if (jobs.length === 0) return null;

  const errorCount = jobs.filter((job) => job.status === "error").length;
  const unfinished = jobs.filter(
    (job) => job.status === "error" || job.status === "cancelled"
  ).length;
  const visible = filter === "all" ? jobs : jobs.filter((job) => job.status === "error");

  return (
    <section className="panel">
      {haltReason && (
        <div className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2.5">
          <p className="text-xs font-semibold text-red-300">
            Batch stopped — this failure affects every job
          </p>
          <p className="mt-1 text-[11px] leading-relaxed break-words text-red-200/90">
            {haltReason}
          </p>
          <p className="mt-1.5 text-[11px] text-muted">
            Remaining jobs were cancelled rather than run into the same wall. Fix
            the cause, then use “Retry all failed”.
          </p>
        </div>
      )}

      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="panel-title mb-0">Queue</h2>
        <div className="flex gap-2">
          {unfinished > 0 && (
            <button
              type="button"
              className="pill py-1 text-xs"
              onClick={retryFailedJobs}
            >
              Retry all failed {unfinished}
            </button>
          )}
          <button
            type="button"
            className={`pill py-1 text-xs ${filter === "all" ? "pill-active" : ""}`}
            onClick={() => setFilter("all")}
          >
            All {jobs.length}
          </button>
          <button
            type="button"
            className={`pill py-1 text-xs ${filter === "error" ? "pill-active" : ""}`}
            onClick={() => setFilter("error")}
            disabled={errorCount === 0}
          >
            Failed {errorCount}
          </button>
        </div>
      </div>

      <ul className="max-h-80 space-y-1 overflow-y-auto pr-1">
        {visible.map((job) => {
          const meta = STATUS_META[job.status];
          return (
            <li
              key={job.id}
              className="flex items-start gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs"
            >
              <span className={`mt-0.5 w-4 shrink-0 text-center ${meta.className}`}>
                {meta.icon}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-foreground">{job.prompt}</span>
                  {job.referencedCharacterIds.length > 0 && (
                    <span className="shrink-0 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent">
                      {job.referencedCharacterIds.map((id) => `@${id}`).join(" ")}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
                  <span>
                    #{job.promptIndex + 1}·{job.copyIndex + 1}
                  </span>
                  <span>{job.status}</span>
                  {job.attempts > 0 && <span>{job.attempts} retries</span>}
                  {job.terminal && (
                    <span className="text-red-400">
                      not retried — fix the cause first
                    </span>
                  )}
                  {job.resolutionMismatch && (
                    <span className="text-amber-400">resolution mismatch</span>
                  )}
                </div>
                {job.error && (
                  <p className="mt-1 break-words text-[11px] text-red-400">
                    {job.error}
                  </p>
                )}
              </div>

              {(job.status === "error" || job.status === "cancelled") && (
                <button
                  type="button"
                  className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] text-muted transition hover:border-accent hover:text-foreground"
                  onClick={() => retryJob(job.id)}
                >
                  Retry
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
