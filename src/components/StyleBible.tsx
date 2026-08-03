"use client";

import { useGenerationStore } from "@/store/generationStore";

export function StyleBible({ disabled }: { disabled: boolean }) {
  const styleBible = useGenerationStore((state) => state.settings.styleBible);
  const setSettings = useGenerationStore((state) => state.setSettings);

  return (
    <section className="panel">
      <h2 className="panel-title">Style bible</h2>
      <textarea
        className="field resize-y font-mono leading-6"
        rows={3}
        value={styleBible}
        disabled={disabled}
        placeholder="consistent watercolor style, warm muted palette, same soft side lighting across every shot"
        onChange={(event) => setSettings({ styleBible: event.target.value })}
      />
      <p className="mt-2 text-xs text-muted">
        Prepended to every prompt in the batch — the main lever for a consistent look
        across a whole story.
      </p>
    </section>
  );
}
