"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatTime } from "@/lib/editor/format";
import type { Timeline, TimelineClip } from "@/lib/editor/timeline";
import type { EditorImage } from "@/store/editorStore";
import { MIN_CLIP_SECONDS } from "@/store/editorStore";

interface Props {
  timeline: Timeline;
  images: EditorImage[];
  thumbnails: Map<string, string>;
  edits: Record<string, { start?: number; length?: number }>;
  disabled: boolean;
  /** Reads the preview's clock on an animation frame, rather than as a prop. */
  readTime: () => number;
  onSeek: (time: number) => void;
  onStart: (id: string, start: number) => void;
  onLength: (id: string, length: number | null) => void;
  onReset: (id: string) => void;
  onResetAll: () => void;
  onToggle: (id: string) => void;
}

/** Zoom steps in pixels per second. Ten minutes at 4px/s is a 2400px track. */
const ZOOMS = [1, 2, 4, 8, 16, 32, 64];
const TRACK_HEIGHT = 74;

/**
 * The step that comes closest to showing the whole thing at once without
 * overflowing. A minute of material and seventeen minutes of it want very
 * different scales, and starting either one at a fixed number is wrong for the
 * other — a minute at 2px/s is a row of slivers.
 */
function fitZoom(total: number, width: number): number {
  if (total <= 0) return 8;
  const ideal = width / total;
  const fits = ZOOMS.filter((z) => z <= ideal);
  return fits.length ? fits[fits.length - 1] : ZOOMS[0];
}

type Drag =
  | { kind: "move"; id: string; grabbedAt: number; from: number }
  | { kind: "resize"; id: string; from: number; startedAt: number };

/**
 * The timeline as something you can take hold of.
 *
 * Filenames place everything to begin with, and for a batch of a hundred that
 * is the only sane way to do it. But the last ten per cent of an edit is always
 * "that one needs another second" — and until now the only way to say so was to
 * rename the file and drop the folder again.
 *
 * Dragging writes an override against the visual's id. The cue underneath is
 * never touched, so any clip can be handed back to its filename, one at a time
 * or all at once.
 */
export function TimelineEditor({
  timeline,
  images,
  thumbnails,
  edits,
  disabled,
  readTime,
  onSeek,
  onStart,
  onLength,
  onReset,
  onResetAll,
  onToggle,
}: Props) {
  const { clips, total } = timeline;
  // Fitted once, from the first timeline that has a length; after that it is
  // the user's to set, and re-fitting under them as clips move would be rude.
  const [zoom, setZoom] = useState(0);
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || total <= 0) return;
    fitted.current = true;
    // The scroller, not the track: the track is sized *from* the zoom, so
    // measuring it would just feed the starting guess back to itself.
    const width = scrollerRef.current?.clientWidth ?? 900;
    setZoom(fitZoom(total, Math.max(320, width - 16)));
  }, [total]);
  const scale = zoom || fitZoom(total, 900);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);

  const byId = useMemo(() => new Map(images.map((i) => [i.id, i])), [images]);
  const width = Math.max(320, total * scale);
  const editedCount = Object.keys(edits).length;

  // The playhead is moved directly rather than through state: the preview
  // advances it sixty times a second and this component must not re-render at
  // that rate with a hundred clips in it.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const node = playheadRef.current;
      if (node) node.style.left = `${readTime() * scale}px`;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [readTime, scale]);

  const timeAt = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return 0;
      return Math.max(0, Math.min(total, (clientX - rect.left) / scale));
    },
    [total, scale]
  );

  // Dragging is tracked on the window, so the pointer may leave the clip — or
  // the track — without the drag sticking to the cursor.
  useEffect(() => {
    if (!drag) return;

    const onMove = (event: PointerEvent) => {
      const at = timeAt(event.clientX);
      if (drag.kind === "move") {
        const next = Math.max(0, at - drag.grabbedAt);
        onStart(drag.id, next);
        setHint(`${formatTime(next, true)}`);
      } else {
        const next = Math.max(MIN_CLIP_SECONDS, at - drag.startedAt);
        onLength(drag.id, next);
        setHint(`${next.toFixed(2)}s`);
      }
    };
    const stop = () => { setDrag(null); setHint(null); };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [drag, timeAt, onStart, onLength]);

  /** Ticks thinned so the labels stay readable at any zoom. */
  const ticks = useMemo(() => {
    if (total <= 0) return [];
    const target = 90; // pixels between labels
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => s * scale >= target) ?? steps[steps.length - 1];
    const out: number[] = [];
    for (let t = 0; t <= total; t += step) out.push(t);
    return out;
  }, [total, scale]);

  if (clips.length === 0) return null;

  return (
    <section className="panel space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="panel-title mb-0">Timeline</p>
          <p className="mt-0.5 text-[11px] text-muted">
            Drag a clip to move it, its right edge to change how long it holds.
            A removed clip comes back from the list below.
            {editedCount > 0 && (
              <span className="text-accent"> {editedCount} edited by hand.</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {editedCount > 0 && (
            <button
              type="button"
              disabled={disabled}
              onClick={onResetAll}
              className="pill px-2 py-1 text-xs disabled:opacity-40"
              title="Put every clip back where its filename says"
            >
              Reset all
            </button>
          )}
          <button
            type="button"
            onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(scale) - 1)] ?? scale)}
            disabled={scale === ZOOMS[0]}
            className="pill px-2 py-1 text-xs disabled:opacity-40"
          >
            −
          </button>
          <span className="w-14 text-center font-mono text-[11px] text-muted">
            {scale}px/s
          </span>
          <button
            type="button"
            onClick={() =>
              setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(scale) + 1)] ?? scale)
            }
            disabled={scale === ZOOMS[ZOOMS.length - 1]}
            className="pill px-2 py-1 text-xs disabled:opacity-40"
          >
            +
          </button>
        </div>
      </div>

      <div
        ref={scrollerRef}
        className="overflow-x-auto overflow-y-hidden rounded-lg border border-line bg-surface-2"
      >
        <div style={{ width }} className="relative select-none">
          {/* Ruler */}
          <div className="relative h-5 border-b border-line">
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute top-0 border-l border-line pl-1 font-mono text-[10px] text-muted"
                style={{ left: t * scale }}
              >
                {formatTime(t)}
              </span>
            ))}
          </div>

          {/* Clips */}
          <div
            ref={trackRef}
            onPointerDown={(event) => {
              // A press on the empty track is a seek, the same as the ruler in
              // the preview. Presses on a clip stop before they reach here.
              if (event.target === event.currentTarget) onSeek(timeAt(event.clientX));
            }}
            className="relative"
            style={{ height: TRACK_HEIGHT }}
          >
            {clips.map((clip) => (
              <ClipBlock
                key={`${clip.sourceId ?? "gap"}-${clip.index}`}
                clip={clip}
                zoom={scale}
                source={clip.sourceId ? byId.get(clip.sourceId) : undefined}
                thumbnail={clip.sourceId ? thumbnails.get(clip.sourceId) : undefined}
                edited={Boolean(clip.sourceId && edits[clip.sourceId])}
                dragging={drag?.id === clip.sourceId}
                disabled={disabled}
                onSeek={onSeek}
                selected={clip.sourceId === selected}
                onSelect={() => setSelected(clip.sourceId)}
                onGrab={(kind, clientX) => {
                  if (!clip.sourceId || disabled) return;
                  setSelected(clip.sourceId);
                  setDrag(
                    kind === "move"
                      ? {
                          kind,
                          id: clip.sourceId,
                          // Where inside the clip it was taken hold of, so it
                          // moves with the cursor instead of jumping so its
                          // start lands under it.
                          grabbedAt: timeAt(clientX) - clip.start,
                          from: clip.start,
                        }
                      : { kind, id: clip.sourceId, from: clip.start, startedAt: clip.start }
                  );
                }}
                onReset={() => clip.sourceId && onReset(clip.sourceId)}
                onToggle={() => clip.sourceId && onToggle(clip.sourceId)}
              />
            ))}
            <div
              ref={playheadRef}
              className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 -translate-x-1/2 bg-white"
            />
          </div>
        </div>
      </div>

      {hint ? (
        <p className="text-center font-mono text-xs text-accent">{hint}</p>
      ) : (
        <Inspector
          clip={clips.find((c) => c.sourceId && c.sourceId === selected) ?? null}
          source={selected ? byId.get(selected) : undefined}
          edited={Boolean(selected && edits[selected])}
          disabled={disabled}
          onStart={onStart}
          onLength={onLength}
          onReset={onReset}
          onToggle={onToggle}
        />
      )}
    </section>
  );
}

function ClipBlock({
  clip,
  zoom,
  source,
  thumbnail,
  edited,
  selected,
  dragging,
  disabled,
  onSeek,
  onSelect,
  onGrab,
  onReset,
  onToggle,
}: {
  clip: TimelineClip;
  zoom: number;
  source: EditorImage | undefined;
  thumbnail: string | undefined;
  edited: boolean;
  selected: boolean;
  dragging: boolean;
  disabled: boolean;
  onSeek: (time: number) => void;
  onSelect: () => void;
  onGrab: (kind: "move" | "resize", clientX: number) => void;
  onReset: () => void;
  onToggle: () => void;
}) {
  const length = clip.end - clip.start;
  const width = Math.max(2, length * zoom);
  // Three thresholds, because a clip can be any width from a sliver to the
  // whole track: the thumbnail is the first thing to go, then the readouts,
  // and the buttons hang on longest — a two-second clip is exactly the one you
  // are most likely to want to remove.
  const showThumb = width > 96;
  const showReadout = width > 54;
  const showButtons = width > 30;

  // What the slot does to a motion clip's speed, which is the thing you are
  // actually choosing when you drag a four-second clip out to twelve.
  const speed =
    clip.kind === "motion" && source?.duration
      ? length / source.duration
      : null;

  const tint =
    clip.sourceId === null
      ? "border-line bg-black/50"
      : clip.kind === "avatar"
        ? "border-emerald-500/50 bg-emerald-500/10"
        : clip.kind === "motion"
          ? "border-sky-500/50 bg-sky-500/10"
          : "border-line bg-surface-1";

  return (
    <div
      className={`group absolute top-1 bottom-1 overflow-hidden rounded border ${tint} ${
        edited ? "ring-1 ring-accent" : ""
      } ${selected ? "ring-2 ring-white/70" : ""} ${dragging ? "z-10 opacity-80" : ""}`}
      style={{ left: clip.start * zoom, width }}
      title={`${clip.label} · ${formatTime(clip.start, true)} → ${formatTime(clip.end, true)} · ${length.toFixed(2)}s${
        speed ? ` · ${speed.toFixed(2)}x length` : ""
      }`}
    >
      <div
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (clip.sourceId) {
            onSelect();
            onGrab("move", event.clientX);
          } else {
            onSeek(clip.start);
          }
        }}
        onDoubleClick={() => onSeek(clip.start)}
        className={`flex h-full items-stretch ${
          clip.sourceId && !disabled ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
        }`}
      >
        {thumbnail && showThumb && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnail}
            alt=""
            draggable={false}
            className="h-full w-12 shrink-0 object-cover opacity-70"
          />
        )}
        <div className="min-w-0 flex-1 px-1 py-0.5">
          <p className="truncate text-[10px] leading-tight text-foreground/90">
            {clip.label}
          </p>
          {showReadout && (
            <>
              <p className="font-mono text-[10px] leading-tight text-muted">
                {length.toFixed(1)}s
              </p>
              {speed !== null && (
                <p
                  className={`font-mono text-[10px] leading-tight ${
                    speed > 1.01 ? "text-sky-300" : speed < 0.99 ? "text-amber-300" : "text-muted"
                  }`}
                >
                  {speed > 1.01
                    ? `${(1 / speed).toFixed(2)}x slow`
                    : speed < 0.99
                      ? `${(1 / speed).toFixed(2)}x fast`
                      : "1x"}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {clip.sourceId && !disabled && (
        <>
          {/* The grab strip for length. Wide enough to hit, and it lights up on
              hover so it is discoverable without a legend. */}
          <div
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onGrab("resize", event.clientX);
            }}
            className="absolute top-0 right-0 bottom-0 w-2 cursor-ew-resize bg-accent/0 transition group-hover:bg-accent/60"
            title="Drag to change how long this holds"
          />
          {showButtons && (
            <div className="absolute top-0.5 right-3 hidden gap-0.5 group-hover:flex">
              {edited && (
                <button
                  type="button"
                  onClick={onReset}
                  title="Back to the filename's timing"
                  className="rounded bg-black/70 px-1 text-[10px] text-white/80 hover:text-white"
                >
                  ↺
                </button>
              )}
              <button
                type="button"
                onClick={onToggle}
                title="Take this out of the timeline"
                className="rounded bg-black/70 px-1 text-[10px] text-white/80 hover:text-red-400"
              >
                ✕
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Numbers for the clip in hand.
 *
 * Dragging is the fast way to say "about there"; this is how you say "exactly
 * 3.5 seconds". It also carries the remove and reset buttons, because a clip
 * two seconds long is a few pixels wide at a readable zoom and hanging its only
 * controls inside it makes the short clips — the ones most likely to need
 * fixing — the hardest to reach.
 */
function Inspector({
  clip,
  source,
  edited,
  disabled,
  onStart,
  onLength,
  onReset,
  onToggle,
}: {
  clip: TimelineClip | null;
  source: EditorImage | undefined;
  edited: boolean;
  disabled: boolean;
  onStart: (id: string, start: number) => void;
  onLength: (id: string, length: number | null) => void;
  onReset: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  if (!clip?.sourceId) {
    return (
      <p className="text-center text-[11px] text-muted">
        Click a clip to set its timing exactly.
      </p>
    );
  }

  const id = clip.sourceId;
  const length = clip.end - clip.start;
  const speed = clip.kind === "motion" && source?.duration ? length / source.duration : null;

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg bg-surface-2 px-2 py-1.5">
      <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={clip.label}>
        {clip.label}
      </span>

      <label className="text-[11px] text-muted">
        Starts
        <input
          type="number"
          step={0.1}
          min={0}
          value={Number(clip.start.toFixed(2))}
          disabled={disabled}
          onChange={(event) => onStart(id, Number(event.target.value) || 0)}
          className="field mt-0.5 block w-20 px-1.5 py-1 font-mono text-xs"
        />
      </label>

      <label className="text-[11px] text-muted">
        Holds
        <input
          type="number"
          step={0.1}
          min={MIN_CLIP_SECONDS}
          value={Number(length.toFixed(2))}
          disabled={disabled}
          onChange={(event) =>
            onLength(id, Math.max(MIN_CLIP_SECONDS, Number(event.target.value) || MIN_CLIP_SECONDS))
          }
          className="field mt-0.5 block w-20 px-1.5 py-1 font-mono text-xs"
        />
      </label>

      {speed !== null && source?.duration && (
        <span className="pb-1 text-[11px] text-muted">
          {source.duration.toFixed(1)}s of footage —{" "}
          <span className={speed > 1.01 ? "text-sky-300" : speed < 0.99 ? "text-amber-300" : ""}>
            {speed > 1.01
              ? `${(1 / speed).toFixed(2)}x slow motion`
              : speed < 0.99
                ? `${(1 / speed).toFixed(2)}x sped up`
                : "normal speed"}
          </span>
        </span>
      )}
      {clip.kind === "avatar" && (
        <span className="pb-1 text-[11px] text-muted">
          talking clip — changing this moves it out of sync
        </span>
      )}

      <button
        type="button"
        disabled={disabled || !edited}
        onClick={() => onReset(id)}
        className="pill px-2 py-1 text-xs disabled:opacity-40"
        title="Back to the timing in the filename"
      >
        Reset
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onToggle(id)}
        className="pill px-2 py-1 text-xs text-red-300 disabled:opacity-40"
        title="Take this out of the timeline"
      >
        Remove
      </button>
    </div>
  );
}
