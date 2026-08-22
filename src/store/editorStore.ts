"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { buildTimeline, clipZoom, type Timeline } from "@/lib/editor/timeline";
import { parseTimestamp } from "@/lib/editor/timestamp";
import { uploadAll } from "@/lib/editor/upload";
import {
  DEFAULT_SETTINGS,
  MAX_IMAGES,
  type CreateJobResponse,
  type ErrorResponse,
  type JobStatus,
  type LeadIn,
  type RenderClip,
  type RenderRequest,
  type RenderSettings,
  type ZoomDirection,
} from "@/types/editor";

/** An image the editor is holding, before and after it reaches the server. */
export interface EditorImage {
  id: string;
  file: File;
  /** The original filename — what the cue was read from, and what warnings name. */
  label: string;
  seconds: number | null;
  /** Object URL for the preview canvas and the filmstrip. */
  url: string;
  excluded: boolean;
}

export interface AudioTrack {
  file: File;
  name: string;
  duration: number;
  url: string;
}

export type ExportPhase = "idle" | "uploading" | "rendering" | "done" | "error";

export interface ExportState {
  phase: ExportPhase;
  /** 0-1 across the upload, which is the part the client can measure itself. */
  uploadRatio: number;
  status: JobStatus | null;
  error: string | null;
  /** Set once the render lands; the page plays and downloads from here. */
  outputUrl: string | null;
  outputBytes: number;
}

const IDLE_EXPORT: ExportState = {
  phase: "idle",
  uploadRatio: 0,
  status: null,
  error: null,
  outputUrl: null,
  outputBytes: 0,
};

/** Settings worth remembering between sessions; media obviously isn't. */
interface PersistedSettings {
  settings: RenderSettings;
  zoom: ZoomDirection;
  leadIn: LeadIn;
  tailSeconds: number;
  fileName: string;
}

interface EditorStore extends PersistedSettings {
  images: EditorImage[];
  audio: AudioTrack | null;
  export: ExportState;

  addImages: (files: File[]) => void;
  removeImage: (id: string) => void;
  toggleImage: (id: string) => void;
  clearImages: () => void;
  setAudio: (track: AudioTrack | null) => void;

  setSettings: (patch: Partial<RenderSettings>) => void;
  setZoom: (zoom: ZoomDirection) => void;
  setLeadIn: (leadIn: LeadIn) => void;
  setTailSeconds: (seconds: number) => void;
  setFileName: (name: string) => void;

  startExport: () => Promise<void>;
  cancelExport: () => void;
  dismissExport: () => void;
}

let exportAbort: AbortController | null = null;

/**
 * Changing the inputs invalidates a finished render, but must not wipe the
 * progress of one still running — the UI disables the controls during an
 * export, and this is the backstop for anything that slips past that.
 */
function invalidate(state: { export: ExportState }): ExportState {
  const { phase } = state.export;
  return phase === "uploading" || phase === "rendering" ? state.export : IDLE_EXPORT;
}

export const useEditorStore = create<EditorStore>()(
  persist(
    (set, get) => ({
      images: [],
      audio: null,
      export: IDLE_EXPORT,

      settings: DEFAULT_SETTINGS,
      zoom: "in",
      leadIn: "hold",
      tailSeconds: 4,
      fileName: "slideshow.mp4",

      addImages: (files) => {
        const existing = get().images;
        const seen = new Set(existing.map((image) => image.label));
        const added: EditorImage[] = [];

        for (const file of files) {
          if (!file.type.startsWith("image/") && !/\.(png|jpe?g|webp|bmp|tiff?)$/i.test(file.name)) {
            continue;
          }
          // Re-dropping the same folder shouldn't double every cue.
          if (seen.has(file.name)) continue;
          seen.add(file.name);
          added.push({
            id: `${file.name}-${file.size}-${file.lastModified}`,
            file,
            label: file.name,
            seconds: parseTimestamp(file.name),
            url: URL.createObjectURL(file),
            excluded: false,
          });
        }

        const next = [...existing, ...added].slice(0, MAX_IMAGES);
        // Anything past the cap never gets shown, so release it immediately.
        for (const image of added.slice(Math.max(0, MAX_IMAGES - existing.length))) {
          URL.revokeObjectURL(image.url);
        }
        set((state) => ({ images: next, export: invalidate(state) }));
      },

      removeImage: (id) =>
        set((state) => {
          const target = state.images.find((image) => image.id === id);
          if (target) URL.revokeObjectURL(target.url);
          return {
            images: state.images.filter((image) => image.id !== id),
            export: invalidate(state),
          };
        }),

      toggleImage: (id) =>
        set((state) => ({
          images: state.images.map((image) =>
            image.id === id ? { ...image, excluded: !image.excluded } : image
          ),
          export: invalidate(state),
        })),

      clearImages: () =>
        set((state) => {
          for (const image of state.images) URL.revokeObjectURL(image.url);
          return { images: [], export: invalidate(state) };
        }),

      setAudio: (track) =>
        set((state) => {
          if (state.audio && state.audio.url !== track?.url) {
            URL.revokeObjectURL(state.audio.url);
          }
          return { audio: track, export: invalidate(state) };
        }),

      setSettings: (patch) =>
        set((state) => ({
          settings: { ...state.settings, ...patch },
          export: invalidate(state),
        })),
      setZoom: (zoom) => set((state) => ({ zoom, export: invalidate(state) })),
      setLeadIn: (leadIn) => set((state) => ({ leadIn, export: invalidate(state) })),
      setTailSeconds: (tailSeconds) =>
        set((state) => ({ tailSeconds, export: invalidate(state) })),
      setFileName: (fileName) => set({ fileName }),

      startExport: async () => {
        const state = get();
        if (state.export.phase === "uploading" || state.export.phase === "rendering") {
          return;
        }

        const timeline = selectTimeline(state);
        if (timeline.clips.length === 0) {
          set({
            export: { ...IDLE_EXPORT, phase: "error", error: "There's nothing on the timeline to render." },
          });
          return;
        }

        const controller = new AbortController();
        exportAbort = controller;
        set({ export: { ...IDLE_EXPORT, phase: "uploading" } });

        let jobId: string | null = null;

        try {
          const created = (await postJson("/api/editor/job", null, controller.signal)) as
            | CreateJobResponse
            | ErrorResponse;
          if (!created.ok) throw new Error(created.error);
          jobId = created.id;

          // Only the images that actually claimed a slot get uploaded — a
          // hundred-image folder with a few duds shouldn't send the duds.
          const used = new Set(
            timeline.clips.map((clip) => clip.imageId).filter(Boolean) as string[]
          );
          const uploads: { key: string; kind: "image" | "audio"; file: File }[] =
            state.images
              .filter((image) => used.has(image.id))
              .map((image) => ({ key: image.id, kind: "image", file: image.file }));

          if (state.audio) {
            uploads.push({ key: "__audio", kind: "audio", file: state.audio.file });
          }

          const totalBytes = uploads.reduce((sum, entry) => sum + entry.file.size, 0);

          const stored = await uploadAll(
            jobId,
            uploads,
            (sentBytes) =>
              set((current) => ({
                export: {
                  ...current.export,
                  uploadRatio: totalBytes ? Math.min(1, sentBytes / totalBytes) : 1,
                },
              })),
            controller.signal
          );

          if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");

          const clips: RenderClip[] = timeline.clips.map((clip, index) => ({
            file: clip.imageId ? (stored.get(clip.imageId) ?? null) : null,
            start: clip.start,
            end: clip.end,
            zoom: clip.imageId ? clipZoom(state.zoom, index) : "none",
          }));

          const request: RenderRequest = {
            clips,
            audio: state.audio ? (stored.get("__audio") ?? null) : null,
            total: timeline.total,
            settings: state.settings,
          };

          const started = (await postJson(
            `/api/editor/job/${jobId}/render`,
            request,
            controller.signal
          )) as { ok: true; status: JobStatus } | ErrorResponse;
          if (!started.ok) throw new Error(started.error);

          set((current) => ({
            export: { ...current.export, phase: "rendering", uploadRatio: 1, status: started.status },
          }));

          const final = await pollJob(jobId, controller.signal, (status) =>
            set((current) => ({ export: { ...current.export, status } }))
          );

          if (final.phase === "done") {
            const name = encodeURIComponent(get().fileName || "slideshow.mp4");
            set((current) => ({
              export: {
                ...current.export,
                phase: "done",
                status: final,
                outputUrl: `/api/editor/job/${jobId}/output?name=${name}`,
                outputBytes: final.outputBytes,
              },
            }));
          } else if (final.phase === "cancelled") {
            set({ export: IDLE_EXPORT });
          } else {
            throw new Error(final.error ?? "The render failed.");
          }
        } catch (error) {
          if (controller.signal.aborted) {
            set({ export: IDLE_EXPORT });
          } else {
            set((current) => ({
              export: {
                ...current.export,
                phase: "error",
                error: error instanceof Error ? error.message : "The export failed.",
              },
            }));
          }
          // A failed or abandoned job is a few hundred megabytes of scratch
          // files; there's no reason to leave them for the sweeper.
          if (jobId) void discard(jobId);
        } finally {
          if (exportAbort === controller) exportAbort = null;
        }
      },

      cancelExport: () => {
        const status = get().export.status;
        exportAbort?.abort();
        exportAbort = null;
        if (status) void fetch(`/api/editor/job/${status.id}?keep=1`, { method: "DELETE" });
        set({ export: IDLE_EXPORT });
      },

      dismissExport: () => set({ export: IDLE_EXPORT }),
    }),
    {
      name: "bulk-generator-editor",
      storage: createJSONStorage(() => localStorage),
      // Files and object URLs mean nothing after a reload, so only the choices
      // that describe how to render are kept.
      partialize: (state): PersistedSettings => ({
        settings: state.settings,
        zoom: state.zoom,
        leadIn: state.leadIn,
        tailSeconds: state.tailSeconds,
        fileName: state.fileName,
      }),
    }
  )
);

/** The timeline the whole UI reads from — derived, never stored. */
export function selectTimeline(state: {
  images: EditorImage[];
  audio: AudioTrack | null;
  tailSeconds: number;
  leadIn: LeadIn;
}): Timeline {
  return buildTimeline({
    items: state.images.map((image) => ({
      id: image.id,
      label: image.label,
      seconds: image.seconds,
      excluded: image.excluded,
    })),
    audioDuration: state.audio?.duration ?? 0,
    tailSeconds: state.tailSeconds,
    leadIn: state.leadIn,
  });
}

async function postJson(url: string, body: unknown, signal: AbortSignal) {
  const response = await fetch(url, {
    method: "POST",
    signal,
    ...(body === null
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (payload) return payload;
  throw new Error(`Request to ${url} failed (${response.status}).`);
}

/**
 * Polls until the job stops moving. A second between checks is plenty for a
 * render measured in minutes, and keeps the log quiet.
 */
async function pollJob(
  id: string,
  signal: AbortSignal,
  onStatus: (status: JobStatus) => void
): Promise<JobStatus> {
  for (;;) {
    await sleep(1000, signal);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    const response = await fetch(`/api/editor/job/${id}`, { signal, cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as
      | { ok: true; status: JobStatus }
      | ErrorResponse
      | null;

    if (!payload) throw new Error(`Lost contact with the render (${response.status}).`);
    if (!payload.ok) throw new Error(payload.error);

    onStatus(payload.status);
    const { phase } = payload.status;
    if (phase === "done" || phase === "error" || phase === "cancelled") {
      return payload.status;
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function discard(id: string) {
  return fetch(`/api/editor/job/${id}`, { method: "DELETE" }).catch(() => {});
}
