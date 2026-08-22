"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AudioSource } from "@/lib/audioSource";
import { formatTime } from "@/lib/editor/format";
import { secondsToCue } from "@/lib/editor/timestamp";

/** Grab zone for the selection edges, in pixels either side. */
const HANDLE_PX = 10;
const MIN_SECONDS = 1;
const CANVAS_HEIGHT = 200;

interface Props {
  source: AudioSource;
  /** Where the cut currently sits, if the row already has one. */
  start: number;
  duration: number;
  maxSeconds: number;
  onCancel: () => void;
  onConfirm: (start: number, duration: number) => void;
}

type Drag =
  | { kind: "move"; grabOffset: number }
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "new"; anchor: number };

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/**
 * Cuts a short clip out of a long recording.
 *
 * The whole point is being able to see *seconds*, so the waveform is tall, the
 * view zooms independently of the selection, and the ruler thins its labels as
 * you zoom so there is always a readable scale rather than a wall of ticks.
 */
export function AudioTrimmer({
  source,
  start,
  duration,
  maxSeconds,
  onCancel,
  onConfirm,
}: Props) {
  const total = source.duration;
  const ceiling = Math.min(maxSeconds, total);

  const [selStart, setSelStart] = useState(() => clamp(start, 0, Math.max(0, total - MIN_SECONDS)));
  const [selLength, setSelLength] = useState(() =>
    clamp(duration || Math.min(15, ceiling), MIN_SECONDS, ceiling)
  );

  // The visible window, independent of the selection.
  const [viewStart, setViewStart] = useState(0);
  const [viewSpan, setViewSpan] = useState(total);

  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const playheadRef = useRef<number>(-1);

  const selEnd = Math.min(total, selStart + selLength);

  // ---- coordinate helpers ----
  const widthRef = useRef(1000);
  const timeToX = useCallback(
    (time: number) => ((time - viewStart) / viewSpan) * widthRef.current,
    [viewStart, viewSpan]
  );
  const xToTime = useCallback(
    (x: number) => viewStart + (x / widthRef.current) * viewSpan,
    [viewStart, viewSpan]
  );

  const clampView = useCallback(
    (nextStart: number, nextSpan: number) => {
      const span = clamp(nextSpan, Math.min(1, total), total);
      return { start: clamp(nextStart, 0, Math.max(0, total - span)), span };
    },
    [total]
  );

  /** Keeps the selection in frame when it moves outside the current window. */
  const revealSelection = useCallback(() => {
    setViewStart((currentStart) => {
      const span = viewSpan;
      if (selStart >= currentStart && selEnd <= currentStart + span) return currentStart;
      const centred = selStart + (selEnd - selStart) / 2 - span / 2;
      return clamp(centred, 0, Math.max(0, total - span));
    });
  }, [selStart, selEnd, viewSpan, total]);

  // ---- drawing ----
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);

      const ratio = window.devicePixelRatio || 1;
      const cssWidth = canvas.clientWidth || 1;
      widthRef.current = cssWidth;
      if (canvas.width !== Math.round(cssWidth * ratio)) {
        canvas.width = Math.round(cssWidth * ratio);
        canvas.height = Math.round(CANVAS_HEIGHT * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      const w = cssWidth;
      const h = CANVAS_HEIGHT;
      const mid = h / 2;

      context.clearRect(0, 0, w, h);
      context.fillStyle = "#14141b";
      context.fillRect(0, 0, w, h);

      // Everything outside the selection is dimmed, so the cut reads instantly.
      const x0 = timeToX(selStart);
      const x1 = timeToX(selEnd);
      context.fillStyle = "#0b0b0f";
      context.fillRect(0, 0, Math.max(0, Math.min(w, x0)), h);
      context.fillRect(Math.max(0, Math.min(w, x1)), 0, w, h);

      const wave = source.waveform;
      if (wave) {
        const perSecond = wave.perSecond;
        for (let x = 0; x < w; x++) {
          const from = Math.floor((viewStart + (x / w) * viewSpan) * perSecond);
          const to = Math.max(
            from + 1,
            Math.floor((viewStart + ((x + 1) / w) * viewSpan) * perSecond)
          );
          let low = 0;
          let high = 0;
          for (let i = from; i < to && i < wave.min.length; i++) {
            if (wave.min[i] < low) low = wave.min[i];
            if (wave.max[i] > high) high = wave.max[i];
          }
          const inside = x >= x0 && x <= x1;
          context.fillStyle = inside ? "#7c6cf6" : "#3a3a4a";
          const top = mid - high * (mid - 6);
          const bottom = mid - low * (mid - 6);
          context.fillRect(x, top, 1, Math.max(1, bottom - top));
        }
      } else {
        context.fillStyle = "#3a3a4a";
        context.fillRect(0, mid - 1, w, 2);
      }

      // Selection edges.
      context.fillStyle = "#e9e9ef";
      context.fillRect(x0 - 1, 0, 2, h);
      context.fillRect(x1 - 1, 0, 2, h);
      context.fillStyle = "rgba(233,233,239,0.9)";
      for (const x of [x0, x1]) {
        context.fillRect(x - 4, mid - 18, 8, 36);
      }

      // Playhead.
      const at = playheadRef.current;
      if (at >= 0) {
        const px = timeToX(at);
        if (px >= 0 && px <= w) {
          context.fillStyle = "#ffffff";
          context.fillRect(px - 0.5, 0, 1, h);
        }
      }
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [source.waveform, selStart, selEnd, viewStart, viewSpan, timeToX]);

  // ---- ruler ticks ----
  const ticks = useMemo(() => {
    const targetCount = 10;
    const raw = viewSpan / targetCount;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((candidate) => candidate >= raw) ?? 600;
    const first = Math.ceil(viewStart / step) * step;
    const out: number[] = [];
    for (let t = first; t <= viewStart + viewSpan + 1e-6; t += step) out.push(t);
    return { step, values: out };
  }, [viewStart, viewSpan]);

  // ---- pointer interaction ----
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const time = xToTime(x);
    const xStart = timeToX(selStart);
    const xEnd = timeToX(selEnd);

    let drag: Drag;
    if (Math.abs(x - xStart) <= HANDLE_PX) drag = { kind: "start" };
    else if (Math.abs(x - xEnd) <= HANDLE_PX) drag = { kind: "end" };
    else if (x > xStart && x < xEnd) drag = { kind: "move", grabOffset: time - selStart };
    else {
      drag = { kind: "new", anchor: time };
      setSelStart(clamp(time, 0, Math.max(0, total - MIN_SECONDS)));
      setSelLength(MIN_SECONDS);
    }
    dragRef.current = drag;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const time = clamp(xToTime(x), 0, total);
    const drag = dragRef.current;

    if (!drag) {
      // Cursor feedback even when not dragging.
      const xStart = timeToX(selStart);
      const xEnd = timeToX(selEnd);
      const near = Math.abs(x - xStart) <= HANDLE_PX || Math.abs(x - xEnd) <= HANDLE_PX;
      event.currentTarget.style.cursor = near
        ? "ew-resize"
        : x > xStart && x < xEnd
          ? "grab"
          : "crosshair";
      return;
    }

    if (drag.kind === "move") {
      setSelStart(clamp(time - drag.grabOffset, 0, Math.max(0, total - selLength)));
    } else if (drag.kind === "start") {
      const end = selEnd;
      const next = clamp(time, Math.max(0, end - ceiling), end - MIN_SECONDS);
      setSelStart(next);
      setSelLength(end - next);
    } else if (drag.kind === "end") {
      setSelLength(clamp(time - selStart, MIN_SECONDS, Math.min(ceiling, total - selStart)));
    } else {
      const from = Math.min(drag.anchor, time);
      const to = Math.max(drag.anchor, time);
      const length = clamp(to - from, MIN_SECONDS, Math.min(ceiling, total - from));
      setSelStart(clamp(from, 0, Math.max(0, total - length)));
      setSelLength(length);
    }
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  /** Wheel zooms about the cursor, which is what makes a long track navigable. */
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const anchor = xToTime(x);
    const factor = event.deltaY > 0 ? 1.25 : 0.8;
    const next = clampView(anchor - (anchor - viewStart) * factor, viewSpan * factor);
    setViewStart(next.start);
    setViewSpan(next.span);
  };

  const zoomBy = (factor: number) => {
    const centre = viewStart + viewSpan / 2;
    const next = clampView(centre - (viewSpan * factor) / 2, viewSpan * factor);
    setViewStart(next.start);
    setViewSpan(next.span);
  };

  const fitSelection = () => {
    const pad = Math.max(0.5, selLength * 0.25);
    const next = clampView(selStart - pad, selLength + pad * 2);
    setViewStart(next.start);
    setViewSpan(next.span);
  };

  // ---- playback of the selection ----
  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    let frame = 0;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (element.paused) return;
      playheadRef.current = element.currentTime;
      if (element.currentTime >= selEnd - 0.01) {
        if (loop) element.currentTime = selStart;
        else {
          element.pause();
          setPlaying(false);
        }
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [selStart, selEnd, loop]);

  const togglePlay = useCallback(() => {
    const element = audioRef.current;
    if (!element) return;
    if (element.paused) {
      if (element.currentTime < selStart || element.currentTime >= selEnd) {
        element.currentTime = selStart;
      }
      void element.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      element.pause();
      setPlaying(false);
      playheadRef.current = element.currentTime;
    }
  }, [selStart, selEnd]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === " ") {
        event.preventDefault();
        togglePlay();
      } else if (event.key === "Escape") {
        onCancel();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const step = event.shiftKey ? 1 : 0.1;
        const delta = event.key === "ArrowLeft" ? -step : step;
        setSelStart((current) => clamp(current + delta, 0, Math.max(0, total - selLength)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, onCancel, total, selLength]);

  const outputName = `${source.name}_${secondsToCue(selStart)}`;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-5xl space-y-3 rounded-xl border border-line bg-surface p-5 shadow-2xl shadow-black/60">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold" title={source.fileName}>
              {source.fileName}
            </h2>
            <p className="text-xs text-muted">
              {formatTime(total, true)} total · drag to select, scroll to zoom
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" className="pill px-2 py-1 text-xs" onClick={() => zoomBy(0.5)}>
              Zoom in
            </button>
            <button type="button" className="pill px-2 py-1 text-xs" onClick={() => zoomBy(2)}>
              Zoom out
            </button>
            <button type="button" className="pill px-2 py-1 text-xs" onClick={fitSelection}>
              Fit cut
            </button>
            <button
              type="button"
              className="pill px-2 py-1 text-xs"
              onClick={() => {
                setViewStart(0);
                setViewSpan(total);
              }}
            >
              Whole track
            </button>
          </div>
        </div>

        {/* Ruler. The step adapts to the zoom so there is always a readable
            scale — per-second when you're close, per-minute when you're not. */}
        <div className="relative h-6 select-none border-b border-line">
          {ticks.values.map((t) => {
            const left = ((t - viewStart) / viewSpan) * 100;
            if (left < -2 || left > 102) return null;
            return (
              <div
                key={t}
                className="absolute bottom-0 flex flex-col items-center"
                style={{ left: `${left}%`, transform: "translateX(-50%)" }}
              >
                <span className="font-mono text-[10px] leading-none text-muted">
                  {ticks.step < 1 ? t.toFixed(1) : formatTime(t)}
                </span>
                <span className="mt-0.5 h-2 w-px bg-line" />
              </div>
            );
          })}
        </div>

        <div
          ref={wrapRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={onWheel}
          className="relative touch-none overflow-hidden rounded-lg border border-line"
          style={{ height: CANVAS_HEIGHT }}
        >
          <canvas ref={canvasRef} className="block h-full w-full" />
          {!source.waveform && (
            <div className="absolute inset-0 grid place-items-center text-xs text-muted">
              Reading the waveform…
            </div>
          )}
        </div>

        {/* Pan bar: with a long track zoomed in, this is how you move around
            without losing the selection. */}
        <input
          type="range"
          min={0}
          max={Math.max(0, total - viewSpan)}
          step={0.01}
          value={Math.min(viewStart, Math.max(0, total - viewSpan))}
          disabled={viewSpan >= total}
          onChange={(event) => setViewStart(Number(event.target.value))}
          className="w-full accent-[var(--accent)] disabled:opacity-30"
        />

        <div className="flex flex-wrap items-end gap-3">
          <button type="button" onClick={togglePlay} className="btn-primary">
            {playing ? "Pause" : "Play cut"}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={loop}
              onChange={(event) => setLoop(event.target.checked)}
              className="accent-[var(--accent)]"
            />
            Loop
          </label>

          <label className="text-xs text-muted">
            Start
            <input
              type="number"
              min={0}
              max={Math.max(0, total - MIN_SECONDS)}
              step={0.1}
              value={Number(selStart.toFixed(2))}
              onChange={(event) => {
                const next = clamp(
                  Number(event.target.value) || 0,
                  0,
                  Math.max(0, total - selLength)
                );
                setSelStart(next);
              }}
              onBlur={revealSelection}
              className="field mt-0.5 w-24 px-2 py-1 font-mono text-xs"
            />
          </label>

          <label className="text-xs text-muted">
            Length
            <input
              type="number"
              min={MIN_SECONDS}
              max={ceiling}
              step={0.1}
              value={Number(selLength.toFixed(2))}
              onChange={(event) =>
                setSelLength(
                  clamp(
                    Number(event.target.value) || MIN_SECONDS,
                    MIN_SECONDS,
                    Math.min(ceiling, total - selStart)
                  )
                )
              }
              onBlur={revealSelection}
              className="field mt-0.5 w-24 px-2 py-1 font-mono text-xs"
            />
          </label>

          <div className="flex gap-1">
            {[5, 10, 15, 20, 30].map((seconds) => (
              <button
                key={seconds}
                type="button"
                disabled={seconds > Math.min(ceiling, total)}
                onClick={() =>
                  setSelLength(clamp(seconds, MIN_SECONDS, Math.min(ceiling, total - selStart)))
                }
                className={`pill px-2 py-1 text-xs ${
                  Math.abs(selLength - seconds) < 0.05 ? "pill-active" : ""
                }`}
              >
                {seconds}s
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
          <p className="text-xs text-muted">
            Cut{" "}
            <span className="font-mono text-foreground">
              {formatTime(selStart, true)} → {formatTime(selEnd, true)}
            </span>{" "}
            · <span className="text-foreground">{selLength.toFixed(1)}s</span> · saves as{" "}
            <span className="font-mono text-foreground">{outputName}.mp4</span>
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onConfirm(selStart, selLength)}
              className="btn-primary"
            >
              Use this cut
            </button>
          </div>
        </div>

        <audio ref={audioRef} src={source.url} preload="auto" className="hidden" />
      </div>
    </div>
  );
}
