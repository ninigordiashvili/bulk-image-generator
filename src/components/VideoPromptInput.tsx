"use client";
import { HelpTip } from "./HelpTip";

import { cueIssues } from "@/lib/prompts";
import { pendingVideoShots } from "@/lib/videoPrompts";
import { videoModel } from "@/lib/videoModels";
import { videoRate } from "@/lib/vertexPricing";
import { useVideoStore } from "@/store/videoStore";
import { MAX_SHOTS } from "@/types";

export function VideoPromptInput({ disabled }: { disabled: boolean }) {
  const promptText = useVideoStore(state => state.promptText);
  const setPromptText = useVideoStore(state => state.setPromptText);
  const defaults = useVideoStore(state => state.defaults);
  const shots = pendingVideoShots({ provider: "vertex", inputMode: "text", promptText, defaults, shots: [] });
  const spec = videoModel(defaults.model);
  const issues = cueIssues(promptText);
  const rate = videoRate(spec.requestModel, false, defaults.resolution).usd;
  return <section className="panel space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="panel-title mb-0">Text-to-video prompts</h2>
        <button type="button" disabled={disabled || !promptText} onClick={() => setPromptText("")} className="text-xs text-muted hover:text-foreground disabled:opacity-40">Clear all</button>
      <span className={shots.length > MAX_SHOTS ? "text-xs text-red-400" : "text-xs text-muted"}>{shots.length} / {MAX_SHOTS} videos</span>
    </div>
    <div className="flex items-center gap-2 text-xs text-muted">
      <span>Estimated batch: ${(shots.reduce((sum, shot) => sum + shot.duration, 0) * rate).toFixed(2)}</span>
      <HelpTip label="Video cost and duration">Audio off. ${rate.toFixed(2)}/second at {defaults.resolution}; ${(rate * defaults.duration).toFixed(2)} per clip. Tags name the files; Duration sets each clip&apos;s length.</HelpTip>
    </div>

    <div className="flex items-center gap-2"><label className="text-xs text-muted" htmlFor="video-prompts">Video prompts</label><HelpTip label="Video prompt format">Start each prompt with a timestamp tag, just like images. Each tag starts a new video; its description can span several lines or paragraphs. Without tags, separate prompts with a blank line (or use one prompt per line).</HelpTip></div>
    <textarea id="video-prompts" className="field min-h-64 w-full resize-y font-mono text-sm"
      value={promptText} disabled={disabled} onChange={event => setPromptText(event.target.value)}
      placeholder={"#0-00\nA wide shot of a mountain valley at sunrise. The camera moves slowly forward.\n\n#0-04\nA river winding through a forest, seen from above."} />

    {shots.length > MAX_SHOTS && <p role="alert" className="text-xs text-red-400">Split this into batches of at most {MAX_SHOTS} prompts. Nothing will be submitted until it fits.</p>}
    {issues.empty.length > 0 && <p role="alert" className="text-xs text-amber-400">These tags have no prompt and will be skipped: {issues.empty.join(", ")}.</p>}
    {issues.duplicates.length > 0 && <p role="alert" className="text-xs text-amber-400">Repeated filenames: {issues.duplicates.join(", ")}. Use distinct timestamp tags to keep downloads easy to identify.</p>}
    {shots.length > 0 && <details>
      <summary className="cursor-pointer text-xs text-accent">Preview {shots.length} prompts and filenames</summary>
      <ol className="mt-2 max-h-64 space-y-2 overflow-auto text-xs">
        {shots.map((shot, index) => <li key={shot.id}><span className="font-mono text-accent">{shot.tag ?? `${index + 1}-1`}.mp4</span><p className="whitespace-pre-wrap text-muted">{shot.prompt}</p></li>)}
      </ol>
    </details>}
  </section>;
}
