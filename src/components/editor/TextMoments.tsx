"use client";

import { useMemo, useState } from "react";
import { formatTime } from "@/lib/editor/format";
import { parseClock } from "@/lib/editor/timestamp";
import { useEditorStore } from "@/store/editorStore";
import { STYLE_ORDER, TEXT_STYLES, styleOf } from "@/lib/editor/textStyles";
import { MAX_MOMENTS, type MomentAnimation, type TextMoment } from "@/types/editor";

const ANIMATIONS: { value: MomentAnimation; label: string }[] = [
  { value: "rise", label: "Rise from below" },
  { value: "fade", label: "Fade in place" },
  { value: "drop", label: "Drop from above" },
];

/**
 * Picking the handful of moments in a script that get text on screen.
 *
 * Detection is the easy half and the wrong half to automate fully: a narration
 * is wall-to-wall numbers, and something that put every one of them on screen
 * would be worse than nothing. So the scan only ever *proposes* — the list
 * starts with nothing chosen, and a phrase appears in the film because it was
 * ticked here.
 */
export function TextMoments({ disabled }: { disabled: boolean }) {
  const transcript = useEditorStore((state) => state.transcript);
  const candidates = useEditorStore((state) => state.candidates);
  const moments = useEditorStore((state) => state.moments);
  const setTranscript = useEditorStore((state) => state.setTranscript);
  const addMoment = useEditorStore((state) => state.addMoment);
  const addBlankMoment = useEditorStore((state) => state.addBlankMoment);
  const updateMoment = useEditorStore((state) => state.updateMoment);
  const removeMoment = useEditorStore((state) => state.removeMoment);
  const clearMoments = useEditorStore((state) => state.clearMoments);

  const [showTranscript, setShowTranscript] = useState(false);
  const chosen = useMemo(() => new Set(moments.map((m) => m.id)), [moments]);
  const unchosen = candidates.filter((candidate) => !chosen.has(candidate.id));

  return (
    <section className="panel space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="panel-title mb-0">Text on screen</p>
        {moments.length > 0 && (
          <button
            type="button"
            disabled={disabled}
            onClick={clearMoments}
            className="text-xs text-muted hover:text-foreground disabled:opacity-40"
          >
            clear
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowTranscript((open) => !open)}
        className="pill w-full text-center text-xs"
      >
        {showTranscript ? "Hide transcript" : transcript ? "Edit transcript" : "Paste a transcript"}
      </button>

      {showTranscript && (
        <div className="space-y-1.5">
          <textarea
            value={transcript}
            disabled={disabled}
            onChange={(event) => setTranscript(event.target.value)}
            rows={6}
            spellCheck={false}
            placeholder={"0:00\nBack in 1969 nobody believed it.\n0:06\nHere are the Top 5 things they got wrong."}
            className="field w-full px-2 py-1.5 font-mono text-[11px] leading-relaxed"
          />
          <p className="text-[11px] text-muted">
            An SRT or VTT file, or the text copied out of YouTube&rsquo;s{" "}
            <span className="font-mono">… → Show transcript</span> panel. It has
            to carry times — that is how a phrase knows when it is spoken.
          </p>
        </div>
      )}

      {transcript.trim() && (
        <p className="text-[11px] text-muted">
          {candidates.length} phrase{candidates.length === 1 ? "" : "s"} found ·{" "}
          {moments.length} on screen
        </p>
      )}

      {unchosen.length > 0 && (
        <div className="max-h-52 space-y-1 overflow-y-auto">
          {unchosen.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              disabled={disabled || moments.length >= MAX_MOMENTS}
              onClick={() => addMoment(candidate)}
              className="flex w-full items-baseline gap-2 rounded-md bg-surface-2 px-2 py-1.5 text-left text-xs hover:bg-black/40 disabled:opacity-40"
            >
              <span className="w-12 shrink-0 font-mono text-[11px] text-muted">
                {formatTime(candidate.start)}
              </span>
              <span className="shrink-0 font-medium">{candidate.text}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted" title={candidate.context}>
                {candidate.context}
              </span>
              <span className="shrink-0 text-[11px] text-accent">+ add</span>
            </button>
          ))}
        </div>
      )}

      {moments.map((moment) => (
        <MomentRow
          key={moment.id}
          moment={moment}
          disabled={disabled}
          onChange={(patch) => updateMoment(moment.id, patch)}
          onRemove={() => removeMoment(moment.id)}
        />
      ))}

      <button
        type="button"
        disabled={disabled || moments.length >= MAX_MOMENTS}
        onClick={() => addBlankMoment(moments.length ? moments[moments.length - 1].start + 10 : 0)}
        className="pill w-full text-center text-xs disabled:opacity-40"
      >
        + Add one by hand
      </button>

      {moments.length > 0 && (
        <p className="text-[10px] text-muted">
          A new one copies the last one&rsquo;s style, size, timing and fades, so
          a run of them matches without setting each again.
        </p>
      )}
    </section>
  );
}

function MomentRow({
  moment,
  disabled,
  onChange,
  onRemove,
}: {
  moment: TextMoment;
  disabled: boolean;
  onChange: (patch: Partial<TextMoment>) => void;
  onRemove: () => void;
}) {
  const [startDraft, setStartDraft] = useState<string | null>(null);

  const commitStart = () => {
    const typed = startDraft;
    setStartDraft(null);
    if (typed === null) return;
    const parsed = parseClock(typed);
    if (parsed !== null) onChange({ start: Math.max(0, parsed) });
  };

  return (
    <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-2">
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          inputMode="numeric"
          value={startDraft ?? formatTime(moment.start, true)}
          disabled={disabled}
          title="When it appears. 3:14, #3-14, or plain seconds."
          onChange={(event) => setStartDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitStart();
            if (event.key === "Escape") setStartDraft(null);
          }}
          onBlur={commitStart}
          className="field w-20 shrink-0 px-1.5 py-1 font-mono text-xs"
        />
        <input
          type="text"
          value={moment.text}
          disabled={disabled}
          placeholder="What it says"
          onChange={(event) => onChange({ text: event.target.value })}
          className="field min-w-0 flex-1 px-2 py-1 text-xs"
        />
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          className="shrink-0 px-1 text-xs text-muted hover:text-red-400 disabled:opacity-40"
        >
          ✕
        </button>
      </div>

      <div className="space-y-1">
        <span className="text-[11px] text-muted">Style</span>
        <div className="grid grid-cols-5 gap-1">
          {STYLE_ORDER.map((name) => {
            const spec = TEXT_STYLES[name];
            const active = (moment.style ?? "modern") === name;
            return (
              <button
                key={name}
                type="button"
                disabled={disabled}
                title={spec.hint}
                onClick={() => onChange({ style: name })}
                className={`rounded-md border px-1 py-1.5 text-[10px] leading-tight transition ${
                  active
                    ? "border-accent bg-accent/15 text-foreground"
                    : "border-line bg-surface-2 text-muted hover:text-foreground"
                }`}
              >
                {/* Each button is set in its own face, so the choice is made by
                    looking rather than by reading the names. */}
                <span
                  className="block truncate"
                  style={{
                    fontFamily: spec.css,
                    fontWeight: spec.weight,
                    textTransform: spec.uppercase ? "uppercase" : "none",
                  }}
                >
                  Ag
                </span>
                <span className="mt-0.5 block truncate opacity-70">{spec.label}</span>
              </button>
            );
          })}
        </div>
        <p className="text-[10px] text-muted">{styleOf(moment.style).hint}</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11px] text-muted">
          <span className="flex items-baseline justify-between">
            <span>Holds for</span>
            <span className="font-mono text-foreground">{moment.duration.toFixed(1)}s</span>
          </span>
          <input
            type="range"
            min={1}
            max={12}
            step={0.5}
            value={moment.duration}
            disabled={disabled}
            onChange={(event) => onChange({ duration: Number(event.target.value) })}
            className="w-full accent-[var(--accent)] disabled:opacity-40"
          />
        </label>

        <label className="text-[11px] text-muted">
          <span className="flex items-baseline justify-between">
            <span>Darkening</span>
            <span className="font-mono text-foreground">
              {Math.round(moment.darken * 100)}%
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={0.8}
            step={0.05}
            value={moment.darken}
            disabled={disabled}
            onChange={(event) => onChange({ darken: Number(event.target.value) })}
            className="w-full accent-[var(--accent)] disabled:opacity-40"
          />
        </label>

        <label className="text-[11px] text-muted">
          <span className="flex items-baseline justify-between">
            <span>Size</span>
            <span className="font-mono text-foreground">
              {Math.round(moment.size * 100)}% of height
            </span>
          </span>
          <input
            type="range"
            min={0.04}
            max={0.3}
            step={0.01}
            value={moment.size}
            disabled={disabled}
            onChange={(event) => onChange({ size: Number(event.target.value) })}
            className="w-full accent-[var(--accent)] disabled:opacity-40"
          />
        </label>

        <label className="text-[11px] text-muted">
          <span className="flex items-baseline justify-between">
            <span>Fade in</span>
            <span className="font-mono text-foreground">{(moment.fadeIn ?? 0).toFixed(2)}s</span>
          </span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={moment.fadeIn ?? 0.35}
            disabled={disabled}
            onChange={(event) => onChange({ fadeIn: Number(event.target.value) })}
            className="w-full accent-[var(--accent)] disabled:opacity-40"
          />
        </label>

        <label className="text-[11px] text-muted">
          <span className="flex items-baseline justify-between">
            <span>Fade out</span>
            <span className="font-mono text-foreground">{(moment.fadeOut ?? 0).toFixed(2)}s</span>
          </span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={moment.fadeOut ?? 0.45}
            disabled={disabled}
            onChange={(event) => onChange({ fadeOut: Number(event.target.value) })}
            className="w-full accent-[var(--accent)] disabled:opacity-40"
          />
        </label>

        <label className="text-[11px] text-muted">
          <span>Arrives</span>
          <select
            value={moment.animation}
            disabled={disabled}
            onChange={(event) =>
              onChange({ animation: event.target.value as MomentAnimation })
            }
            className="field mt-0.5 w-full px-1.5 py-1 text-xs"
          >
            {ANIMATIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
