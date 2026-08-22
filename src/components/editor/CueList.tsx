"use client";

import { useMemo, useState } from "react";
import { formatDuration, formatTime } from "@/lib/editor/format";
import type { Timeline } from "@/lib/editor/timeline";
import type { EditorImage } from "@/store/editorStore";

interface Props {
  images: EditorImage[];
  timeline: Timeline;
  disabled: boolean;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}

/**
 * Every image, what its filename resolved to, and how long it ends up on
 * screen. This is where a mis-named file shows itself — the timeline is built
 * entirely out of these names, so being able to read the mapping back is the
 * difference between a puzzling export and an obvious typo.
 */
export function CueList({ images, timeline, disabled, onToggle, onRemove }: Props) {
  const [open, setOpen] = useState(false);

  const spans = useMemo(() => {
    const map = new Map<string, { start: number; end: number }>();
    for (const clip of timeline.clips) {
      if (clip.imageId) map.set(clip.imageId, { start: clip.start, end: clip.end });
    }
    return map;
  }, [timeline]);

  const ordered = useMemo(
    () =>
      [...images].sort((a, b) => {
        // Unreadable names sink to the bottom, where they're the first thing
        // you see when you come looking for what went wrong.
        if (a.seconds === null) return b.seconds === null ? a.label.localeCompare(b.label) : 1;
        if (b.seconds === null) return -1;
        return a.seconds - b.seconds || a.label.localeCompare(b.label);
      }),
    [images]
  );

  if (images.length === 0) return null;

  const unreadable = images.filter((image) => image.seconds === null).length;

  return (
    <section className="panel space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="panel-title mb-0">Cues</p>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="text-xs text-muted hover:text-foreground"
        >
          {open ? "Hide list" : `Show all ${images.length}`}
        </button>
      </div>

      {timeline.warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2">
          {timeline.warnings.slice(0, 8).map((warning) => (
            <li key={warning} className="text-xs text-amber-300">
              {warning}
            </li>
          ))}
          {timeline.warnings.length > 8 && (
            <li className="text-xs text-amber-300/70">
              …and {timeline.warnings.length - 8} more.
            </li>
          )}
        </ul>
      )}

      {!open && timeline.warnings.length === 0 && (
        <p className="text-xs text-muted">
          All {images.length} filenames read cleanly
          {unreadable > 0 ? ` except ${unreadable}` : ""}.
        </p>
      )}

      {open && (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-surface">
              <tr className="text-xs text-muted">
                <th className="py-1 pr-2 font-medium">File</th>
                <th className="py-1 pr-2 font-medium">Cue</th>
                <th className="py-1 pr-2 font-medium">On screen</th>
                <th className="py-1 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((image) => {
                const span = spans.get(image.id);
                return (
                  <tr
                    key={image.id}
                    className={`border-t border-line/60 ${
                      image.excluded ? "opacity-40" : ""
                    }`}
                  >
                    <td className="max-w-0 py-1.5 pr-2">
                      <span className="block truncate font-mono text-xs" title={image.label}>
                        {image.label}
                      </span>
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs whitespace-nowrap">
                      {image.seconds === null ? (
                        <span className="text-amber-400">no cue</span>
                      ) : (
                        formatTime(image.seconds, true)
                      )}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs whitespace-nowrap text-muted">
                      {span ? formatDuration(span.end - span.start) : "—"}
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => onToggle(image.id)}
                        className="text-xs text-muted hover:text-foreground disabled:opacity-40"
                      >
                        {image.excluded ? "use" : "skip"}
                      </button>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => onRemove(image.id)}
                        className="ml-2 text-xs text-muted hover:text-red-400 disabled:opacity-40"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
