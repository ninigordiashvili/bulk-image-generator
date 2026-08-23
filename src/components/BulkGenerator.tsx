"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ZipProgress } from "@/lib/download";
import { KIE_MODELS } from "@/lib/kieModels";
import { parsePrompts } from "@/lib/prompts";
import { VIDEO_MODELS } from "@/lib/videoModels";
import {
  activeModelId,
  isRunning,
  useGenerationStore,
} from "@/store/generationStore";
import { useVideoStore } from "@/store/videoStore";
import { MAX_PROMPTS } from "@/types";
import { AccountSelector } from "./AccountSelector";
import { BulkPromptInput } from "./BulkPromptInput";
import { CharacterLibrary } from "./CharacterLibrary";
import { CostEstimate } from "./CostEstimate";
import { DownloadProgress } from "./DownloadProgress";
import { GenerationProgress } from "./GenerationProgress";
import { GenerationSettingsPanel } from "./GenerationSettingsPanel";
import { ImageGallery } from "./ImageGallery";
import { QueuePanel } from "./QueuePanel";
import { StyleBible } from "./StyleBible";
import { VideoBatch } from "./VideoBatch";

type Mode = "images" | "videos";

export function BulkGenerator() {
  const queueState = useGenerationStore((state) => state.queueState);
  const promptText = useGenerationStore((state) => state.promptText);
  const settings = useGenerationStore((state) => state.settings);
  const { accountId, imagesPerPrompt } = settings;
  const startGeneration = useGenerationStore((state) => state.startGeneration);
  const cancelGeneration = useGenerationStore((state) => state.cancelGeneration);
  const hydrateGallery = useGenerationStore((state) => state.hydrateGallery);

  const videoQueueState = useVideoStore((state) => state.queueState);
  const videoCount = useVideoStore((state) => state.videos.length);

  const [mode, setMode] = useState<Mode>("images");
  const [zipProgress, setZipProgress] = useState<ZipProgress | null>(null);

  useEffect(() => {
    void hydrateGallery();
  }, [hydrateGallery]);

  const promptCount = useMemo(
    () => Math.min(parsePrompts(promptText).length, MAX_PROMPTS),
    [promptText]
  );

  const running = isRunning(queueState);
  const videoRunning = isRunning(videoQueueState);
  const totalImages = promptCount * imagesPerPrompt;
  // The custom-model box starts empty, so "a model is selected" isn't a given.
  const modelId = activeModelId(settings);
  const canStart =
    !running && promptCount > 0 && accountId.length > 0 && modelId.length > 0;

  return (
    <main className="mx-auto w-full max-w-[1600px] space-y-4 px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Bulk AI Generator</h1>
          <p className="mt-1 text-xs text-muted">
            kie.ai · {KIE_MODELS.length} image models + {VIDEO_MODELS.length} video
            models — everything runs locally against your own kie.ai credits.
          </p>
        </div>

        {/* The two modes share an account and a credit balance but nothing else:
            different inputs, different queue, different gallery. Switching tabs
            mid-run is safe — each queue keeps running in its own store. */}
        <div className="flex gap-1 rounded-lg border border-line bg-surface-2 p-1">
          {(["images", "videos"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setMode(tab)}
              className={`rounded-md px-3 py-1.5 text-xs capitalize transition ${
                mode === tab
                  ? "bg-accent/15 text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {tab}
              {tab === "videos" && videoRunning && (
                <span className="ml-1.5 text-accent">●</span>
              )}
              {tab === "images" && running && (
                <span className="ml-1.5 text-accent">●</span>
              )}
              {tab === "videos" && !videoRunning && videoCount > 0 && (
                <span className="ml-1.5 text-[10px] opacity-70">{videoCount}</span>
              )}
            </button>
          ))}
        </div>

        {/* Their own routes rather than more tabs: each holds a lot of media
            in memory, and unmounting all of it every time someone glances at
            the queue would be its own bug. */}
        <div className="flex gap-2">
          <Link href="/sound" className="pill">
            Sound editor →
          </Link>
          <Link href="/editor" className="pill">
            Video editor →
          </Link>
        </div>
      </header>

      {mode === "videos" ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(300px,1fr)]">
          <VideoBatch />
          <div>
            <AccountSelector disabled={videoRunning} />
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
            <div className="space-y-4">
              <CharacterLibrary disabled={running} />
              <StyleBible disabled={running} />
              <BulkPromptInput disabled={running} />
              <CostEstimate />

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!canStart}
                  onClick={startGeneration}
                >
                  Generate {totalImages > 0 ? `${totalImages} images` : ""}
                </button>

                {running && (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={cancelGeneration}
                  >
                    {queueState === "cancelling" ? "Cancelling…" : "Cancel run"}
                  </button>
                )}

                {!accountId && (
                  <span className="text-xs text-amber-400">
                    Select a kie.ai account first.
                  </span>
                )}

                {accountId && !modelId && (
                  <span className="text-xs text-amber-400">
                    Enter a kie.ai model id in the settings panel.
                  </span>
                )}
              </div>
            </div>

            <div className="space-y-4">
              <AccountSelector disabled={running} />
              <GenerationSettingsPanel disabled={running} />
            </div>
          </div>

          <GenerationProgress />
          <QueuePanel />
          <ImageGallery onZipProgress={setZipProgress} />
          <DownloadProgress progress={zipProgress} />
        </>
      )}
    </main>
  );
}
