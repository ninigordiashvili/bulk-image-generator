"use client";

import Image from "next/image";
import { VIDEO_MODELS, videoModel } from "@/lib/videoModels";
import { creditsPerImage, formatCredits } from "@/lib/pricing";
import { useVideoStore } from "@/store/videoStore";
import type { GenerationJob, VideoShot } from "@/types";

const STATUS_META: Record<string, { icon: string; className: string }> = {
  queued: { icon: "○", className: "text-muted" },
  generating: { icon: "◐", className: "text-accent animate-pulse" },
  retrying: { icon: "↻", className: "text-amber-400" },
  success: { icon: "✓", className: "text-emerald-400" },
  error: { icon: "✕", className: "text-red-400" },
  cancelled: { icon: "–", className: "text-muted" },
};

export function VideoShotRow({
  shot,
  index,
  job,
  disabled,
}: {
  shot: VideoShot;
  index: number;
  job?: GenerationJob;
  disabled: boolean;
}) {
  const updateShot = useVideoStore((state) => state.updateShot);
  const removeShot = useVideoStore((state) => state.removeShot);
  const retryJob = useVideoStore((state) => state.retryJob);
  const creditRates = useVideoStore((state) => state.creditRates);

  const spec = videoModel(shot.model);
  const status = job ? STATUS_META[job.status] : undefined;
  const rate = creditsPerImage(
    shot.model,
    { duration: shot.duration, resolution: shot.resolution },
    creditRates
  );

  return (
    <li className="flex gap-3 rounded-lg border border-line bg-surface-2 p-3">
      <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-md bg-black/40">
        <Image
          src={`data:${shot.image.mimeType};base64,${shot.image.base64}`}
          alt={shot.image.name}
          fill
          unoptimized
          className="object-cover"
        />
        <span className="badge absolute top-1 left-1">{index + 1}</span>
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start gap-2">
          <textarea
            className="field h-16 flex-1 resize-y text-xs"
            placeholder={`Describe the motion for ${shot.image.name} — what moves, and how the camera behaves.`}
            value={shot.prompt}
            disabled={disabled}
            onChange={(event) =>
              updateShot(shot.id, { prompt: event.target.value })
            }
          />
          <button
            type="button"
            className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] text-muted transition hover:border-red-500 hover:text-red-400 disabled:opacity-40"
            disabled={disabled}
            onClick={() => removeShot(shot.id)}
            title="Remove this shot"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            Model
            <select
              className="field w-auto px-2 py-1 text-xs"
              value={shot.model}
              disabled={disabled}
              onChange={(event) => updateShot(shot.id, { model: event.target.value })}
            >
              {VIDEO_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>

          {/* Duration and resolution are per row, and their allowed values come
              from the row's own model — Veo tops out at 8s, Grok at 30s. */}
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            Duration
            <select
              className="field w-auto px-2 py-1 text-xs"
              value={shot.duration}
              disabled={disabled}
              onChange={(event) =>
                updateShot(shot.id, { duration: Number(event.target.value) })
              }
            >
              {spec.durations.map((duration) => (
                <option key={duration} value={duration}>
                  {duration}s
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-1.5 text-[11px] text-muted">
            Resolution
            <div className="flex gap-1">
              {spec.resolutions.map((resolution) => (
                <button
                  key={resolution}
                  type="button"
                  disabled={disabled}
                  onClick={() => updateShot(shot.id, { resolution })}
                  className={`pill px-2 py-0.5 text-[11px] ${
                    shot.resolution === resolution ? "pill-active" : ""
                  }`}
                >
                  {resolution}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            Ratio
            <select
              className="field w-auto px-2 py-1 text-xs"
              value={shot.aspectRatio}
              disabled={disabled}
              onChange={(event) =>
                updateShot(shot.id, { aspectRatio: event.target.value })
              }
            >
              {spec.aspectRatios.map((ratio) => (
                <option key={ratio} value={ratio}>
                  {ratio}
                </option>
              ))}
            </select>
          </label>

          {rate !== null && (
            <span className="text-[11px] text-muted">≈ {formatCredits(rate)}</span>
          )}
        </div>

        {job && status && (
          <div className="flex items-start gap-2 text-[11px]">
            <span className={status.className}>
              {status.icon} {job.status}
            </span>
            {job.attempts > 0 && (
              <span className="text-muted">{job.attempts} retries</span>
            )}
            {job.error && (
              <span className="min-w-0 flex-1 break-words text-red-400">
                {job.error}
              </span>
            )}
            {(job.status === "error" || job.status === "cancelled") && (
              <button
                type="button"
                className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] text-muted hover:border-accent hover:text-foreground"
                onClick={() => retryJob(job.id)}
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
