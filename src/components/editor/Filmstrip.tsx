"use client";

import { useEffect, useRef } from "react";
import { formatDuration, formatTime } from "@/lib/editor/format";
import type { TimelineClip } from "@/lib/editor/timeline";

interface Props {
  clips: TimelineClip[];
  activeIndex: number;
  thumbnails: Map<string, string>;
  onSeek: (time: number) => void;
  onToggleImage: (id: string) => void;
}

/**
 * The images in play order at a readable size. The ruler above it shows where
 * the cuts fall in time; this shows what's actually on screen at each one,
 * which is the thing you're checking when a hundred of them came out of a
 * batch generator.
 */
export function Filmstrip({
  clips,
  activeIndex,
  thumbnails,
  onSeek,
  onToggleImage,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // Follow playback, but only within the strip — scrolling the page out from
  // under someone every four seconds would be unusable.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const active = activeRef.current;
    if (!scroller || !active) return;
    const left = active.offsetLeft - scroller.clientWidth / 2 + active.clientWidth / 2;
    scroller.scrollTo({ left, behavior: "smooth" });
  }, [activeIndex]);

  if (clips.length === 0) return null;

  return (
    <div ref={scrollerRef} className="flex gap-2 overflow-x-auto pb-2">
      {clips.map((clip, index) => {
        const active = index === activeIndex;
        const thumb = clip.sourceId ? thumbnails.get(clip.sourceId) : undefined;
        return (
          <button
            key={clip.index}
            ref={active ? activeRef : undefined}
            type="button"
            onClick={() => onSeek(clip.start)}
            onDoubleClick={() => clip.sourceId && onToggleImage(clip.sourceId)}
            title={`${clip.label} — ${formatTime(clip.start, true)} for ${formatDuration(
              clip.end - clip.start
            )}${clip.sourceId ? "\nDouble-click to drop this image" : ""}`}
            className={`group relative w-28 shrink-0 overflow-hidden rounded-lg border transition ${
              active ? "border-accent" : "border-line hover:border-accent/60"
            }`}
          >
            <div className="aspect-video w-full bg-black">
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumb}
                  alt={clip.label}
                  className="h-full w-full object-contain"
                  loading="lazy"
                  draggable={false}
                />
              ) : (
                <div className="grid h-full place-items-center text-[10px] text-muted">
                  {clip.sourceId ? "…" : "black"}
                </div>
              )}
            </div>
            <div className="flex items-baseline justify-between px-1.5 py-1">
              <span className="font-mono text-[10px] text-foreground">
                {formatTime(clip.start)}
              </span>
              <span className="text-[10px] text-muted">
                {formatDuration(clip.end - clip.start)}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
