import type { ClipKind, ClipZoom, RenderSettings } from "@/types/editor";

export function isNarrationVideo(clip: { label?: string; kind: string }): boolean {
  return clip.kind !== "still" && /^narration/i.test(clip.label ?? "");
}

export function clipZoomSettings(
  clip: { label?: string; kind: ClipKind },
  direction: ClipZoom,
  settings: Pick<RenderSettings, "zoomAmount" | "zoomAmountMotion" | "narrationZoomAmount" | "effectsOnStills" | "effectsOnMotion">
): { direction: ClipZoom; amount: number } {
  if (isNarrationVideo(clip)) {
    const requested = settings.narrationZoomAmount ?? 0;
    const amount = Number.isFinite(requested) ? Math.max(0, Math.min(0.2, requested)) : 0;
    return { direction: amount > 0 ? "in" : "none", amount };
  }
  if (clip.kind === "avatar" || !(clip.kind === "motion" ? settings.effectsOnMotion : settings.effectsOnStills)) {
    return { direction: "none", amount: 0 };
  }
  return { direction, amount: clip.kind === "motion" ? settings.zoomAmountMotion : settings.zoomAmount };
}
