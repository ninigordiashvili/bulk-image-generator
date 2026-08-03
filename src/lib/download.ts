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

export function fileNameFor(image: GeneratedImage, index?: number): string {
  const slug =
    image.prompt
      .toLowerCase()
      .replace(/@\d+/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "image";
  const prefix = index === undefined ? "" : `${String(index + 1).padStart(3, "0")}-`;
  return `${prefix}${slug}.${extensionFor(image.mimeType)}`;
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
    let name = fileNameFor(image, index);
    while (usedNames.has(name)) name = `dup-${name}`;
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
