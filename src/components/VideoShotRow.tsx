"use client";
import { HeygenSettings } from "./HeygenSettings";
import { heygenEstimate } from "@/lib/heygen";


import Image from "next/image";
import { useState } from "react";
import { isAudioDriven, videoModel, videoModelsFor } from "@/lib/videoModels";
import { formatTime } from "@/lib/editor/format";
import { creditsPerImage, formatCredits } from "@/lib/pricing";
import { shotSize, useVideoStore } from "@/store/videoStore";
import type { GenerationJob, VideoShot } from "@/types";
import { AudioTrimmer } from "./AudioTrimmer";

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
  // The video tab's own account, not the image tab's.
  const provider = useVideoStore((state) => state.provider);
  const updateShot = useVideoStore((state) => state.updateShot);
  const removeShot = useVideoStore((state) => state.removeShot);
  const applyPromptToAll = useVideoStore((state) => state.applyPromptToAll);
  const shotCount = useVideoStore((state) => state.shots.length);
  const retryJob = useVideoStore((state) => state.retryJob);
  const creditRates = useVideoStore((state) => state.creditRates);
  const audioSources = useVideoStore((state) => state.audioSources);
  const setShotAudio = useVideoStore((state) => state.setShotAudio);

  const [trimming, setTrimming] = useState(false);

  const spec = videoModel(shot.model);
  const audioDriven = isAudioDriven(spec);
  const source = audioSources.find((entry) => entry.id === shot.audio?.sourceId);
  const status = job ? STATUS_META[job.status] : undefined;
  const rate = provider === "heygen" ? null : creditsPerImage(shot.model, shotSize(shot), creditRates);

  const promptControls = (
    <div className="flex items-start gap-2">
      <textarea
        aria-label="Motion prompt"
        className="field h-16 flex-1 resize-y text-xs"
        placeholder={audioDriven ? "Optional motion direction; the voice track drives the performance." : "Describe the motion and camera behavior for this scene."}
        value={shot.prompt}
        disabled={disabled || shot.model === "heygen:avatar_iii" || (shot.model === "heygen:avatar_iv" && shot.heygen?.source === "avatar" && !!shot.heygen.avatarType && shot.heygen.avatarType !== "photo_avatar")}
        onChange={event => updateShot(shot.id, { prompt: event.target.value })}
      />
      <button type="button" className="btn-ghost text-xs" disabled={disabled || shotCount < 2 || !shot.prompt.trim()} onClick={() => applyPromptToAll(shot.prompt)} title="Give all rows this prompt">Apply prompt to all</button>
    </div>
  );

  return (
    <li className="flex gap-3 rounded-lg border border-line bg-surface-2 p-3">
      <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-md bg-black/40">
        {shot.image ? <Image
          src={`data:${shot.image.mimeType};base64,${shot.image.base64}`}
          alt={shot.image.name}
          fill
          unoptimized
          className="object-cover"
        /> : <span className="flex h-full items-center justify-center text-xs text-muted">{provider === "heygen" ? "HeyGen avatar" : "Text to video"}</span>}
        <span className="badge absolute top-1 left-1">{index + 1}</span>
      </div>

      <div className="min-w-0 flex-1 space-y-2">

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button type="button" className="btn-ghost text-xs" disabled={disabled} onClick={() => removeShot(shot.id)} title="Remove this shot" aria-label="Remove this shot">&#215;</button>
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            Model
            <select
              className="field w-auto px-2 py-1 text-xs"
              value={shot.model}
              disabled={disabled}
              onChange={(event) => updateShot(shot.id, { model: event.target.value })}
            >
              {videoModelsFor(provider).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>

          {/* An avatar row has no size options at all: the model takes an
              image, a voice track and a prompt, and the audio sets the length.
              So the row shows the cut instead. */}
          {audioDriven ? (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="text-muted">Voice</span>
              {shot.audio && source ? (
                <>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setTrimming(true)}
                    className="pill px-2 py-0.5 text-[11px] pill-active font-mono"
                    title="Change the cut"
                  >
                    {source.name} · {formatTime(shot.audio.start, true)} +
                    {shot.audio.duration.toFixed(1)}s
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setShotAudio(shot.id, undefined)}
                    className="text-[11px] text-muted hover:text-red-400 disabled:opacity-40"
                    title="Remove the voice track"
                  >
                    ✕
                  </button>
                </>
              ) : audioSources.length === 0 ? (
                <span className="text-amber-400">
                  load a voice track above first
                </span>
              ) : (
                <select
                  className="field w-auto px-2 py-1 text-xs"
                  value=""
                  disabled={disabled}
                  onChange={(event) => {
                    const picked = audioSources.find((e) => e.id === event.target.value);
                    if (!picked) return;
                    setShotAudio(shot.id, {
                      sourceId: picked.id,
                      name: picked.name,
                      start: 0,
                      duration: Math.min(15, picked.duration),
                    });
                    setTrimming(true);
                  }}
                >
                  <option value="" disabled>
                    Pick a track…
                  </option>
                  {audioSources.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.fileName}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ) : (
          <>
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
          </>
          )}

          {rate !== null && (
            <span className="text-[11px] text-muted">≈ {formatCredits(rate)}</span>
          )}
        </div>

        {provider !== "heygen" && promptControls}

        {provider === "heygen" && <>
          <details className="rounded border border-line p-3">
            <summary className="cursor-pointer text-xs text-muted">HeyGen Settings</summary>
            <div className="mt-3 space-y-3">
              {promptControls}
          <HeygenSettings model={shot.model} resolution={shot.resolution} aspectRatio={shot.aspectRatio} options={shot.heygen} disabled={disabled} onChange={patch => updateShot(shot.id, patch)} />
            </div>
          </details>
          <p className="text-xs text-muted">Selected audio: {(shot.audio?.duration ?? 0).toFixed(2)}s  -  Estimated &#36;{heygenEstimate(shot.audio?.duration ?? 0).toFixed(2)}</p>
        </>}
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

      {trimming && source && shot.audio && (
        <AudioTrimmer
          source={source}
          start={shot.audio.start}
          duration={shot.audio.duration}
          maxSeconds={spec.maxAudioSeconds ?? 300}
          onCancel={() => setTrimming(false)}
          onConfirm={(start, length) => {
            setShotAudio(shot.id, {
              sourceId: source.id,
              name: source.name,
              start,
              duration: length,
            });
            setTrimming(false);
          }}
        />
      )}
    </li>
  );
}
