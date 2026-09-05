"use client";

import { formatTime } from "@/lib/editor/format";
import { SHAPE_LABELS } from "@/lib/editor/shapes";
import { parseClock } from "@/lib/editor/timestamp";
import { useEditorStore } from "@/store/editorStore";
import { MAX_SHAPES, SHAPE_KINDS, type ShapeElement } from "@/types/editor";

/**
 * The drawn elements — boxes, circles and arrows placed over the picture.
 *
 * Everything here is a number, and the position is deliberately not among the
 * controls: a shape is dragged in the preview, which is the only way to place
 * one against the frame it has to line up with. The panel sets what the drag
 * cannot — what it is, how big, what colour, and when it shows.
 */
export function ShapeElements({ disabled }: { disabled: boolean }) {
  const shapes = useEditorStore((state) => state.shapes);
  const addShape = useEditorStore((state) => state.addShape);
  const updateShape = useEditorStore((state) => state.updateShape);
  const removeShape = useEditorStore((state) => state.removeShape);
  const clearShapes = useEditorStore((state) => state.clearShapes);

  const full = shapes.length >= MAX_SHAPES;
  // A new one lands after the last, so a run of them doesn't stack on one spot.
  const nextStart = shapes.length ? shapes[shapes.length - 1].start : 0;

  return (
    <section className="panel space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="panel-title mb-0">Shapes</p>
        {shapes.length > 0 && (
          <button
            type="button"
            disabled={disabled}
            onClick={clearShapes}
            className="text-xs text-muted hover:text-foreground disabled:opacity-40"
          >
            clear
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {SHAPE_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            disabled={disabled || full}
            onClick={() => addShape(kind, nextStart)}
            className="pill flex-1 px-2 py-1 text-center text-[11px] disabled:opacity-40"
          >
            + {SHAPE_LABELS[kind]}
          </button>
        ))}
      </div>

      {shapes.length === 0 ? (
        <p className="text-[11px] text-muted">
          Add one, then drag it in the preview to place it. Where you put it is
          where it renders — the export draws the same picture the preview does.
        </p>
      ) : (
        <p className="text-[11px] text-muted">
          {shapes.length} of {MAX_SHAPES} · drag any of them in the preview to
          reposition.
        </p>
      )}

      {shapes.map((shape) => (
        <ShapeRow
          key={shape.id}
          shape={shape}
          disabled={disabled}
          onChange={(patch) => updateShape(shape.id, patch)}
          onRemove={() => removeShape(shape.id)}
        />
      ))}
    </section>
  );
}

function ShapeRow({
  shape,
  disabled,
  onChange,
  onRemove,
}: {
  shape: ShapeElement;
  disabled: boolean;
  onChange: (patch: Partial<ShapeElement>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-line bg-surface px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-4 w-4 shrink-0 rounded-sm border border-line"
          style={{ background: shape.colour, opacity: Math.max(0.15, shape.opacity) }}
        />
        <span className="text-xs font-medium">{SHAPE_LABELS[shape.kind]}</span>
        <span className="font-mono text-[11px] text-muted">
          {Math.round(shape.x * 100)},{Math.round(shape.y * 100)}
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          className="ml-auto text-[11px] text-muted hover:text-red-400 disabled:opacity-40"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-1.5 text-[11px] text-muted">
          From
          <input
            type="text"
            defaultValue={formatTime(shape.start)}
            disabled={disabled}
            onBlur={(event) => {
              const seconds = parseClock(event.target.value);
              if (seconds === null) {
                event.target.value = formatTime(shape.start);
                return;
              }
              onChange({ start: Math.max(0, seconds) });
              event.target.value = formatTime(Math.max(0, seconds));
            }}
            className="field w-16 px-1.5 py-0.5 text-center font-mono text-[11px]"
          />
        </label>

        <label className="flex items-center gap-1.5 text-[11px] text-muted">
          For
          <input
            type="number"
            min={0.2}
            max={600}
            step={0.5}
            value={shape.duration}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                duration: Math.min(600, Math.max(0.2, Number(event.target.value) || 0.2)),
              })
            }
            className="field w-16 px-1.5 py-0.5 text-center font-mono text-[11px]"
          />
          s
        </label>

        <label className="flex items-center gap-1.5 text-[11px] text-muted">
          Colour
          <input
            type="color"
            value={shape.colour}
            disabled={disabled}
            onChange={(event) => onChange({ colour: event.target.value })}
            className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent disabled:opacity-40"
          />
        </label>
      </div>

      <Slider
        label="Width"
        value={shape.width}
        min={0.01}
        max={1}
        disabled={disabled}
        format={(value) => `${Math.round(value * 100)}%`}
        onChange={(width) => onChange({ width })}
      />
      <Slider
        label="Height"
        value={shape.height}
        min={0.01}
        max={1}
        disabled={disabled}
        format={(value) => `${Math.round(value * 100)}%`}
        onChange={(height) => onChange({ height })}
      />
      <Slider
        label="Opacity"
        value={shape.opacity}
        min={0}
        max={1}
        disabled={disabled}
        format={(value) => `${Math.round(value * 100)}%`}
        onChange={(opacity) => onChange({ opacity })}
      />
      {/* Zero fills the shape solid, which is the useful default for a
          highlight and useless for a box meant to frame something. */}
      <Slider
        label="Outline"
        value={shape.stroke}
        min={0}
        max={0.03}
        step={0.001}
        disabled={disabled}
        format={(value) => (value < 0.0005 ? "filled" : `${(value * 100).toFixed(1)}%`)}
        onChange={(stroke) => onChange({ stroke })}
      />
      <Slider
        label="Rotation"
        value={shape.rotation}
        min={-180}
        max={180}
        step={1}
        disabled={disabled}
        format={(value) => `${Math.round(value)}°`}
        onChange={(rotation) => onChange({ rotation })}
      />
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  disabled,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled: boolean;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-muted">
      <span className="w-14 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="min-w-0 flex-1 accent-[var(--accent)] disabled:opacity-40"
      />
      <span className="w-12 shrink-0 text-right font-mono">{format(value)}</span>
    </label>
  );
}
