"use client";
import { HelpTip } from "./HelpTip";

import { HeygenSettings } from "./HeygenSettings";
import { heygenEstimate } from "@/lib/heygen";
import { WorkTiming } from "./WorkTiming";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadShotImage } from "@/lib/imageFile";
import { formatTime } from "@/lib/editor/format";
import { creditsPerImage, formatCredits, formatUsd, creditsToUsd } from "@/lib/pricing";
import {
  defaultVideoModelFor,
  isAudioDriven,
  videoModel,
  videoModelsFor,
} from "@/lib/videoModels";
import { isRunning, useGenerationStore } from "@/store/generationStore";
import { isRunnable, shotSize, useVideoStore } from "@/store/videoStore";
import { MAX_CONCURRENCY, MAX_SHOTS } from "@/types";
import { VideoGallery } from "./VideoGallery";
import { VideoShotRow } from "./VideoShotRow";
import { VideoPromptInput } from "./VideoPromptInput";
import { pendingVideoShots } from "@/lib/videoPrompts";

export function VideoBatch() {
  const addAvatarShots = useVideoStore(state => state.addAvatarShots);
  const [avatarRows, setAvatarRows] = useState(1);
  const shots = useVideoStore((state) => state.shots);
  const inputMode = useVideoStore(state => state.inputMode);
  const setInputMode = useVideoStore(state => state.setInputMode);
  const promptText = useVideoStore(state => state.promptText);
  const defaults = useVideoStore((state) => state.defaults);
  const setDefaults = useVideoStore((state) => state.setDefaults);
  const updateShot = useVideoStore((state) => state.updateShot);
  const jobs = useVideoStore((state) => state.jobs);
  const progress = useVideoStore((state) => state.progress);
  const queueState = useVideoStore((state) => state.queueState);
  const haltReason = useVideoStore((state) => state.haltReason);
  const backgroundStatus = useVideoStore((state) => state.backgroundStatus);
  const concurrency = useVideoStore((state) => state.concurrency);
  const creditRates = useVideoStore((state) => state.creditRates);

  const addShots = useVideoStore((state) => state.addShots);
  const clearShots = useVideoStore((state) => state.clearShots);
  const applyToAll = useVideoStore((state) => state.applyToAll);
  const audioSources = useVideoStore((state) => state.audioSources);
  const audioError = useVideoStore((state) => state.audioError);
  const addAudioSource = useVideoStore((state) => state.addAudioSource);
  const removeAudioSource = useVideoStore((state) => state.removeAudioSource);
  const applyAudioSourceToAll = useVideoStore((state) => state.applyAudioSourceToAll);
  const [loadingAudio, setLoadingAudio] = useState(false);

  /** The voice-track shelf only appears once a row actually needs one. */
  const anyAudioModel = useMemo(
    () =>
      isAudioDriven(videoModel(defaults.model)) ||
      shots.some((shot) => isAudioDriven(videoModel(shot.model))),
    [defaults.model, shots]
  );
  const setConcurrency = useVideoStore((state) => state.setConcurrency);
  const startGeneration = useVideoStore((state) => state.startGeneration);
  const cancelGeneration = useVideoStore((state) => state.cancelGeneration);
  const retryFailedJobs = useVideoStore((state) => state.retryFailedJobs);
  const retryJob = useVideoStore(state => state.retryJob);
  const hydrateGallery = useVideoStore((state) => state.hydrateGallery);

  // The video tab's own account gates starting a video run.
  const accountId = useVideoStore((state) => state.accountId);
  // The video tab's own account decides which models can run here. It used to
  // read the image tab's, which is how choosing an account for one moved the
  // other.
  const provider = useVideoStore((state) => state.provider);

  // Switching account provider strands every row on a model the new account
  // cannot reach — the row's dropdown no longer lists it, so it renders blank
  // and the run fails at submit. Moving them to the new provider's default is
  // the only outcome that leaves the batch usable.
  useEffect(() => {
    const fallback = defaultVideoModelFor(provider);
    if (videoModel(defaults.model).provider !== provider) {
      setDefaults({ model: fallback });
    }
    for (const shot of shots) {
      if (videoModel(shot.model).provider !== provider) {
        updateShot(shot.id, { model: fallback });
      }
    }
  }, [provider, defaults.model, shots, setDefaults, updateShot]);
  const credits = useGenerationStore((state) => state.credits);

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void hydrateGallery();
  }, [hydrateGallery]);

  const running = isRunning(queueState);
  const jobsById = useMemo(
    () => new Map(jobs.map((job) => [job.id, job])),
    [jobs]
  );

  // What "ready" means depends on the row's model: a prompt for the animators,
  // a voice cut for the avatars.
  const textMode = provider === "vertex" && inputMode === "text";
  const pending = pendingVideoShots({ provider, inputMode, promptText, shots, defaults });
  const ready = pending.filter(isRunnable);
  const notReady = pending.length - ready.length;

  // Each row can be a different model at a different length, so the estimate is
  // a sum over rows rather than count × rate. Rows on a model that has never run
  // here contribute nothing and are counted as unknown.
  const estimate = useMemo(() => {
    let known = 0;
    let unknown = 0;
    for (const shot of ready) {
      const rate = creditsPerImage(shot.model, shotSize(shot), creditRates);
      if (rate === null) unknown++;
      else known += rate;
    }
    return { known, unknown };
  }, [ready, creditRates]);

  async function ingest(files: FileList | File[]) {
    setError(null);
    setLoading(true);
    try {
      const list = Array.from(files);
      const room = MAX_SHOTS - shots.length;
      if (list.length > room) {
        setError(
          `Only ${room} more shot${room === 1 ? "" : "s"} fit (limit ${MAX_SHOTS}); the rest were skipped.`
        );
      }
      const loaded = [];
      for (const file of list.slice(0, Math.max(room, 0))) {
        try {
          const image = await loadShotImage(file);
          loaded.push({
            base64: image.base64,
            mimeType: image.mimeType,
            name: file.name.replace(/\.[^.]+$/, "").slice(0, 60),
            width: image.width,
            height: image.height,
          });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not read file.");
        }
      }
      if (loaded.length > 0) addShots(loaded);
    } finally {
      setLoading(false);
    }
  }

  const percent =
    progress.total === 0 ? 0 : (progress.completed / progress.total) * 100;
  const unfinished = jobs.filter(
    (job) => job.status === "error" || job.status === "cancelled"
  ).length;

  return (
    <div className="space-y-4">
      <section className="panel space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-primary"
            disabled={running || ready.length === 0 || pending.length > MAX_SHOTS || !accountId}
            onClick={startGeneration}
          >
            Generate {ready.length > 0 ? `${ready.length} videos` : "videos"}
          </button>

          {running && (
            <button type="button" className="btn-ghost" onClick={cancelGeneration}>
              {queueState === "cancelling" ? "Cancelling…" : "Cancel run"}
            </button>
          )}

          {unfinished > 0 && !running && (
            <button type="button" className="btn-ghost" onClick={retryFailedJobs}>
              Retry {unfinished} failed
            </button>
          )}

          <div role="group" aria-label="Video settings" className="contents">
          <label className="flex items-center gap-1.5 text-[11px] text-muted">Model <select aria-label={textMode ? "Model" : "Batch model"} className="field w-auto max-w-full px-2 py-1 text-xs" disabled={running} value={defaults.model} onChange={event => (textMode ? setDefaults : applyToAll)({ model: event.target.value })}>
            {videoModelsFor(provider).map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select></label>
          {provider !== "heygen" && videoModel(defaults.model).durations.length > 0 && <label className="flex items-center gap-1.5 text-[11px] text-muted">Duration <select aria-label={textMode ? "Duration" : "Batch duration"} className="field w-auto max-w-full px-2 py-1 text-xs" disabled={running} value={defaults.duration} onChange={event => (textMode ? setDefaults : applyToAll)({ duration: Number(event.target.value) })}>
            {videoModel(defaults.model).durations.map(value => <option key={value} value={value}>{value}s</option>)}
          </select></label>}
          {provider !== "heygen" && videoModel(defaults.model).resolutions.length > 0 && <label className="flex items-center gap-1.5 text-[11px] text-muted">Resolution <select aria-label={textMode ? "Resolution" : "Batch resolution"} className="field w-auto max-w-full px-2 py-1 text-xs" disabled={running} value={defaults.resolution} onChange={event => (textMode ? setDefaults : applyToAll)({ resolution: event.target.value })}>
            {videoModel(defaults.model).resolutions.map(value => <option key={value}>{value}</option>)}
          </select></label>}
          {provider !== "heygen" && videoModel(defaults.model).aspectRatios.length > 0 && <label className="flex items-center gap-1.5 text-[11px] text-muted">Ratio <select aria-label={textMode ? "Ratio" : "Batch ratio"} className="field w-auto max-w-full px-2 py-1 text-xs" disabled={running} value={defaults.aspectRatio} onChange={event => (textMode ? setDefaults : applyToAll)({ aspectRatio: event.target.value })}>
            {videoModel(defaults.model).aspectRatios.map(value => <option key={value}>{value}</option>)}
          </select></label>}
            <HelpTip label="Batch settings">{textMode ? "Settings apply to every video prompt." : "Changes apply to all current shots and new images. Individual shots can override these settings."}</HelpTip>
          </div>

          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            At once
            <input
              type="number"
              className="field w-16 px-2 py-1 text-xs"
              min={1}
              max={MAX_CONCURRENCY}
              value={concurrency}
              onChange={(event) =>
                setConcurrency(
                  Math.min(MAX_CONCURRENCY, Math.max(1, Number(event.target.value) || 1))
                )
              }
            />
          </label>
          <HelpTip label="Retries and quota waits">{provider === "heygen" ? "HeyGen quota waits and temporary connection errors retry safely. Accepted videos resume by ID. Use Retry on a failed row." : "Vertex quota errors wait and keep retrying until success or cancellation. Other failed prompts retry once automatically. After that, use Retry on the failed row."}</HelpTip>

          {!accountId && (
            <span className="text-xs text-amber-400">
              Select an account for this video batch.
            </span>
          )}
        </div>
        {provider === "kie" && <p className="text-[11px] text-muted">
          {estimate.known > 0 && (
            <>
              Estimated{" "}
              <span
                className={
                  credits !== null && estimate.known > credits
                    ? "font-semibold text-amber-400"
                    : "font-semibold text-foreground"
                }
              >
                {formatCredits(estimate.known)}
              </span>{" "}
              (~{formatUsd(creditsToUsd(estimate.known))}) for this batch.{" "}
            </>
          )}
          {estimate.unknown > 0 && <span>{estimate.unknown} unpriced rows. </span>}
          <HelpTip label="Video estimate">Costs are estimates based on recorded model rates. Unpriced rows are excluded until their first successful generation.</HelpTip>
        </p>}
        {provider === "heygen" && <p className="text-xs text-muted">Estimated <strong className="text-foreground">&#36;{heygenEstimate(ready.reduce((sum, shot) => sum + (shot.audio?.duration ?? 0), 0)).toFixed(2)}</strong> for {ready.length} videos <HelpTip label="HeyGen estimate">$1/minute, based on selected audio cuts. This is your configured estimate, not a provider quote.</HelpTip></p>}
      </section>

      {provider === "vertex" && <div className="flex gap-2" role="group" aria-label="Video input mode">
        <button className="pill" aria-pressed={textMode} disabled={running} onClick={() => setInputMode("text")}>Text to video</button>
        <button className="pill" aria-pressed={!textMode} disabled={running} onClick={() => setInputMode("images")}>Image to video</button>
      </div>}
      {provider === "heygen" && <section className="panel space-y-3">
        <h2 className="panel-title">HeyGen batch defaults</h2>
        <HeygenSettings model={defaults.model} resolution={defaults.resolution} aspectRatio={defaults.aspectRatio} options={defaults.heygen} disabled={running} onChange={patch => applyToAll(patch)} />
        {defaults.heygen?.source === "avatar" && <div className="flex items-center gap-2"><input aria-label="Number of avatar rows" className="field w-20" type="number" min={1} max={MAX_SHOTS} value={avatarRows} disabled={running} onChange={e => setAvatarRows(Math.max(1, Math.min(MAX_SHOTS, Number(e.target.value) || 1)))} /><button className="btn-ghost" disabled={running || shots.length >= MAX_SHOTS} onClick={() => addAvatarShots(avatarRows)}>Add avatar rows</button></div>}
        <HelpTip label="HeyGen batch settings">Changes here apply to all rows and new images. Each row can override these settings and trim its own audio.</HelpTip>
      </section>}
      {textMode ? <VideoPromptInput disabled={running} /> : <>
      <section className="panel">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="panel-title mb-0">Storyboard</h2>
          <button type="button" className="btn-ghost text-xs" disabled={running || shots.length === 0} onClick={clearShots}>Clear all</button>
          <span className="text-[11px] text-muted">
            {shots.length} / {MAX_SHOTS} shots
            {notReady > 0 && (
              <span className="text-amber-400">
                {" "}
                · {notReady} not ready yet
              </span>
            )}
          </span>
        </div>

        <div
          onDragOver={(event) => {
            event.preventDefault();
            if (!running) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!running && event.dataTransfer.files.length) {
              void ingest(event.dataTransfer.files);
            }
          }}
          onClick={() => !running && inputRef.current?.click()}
          className={`cursor-pointer rounded-lg border border-dashed px-4 py-6 text-center text-xs transition ${
            dragging ? "border-accent bg-accent/10" : "border-line"
          } ${running ? "cursor-not-allowed opacity-50" : "hover:border-accent"}`}
        >
          <span className="text-muted">
            {loading
              ? "Reading images…"
              : "Drop images here or click to browse"}
          </span>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) void ingest(event.target.files);
            event.target.value = "";
          }}
        />

        {error && <p className="mt-2 text-xs text-amber-400">{error}</p>}

        {/* Voice tracks live here rather than on a row, because one recording
            usually feeds many rows — each taking its own cut out of it. */}
        {(anyAudioModel || audioSources.length > 0) && (
          <div className="mt-3 space-y-2 rounded-lg border border-line bg-surface px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted">Voice tracks:</span>
              {audioSources.map((source) => (
                <span
                  key={source.id}
                  className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 py-0.5 text-[11px]"
                >
                  <span className="max-w-[16rem] truncate" title={source.fileName}>
                    {source.fileName}
                  </span>
                  <span className="font-mono text-muted">{formatTime(source.duration)}</span>
                  <button
                    type="button"
                    disabled={running || shots.length === 0}
                    onClick={() => applyAudioSourceToAll(source.id)}
                    className="text-muted hover:text-foreground disabled:opacity-40"
                    title="Give every row this track — each row still keeps its own cut"
                  >
                    → all rows
                  </button>
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => removeAudioSource(source.id)}
                    className="text-muted hover:text-red-400 disabled:opacity-40"
                  >
                    ✕
                  </button>
                </span>
              ))}
              <label
                className={`pill px-2 py-0.5 text-[11px] ${
                  running || loadingAudio ? "pointer-events-none opacity-50" : "cursor-pointer"
                }`}
              >
                {loadingAudio ? "Reading…" : "+ Add audio"}
                <input
                  type="file"
                  accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus"
                  multiple
                  className="hidden"
                  disabled={running || loadingAudio}
                  onChange={async (event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = "";
                    if (files.length === 0) return;
                    setLoadingAudio(true);
                    try {
                      for (const file of files) await addAudioSource(file);
                    } finally {
                      setLoadingAudio(false);
                    }
                  }}
                />
              </label>
            </div>
            {audioSources.length === 0 && (
              <p className="text-[11px] text-muted">
                Load a recording, then each avatar row cuts the seconds it needs
                out of it.
              </p>
            )}
            {audioError && <p className="text-[11px] text-red-400">{audioError}</p>}
          </div>
        )}

        {shots.length > 0 && (
          <>

            <ul className="mt-3 space-y-2">
              {shots.map((shot, index) => (
                <VideoShotRow
                  key={shot.id}
                  shot={shot}
                  index={index}
                  job={jobsById.get(shot.id)}
                  disabled={running}
                />
              ))}
            </ul>
          </>
        )}
      </section>
      </>}
      {(backgroundStatus || jobs.length > 0 || haltReason) && <section className="panel space-y-3">
        <WorkTiming status={backgroundStatus} />
        {jobs.length > 0 && (
          <>
            <div className="h-2 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="text-xs text-muted">
              {progress.completed} / {progress.total} · {progress.succeeded} ok ·{" "}
              {progress.failed} failed · {progress.inFlight} rendering
            </p>
          </>
        )}
        {textMode && jobs.length > 0 && <ul className="max-h-72 space-y-2 overflow-auto text-xs">
          {jobs.map(job => <li key={job.id} className="rounded border border-line p-2">
            <div className="flex items-center justify-between gap-2"><span>{job.tag ?? job.promptIndex + 1}.mp4 - {job.status}</span>
              {["error", "cancelled"].includes(job.status) && !running && <button className="text-accent underline" onClick={() => retryJob(job.id)}>Retry</button>}
            </div>
            {job.error && <p className="mt-1 text-red-400">{job.error}</p>}
          </li>)}
        </ul>}

        {haltReason && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2.5">
            <p className="text-xs font-semibold text-red-300">
              Batch stopped — this failure affects every shot
            </p>
            <p className="mt-1 text-[11px] leading-relaxed break-words text-red-200/90">
              {haltReason}
            </p>
          </div>
        )}
      </section>}

      <VideoGallery />
    </div>
  );
}
