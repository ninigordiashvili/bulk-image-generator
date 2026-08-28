/**
 * The image-to-video models this app drives. Unlike the image catalog — which is
 * generated from kie's OpenAPI specs — there are only two, and they sit on
 * *different* kie APIs with incompatible parameter shapes, so they're described
 * by hand:
 *
 * - Veo 3.1 Lite lives on kie's dedicated Veo namespace (`/api/v1/veo/*`), takes
 *   a fixed set of durations, and names its images field `imageUrls`.
 * - Grok Image-to-Video is an ordinary market model on `jobs/createTask`, takes
 *   any duration from 6 to 30 seconds, and wants that number as a *string*.
 *
 * Verified against docs.kie.ai on 2026-07-31.
 */

/** Which kie API a model is reached through — they poll differently too. */
export type VideoApi = "veo" | "jobs" | "vertex";

/**
 * What supplies the clip's content and length.
 *
 * `prompt` models animate a still for a length you pick. `audio` models are
 * talking avatars: they lip-sync the still to a voice track, so the audio *is*
 * the clip — its length, its pacing, its content — and duration, resolution and
 * aspect ratio aren't theirs to choose.
 */
export type VideoInput = "prompt" | "audio";

export interface VideoModelSpec {
  id: string;
  label: string;
  api: VideoApi;
  /**
   * Which account pays. Both providers serve a model called "Veo 3.1 Lite" and
   * they are not the same thing — one bills kie.ai credits, the other Google
   * Cloud — so the picker must never show them together.
   */
  provider: "kie" | "vertex";
  input: VideoInput;
  /** Model string sent in the request body. */
  requestModel: string;
  docUrl: string;
  /** Allowed clip lengths in seconds. */
  durations: readonly number[];
  defaultDuration: number;
  resolutions: readonly string[];
  defaultResolution: string;
  aspectRatios: readonly string[];
  defaultAspectRatio: string;
  blurb: string;
  /** Longest audio the model accepts, for `audio` models only. */
  maxAudioSeconds?: number;
}

/** True when a row needs an audio cut rather than a duration. */
export function isAudioDriven(spec: VideoModelSpec): boolean {
  return spec.input === "audio";
}

/** 6–30s at 1s steps, per the Grok schema. */
const GROK_DURATIONS = Array.from({ length: 25 }, (_, index) => index + 6);

/** 1–15s, per the published Grok Imagine Video 1.5 range. */
const GROK_15_DURATIONS = Array.from({ length: 15 }, (_, index) => index + 1);

/** 4–12s, per the Seedance 1.5 Pro schema. */
const SEEDANCE_DURATIONS = Array.from({ length: 9 }, (_, index) => index + 4);

export const VIDEO_MODELS: readonly VideoModelSpec[] = [
  {
    id: "veo3_lite",
    label: "Veo 3.1 Lite",
    api: "veo",
    provider: "kie",
    input: "prompt",
    requestModel: "veo3_lite",
    docUrl: "https://docs.kie.ai/veo3-api/generate-veo-3-video",
    durations: [4, 6, 8],
    defaultDuration: 8,
    resolutions: ["720p", "1080p", "4k"],
    defaultResolution: "720p",
    aspectRatios: ["16:9", "9:16", "Auto"],
    defaultAspectRatio: "16:9",
    blurb: "Google Veo 3.1 Lite. Short clips, native audio, highest fidelity here.",
  },
  {
    id: "grok-imagine/image-to-video",
    label: "Grok Image-to-Video",
    api: "jobs",
    provider: "kie",
    input: "prompt",
    requestModel: "grok-imagine/image-to-video",
    docUrl: "https://docs.kie.ai/market/grok-imagine/image-to-video",
    durations: GROK_DURATIONS,
    defaultDuration: 6,
    resolutions: ["480p", "720p"],
    defaultResolution: "720p",
    aspectRatios: ["16:9", "9:16", "1:1", "3:2", "2:3"],
    defaultAspectRatio: "16:9",
    blurb: "xAI Grok Imagine. Much longer clips (up to 30s), lower resolution ceiling.",
  },
  {
    id: "grok-imagine-video-1-5-preview",
    label: "Grok Imagine Video 1.5",
    api: "jobs",
    provider: "kie",
    input: "prompt",
    // Not the `grok-imagine/...` form the older entry uses — this one has no
    // slash, which was confirmed against kie's API rather than assumed from
    // the family's naming.
    requestModel: "grok-imagine-video-1-5-preview",
    docUrl: "https://kie.ai/grok-imagine-video-1.5",
    durations: GROK_15_DURATIONS,
    defaultDuration: 8,
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "720p",
    // Taken from the older Grok Imagine entry: kie's docs for this model were
    // unreachable, and the aspect set is the one part not published elsewhere.
    aspectRatios: ["16:9", "9:16", "1:1", "3:2", "2:3"],
    defaultAspectRatio: "16:9",
    blurb:
      "xAI Grok Imagine 1.5. 1–15s and up to 1080p — costs scale steeply with " +
      "resolution (roughly 2.4 / 4.5 / 8 credits per second at 480p / 720p / 1080p).",
  },
  {
    id: "bytedance/seedance-1.5-pro",
    label: "Seedance 1.5 Pro",
    api: "jobs",
    provider: "kie",
    input: "prompt",
    requestModel: "bytedance/seedance-1.5-pro",
    docUrl: "https://docs.kie.ai/market/bytedance/seedance-1-5-pro",
    durations: SEEDANCE_DURATIONS,
    defaultDuration: 8,
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "720p",
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    defaultAspectRatio: "16:9",
    blurb:
      "ByteDance Seedance 1.5 Pro. 4–12s, up to 1080p, and the widest aspect " +
      "range here including 21:9.",
  },
  {
    // Audio-driven, so every size field below is empty on purpose: the model
    // takes image_url + audio_url + prompt and nothing else.
    id: "kling/ai-avatar-standard",
    label: "Kling AI Avatar (Standard)",
    api: "jobs",
    provider: "kie",
    input: "audio",
    requestModel: "kling/ai-avatar-standard",
    docUrl: "https://docs.kie.ai/market/kling/ai-avatar-standard",
    durations: [],
    defaultDuration: 0,
    resolutions: [],
    defaultResolution: "",
    aspectRatios: [],
    defaultAspectRatio: "",
    maxAudioSeconds: 300,
    blurb: "Talking avatar: lip-syncs a portrait to a voice track. Length comes from the audio.",
  },
  {
    id: "kling/ai-avatar-pro",
    label: "Kling AI Avatar (Pro)",
    api: "jobs",
    provider: "kie",
    input: "audio",
    requestModel: "kling/ai-avatar-pro",
    docUrl: "https://docs.kie.ai/market/kling/ai-avatar-pro",
    durations: [],
    defaultDuration: 0,
    resolutions: [],
    defaultResolution: "",
    aspectRatios: [],
    defaultAspectRatio: "",
    maxAudioSeconds: 300,
    blurb: "The same avatar model at higher fidelity, for more credits per second.",
  },
  {
    id: "vertex:veo-3.1-lite-generate-001",
    label: "Veo 3.1 Lite (Vertex)",
    api: "vertex",
    provider: "vertex",
    input: "prompt",
    requestModel: "veo-3.1-lite-generate-001",
    docUrl: "https://cloud.google.com/vertex-ai/generative-ai/pricing",
    // Veo named these itself when it rejected an out-of-range request.
    durations: [4, 6, 8],
    defaultDuration: 8,
    // kie's Veo offers 4k; Vertex did not accept it here, so it is left out
    // rather than shown and then rejected after a minute of waiting.
    resolutions: ["720p", "1080p"],
    defaultResolution: "720p",
    aspectRatios: ["16:9", "9:16"],
    defaultAspectRatio: "16:9",
    blurb:
      "Google Veo 3.1 Lite billed to your Google Cloud credits. Silent by " +
      "default — the editor lays your own narration under.",
  },
];

const BY_ID = new Map(VIDEO_MODELS.map((model) => [model.id, model]));

/** The models one provider's account can actually run. */
export function videoModelsFor(
  provider: "kie" | "vertex"
): readonly VideoModelSpec[] {
  return VIDEO_MODELS.filter((model) => model.provider === provider);
}

/** The model a provider falls back to when the current one is the other's. */
export function defaultVideoModelFor(provider: "kie" | "vertex"): string {
  return videoModelsFor(provider)[0]?.id ?? DEFAULT_VIDEO_MODEL;
}

export const DEFAULT_VIDEO_MODEL = VIDEO_MODELS[0].id;

export function findVideoModel(id: string): VideoModelSpec | undefined {
  return BY_ID.get(id);
}

export function videoModel(id: string): VideoModelSpec {
  return BY_ID.get(id) ?? VIDEO_MODELS[0];
}

/**
 * Snaps a duration/resolution/ratio to something the given model actually
 * accepts. Switching a row from Grok to Veo has to move 30s down to 8s, and
 * 480p up to 720p, or kie rejects the call.
 */
export function clampToModel(
  spec: VideoModelSpec,
  settings: { duration: number; resolution: string; aspectRatio: string }
): { duration: number; resolution: string; aspectRatio: string } {
  // An audio-driven model has no size options to snap to, and its row keeps
  // whatever the other models left behind so switching back is lossless.
  if (spec.input === "audio") return settings;

  const duration = spec.durations.includes(settings.duration)
    ? settings.duration
    : nearest(spec.durations, settings.duration);
  return {
    duration,
    resolution: spec.resolutions.includes(settings.resolution)
      ? settings.resolution
      : spec.defaultResolution,
    aspectRatio: spec.aspectRatios.includes(settings.aspectRatio)
      ? settings.aspectRatio
      : spec.defaultAspectRatio,
  };
}

/** Closest allowed duration, so switching models keeps the user's intent. */
function nearest(allowed: readonly number[], value: number): number {
  return allowed.reduce((best, candidate) =>
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best
  );
}
