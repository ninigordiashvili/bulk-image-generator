"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadShotImage } from "@/lib/imageFile";
import { creditsPerImage, formatCredits, formatUsd, creditsToUsd } from "@/lib/pricing";
import { VIDEO_MODELS, videoModel } from "@/lib/videoModels";
import { isRunning, useGenerationStore } from "@/store/generationStore";
import { useVideoStore } from "@/store/videoStore";
import { MAX_SHOTS } from "@/types";
import { VideoGallery } from "./VideoGallery";
import { VideoShotRow } from "./VideoShotRow";

export function VideoBatch() {
  const shots = useVideoStore((state) => state.shots);
  const defaults = useVideoStore((state) => state.defaults);
  const jobs = useVideoStore((state) => state.jobs);
  const progress = useVideoStore((state) => state.progress);
  const queueState = useVideoStore((state) => state.queueState);
  const haltReason = useVideoStore((state) => state.haltReason);
  const concurrency = useVideoStore((state) => state.concurrency);
  const retries = useVideoStore((state) => state.retries);
  const creditRates = useVideoStore((state) => state.creditRates);

  const addShots = useVideoStore((state) => state.addShots);
  const clearShots = useVideoStore((state) => state.clearShots);
  const applyToAll = useVideoStore((state) => state.applyToAll);
  const setConcurrency = useVideoStore((state) => state.setConcurrency);
  const setRetries = useVideoStore((state) => state.setRetries);
  const startGeneration = useVideoStore((state) => state.startGeneration);
  const cancelGeneration = useVideoStore((state) => state.cancelGeneration);
  const retryFailedJobs = useVideoStore((state) => state.retryFailedJobs);
  const hydrateGallery = useVideoStore((state) => state.hydrateGallery);

  const accountId = useGenerationStore((state) => state.settings.accountId);
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

  const ready = shots.filter((shot) => shot.prompt.trim().length > 0);
  const missingPrompts = shots.length - ready.length;

  // Each row can be a different model at a different length, so the estimate is
  // a sum over rows rather than count × rate. Rows on a model that has never run
  // here contribute nothing and are counted as unknown.
  const estimate = useMemo(() => {
    let known = 0;
    let unknown = 0;
    for (const shot of ready) {
      const rate = creditsPerImage(
        shot.model,
        { duration: shot.duration, resolution: shot.resolution },
        creditRates
      );
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
      <section className="panel">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="panel-title mb-0">Storyboard</h2>
          <span className="text-[11px] text-muted">
            {shots.length} / {MAX_SHOTS} shots
            {missingPrompts > 0 && (
              <span className="text-amber-400">
                {" "}
                · {missingPrompts} without a prompt
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
              : "Drop images here — one shot per image. Select all ten at once; each gets its own prompt, model, duration and resolution below."}
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

        {shots.length > 0 && (
          <>
            {/* Setting ten rows by hand is the tedious part; this is the shortcut. */}
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
              <span className="text-[11px] text-muted">Apply to all rows:</span>
              {VIDEO_MODELS.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  className="pill px-2 py-0.5 text-[11px]"
                  disabled={running}
                  onClick={() => applyToAll({ model: model.id })}
                  title={model.blurb}
                >
                  {model.label}
                </button>
              ))}
              <span className="mx-1 text-line">|</span>
              {videoModel(defaults.model).durations.map((duration) => (
                <button
                  key={duration}
                  type="button"
                  className="pill px-2 py-0.5 text-[11px]"
                  disabled={running}
                  onClick={() => applyToAll({ duration })}
                >
                  {duration}s
                </button>
              ))}
              <span className="mx-1 text-line">|</span>
              {videoModel(defaults.model).resolutions.map((resolution) => (
                <button
                  key={resolution}
                  type="button"
                  className="pill px-2 py-0.5 text-[11px]"
                  disabled={running}
                  onClick={() => applyToAll({ resolution })}
                >
                  {resolution}
                </button>
              ))}
              <button
                type="button"
                className="btn-ghost ml-auto text-[11px]"
                disabled={running}
                onClick={clearShots}
              >
                Clear all
              </button>
            </div>

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

      <section className="panel space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-primary"
            disabled={running || ready.length === 0 || !accountId}
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

          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            At once
            <input
              type="number"
              className="field w-16 px-2 py-1 text-xs"
              min={1}
              max={10}
              value={concurrency}
              onChange={(event) =>
                setConcurrency(
                  Math.min(10, Math.max(1, Number(event.target.value) || 1))
                )
              }
            />
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            Retries
            <input
              type="number"
              className="field w-16 px-2 py-1 text-xs"
              min={0}
              max={5}
              value={retries}
              onChange={(event) =>
                setRetries(Math.min(5, Math.max(0, Number(event.target.value) || 0)))
              }
            />
          </label>

          {!accountId && (
            <span className="text-xs text-amber-400">
              Select a kie.ai account in the Images tab first.
            </span>
          )}
        </div>

        <p className="text-[11px] text-muted">
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
          {estimate.unknown > 0 && (
            <>
              {estimate.unknown} row{estimate.unknown === 1 ? "" : "s"} use a model
              that hasn&apos;t run here yet, so {estimate.unknown === 1 ? "its" : "their"}{" "}
              cost is unknown until the first clip finishes.{" "}
            </>
          )}
          Video takes minutes per clip — {concurrency} run at a time, so the batch
          finishes in roughly the time of the slowest {concurrency}.
        </p>

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
      </section>

      <VideoGallery />
    </div>
  );
}
