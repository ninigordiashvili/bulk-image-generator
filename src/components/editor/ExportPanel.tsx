"use client";

import { formatBytes, formatDuration } from "@/lib/editor/format";
import type { ExportState } from "@/store/editorStore";
import type { RenderSettings } from "@/types/editor";

interface Props {
  state: ExportState;
  settings: RenderSettings;
  fileName: string;
  clipCount: number;
  total: number;
  canExport: boolean;
  blocker: string | null;
  onFileName: (name: string) => void;
  onStart: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}

export function ExportPanel({
  state,
  settings,
  fileName,
  clipCount,
  total,
  canExport,
  blocker,
  onFileName,
  onStart,
  onCancel,
  onDismiss,
}: Props) {
  const busy = state.phase === "uploading" || state.phase === "rendering";
  const percent = progressPercent(state);

  return (
    <div className="panel space-y-3">
      <p className="panel-title">Export</p>

      <label className="block">
        <span className="text-xs text-muted">File name</span>
        <input
          type="text"
          className="field mt-1"
          value={fileName}
          disabled={busy}
          spellCheck={false}
          onChange={(event) => onFileName(event.target.value)}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (!value) onFileName("slideshow.mp4");
            else if (!value.toLowerCase().endsWith(".mp4")) onFileName(`${value}.mp4`);
          }}
        />
      </label>

      <p className="text-xs text-muted">
        {clipCount} clips · {formatDuration(total)} · {settings.width}×
        {settings.height} · {settings.fps} fps · H.264 MP4
      </p>

      {busy ? (
        <>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="text-xs text-foreground">
            {state.phase === "uploading"
              ? `Sending files — ${Math.round(state.uploadRatio * 100)}%`
              : (state.status?.message ?? "Rendering…")}
          </p>
          {state.status && state.status.elapsedMs > 0 && (
            <p className="text-[11px] text-muted">
              {Math.round(state.status.elapsedMs / 1000)}s elapsed
            </p>
          )}
          <button type="button" onClick={onCancel} className="btn-ghost w-full">
            Cancel
          </button>
        </>
      ) : state.phase === "done" && state.outputUrl ? (
        <>
          <video
            src={state.outputUrl}
            controls
            playsInline
            className="w-full rounded-lg border border-line bg-black"
          />
          <a
            href={`${state.outputUrl}&download=1`}
            download={fileName}
            className="btn-primary block text-center"
          >
            Download {formatBytes(state.outputBytes)}
          </a>
          <button type="button" onClick={onDismiss} className="btn-ghost w-full">
            Render again
          </button>
          <p className="text-[11px] text-muted">
            Rendered in {Math.round((state.status?.elapsedMs ?? 0) / 1000)}s. The
            file stays on the server for six hours — download it before then.
          </p>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={onStart}
            disabled={!canExport}
            className="btn-primary w-full"
          >
            Export MP4
          </button>
          {blocker && <p className="text-xs text-muted">{blocker}</p>}
          {state.phase === "error" && state.error && (
            <p className="rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
              {state.error}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Upload and render are wildly different lengths, so a single bar has to
 * apportion them. Sending the images is a small fraction of the wall clock on
 * a local server, and the render is nearly all of it.
 */
function progressPercent(state: ExportState): number {
  if (state.phase === "uploading") return state.uploadRatio * 10;
  if (state.phase !== "rendering" || !state.status) return 10;

  const { done, total, phase } = state.status;
  if (phase === "muxing") return 95;
  if (phase === "preparing" || total === 0) return 12;
  return 12 + (done / total) * 80;
}
