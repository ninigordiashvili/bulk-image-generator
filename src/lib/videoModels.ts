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
export type VideoApi = "veo" | "jobs";

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

export const VIDEO_MODELS: readonly VideoModelSpec[] = [
  {
    id: "veo3_lite",
    label: "Veo 3.1 Lite",
    api: "veo",
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
    // Audio-driven, so every size field below is empty on purpose: the model
    // takes image_url + audio_url + prompt and nothing else.
    id: "kling/ai-avatar-standard",
    label: "Kling AI Avatar (Standard)",
    api: "jobs",
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
];

const BY_ID = new Map(VIDEO_MODELS.map((model) => [model.id, model]));

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
