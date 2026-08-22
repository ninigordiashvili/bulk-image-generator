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
  onProgress?.({ current: images.length, total: images.length, phase: "done" });
}
