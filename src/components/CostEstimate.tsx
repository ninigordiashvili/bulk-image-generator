"use client";
import { HelpTip } from "./HelpTip";

import { useMemo } from "react";
import { findModel } from "@/lib/kieModels";
import {
  creditsPerImage,
  creditsToUsd,
  formatCredits,
  formatUsd,
} from "@/lib/pricing";
import { parsePrompts, resolveCharactersForPrompt } from "@/lib/prompts";
import { imageRate } from "@/lib/vertexPricing";
import { VERTEX_BATCH_MODEL, VERTEX_BATCH_IMAGE_USD, batchInputEstimate } from "@/lib/vertexBatch";
import {
  activeInput,
  activeModelId,
  useGenerationStore,
} from "@/store/generationStore";
import { MAX_PROMPTS } from "@/types";

export function CostEstimate() {
  const promptText = useGenerationStore((state) => state.promptText);
  const settings = useGenerationStore((state) => state.settings);
  const creditRates = useGenerationStore((state) => state.creditRates);
  const credits = useGenerationStore((state) => state.credits);
  const characters = useGenerationStore((state) => state.characters);

  const promptCount = useMemo(
    () => Math.min(parsePrompts(promptText).length, MAX_PROMPTS),
    [promptText]
  );

  const model = activeModelId(settings);
  const input = activeInput(settings);
  const label = findModel(model)?.label ?? model ?? "no model";
  const totalImages = promptCount * settings.imagesPerPrompt;

  const rate = model ? creditsPerImage(model, input, creditRates) : null;
  const estimate = rate === null ? null : totalImages * rate;
  const overBalance = estimate !== null && credits !== null && estimate > credits;

  if (settings.provider === "vertex") {
    const batch = settings.vertexImageMode === "batch" && model === VERTEX_BATCH_MODEL;
    const outputCost = totalImages * (batch ? VERTEX_BATCH_IMAGE_USD : imageRate(model).usd);
    const inputCost = model === VERTEX_BATCH_MODEL ? parsePrompts(promptText).slice(0, MAX_PROMPTS).reduce((sum, prompt) =>
      sum + batchInputEstimate([settings.styleBible, prompt.raw].filter(Boolean).join("\n\n"),
        Math.min(14, resolveCharactersForPrompt(prompt, characters).length)) * settings.imagesPerPrompt * (batch ? 1 : 2), 0) : 0;
    return <div className="rounded-xl border border-line bg-surface-2 px-4 py-3">
      <p className="text-sm">{totalImages} images · {batch ? "Batch" : "Standard"} · approximately <strong>${(outputCost + inputCost).toFixed(4)}</strong></p>
      <HelpTip>Image output ${outputCost.toFixed(4)}{model === VERTEX_BATCH_MODEL ? ` + estimated prompt/reference input $${inputCost.toFixed(4)}` : ""}. Image-only results; reference images are supported. Google Cloud billing is authoritative; storage and any model reasoning charges are excluded.</HelpTip>
      {batch && <HelpTip>Eligible Cloud credits apply on the selected project. Google schedules the job; timing is not guaranteed. Individual prompts can fail while other images succeed.</HelpTip>}
    </div>;
  }

  return (
    <div className="rounded-xl border border-line bg-surface-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="text-muted">{promptCount} prompts</span>
        <span className="text-muted">×</span>
        <span className="text-muted">{settings.imagesPerPrompt} images</span>
        <span className="text-muted">×</span>
        <span className="text-muted">
          {rate === null ? "? credits" : formatCredits(rate)} ({label})
        </span>
        <span className="text-muted">=</span>
        <span
          className={`text-base font-semibold ${
            overBalance ? "text-amber-400" : "text-foreground"
          }`}
        >
          {estimate === null ? "unknown" : formatCredits(estimate)}
        </span>
        {estimate !== null && (
          <span className="text-muted">≈ {formatUsd(creditsToUsd(estimate))}</span>
        )}
      </div>

      <p className="mt-1 text-xs text-muted">
        {totalImages} images total
        {overBalance && (
          <span className="text-amber-400">
            {" "}
            · more than the {formatCredits(credits ?? 0)} on this account — the
            batch will stop once the credits run out
          </span>
        )}
      </p>

      <HelpTip>
        {rate === null
          ? "This model hasn't been run here yet, so there's no rate to estimate from. The first finished image records what kie.ai actually charged, and the estimate appears from then on."
          : "Rate learned from what kie.ai actually billed for this model at these settings — not a published price list."}
      </HelpTip>
    </div>
  );
}
