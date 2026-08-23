"use client";

import { formatDuration } from "@/lib/editor/format";
import type { VoiceoverBatch } from "@/store/editorStore";

interface Props {
  batch: VoiceoverBatch;
  disabled: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (name: string) => void;
  onPacing: (patch: { maxGap?: number; keepGap?: number }) => void;
  onJoin: () => void;
}

const AUDIO_PATTERN = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;

/**
 * Turns a folder of takes into one narration bed.
 *
 * Recorded voiceover arrives as separate files with a beat of room tone at each
 * end and uneven pauses between sentences. Joined naively, every seam becomes a
 * two-second hole. This joins them in script order and shortens any pause past
 * the cap — leaving the short ones exactly as recorded, because a breath is
 * part of the performance and a silence is not.
 */
export function VoiceoverJoiner({
  batch,
  disabled,
  onAdd,
  onRemove,
  onPacing,
  onJoin,
}: Props) {
  const { files, busy, error, report, url, maxGap, keepGap } = batch;
  const busyOrDisabled = disabled || busy;

  return (
    <div className="panel space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="panel-title mb-0">Join voiceovers</p>
        {files.length > 0 && (
          <span className="text-[11px] text-muted">{files.length} takes</span>
        )}
      </div>

      {files.length === 0 ? (
        <p className="text-xs text-muted">
          Drop several takes named <span className="font-mono">1</span>,{" "}
          <span className="font-mono">2</span>, <span className="font-mono">3</span>… and
          they&rsquo;ll be joined in that order into one narration bed, with the
          long pauses shortened.
        </p>
      ) : (
        <ol className="max-h-40 space-y-1 overflow-y-auto">
          {files.map((file, index) => (
            <li
              key={file.name}
              className="flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1 text-xs"
            >
              <span className="w-5 shrink-0 text-right font-mono text-muted">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate" title={file.name}>
                {file.name}
              </span>
              <button
                type="button"
                disabled={busyOrDisabled}
                onClick={() => onRemove(file.name)}
                className="shrink-0 text-muted hover:text-red-400 disabled:opacity-40"
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
      )}

      <label
        className={`pill inline-block ${
          busyOrDisabled ? "pointer-events-none opacity-50" : "cursor-pointer"
        }`}
      >
        {files.length === 0 ? "Choose takes" : "Add more"}
        <input
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus"
          multiple
          className="hidden"
          disabled={busyOrDisabled}
          onChange={(event) => {
            const picked = [...(event.target.files ?? [])].filter(
              (file) => AUDIO_PATTERN.test(file.name) || file.type.startsWith("audio/")
            );
            event.target.value = "";
            if (picked.length) onAdd(picked);
          }}
        />
      </label>

      {files.length > 0 && (
        <>
          <label className="block">
            <span className="flex items-baseline justify-between text-xs text-muted">
              <span>Shorten pauses longer than</span>
              <span className="font-mono text-foreground">{maxGap.toFixed(1)}s</span>
            </span>
            <input
              type="range"
              min={0.3}
              max={4}
              step={0.1}
              value={maxGap}
              disabled={busyOrDisabled}
              onChange={(event) => onPacing({ maxGap: Number(event.target.value) })}
              className="mt-1 w-full accent-[var(--accent)] disabled:opacity-40"
            />
          </label>

          <label className="block">
            <span className="flex items-baseline justify-between text-xs text-muted">
              <span>…down to</span>
              <span className="font-mono text-foreground">{keepGap.toFixed(2)}s</span>
            </span>
            <input
              type="range"
              min={0.1}
              max={Math.max(0.2, maxGap)}
              step={0.05}
              value={keepGap}
              disabled={busyOrDisabled}
              onChange={(event) => onPacing({ keepGap: Number(event.target.value) })}
              className="mt-1 w-full accent-[var(--accent)] disabled:opacity-40"
            />
            <span className="text-[11px] text-muted">
              Anything shorter than the cap is left exactly as recorded — a
              breath between sentences is part of the read. Speech is never
              touched.
            </span>
          </label>

          <button
            type="button"
            onClick={onJoin}
            disabled={busyOrDisabled}
            className="btn-primary w-full"
          >
            {busy ? "Joining…" : `Join ${files.length} takes`}
          </button>
        </>
      )}

      {error && (
        <p className="rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {report && (
        <div className="space-y-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2">
          <p className="text-xs text-emerald-300">
            {report.parts} takes joined — {formatDuration(report.originalDuration)} became{" "}
            {formatDuration(report.duration)}.
          </p>
          <p className="text-[11px] text-emerald-200/80">
            {report.tightened} pause{report.tightened === 1 ? "" : "s"} shortened,{" "}
            {report.removed.toFixed(1)}s of dead air removed. It&rsquo;s loaded as the
            narration below.
          </p>
          {url && (
            <a
              href={url}
              download="narration.m4a"
              className="inline-block text-[11px] text-emerald-300 underline hover:text-emerald-200"
            >
              Download the joined track
            </a>
          )}
        </div>
      )}
    </div>
  );
}
