import type { GalleryOrderKeys } from "@/types";
import { markGalleryDownload } from "./galleryDb";

export async function trackGalleryDownload(store: "images" | "videos", item: GalleryOrderKeys) {
  await markGalleryDownload(store, item.id);
  if (item.workId && item.workIndex !== undefined) {
    const response = await fetch("/api/downloads", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.workId, index: item.workIndex, image: item.imageIndex ?? 0 }) });
    if (!response.ok) throw new Error("Server download receipt was not saved; server copies will be retained.");
  }
}
