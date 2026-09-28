import { downloadExpired } from "@/lib/retention";
import { openDB, type IDBPDatabase } from "idb";
import { compareByRequestOrder } from "@/lib/galleryOrder";
import type { GeneratedImage, GeneratedVideo } from "@/types";

const DB_NAME = "bulk-image-generator";
/** v2 added the `videos` store. */
const DB_VERSION = 2;
const STORE = "images";
const VIDEO_STORE = "videos";

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("IndexedDB is browser-only."));
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      // Runs for a fresh database and for an upgrade from v1, so each store is
      // created only if absent rather than assuming which version we came from.
      upgrade(db) {
        for (const name of [STORE, VIDEO_STORE]) {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, { keyPath: "id" });
            store.createIndex("createdAt", "createdAt");
          }
        }
      },
    });
  }
  return dbPromise;
}

/**
 * The generated gallery lives here rather than in localStorage — base64 images
 * blow past the ~5–10MB localStorage cap after a few dozen results.
 */
export async function loadImages(): Promise<GeneratedImage[]> {
  try {
    await cleanupGallery();
    const db = await getDb();
    const images = (await db.getAllFromIndex(
      STORE,
      "createdAt"
    )) as GeneratedImage[];
    // Same order as the live gallery: newest batch first, prompt order within it.
    return images.sort(compareByRequestOrder);
  } catch {
    return [];
  }
}

export async function putImage(image: GeneratedImage): Promise<void> {
  await putPreservingDownload(STORE, image);
}

export async function deleteImage(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, id);
}

export async function clearImages(): Promise<void> {
  const db = await getDb();
  await db.clear(STORE);
}

/**
 * Videos are stored with their bytes as a Blob rather than base64. IndexedDB
 * stores Blobs natively, and a 20MB clip would become a 27MB string otherwise —
 * for a batch of ten that difference decides whether the gallery survives.
 */
export async function loadVideos(): Promise<GeneratedVideo[]> {
  try {
    await cleanupGallery();
    const db = await getDb();
    const videos = (await db.getAllFromIndex(
      VIDEO_STORE,
      "createdAt"
    )) as GeneratedVideo[];
    // Same order as the live gallery: newest batch first, shot order within it.
    return videos.sort(compareByRequestOrder);
  } catch {
    return [];
  }
}

export async function putVideo(video: GeneratedVideo): Promise<void> {
  await putPreservingDownload(VIDEO_STORE, video);
}

export async function deleteVideo(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(VIDEO_STORE, id);
}

export async function clearVideos(): Promise<void> {
  const db = await getDb();
  await db.clear(VIDEO_STORE);
}

/** Download metadata stays alongside bytes and survives browser restarts. */
export async function markGalleryDownload(store: "images" | "videos", id: string, at = Date.now()) {
  const db = await getDb();
  const tx = db.transaction(store, "readwrite");
  const item = await tx.store.get(id);
  if (item && !item.downloadedAt) await tx.store.put({ ...item, downloadedAt: at });
  await tx.done;
}

export async function cleanupGallery(now = Date.now()) {
  const db = await getDb();
  const removed: { images: string[]; videos: string[] } = { images: [], videos: [] };
  for (const store of [STORE, VIDEO_STORE] as const) {
    const tx = db.transaction(store, "readwrite");
    let cursor = await tx.store.openCursor();
    while (cursor) {
      if (downloadExpired(cursor.value.downloadedAt, now)) {
        removed[store].push(cursor.value.id);
        await cursor.delete();
      }
      cursor = await cursor.continue();
    }
    await tx.done;
  }
  return removed;
}

/** Lightweight descriptors let downloads in Activity/another browser be reconciled. */
export async function galleryDownloadRefs() {
  const db = await getDb();
  const refs: { id: string; store: "images" | "videos"; workId: string; workIndex: number; imageIndex: number; createdAt: number }[] = [];
  for (const store of [STORE, VIDEO_STORE] as const) {
    const tx = db.transaction(store);
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const item = cursor.value;
      if (item.workId && Number.isInteger(item.workIndex)) refs.push({ id: item.id, store,
        workId: item.workId, workIndex: item.workIndex, imageIndex: item.imageIndex ?? 0, createdAt: item.createdAt });
      cursor = await cursor.continue();
    }
    await tx.done;
  }
  return refs;
}

async function putPreservingDownload(store: "images" | "videos", item: GeneratedImage | GeneratedVideo) {
  const db = await getDb();
  const tx = db.transaction(store, "readwrite");
  const previous = await tx.store.get(item.id);
  // A regenerated result in the same slot is a new file, not a downloaded copy.
  await tx.store.put({ ...item, downloadedAt: previous?.taskId === item.taskId ? previous?.downloadedAt ?? item.downloadedAt : item.downloadedAt });
  await tx.done;
}
