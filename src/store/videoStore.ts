"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  clearVideos as clearVideoDb,
  deleteVideo as deleteVideoDb,
  loadVideos,
  putVideo,
} from "@/lib/galleryDb";
import { insertVideos } from "@/lib/galleryOrder";
import { pendingVideoShots } from "@/lib/videoPrompts";
import { videoRate } from "@/lib/vertexPricing";
import {
  CUT_BUDGET_BYTES,
  decodeTrack,
  encodeCut,
  type DecodedAudio,
  type Waveform,
} from "@/lib/audioCut";
import { secondsToCue } from "@/lib/editor/timestamp";
import { parseTimestamp } from "@/lib/editor/timestamp";
import { cueTagIn, sanitizeCueTag, stripCueLines } from "@/lib/prompts";
import { creditsPerImage, recordRate, type CreditRates } from "@/lib/pricing";
import {
  DEFAULT_VIDEO_MODEL,
  clampToModel,
  isAudioDriven,
  videoModel,
  defaultVideoModelFor,
} from "@/lib/videoModels";
import { BackgroundQueue, newBatchId } from "@/services/BackgroundQueue";
import type { WorkStatus } from "@/types/work";
import { heygenEstimate, heygenSource, type HeygenOptions } from "@/lib/heygen";
import type { VideoProvider } from "@/types";
import { useGenerationStore } from "@/store/generationStore";
import {
  MAX_SHOTS,
  type GeneratedVideo,
  type GenerationJob,
  type QueueProgress,
  type QueueState,
  type ShotAudio,
  type ShotImage,
  type VideoShot,
} from "@/types";

/**
 * A voice track loaded this session. The decoded samples are kept because every
 * cut is sliced out of them here in the browser — there is no server-side copy.
 */
export interface AudioSource {
  id: string;
  name: string;
  fileName: string;
  duration: number;
  url: string;
  waveform: Waveform | null;
  decoded: DecodedAudio | null;
}

/**
 * What the finished clip is saved as. A `#0-00` line in the shot's prompt wins;
 * failing that, a source still that is itself named for a timestamp passes its
 * name on — animate `0-00.png` and you get `0-00.mp4`, so a batch of clips can
 * go straight back onto the video editor's timeline.
 *
 * A still with an ordinary name is left alone: only a name the editor would
 * actually read as a cue is worth propagating.
 */
function shotTag(shot: {
  prompt: string;
  tag?: string;
  image?: { name: string };
  audio?: ShotAudio;
}): string | undefined {
  const fromPrompt = cueTagIn(shot.prompt);
  if (fromPrompt) return fromPrompt;
  if (shot.tag) return sanitizeCueTag(shot.tag) ?? undefined;

  // A talking clip is defined by its voice track, so it takes that track's name
  // plus where in it the cut was taken: narration_1-35.mp4 from 1:35 of
  // narration.mp3. The suffix is in the app's own cue form, so the clip also
  // drops straight onto the video editor's timeline at that moment.
  if (shot.audio) {
    const stem = sanitizeCueTag(shot.audio.name) ?? "audio";
    return `${stem}_${secondsToCue(shot.audio.start)}`;
  }

  if (!shot.image || parseTimestamp(shot.image.name) === null) return undefined;
  return sanitizeCueTag(shot.image.name) ?? undefined;
}

/**
 * A row is ready when it has what its model actually needs. A talking-avatar
 * row is driven by its voice track, so an empty prompt is fine and a missing
 * cut is not — the reverse of every other model here.
 */
/**
 * How long the finished clip will be, and at what size.
 *
 * An avatar row has no duration or resolution of its own — the voice track sets
 * the length — but the gallery still has to label the clip, and the learned
 * credit rates are keyed on these. Reporting the row's stale prompt-model
 * duration would mislabel every talking clip and poison the rate table.
 */
export function shotSize(shot: VideoShot): { duration: number; resolution: string } {
  if (isAudioDriven(videoModel(shot.model))) {
    return {
      duration: shot.audio?.duration ?? 0,
      resolution: videoModel(shot.model).provider === "heygen" ? shot.resolution : "avatar",
    };
  }
  return { duration: shot.duration, resolution: shot.resolution };
}

export function isRunnable(shot: VideoShot): boolean {
  const spec = videoModel(shot.model);
  if (spec.provider === "heygen" && heygenSource(shot.model, shot.heygen) === "avatar") {
    if (!shot.heygen?.avatarId?.trim()) return false;
  } else if (!shot.image && spec.provider !== "vertex") return false;
  if (isAudioDriven(videoModel(shot.model))) {
    return Boolean(shot.audio && shot.audio.duration > 0 && shot.audio.duration <= (spec.maxAudioSeconds ?? 300));
  }
  return stripCueLines(shot.prompt).length > 0;
}

const EMPTY_PROGRESS: QueueProgress = {
  total: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  inFlight: 0,
};

/** Everything a row needs except the image, so "apply to all" has one shape. */
export interface ShotSettings {
  heygen?: HeygenOptions;
  model: string;
  duration: number;
  resolution: string;
  aspectRatio: string;
}

interface VideoStore {
  shots: VideoShot[];
  inputMode: "text" | "images";
  promptText: string;
  setInputMode: (mode: "text" | "images") => void;
  setPromptText: (text: string) => void;
  /** Defaults applied to newly added rows. */
  defaults: ShotSettings;
  concurrency: number;
  retries: number;
  creditRates: CreditRates;

  /** Voice tracks loaded this session, shared by every row that cuts from one. */
  audioSources: AudioSource[];
  audioError: string | null;

  videos: GeneratedVideo[];
  galleryHydrated: boolean;

  backgroundStatus: WorkStatus | null;
  jobs: GenerationJob[];
  progress: QueueProgress;
  queueState: QueueState;
  haltReason: string | null;

  addShots: (images: ShotImage[]) => void;
  addAvatarShots: (count: number) => void;
  updateShot: (id: string, patch: Partial<VideoShot>) => void;
  removeShot: (id: string) => void;
  clearShots: () => void;
  applyToAll: (settings: Partial<ShotSettings>) => void;
  /**
   * One prompt onto every row. Not part of `applyToAll` because that also
   * writes what it applied into `defaults`, and a prompt is not a default: a
   * row added later describes its own image, and inheriting the last batch's
   * wording would be worse than an empty box.
   */
  applyPromptToAll: (prompt: string) => void;
  addAudioSource: (file: File) => Promise<AudioSource | null>;
  removeAudioSource: (id: string) => void;
  setShotAudio: (id: string, audio: ShotAudio | undefined) => void;
  applyAudioSourceToAll: (sourceId: string) => void;
  setDefaults: (patch: Partial<ShotSettings>) => void;
  setConcurrency: (value: number) => void;
  setRetries: (value: number) => void;

  hydrateGallery: () => Promise<void>;
  /**
   * The video tab's own account. Separate from the image tab's on purpose: the
   * two used to share one, so picking kie.ai for a video batch also moved the
   * image tab — and any image batch running on it — onto that account.
   */
  provider: VideoProvider;
  accountId: string;
  setAccount: (patch: { provider?: VideoProvider; accountId?: string }) => void;

  startGeneration: () => void;
  cancelGeneration: () => void;
  retryJob: (jobId: string) => void;
  retryFailedJobs: () => void;

  removeVideo: (id: string) => Promise<void>;
  clearGallery: () => Promise<void>;
}

let queue: BackgroundQueue | null = null;
let shotCounter = 0;

function reconcileShot(shot: VideoShot): VideoShot {
  const spec = videoModel(shot.model);
  if (spec.provider === "heygen") {
    let heygen = shot.heygen;
    if (spec.requestModel !== "avatar_iv" && heygen?.source === "image") heygen = { ...heygen, source: "photo" };
    const photo = heygenSource(spec.id, heygen) !== "avatar" || heygen?.avatarType === "photo_avatar";
    const settings = clampToModel(spec, shot);
    if (spec.requestModel === "avatar_iii" && photo && settings.resolution === "4k") settings.resolution = "1080p";
    return { ...shot, heygen, ...settings };
  }
  return { ...shot, model: spec.id, ...clampToModel(spec, shot) };
}

function reconcileDefaults(settings: ShotSettings): ShotSettings {
  const { model, duration, resolution, aspectRatio, heygen } = reconcileShot({ ...settings, id: "defaults", prompt: "" });
  return { model, duration, resolution, aspectRatio, ...(heygen ? { heygen } : {}) };
}

export const useVideoStore = create<VideoStore>()(
  persist(
    (set, get) => ({
      shots: [],
      inputMode: "text",
      promptText: "",
      setInputMode: (inputMode) => set({ inputMode }),
      setPromptText: (promptText) => set({ promptText }),
      defaults: {
        model: DEFAULT_VIDEO_MODEL,
        duration: videoModel(DEFAULT_VIDEO_MODEL).defaultDuration,
        resolution: videoModel(DEFAULT_VIDEO_MODEL).defaultResolution,
        aspectRatio: videoModel(DEFAULT_VIDEO_MODEL).defaultAspectRatio,
      },
      provider: "kie",
      accountId: "",
      concurrency: 3,
      retries: 1,
      creditRates: {},

      audioSources: [],
      audioError: null,

      videos: [],
      galleryHydrated: false,

      backgroundStatus: null,
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

      addAvatarShots: (count) => set(state => ({ shots: [...state.shots, ...Array.from({ length: Math.min(MAX_SHOTS - state.shots.length, Math.max(0, Math.floor(count))) }, () => reconcileShot({
        ...state.defaults, heygen: { ...state.defaults.heygen, source: "avatar" }, id: "shot-" + Date.now() + "-" + shotCounter++, prompt: "",
      }))] })),
      updateShot: (id, patch) => {
        // Changing what to render invalidates any task already running for this
        // row — resuming it would return a clip of the *old* settings. Editing
        // only the prompt text does the same, since the prompt is the render.
        const invalidates =
          patch.taskId === undefined &&
          ["model", "duration", "resolution", "aspectRatio", "prompt", "heygen"].some(
            (field) => field in patch
          );
        set((state) => ({
          shots: state.shots.map((shot) =>
            shot.id === id
              ? reconcileShot({
                  ...shot,
                  ...patch,
                  ...(patch.model?.startsWith("heygen:") && !shot.model.startsWith("heygen:") ? { aspectRatio: "auto", resolution: "1080p" } : {}),
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

      addAudioSource: async (file) => {
        set({ audioError: null });
        try {
          const id = `${file.name}-${file.size}-${file.lastModified}`;
          const existing = get().audioSources.find((source) => source.id === id);
          if (existing) return existing;

          // One decode serves both the waveform and every cut taken later.
          const { decoded, waveform } = await decodeTrack(file);

          const source: AudioSource = {
            id,
            name: file.name.replace(/\.[^.]+$/, "").slice(0, 60),
            fileName: file.name,
            duration: decoded.duration,
            url: URL.createObjectURL(file),
            waveform,
            decoded,
          };
          set((state) => ({ audioSources: [...state.audioSources, source] }));
          return source;
        } catch (error) {
          set({
            audioError:
              error instanceof Error ? error.message : "Could not read that audio file.",
          });
          return null;
        }
      },

      removeAudioSource: (id) =>
        set((state) => {
          const source = state.audioSources.find((entry) => entry.id === id);
          if (source) URL.revokeObjectURL(source.url);
          return {
            audioSources: state.audioSources.filter((entry) => entry.id !== id),
            // Rows pointing at a track that's gone would fail at generation
            // time with a confusing server error; clear them now instead.
            shots: state.shots.map((shot) =>
              shot.audio?.sourceId === id ? { ...shot, audio: undefined } : shot
            ),
          };
        }),

      setShotAudio: (id, audio) =>
        set((state) => ({
          shots: state.shots.map((shot) =>
            shot.id === id
              ? // Changing the voice track changes the render, so any task
                // already running for this row is the wrong clip now.
                { ...shot, audio, taskId: undefined }
              : shot
          ),
        })),

      applyAudioSourceToAll: (sourceId) =>
        set((state) => {
          const source = state.audioSources.find((entry) => entry.id === sourceId);
          if (!source) return {};
          const length = Math.min(15, source.duration);
          return {
            shots: state.shots.map((shot) =>
              shot.audio?.sourceId === sourceId
                ? shot
                : {
                    ...shot,
                    // Only the track is shared; every row still picks its own
                    // moment, which is the whole point of the trimmer.
                    audio: {
                      sourceId,
                      name: source.name,
                      start: shot.audio?.start ?? 0,
                      duration: shot.audio?.duration ?? length,
                    },
                    taskId: undefined,
                  }
            ),
          };
        }),

      applyToAll: (settings) => {
        set((state) => ({
          shots: state.shots.map((shot) => reconcileShot({ ...shot, ...settings, ...(settings.model?.startsWith("heygen:") && !shot.model.startsWith("heygen:") ? { aspectRatio: "auto", resolution: "1080p" } : {}) })),
          defaults: reconcileDefaults({ ...state.defaults, ...settings }),
        }));
      },

      applyPromptToAll: (prompt) => {
        set((state) => ({
          shots: state.shots.map((shot) =>
            shot.prompt === prompt
              ? shot
              : // Same rule `updateShot` applies to a hand-edited prompt: the
                // prompt *is* the render, so a task already in flight for this
                // row would come back as the old clip and still be billed.
                { ...shot, prompt, taskId: undefined }
          ),
        }));
      },

      setDefaults: (patch) => {
        set((state) => {
          const defaults = { ...state.defaults, ...patch };
          return { defaults: reconcileDefaults(defaults) };
        });
      },

      setAccount: (patch) =>
        set((state) => {
          const provider = patch.provider ?? state.provider;
          // A provider change carries the model with it: the old one belongs to
          // a catalog this account cannot reach.
          const model =
            provider === state.provider
              ? state.defaults.model
              : defaultVideoModelFor(provider);
          return {
            provider,
            accountId: patch.accountId ?? state.accountId,
            defaults: reconcileDefaults({ ...state.defaults, model, ...(provider === "heygen" && state.provider !== "heygen" ? { aspectRatio: "auto", resolution: "1080p" } : {}) }),
          };
        }),

      setConcurrency: (concurrency) => {
        set({ concurrency });
        queue?.setConcurrency(concurrency);
      },

      setRetries: () => set({ retries: 1 }),

      hydrateGallery: async () => {
        if (get().galleryHydrated) return;
        const videos = await loadVideos();
        set({ videos, galleryHydrated: true });
      },

      startGeneration: () => {
        if (["running", "cancelling"].includes(get().queueState)) return;
        const { concurrency } = get();
        const shots = pendingVideoShots(get());
        if (shots.length > MAX_SHOTS) {
          set({ haltReason: `Use at most ${MAX_SHOTS} prompts per video batch. No videos were submitted.` });
          return;
        }

        /**
         * The account this run bills, frozen at the moment it starts.
         *
         * It used to be read per job from the image store, which the two tabs
         * share — so choosing a different account for an image batch moved a
         * running video batch onto it mid-flight, billing clips to the wrong
         * place. The account is picked once, here, and the run keeps it.
         */
        const billing = { provider: get().provider, accountId: get().accountId };
        if (!billing.accountId || shots.some(shot => videoModel(shot.model).provider !== billing.provider)) {
          set({ haltReason: "Select an account and a matching video model before starting." });
          return;
        }
        const runnable = shots.filter(isRunnable);
        if (runnable.length === 0) return;

        // Identifies this run so its clips stay grouped and in shot order,
        // however long individual renders take to come back.
        const batchCreatedAt = Date.now();
        const batchId = `batch-${newBatchId()}`;

        const jobs: GenerationJob[] = runnable.map((shot, index) => ({
          id: shot.id,
          promptId: shot.id,
          prompt: shot.prompt,
          promptIndex: index,
          copyIndex: 0,
          tag: shotTag(shot) ?? null,
          referencedCharacterIds: [],
          status: "queued",
          attempts: 0,
        }));

        queue = new BackgroundQueue({
          kind: "video", accountId: billing.accountId, concurrency,
          onStatus: (backgroundStatus) => set({ backgroundStatus }),
          prepare: async (job) => {
            const shot = runnable.find(candidate => candidate.id === job.id)!;
            const spec = videoModel(shot.model);
            let audio;
            if (isAudioDriven(spec) && shot.audio) {
              const source = get().audioSources.find(entry => entry.id === shot.audio!.sourceId);
              if (!source?.decoded) throw new Error("Re-add the voice track before starting this batch.");
              if (shot.audio.start < 0 || shot.audio.start + shot.audio.duration > source.decoded.duration + 0.001) throw new Error("The selected audio cut extends beyond this track. Trim it again.");
              const cut = await encodeCut(source.decoded, shot.audio.start, shot.audio.duration, billing.provider === "heygen" ? 32 * 1024 * 1024 : undefined);
              if (cut.bytes > (billing.provider === "heygen" ? 32 * 1024 * 1024 : CUT_BUDGET_BYTES)) throw new Error("Audio cut is too large. Shorten it.");
              audio = { base64: cut.base64, mimeType: cut.mimeType, seconds: cut.seconds };
            }
            return { job, provider: billing.provider, request: {
              accountId: billing.accountId, model: shot.model, prompt: stripCueLines(shot.prompt),
              ...(shot.image ? { image: { base64: shot.image.base64, mimeType: shot.image.mimeType } } : {}),
              duration: shot.duration, resolution: shot.resolution, aspectRatio: shot.aspectRatio, audio, heygen: shot.heygen,
            } };
          },
          collect: async (job, result, origin) => {
            if (!result.ok) return result;
            if (!("video" in result)) return { ok: false, error: "Unexpected image result." };
            const shot = runnable.find(candidate => candidate.id === job.id)!;
            const spec = videoModel(shot.model);
            const response = await fetch(result.url);
            if (!response.ok) throw new Error("Could not load the completed video. It remains in Activity.");
            const blob = await response.blob();
            const creditsEstimated = result.credits <= 0;
            const credits = creditsEstimated ? (billing.provider !== "kie" ? 0 : creditsPerImage(shot.model, shotSize(shot), get().creditRates) ?? 0) : result.credits;
            const video: GeneratedVideo = {
              ...origin,
              id: batchId + "-" + shot.id, shotId: shot.id, prompt: stripCueLines(shot.prompt), tag: shotTag(shot),
              model: shot.model, modelLabel: spec.label, mimeType: result.mimeType, blob, sizeBytes: blob.size,
              duration: shotSize(shot).duration, resolution: result.actualResolution ?? shotSize(shot).resolution,
              aspectRatio: shot.aspectRatio, posterBase64: shot.image?.base64 ?? "", posterMimeType: shot.image?.mimeType ?? "",
              batchId, batchCreatedAt, promptIndex: job.promptIndex, createdAt: Date.now(),
              credits, creditsEstimated, taskId: result.taskId, sourceUrl: result.sourceUrl,
              ...(billing.provider === "heygen" ? { estimatedUsd: heygenEstimate(shot.audio?.duration ?? 0) } : {}),
              ...(billing.provider === "vertex" ? { estimatedUsd: videoRate(spec.requestModel, false, shot.resolution).usd * shot.duration } : {}),
            };
            set(state => ({ videos: insertVideos(state.videos, video), creditRates: creditsEstimated ? state.creditRates
              : recordRate(state.creditRates, shot.model, shotSize(shot), result.credits, 1) }));
            void putVideo(video).catch(() => {});
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
        inputMode: state.inputMode,
        promptText: state.promptText,
        defaults: state.defaults,
        provider: state.provider,
        accountId: state.accountId,
        concurrency: state.concurrency,
        retries: state.retries,
        creditRates: state.creditRates,
      }),
      /**
       * `defaults` is stored as one object and the default merge replaces it
       * whole, so a browser holding it from an older build would come back
       * missing any field added since. Layering it over the current defaults
       * means a new one arrives with its default rather than as `undefined`.
       */
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<typeof current>;
        return {
          ...current,
          ...saved,
          defaults: { ...current.defaults, ...(saved.defaults ?? {}) },
          retries: 1,
        };
      },
    }
  )
);
