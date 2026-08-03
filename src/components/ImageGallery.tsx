"use client";

import { useState } from "react";
import { downloadAllAsZip, type ZipProgress } from "@/lib/download";
import { formatSpend } from "@/lib/pricing";
import { useGenerationStore } from "@/store/generationStore";
import { ImageCard } from "./ImageCard";

export function ImageGallery({
  onZipProgress,
}: {
  onZipProgress: (progress: ZipProgress | null) => void;
}) {
  const images = useGenerationStore((state) => state.images);
  const galleryHydrated = useGenerationStore((state) => state.galleryHydrated);
  const clearGallery = useGenerationStore((state) => state.clearGallery);
  const [zipping, setZipping] = useState(false);

  const mismatched = images.filter((image) => image.resolutionMismatch).length;
  const spent = images.reduce((sum, image) => sum + image.credits, 0);

  async function handleZip() {
    setZipping(true);
    onZipProgress({ current: 0, total: images.length, phase: "packing" });
    try {
      await downloadAllAsZip(images, onZipProgress);
    } finally {
      setZipping(false);
      setTimeout(() => onZipProgress(null), 1200);
    }
  }

  return (
    <section className="panel">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="panel-title mb-0">Gallery</h2>
          <p className="mt-1 text-[11px] text-muted">
            {images.length} images · {formatSpend(spent)} billed by kie.ai
            {mismatched > 0 && (
              <span className="text-amber-400">
                {" "}
                · {mismatched} returned a different resolution than requested
              </span>
            )}
          </p>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={images.length === 0 || zipping}
            onClick={() => void handleZip()}
          >
            {zipping ? "Zipping…" : "Download all (ZIP)"}
          </button>
          <button
            type="button"
            className="btn-ghost text-xs hover:border-red-500 hover:text-red-400"
            disabled={images.length === 0}
            onClick={() => {
              if (confirm(`Delete all ${images.length} images from local storage?`)) {
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
      ) : images.length === 0 ? (
        <p className="py-8 text-center text-xs text-muted">
          Nothing generated yet. Results are stored in your browser&apos;s IndexedDB and
          survive a refresh.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {images.map((image) => (
            <ImageCard key={image.id} image={image} />
          ))}
        </div>
      )}
    </section>
  );
}
