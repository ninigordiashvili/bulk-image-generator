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
  const db = await getDb();
  await db.put(STORE, image);
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
  const db = await getDb();
  await db.put(VIDEO_STORE, video);
}

export async function deleteVideo(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(VIDEO_STORE, id);
}

export async function clearVideos(): Promise<void> {
  const db = await getDb();
  await db.clear(VIDEO_STORE);
}
