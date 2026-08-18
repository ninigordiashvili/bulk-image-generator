/**
 * Every value kie.ai accepts inside a task's `input` object. Models declare
 * their own fields (see `src/lib/kieCatalog.ts`), so settings are stored as a
 * loose bag rather than a fixed shape.
 */
export type InputValue = string | number | boolean;
export type ModelInput = Record<string, InputValue>;

/**
 * What actually goes over the wire as a task's `input`. Wider than ModelInput
 * because image fields carry arrays of URLs, which no settings control produces.
 */
export type TaskInput = Record<string, InputValue | string[]>;

/**
 * Client-safe view of a kie.ai account. The API key never leaves the server;
 * `keyHint` is the last four characters, enough to tell two keys apart.
 */
export interface KieAccount {
  id: string;
  label: string;
  keyHint: string;
  /** Where the key came from — `env` accounts aren't in the JSON file. */
  source: "file" | "env";
}

/** Server-only shape, resolved from kie-accounts.json or KIE_API_KEY. */
export interface KieAccountSecret {
  id: string;
  label: string;
  apiKey: string;
  source: "file" | "env";
}

/**
 * An entry in kie-accounts.json that couldn't be used. Surfaced to the client so
 * one half-filled account doesn't hide the ones that do work.
 */
export interface AccountProblem {
  id: string;
  label: string;
  reason: string;
}

export interface AccountsResponse {
  ok: true;
  accounts: KieAccount[];
  problems: AccountProblem[];
}

/** GET /api/accounts/credits — kie.ai balance for one account. */
export type CreditsResponse =
  | { ok: true; credits: number }
  | { ok: false; error: string };

/**
 * A reference image in the character library. `id` is the number the user types
 * as `@1`, `@2`, ... in prompts. `pinned` attaches it to every generation in the
 * batch, whether or not the prompt mentions it.
 */
export interface CharacterRef {
  id: number;
  label: string;
  base64: string;
  mimeType: string;
  pinned: boolean;
}

/**
 * Sentinel model id for the escape hatch: run any kie.ai model, including ones
 * released after this catalog was generated, by naming it and supplying raw JSON.
 */
export const CUSTOM_MODEL = "__custom__";

export interface GenerationSettings {
  accountId: string;
  /** A catalog model id, or CUSTOM_MODEL. */
  model: string;
  /**
   * Input values per model, keyed by model id. Kept per model so switching back
   * and forth doesn't lose the aspect ratio you picked for the other one.
   */
  modelInputs: Record<string, ModelInput>;
  /** Used only when `model === CUSTOM_MODEL`. */
  customModelId: string;
  /** Raw JSON merged into `input` for CUSTOM_MODEL. Free text — may be mid-edit. */
  customInputJson: string;
  /** 1–10 images generated per prompt line. */
  imagesPerPrompt: number;
  /** Prepended to every prompt in the batch — the consistency lever. */
  styleBible: string;
}

export interface QueueConfig {
  /** 1–10 parallel in-flight generations. */
  concurrency: number;
  /** 0–5 retries per job, linear backoff. */
  retries: number;
}

/**
 * Where a result was asked for, not when it came back. Completion order is
 * non-deterministic once more than one job runs at a time, so both galleries
 * sort on these instead — see `lib/galleryOrder.ts`. Every field is optional:
 * results stored before this existed have none, and fall back to `createdAt`.
 */
export interface GalleryOrderKeys {
  id: string;
  createdAt: number;
  /** The run this belongs to — groups a batch together. */
  batchId?: string;
  /** When that run was started. */
  batchCreatedAt?: number;
  /** 0-based position within the batch: prompt line, or shot row for video. */
  promptIndex?: number;
  /** 0-based index within that prompt's copies. Always 0 for video. */
  copyIndex?: number;
  /** 0-based index within the results one task returned. Always 0 for video. */
  imageIndex?: number;
}

export interface GeneratedImage extends GalleryOrderKeys {
  id: string;
  /** The queue job that produced it — lets the progress panel total actual spend. */
  jobId: string;
  prompt: string;
  base64: string;
  mimeType: string;
  /** kie.ai model id that produced it. */
  model: string;
  modelLabel: string;
  width: number;
  height: number;
  /** Measured from the bytes, e.g. "1024×1024". */
  resolution: string;
  /** The `resolution` input asked for, when the model has that field. */
  requestedResolution?: string;
  resolutionMismatch: boolean;
  /** The `aspect_ratio` asked for, for cards that can't measure the image. */
  aspectRatio: string;
  referencedCharacterIds: number[];
  createdAt: number;
  /** kie credits actually billed, as reported by the task record. */
  credits: number;
  taskId: string;
  /** kie's CDN URL. Expires ~24h after generation; the base64 above does not. */
  sourceUrl: string;
}

export interface PromptItem {
  id: string;
  /** Raw line as typed, `@N` tags left intact. */
  raw: string;
  referencedCharacterIds: number[];
}

export type JobStatus =
  | "queued"
  | "generating"
  | "retrying"
  | "success"
  | "error"
  | "cancelled";

export interface GenerationJob {
  id: string;
  promptId: string;
  prompt: string;
  /** 0-based index of the prompt line. */
  promptIndex: number;
  /** 0-based index within this prompt's imagesPerPrompt copies. */
  copyIndex: number;
  referencedCharacterIds: number[];
  status: JobStatus;
  attempts: number;
  error?: string;
  imageId?: string;
  resolutionMismatch?: boolean;
  /** Failed for a reason retrying can't fix (config, auth, credits). */
  terminal?: boolean;
}

export type QueueState = "idle" | "running" | "cancelling" | "done";

export interface QueueProgress {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  inFlight: number;
}

/** POST /api/kie/generate request body. */
export interface GenerateRequest {
  accountId: string;
  /** The literal kie model id, already resolved from CUSTOM_MODEL if needed. */
  model: string;
  prompt: string;
  styleBible: string;
  referenceImages: { label: string; base64: string; mimeType: string }[];
  /** Model-specific fields. The server adds prompt and reference URLs. */
  input: ModelInput;
  /** Field name the model expects reference URLs in; omitted = drop the images. */
  imageField?: string;
  /** True when `imageField` is a single URL string rather than an array. */
  imageSingle?: boolean;
}

export interface GeneratedImagePayload {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
  resolution: string;
  sourceUrl: string;
}

export type GenerateResponse =
  | {
      ok: true;
      taskId: string;
      /** kie can return more than one image for a single task. */
      images: GeneratedImagePayload[];
      credits: number;
    }
  | {
      ok: false;
      error: string;
      /**
       * Whether another attempt could plausibly succeed. Auth, credit and
       * validation failures are `false` — they can't change mid-batch, so
       * retrying only burns wall-clock. Absent means retryable.
       */
      retryable?: boolean;
    };

export const MAX_PROMPTS = 150;
export const MAX_PROMPT_CHARS = 500;

// ---------------------------------------------------------------------------
// Video generation
// ---------------------------------------------------------------------------

/** The still that a clip is animated from, plus everything needed to show it. */
export interface ShotImage {
  base64: string;
  mimeType: string;
  name: string;
  width: number;
  height: number;
}

/**
 * One row of the video storyboard: an image, its own prompt, and its own model
 * and output settings. Rows are independent — a batch can mix Veo and Grok, and
 * mix durations and resolutions, because each row is a separate kie task.
 */
export interface VideoShot {
  id: string;
  image: ShotImage;
  prompt: string;
  model: string;
  duration: number;
  resolution: string;
  aspectRatio: string;
  /**
   * Set once a kie task exists for this shot. Retrying then resumes that task
   * instead of paying for a second render of the same clip.
   */
  taskId?: string;
}

export interface GeneratedVideo extends GalleryOrderKeys {
  id: string;
  shotId: string;
  prompt: string;
  model: string;
  modelLabel: string;
  mimeType: string;
  /** Bytes, held as a Blob — videos are far too large to base64 into a store. */
  blob: Blob;
  sizeBytes: number;
  duration: number;
  resolution: string;
  aspectRatio: string;
  /** The source still, so the gallery can show what it was animated from. */
  posterBase64: string;
  posterMimeType: string;
  createdAt: number;
  credits: number;
  /** True when kie reported no figure and this is our own rate estimate. */
  creditsEstimated?: boolean;
  taskId: string;
  /** kie's CDN URL. Expires; the blob above does not. */
  sourceUrl: string;
}

/** POST /api/kie/video/start request body. */
export interface VideoStartRequest {
  accountId: string;
  model: string;
  prompt: string;
  image: { base64: string; mimeType: string };
  duration: number;
  resolution: string;
  aspectRatio: string;
}

/**
 * Starting and waiting are separate calls. A Veo clip can take well over fifteen
 * minutes, and an HTTP request held open that long dies to any timeout in
 * between — losing track of a task that has already been billed. The client
 * holds the taskId and polls, so a slow render costs patience, not money.
 */
export type VideoStartResponse =
  | { ok: true; taskId: string }
  | { ok: false; error: string; retryable?: boolean };

/**
 * One poll. `done` carries the URL rather than the bytes: a 1080p clip is tens
 * of megabytes, and base64 in JSON would inflate it by a third for no reason —
 * the client pulls the bytes through the file proxy instead.
 */
export type VideoStatusResponse =
  | { ok: true; state: "pending" }
  | {
      ok: true;
      state: "done";
      videoUrl: string;
      credits: number;
      /** Resolution kie reports back, which can differ from the request. */
      actualResolution?: string;
    }
  | { ok: false; error: string; retryable?: boolean };

export const MAX_SHOTS = 25;
