import { trackGalleryDownload } from "./downloadTracking";
import JSZip from "jszip";
import type { GeneratedImage } from "@/types";

/** No proxy fetch anywhere here — the bytes are already local. */
export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

export function extensionFor(mimeType: string): string {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "png";
}

/**
 * A `#0-00` cue on the prompt names the file outright — no index prefix, no
 * slug — because the whole point is that the name is data: the video editor
 * reads it back as the timestamp to place the image at. Everything else keeps
 * the numbered slug, which is only ever for a human scanning a folder.
 */
export function fileNameFor(image: GeneratedImage, index?: number): string {
  const extension = extensionFor(image.mimeType);
  if (image.tag) return `${image.tag}.${extension}`;

  const slug =
    image.prompt
      .toLowerCase()
      .replace(/@\d+/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "image";
  const prefix = index === undefined ? "" : `${String(index + 1).padStart(3, "0")}-`;
  return `${prefix}${slug}.${extension}`;
}

/**
 * Makes `name` unique against `used`, as `0-00 (2).png`. Deliberately not a
 * form the editor's timestamp parser accepts: when one cue produced several
 * images only one of them can hold that moment, so the extras land in the
 * folder unplaced, for you to pick between and rename.
 */
export function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${extension}`;
    if (!used.has(candidate)) return candidate;
  }
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadImage(image: GeneratedImage) {
  triggerDownload(
    base64ToBlob(image.base64, image.mimeType),
    fileNameFor(image)
  );
  void trackGalleryDownload("images", image).catch(console.error);
}

export interface ZipProgress {
  current: number;
  total: number;
  phase: "packing" | "zipping" | "done";
}

export async function downloadAllAsZip(
  images: GeneratedImage[],
  onProgress?: (progress: ZipProgress) => void
): Promise<void> {
  const zip = new JSZip();
  const usedNames = new Set<string>();

  images.forEach((image, index) => {
    const name = uniqueName(fileNameFor(image, index), usedNames);
    usedNames.add(name);
    zip.file(name, image.base64, { base64: true });
    onProgress?.({ current: index + 1, total: images.length, phase: "packing" });
  });

  const blob = await zip.generateAsync(
    { type: "blob", compression: "STORE" },
    (metadata) => {
      onProgress?.({
        current: Math.round(metadata.percent),
        total: 100,
        phase: "zipping",
      });
    }
  );

  triggerDownload(blob, `generated-images-${images.length}.zip`);
  await Promise.all(images.map(image => trackGalleryDownload("images", image).catch(console.error)));
  onProgress?.({ current: images.length, total: images.length, phase: "done" });
}

/** Download a completed server batch without re-running any generation. */
export async function downloadWorkAsZip(
  id: string,
  onProgress?: (progress: ZipProgress) => void
): Promise<void> {
  const response = await fetch('/api/work/' + encodeURIComponent(id));
  if (!response.ok) throw new Error('Could not load this batch. Try again.');
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Batch unavailable.');
  const batch = data.status as import('@/types/work').WorkStatus;
  if (batch.phase !== 'done') throw new Error('Wait until this batch finishes before downloading all files.');
  const files = batch.jobs.filter(job => job.status === 'success').flatMap(job => job.files ?? []);
  if (!files.length) throw new Error('This batch has no completed files to download.');
  const zip = new JSZip();
  const used = new Set<string>();
  onProgress?.({ current: 0, total: files.length, phase: 'packing' });
  for (const [index, file] of files.entries()) {
    const result = await fetch(file.url);
    if (!result.ok) throw new Error('Could not download ' + file.name + '. Try again.');
    const name = uniqueName(file.name.replace(/[\\/]/g, '_'), used);
    used.add(name);
    zip.file(name, await result.arrayBuffer());
    onProgress?.({ current: index + 1, total: files.length, phase: 'packing' });
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, metadata => {
    onProgress?.({ current: Math.round(metadata.percent), total: 100, phase: 'zipping' });
  });
  triggerDownload(blob, 'generated-' + batch.kind + 's-' + batch.id + '.zip');
  await fetch('/api/downloads', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, all: true }) }).catch(console.error);
  onProgress?.({ current: files.length, total: files.length, phase: 'done' });
}
