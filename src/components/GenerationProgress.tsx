"use client";

import { useMemo } from "react";
import { creditsPerImage, formatCredits, formatSpend } from "@/lib/pricing";
import { parsePrompts } from "@/lib/prompts";
import {
  activeInput,
  activeModelId,
  useGenerationStore,
} from "@/store/generationStore";
import { MAX_PROMPTS } from "@/types";

export function GenerationProgress() {
  const progress = useGenerationStore((state) => state.progress);
  const queueState = useGenerationStore((state) => state.queueState);
  const promptText = useGenerationStore((state) => state.promptText);
  const settings = useGenerationStore((state) => state.settings);
  const creditRates = useGenerationStore((state) => state.creditRates);
  const jobs = useGenerationStore((state) => state.jobs);
  const images = useGenerationStore((state) => state.images);

  const promptCount = useMemo(
    () => Math.min(parsePrompts(promptText).length, MAX_PROMPTS),
    [promptText]
  );

  if (queueState === "idle" && jobs.length === 0) return null;

  const percent =
    progress.total === 0 ? 0 : (progress.completed / progress.total) * 100;

  // Actual spend so far: what kie billed for the images this batch produced.
  const jobIds = new Set(jobs.map((job) => job.id));
  const spent = images
    .filter((image) => jobIds.has(image.jobId))
    .reduce((sum, image) => sum + image.credits, 0);

  const model = activeModelId(settings);
  const rate = model
    ? creditsPerImage(model, activeInput(settings), creditRates)
    : null;
  const estimated =
    rate === null ? null : promptCount * settings.imagesPerPrompt * rate;

  return (
    <section className="panel">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="panel-title mb-0">
          {queueState === "running"
            ? "Generating"
            : queueState === "cancelling"
              ? "Cancelling"
              : "Batch complete"}
        </h2>
        <span className="text-xs text-muted">
          {progress.completed} / {progress.total} · {progress.succeeded} ok ·{" "}
          {progress.failed} failed · {progress.inFlight} in flight
        </span>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>

      <p className="mt-2 text-xs text-muted">
        Spent so far{" "}
        <span className="font-semibold text-foreground">{formatSpend(spent)}</span>
        {estimated !== null && <> of {formatCredits(estimated)} estimated</>} for
        this batch.
      </p>
    </section>
  );
}
