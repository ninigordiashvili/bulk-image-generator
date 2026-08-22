"use client";

import { useEffect, useMemo, useState } from "react";
import { uniqueName } from "@/lib/download";
import { formatCredits, formatSpend } from "@/lib/pricing";
import { useVideoStore } from "@/store/videoStore";
import type { GeneratedVideo } from "@/types";

/**
 * A clip with a cue tag is named for it and nothing else, so the file can go
 * straight back into the video editor. Otherwise the `index` is the clip's
 * position in the gallery, which is request order — so the numbers run down the
 * shot list rather than recording who finished first, matching the image ZIP.
 */
function fileNameFor(video: GeneratedVideo, index?: number): string {
  const extension = video.mimeType.includes("webm") ? "webm" : "mp4";
  if (video.tag) return `${video.tag}.${extension}`;

  const slug =
    video.prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "video";
  const prefix = index === undefined ? "" : `${String(index + 1).padStart(3, "0")}-`;
  return `${prefix}${slug}-${video.duration}s-${video.resolution}.${extension}`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function VideoCard({ video, index }: { video: GeneratedVideo; index: number }) {
  const removeVideo = useVideoStore((state) => state.removeVideo);

  // An object URL per clip, revoked on unmount — without that a gallery of ten
  // 1080p videos pins every blob in memory for the life of the page.
  const url = useMemo(() => URL.createObjectURL(video.blob), [video.blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  function download() {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileNameFor(video, index);
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface-2">
      <video
        src={url}
        poster={`data:${video.posterMimeType};base64,${video.posterBase64}`}
        controls
        preload="metadata"
        className="w-full bg-black"
      />
      <div className="space-y-1.5 p-2">
        <p className="line-clamp-2 text-[11px] text-muted" title={video.prompt}>
          {video.prompt}
        </p>
        <div className="flex flex-wrap gap-1 text-[10px] text-muted">
          <span className="badge">{video.modelLabel}</span>
          <span className="badge">{video.duration}s</span>
          <span className="badge">{video.resolution}</span>
          <span className="badge">{formatSize(video.sizeBytes)}</span>
          <span
            className="badge"
            title={
              video.creditsEstimated
                ? "kie's Veo API reports no per-task credit figure — this is the known rate, not a billed amount. Check your balance for truth."
                : "Billed by kie for this clip."
            }
          >
            {video.creditsEstimated ? "≈" : ""}
            {formatCredits(video.credits)}
          </span>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            className="badge cursor-pointer hover:bg-black/80"
            onClick={download}
            title={`Download ${fileNameFor(video, index)}`}
          >
            ↓ Download
          </button>
          <button
            type="button"
            className="badge cursor-pointer hover:bg-red-600/80"
            onClick={() => void removeVideo(video.id)}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export function VideoGallery() {
  const videos = useVideoStore((state) => state.videos);
  const galleryHydrated = useVideoStore((state) => state.galleryHydrated);
  const clearGallery = useVideoStore((state) => state.clearGallery);
  const [busy, setBusy] = useState(false);

  const spent = videos.reduce((sum, video) => sum + video.credits, 0);
  // Veo clips carry an estimate rather than a billed figure, so the total is
  // marked approximate the moment one of them is in it.
  const anyEstimated = videos.some((video) => video.creditsEstimated);
  const totalBytes = videos.reduce((sum, video) => sum + video.sizeBytes, 0);

  async function downloadAll() {
    setBusy(true);
    try {
      // Sequential, with a beat between each: ten simultaneous downloads trips
      // Chrome's multiple-download block and most of them are silently dropped.
      const used = new Set<string>();
      for (const [index, video] of videos.entries()) {
        const url = URL.createObjectURL(video.blob);
        const name = uniqueName(fileNameFor(video, index), used);
        used.add(name);
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        await new Promise((resolve) => setTimeout(resolve, 400));
        URL.revokeObjectURL(url);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="panel-title mb-0">Video gallery</h2>
          <p className="mt-1 text-[11px] text-muted">
            {videos.length} clips · {anyEstimated ? "≈" : ""}
            {formatSpend(spent)} {anyEstimated ? "(Veo cost estimated)" : "billed"}
            {totalBytes > 0 && <> · {formatSize(totalBytes)} stored locally</>}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={videos.length === 0 || busy}
            onClick={() => void downloadAll()}
          >
            {busy ? "Downloading…" : "Download all"}
          </button>
          <button
            type="button"
            className="btn-ghost text-xs hover:border-red-500 hover:text-red-400"
            disabled={videos.length === 0}
            onClick={() => {
              if (confirm(`Delete all ${videos.length} clips from local storage?`)) {
                void clearGallery();
              }
            }}
          >
            Clear gallery
          </button>
        </div>
      </div>

      {!galleryHydrated ? (
        <p className="py-8 text-center text-xs text-muted">Loading gallery…</p>
      ) : videos.length === 0 ? (
        <p className="py-8 text-center text-xs text-muted">
          No clips yet. Generated videos are downloaded from kie and stored in your
          browser, so they outlive the ~24h expiry on kie&apos;s links.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {videos.map((video, index) => (
            <VideoCard key={video.id} video={video} index={index} />
          ))}
        </div>
      )}
    </section>
  );
}
