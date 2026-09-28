"use client";
import { useEffect } from "react";
import { cleanupGallery, galleryDownloadRefs, markGalleryDownload } from "@/lib/galleryDb";
import { useGenerationStore } from "@/store/generationStore";
import { useVideoStore } from "@/store/videoStore";

export function SavedFileCleanup() {
  useEffect(() => {
    let running = false;
    const cleanup = async () => {
      if (running) return;
      running = true;
      try {
        const refs = await galleryDownloadRefs();
        for (let i = 0; i < refs.length; i += 1000) {
          const response = await fetch("/api/downloads", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ files: refs.slice(i, i + 1000) }) });
          if (response.ok) {
            const data = await response.json();
            for (const file of data.files) await markGalleryDownload(file.store, file.id, file.at);
          }
        }
      } catch (error) { console.error("Download history sync failed", error); }
      try {
        const removed = await cleanupGallery();
        if (removed.images.length) useGenerationStore.setState(state => ({ images: state.images.filter(item => !removed.images.includes(item.id)) }));
        if (removed.videos.length) useVideoStore.setState(state => ({ videos: state.videos.filter(item => !removed.videos.includes(item.id)) }));
      } catch (error) { console.error("Gallery cleanup failed", error); }
      finally { running = false; }
    };
    void cleanup();
    const timer = setInterval(() => { void cleanup(); }, 60_000);
    window.addEventListener("focus", cleanup);
    return () => { clearInterval(timer); window.removeEventListener("focus", cleanup); };
  }, []);
  return null;
}
