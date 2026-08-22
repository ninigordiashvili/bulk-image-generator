"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDuration } from "@/lib/editor/format";
import { makeThumbnail } from "@/lib/editor/media";
import { selectTimeline, useEditorStore } from "@/store/editorStore";
import { CueList } from "./CueList";
import { ExportPanel } from "./ExportPanel";
import { MediaIntake } from "./MediaIntake";
import { PreviewStage } from "./PreviewStage";
import { SettingsPanel } from "./SettingsPanel";

export function VideoEditor() {
  const images = useEditorStore((state) => state.images);
  const audio = useEditorStore((state) => state.audio);
  const settings = useEditorStore((state) => state.settings);
  const zoom = useEditorStore((state) => state.zoom);
  const leadIn = useEditorStore((state) => state.leadIn);
  const tailSeconds = useEditorStore((state) => state.tailSeconds);
  const fileName = useEditorStore((state) => state.fileName);
  const exportState = useEditorStore((state) => state.export);

  const addImages = useEditorStore((state) => state.addImages);
  const removeImage = useEditorStore((state) => state.removeImage);
  const toggleImage = useEditorStore((state) => state.toggleImage);
  const clearImages = useEditorStore((state) => state.clearImages);
  const setAudio = useEditorStore((state) => state.setAudio);
  const setSettings = useEditorStore((state) => state.setSettings);
  const setZoom = useEditorStore((state) => state.setZoom);
  const setLeadIn = useEditorStore((state) => state.setLeadIn);
  const setTailSeconds = useEditorStore((state) => state.setTailSeconds);
  const setFileName = useEditorStore((state) => state.setFileName);
  const startExport = useEditorStore((state) => state.startExport);
  const cancelExport = useEditorStore((state) => state.cancelExport);
  const dismissExport = useEditorStore((state) => state.dismissExport);

  const timeline = useMemo(
    () => selectTimeline({ images, audio, tailSeconds, leadIn }),
    [images, audio, tailSeconds, leadIn]
  );

  const thumbnails = useThumbnails(images);
  const busy = exportState.phase === "uploading" || exportState.phase === "rendering";

  const firstCue = timeline.clips.find((clip) => clip.imageId)?.start ?? 0;
  const blocker =
    timeline.clips.length === 0
      ? images.length === 0
        ? "Add images named for their timestamps to get started."
        : "None of those filenames resolved to a cue inside the audio."
      : null;

  return (
    <main className="mx-auto w-full max-w-[1600px] space-y-4 px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Video Editor</h1>
          <p className="mt-1 text-xs text-muted">
            Assembles a slideshow from images named for the timestamp they should
            appear at, over an audio bed. Rendered locally with ffmpeg.
          </p>
        </div>
        <Link href="/" className="pill">
          ← Back to the generator
        </Link>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(320px,1fr)]">
        <div className="space-y-4">
          <PreviewStage
            timeline={timeline}
            images={images}
            audio={audio}
            zoom={zoom}
            zoomAmount={settings.zoomAmount}
            thumbnails={thumbnails}
            onToggleImage={toggleImage}
          />

          <CueList
            images={images}
            timeline={timeline}
            disabled={busy}
            onToggle={toggleImage}
            onRemove={removeImage}
          />
        </div>

        <div className="space-y-4">
          <MediaIntake
            audio={audio}
            imageCount={images.length}
            placedCount={timeline.placed}
            disabled={busy}
            onAudio={setAudio}
            onImages={addImages}
            onClearImages={clearImages}
          />

          <ExportPanel
            state={exportState}
            settings={settings}
            fileName={fileName}
            clipCount={timeline.clips.length}
            total={timeline.total}
            canExport={!busy && timeline.clips.length > 0}
            blocker={blocker}
            onFileName={setFileName}
            onStart={() => void startExport()}
            onCancel={cancelExport}
            onDismiss={dismissExport}
          />

          <SettingsPanel
            settings={settings}
            zoom={zoom}
            leadIn={leadIn}
            tailSeconds={tailSeconds}
            hasAudio={Boolean(audio)}
            hasLeadIn={firstCue > 0 || leadIn === "black"}
            disabled={busy}
            onSettings={setSettings}
            onZoom={setZoom}
            onLeadIn={setLeadIn}
            onTailSeconds={setTailSeconds}
          />

          {timeline.clips.length > 0 && (
            <p className="px-1 text-[11px] text-muted">
              {timeline.placed} images across {formatDuration(timeline.total)}, an
              average of{" "}
              {formatDuration(timeline.total / Math.max(1, timeline.placed))} each.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * Small stills for the filmstrip, made once per image and reused. The source
 * files are full-size renders; putting a hundred of them straight into `<img>`
 * tags would have the browser holding hundreds of megabytes of decoded bitmaps
 * for a strip that shows them at 112 pixels wide.
 */
function useThumbnails(images: { id: string; file: File }[]): Map<string, string> {
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map());
  const cache = useRef(new Map<string, string>());

  useEffect(() => {
    let live = true;
    const wanted = new Set(images.map((image) => image.id));

    for (const [id, url] of cache.current) {
      if (!wanted.has(id)) {
        URL.revokeObjectURL(url);
        cache.current.delete(id);
      }
    }

    const missing = images.filter((image) => !cache.current.has(image.id));
    if (missing.length === 0) {
      if (cache.current.size !== thumbnails.size) setThumbnails(new Map(cache.current));
      return;
    }

    void (async () => {
      // Encoded a few at a time so a hundred-image drop doesn't lock the tab.
      for (let i = 0; i < missing.length && live; i += 4) {
        const batch = missing.slice(i, i + 4);
        await Promise.all(
          batch.map(async (image) => {
            try {
              const url = await makeThumbnail(image.file);
              if (!live) {
                URL.revokeObjectURL(url);
                return;
              }
              cache.current.set(image.id, url);
            } catch {
              // A file the browser can't decode still gets a timeline slot; the
              // strip just shows a placeholder for it.
            }
          })
        );
        if (live) setThumbnails(new Map(cache.current));
      }
    })();

    return () => {
      live = false;
    };
    // `thumbnails` is written here, never read as an input — including it would
    // restart the encode loop on every batch it publishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images]);

  useEffect(() => {
    const held = cache.current;
    return () => {
      for (const url of held.values()) URL.revokeObjectURL(url);
      held.clear();
    };
  }, []);

  return thumbnails;
}
