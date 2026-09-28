"use client";
import { HelpTip } from "./HelpTip";

import { useGenerationStore } from "@/store/generationStore";

export function StyleBible({ disabled }: { disabled: boolean }) {
  const styleBible = useGenerationStore((state) => state.settings.styleBible);
  const setSettings = useGenerationStore((state) => state.setSettings);

  return (
    <section className="panel">
      <div className="mb-3 flex items-center gap-2"><h2 className="panel-title mb-0">Style bible</h2><HelpTip label="Style bible help">
        Prepended to every prompt in the batch — the main lever for a consistent look
        across a whole story.
      </HelpTip></div>
      <textarea
        className="field resize-y font-mono leading-6"
        rows={3}
        value={styleBible}
        disabled={disabled}
        placeholder="consistent watercolor style, warm muted palette, same soft side lighting across every shot"
        onChange={(event) => setSettings({ styleBible: event.target.value })}
      />

    </section>
  );
}
