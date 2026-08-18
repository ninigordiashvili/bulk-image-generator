import type { GalleryOrderKeys, GeneratedImage, GeneratedVideo } from "@/types";

/**
 * Gallery ordering. Results arrive in completion order — with "At once" above 1
 * a short prompt finishes before a long one that was queued ahead of it — so the
 * order results are *received* in says nothing about the order they were *asked*
 * for. Every image and video therefore carries the position it was requested at
 * (`promptIndex`, `copyIndex`, `imageIndex`) and the batch it belongs to, and
 * both galleries sort by those instead of by arrival.
 *
 * Batches are newest-first; within a batch, results follow the prompt lines (or
 * shot rows) exactly as entered. A retried job re-appears at its original
 * position rather than at the front.
 *
 * All of the ordering fields are optional: results generated before this existed
 * are already in IndexedDB without them, and fall back to `createdAt`.
 */
export function compareByRequestOrder(
  a: GalleryOrderKeys,
  b: GalleryOrderKeys
): number {
  // Older results have no batch, so each one is its own batch of one — which
  // sorts them newest-first, exactly as they were before.
  const batchA = a.batchCreatedAt ?? a.createdAt;
  const batchB = b.batchCreatedAt ?? b.createdAt;
  if (batchA !== batchB) return batchB - batchA;

  const byPrompt = (a.promptIndex ?? 0) - (b.promptIndex ?? 0);
  if (byPrompt !== 0) return byPrompt;

  const byCopy = (a.copyIndex ?? 0) - (b.copyIndex ?? 0);
  if (byCopy !== 0) return byCopy;

  // Several images can come back from one task; keep them in the order the
  // model returned them. Videos are always one clip per task.
  const byImage = (a.imageIndex ?? 0) - (b.imageIndex ?? 0);
  if (byImage !== 0) return byImage;

  // Same slot twice means a manual retry re-generated it — oldest first, then
  // id, so the order can never depend on which comparison ran first.
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

/** Merges freshly generated images into the gallery at their requested slots. */
export function insertImages(
  images: GeneratedImage[],
  created: GeneratedImage[]
): GeneratedImage[] {
  return [...created, ...images].sort(compareByRequestOrder);
}

/** Merges a finished clip into the gallery at its shot's slot. */
export function insertVideos(
  videos: GeneratedVideo[],
  created: GeneratedVideo
): GeneratedVideo[] {
  return [created, ...videos].sort(compareByRequestOrder);
}
