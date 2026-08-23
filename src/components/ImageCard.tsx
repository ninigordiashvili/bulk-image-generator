"use client";

import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { downloadImage, fileNameFor } from "@/lib/download";
import { useGenerationStore } from "@/store/generationStore";
import type { GeneratedImage } from "@/types";

const PREVIEW_MAX = 620;

export function ImageCard({ image }: { image: GeneratedImage }) {
  const removeImage = useGenerationStore((state) => state.removeImage);
  const cardRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ left: number; top: number } | null>(null);

  const ratio =
    image.width > 0 && image.height > 0
      ? image.width / image.height
      : ratioFromAspect(image.aspectRatio);

  const src = `data:${image.mimeType};base64,${image.base64}`;

  // Anchored to the card, clamped into the viewport — rendered through a portal so
  // the gallery's overflow/stacking context can't clip it.
  const openPreview = useCallback(() => {
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(PREVIEW_MAX, window.innerWidth - 32);
    const height = width / ratio;
    const left = clamp(
      rect.left + rect.width / 2 - width / 2,
      16,
      window.innerWidth - width - 16
    );
    const top = clamp(
      rect.top + rect.height / 2 - height / 2,
      16,
      Math.max(16, window.innerHeight - height - 16)
    );
    setPreview({ left, top });
  }, [ratio]);

  return (
    <>
      <div
        ref={cardRef}
        className="relative overflow-hidden rounded-lg border border-line bg-surface-2"
      >
        {/* Hover-to-preview is scoped to the image itself. It used to sit on the
            whole card, which meant the preview also opened over the action bar
            and swallowed it. */}
        <div
          className="relative w-full"
          style={{ aspectRatio: String(ratio) }}
          onMouseEnter={openPreview}
          onMouseLeave={() => setPreview(null)}
        >
          <Image src={src} alt={image.prompt} fill unoptimized className="object-cover" />
        </div>

        {/* The filename, before you download rather than after. With #cue
            naming the name *is* the timestamp the shot belongs at, so being
            able to read it off the card is how you check a batch lined up. */}
        <p
          className="truncate border-t border-line px-2 py-1 font-mono text-[11px] text-foreground/80"
          title={fileNameFor(image)}
        >
          {fileNameFor(image)}
        </p>

        <div className="pointer-events-none absolute top-1.5 left-1.5 flex flex-wrap gap-1">
          {image.referencedCharacterIds.length > 0 && (
            <span className="badge">
              {image.referencedCharacterIds.map((id) => `@${id}`).join(" ")}
            </span>
          )}
          <span
            className={`badge ${image.resolutionMismatch ? "bg-amber-500/85 text-black" : ""}`}
            title={
              image.resolutionMismatch
                ? `Requested ${image.requestedResolution}, got ${image.resolution}`
                : image.resolution
            }
          >
            {image.resolutionMismatch
              ? `⚠ ${image.requestedResolution}→${image.resolution}`
              : image.resolution}
          </span>
        </div>

        {/* Always visible, never hover-gated: the preview portal covers the card,
            so a fade-in bar was revealed and hidden in the same motion. Entering
            the bar dismisses any open preview so the buttons stay clickable. */}
        <div
          className="absolute inset-x-0 bottom-7 flex items-center gap-1 bg-gradient-to-t from-black/85 to-transparent p-1.5"
          onMouseEnter={() => setPreview(null)}
        >
          <button
            type="button"
            className="badge cursor-pointer hover:bg-black/80"
            title={`Download ${fileNameFor(image)}`}
            onClick={() => downloadImage(image)}
          >
            ↓ Download
          </button>
          <button
            type="button"
            className="badge cursor-pointer hover:bg-red-600/80"
            title="Remove from the local gallery"
            onClick={() => void removeImage(image.id)}
          >
            Delete
          </button>
        </div>
      </div>

      {preview &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 overflow-hidden rounded-xl border border-line shadow-2xl shadow-black/70"
            style={{
              left: preview.left,
              top: preview.top,
              width: Math.min(PREVIEW_MAX, window.innerWidth - 32),
              aspectRatio: String(ratio),
            }}
          >
            <Image src={src} alt={image.prompt} fill unoptimized className="object-contain bg-black" />
            <p className="absolute inset-x-0 bottom-0 bg-black/75 px-3 py-2 text-xs text-white/90">
              {image.prompt}
              <span className="ml-2 text-white/50">
                {image.aspectRatio} · {image.resolution}
              </span>
            </p>
          </div>,
          document.body
        )}
    </>
  );
}

function ratioFromAspect(aspect: string): number {
  const [w, h] = aspect.split(":").map(Number);
  return w && h ? w / h : 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
