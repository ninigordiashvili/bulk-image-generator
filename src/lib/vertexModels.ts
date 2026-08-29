/**
 * The Vertex AI models this app offers.
 *
 * Three things here are not obvious and each one cost a round of debugging.
 *
 * **Location is per model, not per project.** `gemini-3.1-flash-lite-image`
 * exists only on the `global` endpoint and returns a flat 404 from
 * `us-central1`; Veo answers on `us-central1`. There is no single location that
 * serves both, so each model carries its own and the provider keeps one client
 * per location.
 *
 * **There is only one image API worth using.** The Imagen `:predict` family is
 * both unavailable on this project and deprecated in the SDK, which now tells
 * you to call image models through `generateContent`. So every image model here
 * is a Gemini model and the Imagen path is gone.
 *
 * **`verified` means someone watched it work**, not that it looks right. The
 * flags below were set by generating real images and by making Veo reject a
 * deliberately bad request so it would name what it does accept. Options marked
 * unverified are plausible but untested — the project's quota is tight enough
 * that a 429 is easily mistaken for an invalid value, which is exactly the
 * mistake these flags exist to stop.
 */

export interface VertexImageModel {
  id: string;
  label: string;
  note: string;
  /** The endpoint that serves it. Not interchangeable. */
  location: string;
  aspectRatios: readonly string[];
  /** Confirmed working aspect ratios, a subset of the above. */
  verifiedAspectRatios: readonly string[];
  /** `imageConfig.imageSize` — the resolution tier. */
  imageSizes: readonly string[];
  verifiedImageSizes: readonly string[];
  maxImages: number;
  /** The project's measured per-minute quota for this model. */
  requestsPerMinute: number;
  /**
   * Roughly how long one call takes, measured. Needed because quota is not
   * always the binding constraint: at 2/min an image waits on quota, but a Veo
   * clip on the 50/min account waits on the model, and an estimate built from
   * quota alone would promise 50 clips a minute when five is the truth.
   */
  typicalCallSeconds: number;
}

export interface VertexVideoModel {
  id: string;
  label: string;
  note: string;
  location: string;
  aspectRatios: readonly string[];
  resolutions: readonly string[];
  verifiedResolutions: readonly string[];
  /** Veo rejects anything outside its own list. */
  durations: readonly number[];
  imageToVideo: boolean;
  requestsPerMinute: number;
  /** Fixed cost of a call, before the per-second-of-output part. */
  typicalCallSeconds: number;
  /** Added per second of requested clip length. */
  secondsPerOutputSecond: number;
}

export const VERTEX_IMAGE_MODELS: readonly VertexImageModel[] = [
  {
    id: "gemini-3.1-flash-lite-image",
    label: "Gemini 3.1 Flash Lite Image",
    note: "Verified working — but only on the global endpoint.",
    location: "global",
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    verifiedAspectRatios: ["16:9", "9:16", "1:1"],
    imageSizes: ["1K", "2K", "4K"],
    verifiedImageSizes: ["1K"],
    maxImages: 1,
    // GenContentImageGenRequestsPerMinutePerProjectPerBaseModelGlobal = 2
    requestsPerMinute: 2,
    // Measured: 5-13s per image when not waiting on quota.
    typicalCallSeconds: 10,
  },
  {
    id: "gemini-2.5-flash-image",
    label: "Gemini 2.5 Flash Image",
    note: "Also verified working on the global endpoint.",
    location: "global",
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    verifiedAspectRatios: ["16:9"],
    imageSizes: ["1K", "2K", "4K"],
    verifiedImageSizes: ["1K"],
    maxImages: 1,
    requestsPerMinute: 2,
    typicalCallSeconds: 10,
  },
];

export const VERTEX_VIDEO_MODELS: readonly VertexVideoModel[] = [
  {
    id: "veo-3.1-lite-generate-001",
    label: "Veo 3.1 Lite",
    note: "Verified reachable on us-central1. Cheapest Veo per second.",
    location: "us-central1",
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["720p", "1080p"],
    // Both confirmed: Veo accepted each and then rejected only the duration.
    verifiedResolutions: ["720p", "1080p"],
    // Veo itself listed these when it rejected an out-of-range ask.
    durations: [4, 6, 8],
    imageToVideo: true,
    // LongRunningPredictRequestsPerMinutePerProjectPerBaseModel = 1 on the main
    // account and 50 on the second; the account's own figure overrides this.
    requestsPerMinute: 1,
    // Measured: a 4s 720p clip took 37s end to end, so about 29s of fixed cost
    // plus roughly two seconds of work per second of output.
    typicalCallSeconds: 29,
    secondsPerOutputSecond: 2,
  },
];

export function findVertexImageModel(id: string): VertexImageModel | undefined {
  return VERTEX_IMAGE_MODELS.find((model) => model.id === id);
}

export function findVertexVideoModel(id: string): VertexVideoModel | undefined {
  return VERTEX_VIDEO_MODELS.find((model) => model.id === id);
}

/**
 * Where a model must be called. Unknown ids fall back to the configured default
 * rather than being refused — a new model should be usable before this file
 * knows about it.
 */
export function requestsPerMinuteFor(id: string, fallback: number): number {
  return (
    findVertexImageModel(id)?.requestsPerMinute ??
    findVertexVideoModel(id)?.requestsPerMinute ??
    fallback
  );
}

export function locationFor(id: string, fallback: string): string {
  return (
    findVertexImageModel(id)?.location ??
    findVertexVideoModel(id)?.location ??
    fallback
  );
}
