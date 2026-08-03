"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  clearVideos as clearVideoDb,
  deleteVideo as deleteVideoDb,
  loadVideos,
  putVideo,
} from "@/lib/galleryDb";
import { creditsPerImage, recordRate, type CreditRates } from "@/lib/pricing";
import {
  DEFAULT_VIDEO_MODEL,
  clampToModel,
  videoModel,
} from "@/lib/videoModels";
import { GenerationQueue } from "@/services/GenerationQueue";
import { downloadVideoBlob, pollVideo, startVideo } from "@/services/kieApi";
import { useGenerationStore } from "@/store/generationStore";
import {
  MAX_SHOTS,
  type GeneratedVideo,
  type GenerationJob,
  type QueueProgress,
  type QueueState,
  type ShotImage,
  type VideoShot,
} from "@/types";

const EMPTY_PROGRESS: QueueProgress = {
  total: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  inFlight: 0,
};

/** Everything a row needs except the image, so "apply to all" has one shape. */
export interface ShotSettings {
  model: string;
  duration: number;
  resolution: string;
  aspectRatio: string;
}

interface VideoStore {
  shots: VideoShot[];
  /** Defaults applied to newly added rows. */
  defaults: ShotSettings;
  concurrency: number;
  retries: number;
  creditRates: CreditRates;

  videos: GeneratedVideo[];
  galleryHydrated: boolean;

  jobs: GenerationJob[];
  progress: QueueProgress;
  queueState: QueueState;
  haltReason: string | null;

  addShots: (images: ShotImage[]) => void;
  updateShot: (id: string, patch: Partial<VideoShot>) => void;
  removeShot: (id: string) => void;
  clearShots: () => void;
  applyToAll: (settings: Partial<ShotSettings>) => void;
  setDefaults: (patch: Partial<ShotSettings>) => void;
  setConcurrency: (value: number) => void;
  setRetries: (value: number) => void;

  hydrateGallery: () => Promise<void>;
  startGeneration: () => void;
  cancelGeneration: () => void;
  retryJob: (jobId: string) => void;
  retryFailedJobs: () => void;

  removeVideo: (id: string) => Promise<void>;
  clearGallery: () => Promise<void>;
}

let queue: GenerationQueue | null = null;
let shotCounter = 0;

const POLL_INTERVAL_MS = 12_000;
/** Veo has been observed rendering for over 15 minutes; this is deliberately generous. */
const POLL_DEADLINE_MS = 45 * 60 * 1000;
/**
 * kie's gateway intermittently answers a status read with a 502 while the task
 * is still rendering. The task is already billed, so a blip must not abandon it.
 */
const MAX_CONSECUTIVE_POLL_ERRORS = 12;

type SettledVideo =
  | { ok: true; videoUrl: string; credits: number; actualResolution?: string }
  | { ok: false; error: string; retryable?: boolean };

/**
 * Waits for a task to finish, absorbing transient read failures. Only a
 * genuinely terminal answer (the render failed, the key is bad) or a long run
 * of consecutive failures gives up.
 */
async function awaitVideo(
  accountId: string,
  taskId: string,
  model: string,
  signal: AbortSignal
): Promise<SettledVideo> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let consecutiveErrors = 0;

  for (;;) {
    if (signal.aborted) return { ok: false, error: "Cancelled.", retryable: false };
    await sleep(POLL_INTERVAL_MS, signal);
    if (signal.aborted) return { ok: false, error: "Cancelled.", retryable: false };

    const status = await pollVideo(accountId, taskId, model, signal);

    if (status.ok && status.state === "done") {
      return {
        ok: true,
        videoUrl: status.videoUrl,
        credits: status.credits,
        actualResolution: status.actualResolution,
      };
    }
    if (status.ok) {
      consecutiveErrors = 0;
    } else {
      if (status.retryable === false) return status;
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) return status;
    }

    if (Date.now() > deadline) {
      return {
        ok: false,
        error: `Task ${taskId} was still rendering after ${Math.round(
          POLL_DEADLINE_MS / 60000
        )} minutes. It may yet finish — Retry resumes waiting on the same task rather than paying for a new one.`,
        retryable: true,
      };
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

/**
 * Forces a row's settings to something its model actually accepts. Switching a
 * row from Grok to Veo has to bring 30s down to 8s and 480p up to 720p — kie
 * rejects the mismatch outright, and a rejected batch is a wasted one.
 */
function reconcileShot(shot: VideoShot): VideoShot {
  const spec = videoModel(shot.model);
  return { ...shot, model: spec.id, ...clampToModel(spec, shot) };
}

export const useVideoStore = create<VideoStore>()(
  persist(
    (set, get) => ({
      shots: [],
      defaults: {
        model: DEFAULT_VIDEO_MODEL,
        duration: videoModel(DEFAULT_VIDEO_MODEL).defaultDuration,
        resolution: videoModel(DEFAULT_VIDEO_MODEL).defaultResolution,
        aspectRatio: videoModel(DEFAULT_VIDEO_MODEL).defaultAspectRatio,
      },
      concurrency: 3,
      retries: 1,
      creditRates: {},

      videos: [],
      galleryHydrated: false,

      jobs: [],
      progress: EMPTY_PROGRESS,
      queueState: "idle",
      haltReason: null,

      // Dropping ten files makes ten rows in one go — that is the whole point of
      // the mode, so nothing here asks for them one at a time.
      addShots: (images) => {
        set((state) => {
          const room = Math.max(0, MAX_SHOTS - state.shots.length);
          const added = images.slice(0, room).map((image) =>
            reconcileShot({
              id: `shot-${Date.now()}-${shotCounter++}`,
              image,
              prompt: "",
              ...state.defaults,
            })
          );
          return { shots: [...state.shots, ...added] };
        });
      },

      updateShot: (id, patch) => {
        // Changing what to render invalidates any task already running for this
        // row — resuming it would return a clip of the *old* settings. Editing
        // only the prompt text does the same, since the prompt is the render.
        const invalidates =
          patch.taskId === undefined &&
          ["model", "duration", "resolution", "aspectRatio", "prompt"].some(
            (field) => field in patch
          );
        set((state) => ({
          shots: state.shots.map((shot) =>
            shot.id === id
              ? reconcileShot({
                  ...shot,
                  ...patch,
                  ...(invalidates ? { taskId: undefined } : {}),
                })
              : shot
          ),
        }));
      },

      removeShot: (id) => {
        set((state) => ({ shots: state.shots.filter((shot) => shot.id !== id) }));
      },

      clearShots: () => set({ shots: [] }),

      applyToAll: (settings) => {
        set((state) => ({
          shots: state.shots.map((shot) => reconcileShot({ ...shot, ...settings })),
          defaults: { ...state.defaults, ...settings },
        }));
      },

      setDefaults: (patch) => {
        set((state) => ({ defaults: { ...state.defaults, ...patch } }));
      },

      setConcurrency: (concurrency) => {
        set({ concurrency });
        queue?.setConcurrency(concurrency);
      },

      setRetries: (retries) => {
        set({ retries });
        queue?.setRetries(retries);
      },

      hydrateGallery: async () => {
        if (get().galleryHydrated) return;
        const videos = await loadVideos();
        set({ videos, galleryHydrated: true });
      },

      startGeneration: () => {
        const { shots, concurrency, retries } = get();
        const runnable = shots.filter((shot) => shot.prompt.trim().length > 0);
        if (runnable.length === 0) return;

        const jobs: GenerationJob[] = runnable.map((shot, index) => ({
          id: shot.id,
          promptId: shot.id,
          prompt: shot.prompt,
          promptIndex: index,
          copyIndex: 0,
          referencedCharacterIds: [],
          status: "queued",
          attempts: 0,
        }));

        queue = new GenerationQueue({
          concurrency,
          retries,
          runJob: async (job, signal) => {
            const shot = get().shots.find((candidate) => candidate.id === job.id);
            if (!shot) {
              return { ok: false, error: "Shot was removed.", retryable: false };
            }
            // The account lives in the image store — one kie key serves both.
            const accountId = useGenerationStore.getState().settings.accountId;
            if (!accountId) {
              return { ok: false, error: "No account selected.", retryable: false };
            }

            const spec = videoModel(shot.model);

            // Resume rather than restart. A shot that already has a task id was
            // paid for on a previous attempt — re-creating it would bill a
            // second render for the same clip, which at Veo prices is the most
            // expensive mistake this app could make.
            let taskId = shot.taskId;
            if (!taskId) {
              const started = await startVideo(
                {
                  accountId,
                  model: shot.model,
                  prompt: shot.prompt,
                  image: { base64: shot.image.base64, mimeType: shot.image.mimeType },
                  duration: shot.duration,
                  resolution: shot.resolution,
                  aspectRatio: shot.aspectRatio,
                },
                { signal }
              );
              if (!started.ok) {
                return {
                  ok: false,
                  error: started.error,
                  retryable: started.retryable,
                };
              }
              taskId = started.taskId;
              get().updateShot(shot.id, { taskId });
            }

            const settled = await awaitVideo(accountId, taskId, shot.model, signal);
            if (!settled.ok) {
              // A render that genuinely failed frees the id, so a retry starts a
              // fresh task. A transient read failure keeps it, so a retry
              // resumes the render already in flight.
              if (settled.retryable === false) {
                get().updateShot(shot.id, { taskId: undefined });
              }
              return {
                ok: false,
                error: settled.error,
                retryable: settled.retryable,
              };
            }

            // The clip exists on kie's CDN now and is already paid for. Pull the
            // bytes before that URL expires; a failure here is worth retrying
            // because the generation itself succeeded.
            const file = await downloadVideoBlob(settled.videoUrl, signal);
            if (!file.ok) return { ok: false, error: file.error, retryable: true };

            // kie's Veo namespace reports no per-task credit figure, so a clip
            // that comes back as 0 falls back to the known rate and is labelled
            // estimated — better than a gallery that claims Veo was free.
            const reported = settled.credits;
            const creditsEstimated = reported <= 0;
            const credits = creditsEstimated
              ? (creditsPerImage(
                  shot.model,
                  { duration: shot.duration, resolution: shot.resolution },
                  get().creditRates
                ) ?? 0)
              : reported;

            const video: GeneratedVideo = {
              id: `${shot.id}@${Date.now()}`,
              shotId: shot.id,
              prompt: shot.prompt,
              model: shot.model,
              modelLabel: spec.label,
              mimeType: file.blob.type || "video/mp4",
              blob: file.blob,
              sizeBytes: file.blob.size,
              duration: shot.duration,
              resolution: settled.actualResolution ?? shot.resolution,
              aspectRatio: shot.aspectRatio,
              posterBase64: shot.image.base64,
              posterMimeType: shot.image.mimeType,
              createdAt: Date.now(),
              credits,
              creditsEstimated,
              taskId,
              sourceUrl: settled.videoUrl,
            };

            set((state) => ({
              videos: [video, ...state.videos],
              // Only a figure kie actually reported teaches anything; feeding
              // our own estimate back in would just reinforce itself.
              creditRates: creditsEstimated
                ? state.creditRates
                : recordRate(
                    state.creditRates,
                    shot.model,
                    { duration: shot.duration, resolution: shot.resolution },
                    reported,
                    1
                  ),
            }));
            void putVideo(video).catch(() => {
              /* persistence is best-effort; the clip is already in memory */
            });

            // The clip is collected, so the id has served its purpose. Clearing
            // it means a deliberate re-run generates a new take.
            get().updateShot(shot.id, { taskId: undefined });
            return { ok: true };
          },
        });

        queue.on("job:update", (job) => {
          set((state) => ({
            jobs: state.jobs.map((existing) =>
              existing.id === job.id ? job : existing
            ),
          }));
        });
        queue.on("queue:progress", (progress) => set({ progress }));
        queue.on("queue:state", (queueState) => {
          set({ queueState });
          if (queueState === "done") {
            void useGenerationStore.getState().refreshCredits();
          }
        });
        queue.on("queue:halted", (haltReason) => set({ haltReason }));

        set({
          jobs,
          progress: { ...EMPTY_PROGRESS, total: jobs.length },
          haltReason: null,
        });
        queue.start(jobs);
      },

      cancelGeneration: () => queue?.cancel(),

      retryJob: (jobId) => {
        set({ haltReason: null });
        queue?.retryJob(jobId);
      },

      retryFailedJobs: () => {
        set({ haltReason: null });
        queue?.retryFailed();
      },

      removeVideo: async (id) => {
        set((state) => ({ videos: state.videos.filter((video) => video.id !== id) }));
        await deleteVideoDb(id).catch(() => {});
      },

      clearGallery: async () => {
        set({ videos: [] });
        await clearVideoDb().catch(() => {});
      },
    }),
    {
      name: "bulk-image-generator-video",
      storage: createJSONStorage(() => localStorage),
      // Shots hold a full base64 still each, and videos hold Blobs — neither
      // belongs in localStorage. Only the knobs persist; the storyboard is
      // rebuilt by dropping the images again, and clips live in IndexedDB.
      partialize: (state) => ({
        defaults: state.defaults,
        concurrency: state.concurrency,
        retries: state.retries,
        creditRates: state.creditRates,
      }),
    }
  )
);
