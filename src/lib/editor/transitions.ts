import { isNarrationVideo } from "./clipEffects";
/** A short dip at the cut, without overlapping or shortening either shot. */
export function narrationDip(clips: { label?: string; kind: string; start: number; end: number }[], index: number) {
  const clip = clips[index];
  const isNarration = (i: number) => i >= 0 && Boolean(clips[i]) && isNarrationVideo(clips[i]);
  const touches = (i: number) => clips[i + 1] && Math.abs(clips[i].end - clips[i + 1].start) < 0.001;
  return {
    fadeIn: index > 0 && isNarration(index - 1) && touches(index - 1) ? Math.min(0.12, (clip.end - clip.start) / 2) : 0,
    fadeOut: isNarration(index) && touches(index) ? Math.min(0.12, (clip.end - clip.start) / 2) : 0,
  };
}
