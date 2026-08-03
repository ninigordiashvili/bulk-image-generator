"use client";

import type { ZipProgress } from "@/lib/download";

export function DownloadProgress({ progress }: { progress: ZipProgress | null }) {
  if (!progress) return null;

  const percent =
    progress.phase === "zipping"
      ? progress.current
      : progress.total === 0
        ? 0
        : (progress.current / progress.total) * 100;

  const label =
    progress.phase === "packing"
      ? `Packing ${progress.current} / ${progress.total}`
      : progress.phase === "zipping"
        ? `Building ZIP — ${progress.current}%`
        : "Download started";

  return (
    <div className="fixed right-6 bottom-6 z-50 w-64 rounded-xl border border-line bg-surface p-4 shadow-2xl shadow-black/60">
      <p className="mb-2 text-xs text-foreground">{label}</p>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-2 text-[11px] text-muted">
        Encoded locally from memory — no network round-trip.
      </p>
    </div>
  );
}
