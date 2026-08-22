"use client";

/**
 * Client-side media helpers for the editor: reading an audio file's length, and
 * turning source images into things a canvas can draw cheaply. A hundred 1080p
 * images decoded at full size would be close to a gigabyte of bitmaps, so
 * nothing here ever holds one at its natural resolution.
 */

/** Reads the duration out of an audio file without decoding the whole thing. */
export function readAudioDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const { duration } = audio;
      audio.src = "";
      if (Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error("That file has no readable duration."));
    };
    audio.onerror = () => reject(new Error("That file isn't audio this browser can read."));
    audio.src = url;
  });
}

/** A small still for the filmstrip. Kept as a blob URL so `<img>` can be lazy. */
export async function makeThumbnail(file: Blob, width = 224): Promise<string> {
  const bitmap = await createImageBitmap(file, {
    resizeWidth: width,
    resizeQuality: "medium",
  });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas not available.");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.72)
  );
  if (!blob) throw new Error("Could not encode the thumbnail.");
  return URL.createObjectURL(blob);
}

/**
 * A preview-resolution bitmap. Decoded a little larger than the canvas so the
 * zoom has detail to reveal rather than going soft as it pushes in.
 */
export function decodeForPreview(file: Blob, width: number): Promise<ImageBitmap> {
  return createImageBitmap(file, {
    resizeWidth: Math.round(width * 1.35),
    resizeQuality: "high",
  });
}

/**
 * Keeps a handful of decoded frames around — the one on screen plus whatever
 * playback is about to reach. Anything older is closed, which is the only way
 * to actually release an ImageBitmap.
 */
export class BitmapCache {
  private readonly entries = new Map<string, ImageBitmap>();
  private readonly pending = new Map<string, Promise<ImageBitmap>>();
  /**
   * Images the browser couldn't decode. `request` is called from the draw loop,
   * so without this a single corrupt file would start a fresh decode sixty
   * times a second for as long as it sat on screen.
   */
  private readonly failed = new Set<string>();

  constructor(
    private readonly width: number,
    private readonly limit = 8
  ) {}

  get(id: string): ImageBitmap | undefined {
    const bitmap = this.entries.get(id);
    if (bitmap) {
      // Re-inserting moves it to the end, making the map its own LRU order.
      this.entries.delete(id);
      this.entries.set(id, bitmap);
    }
    return bitmap;
  }

  /** Starts a decode if one isn't already in flight. Safe to call every frame. */
  request(id: string, file: Blob): void {
    if (this.entries.has(id) || this.pending.has(id) || this.failed.has(id)) return;
    const promise = decodeForPreview(file, this.width)
      .then((bitmap) => {
        this.pending.delete(id);
        this.entries.set(id, bitmap);
        this.evict();
        return bitmap;
      })
      .catch((error) => {
        this.pending.delete(id);
        this.failed.add(id);
        throw error;
      });
    this.pending.set(id, promise);
    void promise.catch(() => {});
  }

  private evict() {
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.get(oldest.value)?.close();
      this.entries.delete(oldest.value);
    }
  }

  dispose() {
    for (const bitmap of this.entries.values()) bitmap.close();
    this.entries.clear();
    this.pending.clear();
    this.failed.clear();
  }
}
