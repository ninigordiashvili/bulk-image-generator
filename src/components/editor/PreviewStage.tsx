"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatTime } from "@/lib/editor/format";
import { BitmapCache } from "@/lib/editor/media";
import { clipAt, clipZoom, type Timeline } from "@/lib/editor/timeline";
import type { AudioTrack, EditorImage } from "@/store/editorStore";
import type { ZoomDirection } from "@/types/editor";
import { Filmstrip } from "./Filmstrip";

/** The canvas the preview draws into. Fixed, and independent of export size —
 *  it only has to show the framing and the motion, not the final pixels. */
const PREVIEW_WIDTH = 1280;
const PREVIEW_HEIGHT = 720;

/** How far ahead to decode, in clips. Two covers a cut arriving mid-frame. */
const PREFETCH = 2;

interface Props {
  timeline: Timeline;
  images: EditorImage[];
  audio: AudioTrack | null;
  zoom: ZoomDirection;
  zoomAmount: number;
  thumbnails: Map<string, string>;
  onToggleImage: (id: string) => void;
}

export function PreviewStage({
  timeline,
  images,
  audio,
  zoom,
  zoomAmount,
  thumbnails,
  onToggleImage,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readoutRef = useRef<HTMLSpanElement | null>(null);

  const [playing, setPlaying] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  // The clock lives in refs: it advances sixty times a second, and putting it
  // in state would re-render the whole editor at that rate.
  const timeRef = useRef(0);
  const originRef = useRef(0);
  const playingRef = useRef(false);

  const { clips, total } = timeline;

  const byId = useMemo(() => {
    const map = new Map<string, EditorImage>();
    for (const image of images) map.set(image.id, image);
    return map;
  }, [images]);

  const cacheRef = useRef<BitmapCache | null>(null);
  useEffect(() => {
    if (cacheRef.current == null) cacheRef.current = new BitmapCache(PREVIEW_WIDTH);
    const cache = cacheRef.current;
    return () => {
      cache.dispose();
      cacheRef.current = null;
    };
  }, []);

  const currentTime = useCallback(() => {
    const element = audioRef.current;
    if (audio && element) return element.currentTime;
    if (!playingRef.current) return timeRef.current;
    return (performance.now() - originRef.current) / 1000;
  }, [audio]);

  const seek = useCallback(
    (time: number) => {
      const clamped = Math.max(0, Math.min(total || 0, time));
      timeRef.current = clamped;
      originRef.current = performance.now() - clamped * 1000;
      const element = audioRef.current;
      if (element) element.currentTime = clamped;
    },
    [total]
  );

  const pause = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    audioRef.current?.pause();
    timeRef.current = currentTime();
  }, [currentTime]);

  const play = useCallback(() => {
    if (total <= 0) return;
    // Replay from the top rather than sitting stuck at the end.
    if (timeRef.current >= total - 0.05) seek(0);
    originRef.current = performance.now() - timeRef.current * 1000;
    playingRef.current = true;
    setPlaying(true);
    void audioRef.current?.play().catch(() => {
      playingRef.current = false;
      setPlaying(false);
    });
  }, [seek, total]);

  const toggle = useCallback(() => {
    if (playingRef.current) pause();
    else play();
  }, [pause, play]);

  const step = useCallback(
    (direction: -1 | 1) => {
      const index = Math.max(0, clipAt(clips, currentTime()));
      const target = clips[index + direction];
      // Stepping back from mid-clip goes to this clip's start first.
      if (direction === -1 && currentTime() - clips[index]?.start > 0.35) {
        seek(clips[index].start);
      } else if (target) {
        seek(target.start);
      }
    },
    [clips, currentTime, seek]
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === " ") {
        event.preventDefault();
        toggle();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, toggle]);

  // ---- the draw loop ----
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    const cache = cacheRef.current;
    if (!canvas || !context || !cache) return;

    let frame = 0;
    let lastIndex = -2;
    let lastReadout = -1;

    const render = () => {
      frame = requestAnimationFrame(render);

      let time = currentTime();
      // Reaching the end — or having the end move behind you because the
      // timeline changed underneath — stops playback and parks the playhead.
      if (playingRef.current && (total <= 0 || time >= total)) {
        time = Math.max(0, total);
        playingRef.current = false;
        setPlaying(false);
        audioRef.current?.pause();
      }
      timeRef.current = time;

      const index = clipAt(clips, time);
      const clip = index >= 0 ? clips[index] : null;

      context.fillStyle = "#000000";
      context.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);

      const source = clip?.sourceId ? byId.get(clip.sourceId) : null;

      if (clip && source && clip.kind !== "still") {
        // A video clip is played rather than decoded frame by frame: one
        // element, its source swapped at each cut. That costs a beat at the
        // cut itself, which is a fair trade for smooth motion in between.
        const element = videoRef.current;
        if (element) {
          if (element.dataset.clip !== clip.sourceId) {
            element.dataset.clip = clip.sourceId ?? "";
            element.src = source.url;
            element.load();
          }
          const slot = clip.end - clip.start;
          const footage = source.duration ?? slot;
          // Motion clips are slowed to fill their slot, so preview time runs
          // slower than wall time by the same factor the render will use.
          const stretch =
            clip.kind === "motion" && footage > 0
              ? Math.min(2.5, Math.max(1, slot / footage))
              : 1;
          const want = Math.max(0, Math.min(footage, (time - clip.start) / stretch));

          if (playingRef.current) {
            if (element.paused) void element.play().catch(() => {});
            // Only correct real drift; nudging every frame would stutter.
            if (Math.abs(element.currentTime - want) > 0.2) element.currentTime = want;
            element.playbackRate = Math.max(0.0625, Math.min(4, 1 / stretch));
          } else {
            if (!element.paused) element.pause();
            if (Math.abs(element.currentTime - want) > 0.02) element.currentTime = want;
          }

          if (element.readyState >= 2) {
            drawFitted(context, element, element.videoWidth, element.videoHeight, 1);
          }
        }
      } else if (clip?.sourceId && source) {
        cache.request(clip.sourceId, source.file);
        const bitmap = cache.get(clip.sourceId);
        if (bitmap) drawZoomed(context, bitmap, clip.start, clip.end, time, index);

        // Warm the next couple so a cut doesn't land on an empty cache.
        for (let ahead = 1; ahead <= PREFETCH; ahead++) {
          const upcoming = clips[index + ahead];
          const next = upcoming?.sourceId ? byId.get(upcoming.sourceId) : null;
          if (upcoming?.sourceId && next && upcoming.kind === "still") {
            cache.request(upcoming.sourceId, next.file);
          }
        }
      }

      if (playheadRef.current && total > 0) {
        playheadRef.current.style.left = `${(time / total) * 100}%`;
      }

      // Text and the filmstrip highlight only change on human timescales.
      const tenths = Math.floor(time * 10);
      if (tenths !== lastReadout && readoutRef.current) {
        lastReadout = tenths;
        readoutRef.current.textContent = formatTime(time, true);
      }
      if (index !== lastIndex) {
        lastIndex = index;
        setActiveIndex(Math.max(0, index));
      }
    };

    const drawFitted = (
      ctx: CanvasRenderingContext2D,
      source: CanvasImageSource,
      naturalWidth: number,
      naturalHeight: number,
      scale: number
    ) => {
      if (!naturalWidth || !naturalHeight) return;
      // ffmpeg letterboxes into the frame and then magnifies the whole frame
      // about its centre, so any bars grow with it. Scaling the fitted picture
      // about the centre of the canvas is the same operation.
      const fit =
        Math.min(PREVIEW_WIDTH / naturalWidth, PREVIEW_HEIGHT / naturalHeight) * scale;
      const width = naturalWidth * fit;
      const height = naturalHeight * fit;
      ctx.drawImage(
        source,
        (PREVIEW_WIDTH - width) / 2,
        (PREVIEW_HEIGHT - height) / 2,
        width,
        height
      );
    };

    const drawZoomed = (
      ctx: CanvasRenderingContext2D,
      bitmap: ImageBitmap,
      start: number,
      end: number,
      time: number,
      index: number
    ) => {
      const direction = clips[index]?.kind === "still" ? clipZoom(zoom, index) : "none";
      const span = Math.max(0.0001, end - start);
      const progress = Math.min(1, Math.max(0, (time - start) / span));
      const scale =
        direction === "in"
          ? 1 + zoomAmount * progress
          : direction === "out"
            ? 1 + zoomAmount * (1 - progress)
            : 1;

      drawFitted(ctx, bitmap, bitmap.width, bitmap.height, scale);
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [byId, clips, currentTime, total, zoom, zoomAmount]);

  const onScrub = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || total <= 0) return;
    seek(((event.clientX - rect.left) / rect.width) * total);
  };

  const empty = clips.length === 0;

  return (
    <section className="panel space-y-3">
      <div className="relative overflow-hidden rounded-lg bg-black">
        <canvas
          ref={canvasRef}
          width={PREVIEW_WIDTH}
          height={PREVIEW_HEIGHT}
          onClick={toggle}
          className="block aspect-video w-full cursor-pointer"
        />
        {empty && (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            <p className="text-sm text-muted">
              Drop an audio track and a folder of timestamped images to build a
              timeline.
            </p>
          </div>
        )}
        {/* Off-screen, and only ever the source for a canvas draw. */}
        <video ref={videoRef} muted playsInline preload="auto" className="hidden" />
        {audio && (
          <audio
            key={audio.url}
            ref={audioRef}
            src={audio.url}
            preload="auto"
            className="hidden"
          />
        )}
      </div>

      {/* Proportional ruler: one tick per cut, so the rhythm of the edit is
          visible at a glance even with a hundred images on a ten-minute bed. */}
      <div
        onMouseDown={onScrub}
        className="relative h-8 cursor-pointer overflow-hidden rounded-lg border border-line bg-surface-2"
      >
        {total > 0 &&
          clips.map((clip) => (
            <div
              key={clip.index}
              className={`absolute top-0 bottom-0 border-l ${
                clip.sourceId ? "border-accent/40" : "border-line bg-black/40"
              }`}
              style={{
                left: `${(clip.start / total) * 100}%`,
                width: `${((clip.end - clip.start) / total) * 100}%`,
              }}
            />
          ))}
        <div
          ref={playheadRef}
          className="pointer-events-none absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-white"
          style={{ left: "0%" }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => step(-1)} disabled={empty} className="pill">
          ‹ Prev
        </button>
        <button type="button" onClick={toggle} disabled={empty} className="btn-primary">
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" onClick={() => step(1)} disabled={empty} className="pill">
          Next ›
        </button>

        <span className="ml-2 font-mono text-sm text-foreground">
          <span ref={readoutRef}>0:00</span>
          <span className="text-muted"> / {formatTime(total)}</span>
        </span>

        <span className="ml-auto text-xs text-muted">
          Space to play · ← → to step between images
        </span>
      </div>

      <Filmstrip
        clips={clips}
        activeIndex={activeIndex}
        thumbnails={thumbnails}
        onSeek={seek}
        onToggleImage={onToggleImage}
      />
    </section>
  );
}
