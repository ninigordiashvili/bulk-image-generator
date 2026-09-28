import { hasCue, parsePrompts } from "./prompts";
import { clampToModel, videoModel } from "./videoModels";
import type { VideoProvider, VideoShot } from "@/types";

/** Tagged prompts use the image form's parser. Untagged paragraphs stay together. */
export function parseVideoPrompts(text: string) {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (normalized.split("\n").some(hasCue) || !/\n\s*\n/.test(normalized)) {
    return parsePrompts(normalized);
  }
  return normalized.split(/\n\s*\n/).filter(block => block.trim()).map((raw, index) => ({
    id: `text-${index}`, raw: raw.trim(), tag: null, referencedCharacterIds: [],
  }));
}

export interface VideoDraft {
  provider: VideoProvider;
  inputMode: "text" | "images";
  promptText: string;
  shots: VideoShot[];
  defaults: Pick<VideoShot, "model" | "duration" | "resolution" | "aspectRatio">;
}

/** A single mapping feeds the preview, estimate and submitted batch. */
export function pendingVideoShots(draft: VideoDraft): VideoShot[] {
  if (draft.provider !== "vertex" || draft.inputMode !== "text") return draft.shots;
  const spec = videoModel(draft.defaults.model);
  return parseVideoPrompts(draft.promptText).map((prompt, index) => ({
    id: `text-${index}-${prompt.id}`,
    prompt: prompt.raw,
    tag: prompt.tag ?? `${index + 1}-1`,
    ...draft.defaults,
    ...clampToModel(spec, draft.defaults),
  }));
}
