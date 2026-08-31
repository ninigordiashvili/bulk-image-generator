"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  clearImages as clearGalleryDb,
  deleteImage as deleteImageDb,
  loadImages,
  putImage,
} from "@/lib/galleryDb";
import { isResolutionMismatch } from "@/lib/imageMeta";
import { insertImages } from "@/lib/galleryOrder";
import {
  DEFAULT_MODEL,
  findModel,
  normalizeModel,
  parseCustomInput,
  reconcileInput,
  referenceLimit,
} from "@/lib/kieModels";
import { recordRate, type CreditRates } from "@/lib/pricing";
import { parsePrompts, resolveCharactersForPrompt } from "@/lib/prompts";
import { GenerationQueue } from "@/services/GenerationQueue";
import { fetchAccounts, fetchCredits, generateImage } from "@/services/kieApi";
import { defaultModelFor } from "@/lib/kieModels";
import {
  CUSTOM_MODEL,
  MAX_PROMPTS,
  type AccountProblem,
  type CharacterRef,
  type GeneratedImage,
  type GenerationJob,
  type GenerationSettings,
  type KieAccount,
  type ModelInput,
  type QueueConfig,
  type QueueProgress,
  type QueueState,
} from "@/types";

const EMPTY_PROGRESS: QueueProgress = {
  total: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  inFlight: 0,
};

interface GenerationStore {
  // persisted
  settings: GenerationSettings;
  queueConfig: QueueConfig;
  characters: CharacterRef[];
  promptText: string;
  /** Credits-per-image learned from finished tasks — see `lib/pricing.ts`. */
  creditRates: CreditRates;

  // gallery — IndexedDB backed, hydrated on mount
  images: GeneratedImage[];
  galleryHydrated: boolean;

  // live, in-memory only
  jobs: GenerationJob[];
  progress: QueueProgress;
  queueState: QueueState;
  /** Set when a whole-batch failure stopped the run; null otherwise. */
  haltReason: string | null;

  accounts: KieAccount[];
  /** Entries in kie-accounts.json that were skipped or need attention. */
  accountProblems: AccountProblem[];
  accountsError: string | null;
  accountsLoading: boolean;
  /** Live kie.ai balance for the selected account, null until fetched. */
  credits: number | null;
  creditsError: string | null;

  setSettings: (patch: Partial<GenerationSettings>) => void;
  setModelInput: (field: string, value: string | number | boolean) => void;
  setQueueConfig: (patch: Partial<QueueConfig>) => void;
  setPromptText: (text: string) => void;

  addCharacter: (character: Omit<CharacterRef, "id">) => void;
  updateCharacter: (id: number, patch: Partial<CharacterRef>) => void;
  removeCharacter: (id: number) => void;

  hydrateGallery: () => Promise<void>;
  loadAccounts: () => Promise<void>;
  refreshCredits: () => Promise<void>;

  startGeneration: () => void;
  cancelGeneration: () => void;
  retryJob: (jobId: string) => void;
  retryFailedJobs: () => void;

  removeImage: (id: string) => Promise<void>;
  clearGallery: () => Promise<void>;
}

let queue: GenerationQueue | null = null;

const DEFAULT_SETTINGS: GenerationSettings = {
  provider: "kie",
  accountId: "",
  model: DEFAULT_MODEL,
  modelInputs: {},
  customModelId: "",
  customInputJson: "",
  imagesPerPrompt: 1,
  styleBible: "",
};

/**
 * The single place model and input are made consistent. Every path that can
 * change either funnels through here, so a persisted `resolution: "4K"` can't
 * survive a switch to a model that has no resolution field and turn the whole
 * batch into 422s.
 *
 * It takes `unknown` on purpose: this also runs against whatever is in
 * localStorage, which may predate any of these fields. It must always return a
 * complete, usable settings object rather than throwing — persist swallows a
 * throw from the rehydrate hook, which would let the broken state reach render.
 */
function reconcileSettings(raw: unknown): GenerationSettings {
  const stored = (raw ?? {}) as Partial<GenerationSettings>;
  const settings: GenerationSettings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    modelInputs: isRecord(stored.modelInputs) ? stored.modelInputs : {},
  };

  const model = normalizeModel(settings.model);
  const spec = model === CUSTOM_MODEL ? undefined : findModel(model);
  if (!spec) return { ...settings, model };

  return {
    ...settings,
    model,
    modelInputs: {
      ...settings.modelInputs,
      [model]: reconcileInput(spec, settings.modelInputs[model]),
    },
  };
}

function isRecord(value: unknown): value is Record<string, ModelInput> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `input` for whichever model is selected, catalog or custom. */
export function activeInput(settings: GenerationSettings): ModelInput {
  if (settings.model === CUSTOM_MODEL) {
    const parsed = parseCustomInput(settings.customInputJson);
    return parsed.ok ? parsed.input : {};
  }
  return settings.modelInputs?.[settings.model] ?? {};
}

/** The kie.ai model id to actually send — resolves the custom-model sentinel. */
export function activeModelId(settings: GenerationSettings): string {
  return settings.model === CUSTOM_MODEL
    ? (settings.customModelId ?? "").trim()
    : settings.model;
}

/**
 * A quota overflow (too many/too large reference images) must not take the whole
 * app down — settings just stop persisting until something is removed.
 */
const safeLocalStorage: Storage = {
  get length() {
    return localStorage.length;
  },
  clear: () => localStorage.clear(),
  key: (index) => localStorage.key(index),
  getItem: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      console.warn(
        "[bulk-image-generator] localStorage is full — settings and characters were not saved. Remove a reference image or clear site data."
      );
    }
  },
  removeItem: (key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing useful to do */
    }
  },
};

export const useGenerationStore = create<GenerationStore>()(
  persist(
    (set, get) => ({
      settings: reconcileSettings(DEFAULT_SETTINGS),
      queueConfig: { concurrency: 3, retries: 2 },
      characters: [],
      promptText: "",
      creditRates: {},

      images: [],
      galleryHydrated: false,

      jobs: [],
      progress: EMPTY_PROGRESS,
      queueState: "idle",
      haltReason: null,

      accounts: [],
      accountProblems: [],
      accountsError: null,
      accountsLoading: false,
      credits: null,
      creditsError: null,

      setSettings: (patch) => {
        set((state) => {
          const next = { ...state.settings, ...patch };
          // Choosing an account from the other provider carries the model with
          // it: the previous model belongs to a catalog this account cannot
          // reach, so it is replaced rather than left to fail at submit time.
          if (patch.provider !== undefined && patch.provider !== state.settings.provider) {
            next.model = defaultModelFor(patch.provider);
          }
          return { settings: reconcileSettings(next) };
        });
        if (patch.accountId !== undefined || patch.provider !== undefined) {
          void get().refreshCredits();
        }
      },

      setModelInput: (field, value) => {
        set((state) => {
          const { model, modelInputs } = state.settings;
          return {
            settings: {
              ...state.settings,
              modelInputs: {
                ...modelInputs,
                [model]: { ...(modelInputs?.[model] ?? {}), [field]: value },
              },
            },
          };
        });
      },

      setQueueConfig: (patch) => {
        set((state) => ({ queueConfig: { ...state.queueConfig, ...patch } }));
        const next = get().queueConfig;
        queue?.setConcurrency(next.concurrency);
        queue?.setRetries(next.retries);
      },

      setPromptText: (promptText) => set({ promptText }),

      addCharacter: (character) => {
        set((state) => {
          const nextId =
            state.characters.reduce((max, c) => Math.max(max, c.id), 0) + 1;
          return { characters: [...state.characters, { ...character, id: nextId }] };
        });
      },

      updateCharacter: (id, patch) => {
        set((state) => ({
          characters: state.characters.map((character) =>
            character.id === id ? { ...character, ...patch } : character
          ),
        }));
      },

      removeCharacter: (id) => {
        set((state) => ({
          characters: state.characters.filter((character) => character.id !== id),
        }));
      },

      hydrateGallery: async () => {
        if (get().galleryHydrated) return;
        const images = await loadImages();
        set({ images, galleryHydrated: true });
      },

      loadAccounts: async () => {
        set({ accountsLoading: true, accountsError: null });
        // Both providers are listed together so the picker is the one place a
        // provider is chosen. A failure on one side must not hide the other:
        // Vertex being unconfigured should still leave kie.ai usable.
        const [kie, vertex] = await Promise.all([
          fetchAccounts("kie"),
          fetchAccounts("vertex"),
        ]);
        const merged = [
          ...(kie.ok ? kie.accounts.map((a) => ({ ...a, provider: "kie" as const })) : []),
          ...(vertex.ok
            ? vertex.accounts.map((a) => ({ ...a, provider: "vertex" as const }))
            : []),
        ];
        const result = merged.length
          ? {
              ok: true as const,
              accounts: merged,
              problems: [
                ...(kie.ok ? kie.problems : []),
                ...(vertex.ok ? vertex.problems : []),
              ],
            }
          : { ok: false as const, error: (!kie.ok && kie.error) || (!vertex.ok && vertex.error) || "No accounts configured." };
        if (!result.ok) {
          set({
            accountsLoading: false,
            accountsError: result.error,
            accounts: [],
            accountProblems: [],
            credits: null,
          });
          return;
        }
        // Keep the persisted selection if it's still usable, else fall back to the
        // first usable one — or clear it, so the UI can't submit a dead account id.
        const previous = get().settings;
        // Matched on provider as well as id: both providers have an account
        // called "main", so an id alone would silently keep the wrong one.
        const stillValid = result.accounts.some(
          (a) => a.id === previous.accountId && a.provider === previous.provider
        );
        const fallback = result.accounts[0];
        const provider = stillValid ? previous.provider : (fallback?.provider ?? "kie");
        const accountId = stillValid ? previous.accountId : (fallback?.id ?? "");
        const model =
          provider === previous.provider ? previous.model : defaultModelFor(provider);

        set({
          accounts: result.accounts,
          accountProblems: result.problems,
          accountsLoading: false,
          settings: reconcileSettings({ ...previous, provider, accountId, model }),
        });
        void get().refreshCredits();
      },

      refreshCredits: async () => {
        // Vertex bills the cloud account directly — there is no prepaid balance
        // to fetch, and asking kie about a Vertex account id would only error.
        if (get().settings.provider === "vertex") {
          set({ credits: null });
          return;
        }
        const { accountId } = get().settings;
        if (!accountId) {
          set({ credits: null, creditsError: null });
          return;
        }
        const result = await fetchCredits(accountId);
        if (result.ok) set({ credits: result.credits, creditsError: null });
        else set({ credits: null, creditsError: result.error });
      },

      startGeneration: () => {
        const { settings, queueConfig, promptText, characters } = get();

        /**
         * The settings this run will use, frozen at the moment it starts.
         *
         * Every job used to re-read the live store, which meant a batch was
         * only ever using whatever was selected *now* rather than what was
         * chosen when it was started. Picking a different account for a video
         * batch in the other tab therefore moved a running image batch onto
         * that account mid-flight — real credits, billed to the wrong place —
         * and because switching provider also reassigns the model, the images
         * changed model and aspect ratio partway through too.
         *
         * Nothing in here is read from the store again. The characters are
         * copied for the same reason: editing one during a run must not change
         * what the rest of the run generates.
         */
        const locked = {
          settings: { ...settings, modelInputs: { ...settings.modelInputs } },
          characters: characters.map((character) => ({ ...character })),
        };
        // Hard cap: anything past MAX_PROMPTS is dropped, and the input warns about it.
        const prompts = parsePrompts(promptText).slice(0, MAX_PROMPTS);
        if (prompts.length === 0) return;

        // Identifies this run so its images stay grouped and ordered together,
        // however long individual jobs take to come back.
        const batchCreatedAt = Date.now();
        const batchId = `batch-${batchCreatedAt}`;

        const jobs: GenerationJob[] = [];
        prompts.forEach((prompt, promptIndex) => {
          const refs = resolveCharactersForPrompt(prompt, characters);
          for (let copyIndex = 0; copyIndex < settings.imagesPerPrompt; copyIndex++) {
            jobs.push({
              id: `${prompt.id}-${copyIndex}`,
              promptId: prompt.id,
              prompt: prompt.raw,
              promptIndex,
              copyIndex,
              tag: prompt.tag,
              referencedCharacterIds: refs.map((ref) => ref.id),
              status: "queued",
              attempts: 0,
            });
          }
        });

        queue = new GenerationQueue({
          concurrency: queueConfig.concurrency,
          retries: queueConfig.retries,
          runJob: async (job, signal) => {
            const current = locked.settings;
            const model = activeModelId(current);
            if (!model) {
              return { ok: false, error: "No model id set.", retryable: false };
            }

            const spec = findModel(model);
            const input = activeInput(current);
            // A text-to-image-only model has nowhere to put references, so they
            // are dropped rather than sent into a field it will reject.
            const limit = spec ? referenceLimit(spec) : 0;
            const refs = locked.characters
              .filter((character) => job.referencedCharacterIds.includes(character.id))
              .slice(0, Math.max(limit, 0));

            const response = await generateImage(
              {
                provider: current.provider,
              accountId: current.accountId,
                model,
                prompt: job.prompt,
                styleBible: current.styleBible,
                referenceImages: refs.map((ref) => ({
                  label: ref.label,
                  base64: ref.base64,
                  mimeType: ref.mimeType,
                })),
                input,
                imageField: spec?.imageField,
                imageSingle: spec?.imageSingle,
              },
              { signal }
            );

            if (!response.ok) {
              return {
                ok: false,
                error: response.error,
                retryable: response.retryable,
              };
            }

            const requestedResolution =
              typeof input.resolution === "string" ? input.resolution : undefined;
            const aspectRatio =
              typeof input.aspect_ratio === "string" ? input.aspect_ratio : "auto";
            // kie bills per task, so a task that returned three images cost a
            // third of the total each.
            const perImageCredits = response.images.length
              ? response.credits / response.images.length
              : response.credits;

            const created: GeneratedImage[] = response.images.map((image, index) => {
              const dimensions =
                image.width > 0 && image.height > 0
                  ? { width: image.width, height: image.height }
                  : null;
              return {
                id: `${job.id}@${Date.now()}-${index}`,
                jobId: job.id,
                prompt: job.prompt,
                tag: job.tag ?? undefined,
                base64: image.base64,
                mimeType: image.mimeType,
                model,
                modelLabel: spec?.label ?? model,
                width: image.width,
                height: image.height,
                resolution: image.resolution,
                requestedResolution,
                resolutionMismatch: isResolutionMismatch(
                  requestedResolution,
                  dimensions
                ),
                aspectRatio,
                referencedCharacterIds: job.referencedCharacterIds,
                // Requested position, not arrival position — the gallery orders
                // on these so results follow the prompts as typed.
                batchId,
                batchCreatedAt,
                promptIndex: job.promptIndex,
                copyIndex: job.copyIndex,
                imageIndex: index,
                createdAt: Date.now(),
                credits: perImageCredits,
                taskId: response.taskId,
                sourceUrl: image.sourceUrl,
              };
            });

            set((state) => ({
              images: insertImages(state.images, created),
              // What it actually cost feeds the next estimate — see lib/pricing.
              creditRates: recordRate(
                state.creditRates,
                model,
                input,
                response.credits,
                created.length
              ),
            }));
            for (const image of created) {
              void putImage(image).catch(() => {
                /* gallery persistence is best-effort; it's already in memory */
              });
            }

            return {
              ok: true,
              resolutionMismatch: created.some((image) => image.resolutionMismatch),
            };
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
          // The balance only moves while a batch runs; refresh once it settles.
          if (queueState === "done") void get().refreshCredits();
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

      removeImage: async (id) => {
        set((state) => ({ images: state.images.filter((image) => image.id !== id) }));
        await deleteImageDb(id).catch(() => {});
      },

      clearGallery: async () => {
        set({ images: [] });
        await clearGalleryDb().catch(() => {});
      },
    }),
    {
      name: "bulk-image-generator",
      storage: createJSONStorage(() => safeLocalStorage),
      // Bumped when this app was rebuilt on kie.ai. Version 0 is the Vertex-era
      // shape: its `model` is a Google model id, it has no `modelInputs`, and
      // its per-image costs are dollars rather than credits.
      version: 1,
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        if (version >= 1) return state;
        const old = (state.settings ?? {}) as Partial<GenerationSettings>;
        // The prompts, characters and style bible are the user's actual work and
        // carry over. Only the provider-specific parts are reset.
        return {
          ...state,
          settings: {
            ...DEFAULT_SETTINGS,
            styleBible: old.styleBible ?? "",
            imagesPerPrompt: old.imagesPerPrompt ?? 1,
          },
          creditRates: {},
        };
      },
      // images/jobs/progress/queueState are deliberately excluded: images live in
      // IndexedDB, and live run state was never meant to survive a refresh.
      partialize: (state) => ({
        settings: state.settings,
        queueConfig: state.queueConfig,
        characters: state.characters,
        promptText: state.promptText,
        creditRates: state.creditRates,
      }),
      // Second line of defence after `migrate`: a persisted setting can still
      // name a model we dropped, or carry fields the current model doesn't have.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.settings = reconcileSettings(state.settings);
      },
    }
  )
);

export const isRunning = (state: QueueState) =>
  state === "running" || state === "cancelling";
