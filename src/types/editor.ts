/**
 * Types shared by the video editor's client and its render API. The editor
 * assembles a slideshow from images whose filenames encode the timestamp they
 * should appear at, lays an audio track under it, and hands the whole thing to
 * ffmpeg on the server.
 */

/** Which way an image drifts over its slot. `alternate` flips per clip. */
export type ZoomDirection = "none" | "in" | "out" | "alternate";

/** What a single clip actually does — `alternate` is resolved away by then. */
export type ClipZoom = "none" | "in" | "out";

/** What fills the screen before the first image, when it doesn't start at 0:00. */
export type LeadIn = "black" | "hold";

export type Encoder = "libx264" | "h264_videotoolbox";

export interface Resolution {
  label: string;
  width: number;
  height: number;
}

/** Everything the render depends on that isn't the clip list itself. */
export interface RenderSettings {
  width: number;
  height: number;
  fps: number;
  encoder: Encoder;
  /** Peak extra scale, as a fraction: 0.08 = the image ends 8% larger. */
  zoomAmount: number;
  /** Seconds of audio fade at the tail. 0 disables it. */
  audioFadeOut: number;
  fileName: string;
}

/** One slot on the timeline. `file` is null for a black gap. */
export interface RenderClip {
  file: string | null;
  start: number;
  end: number;
  zoom: ClipZoom;
}

export interface RenderRequest {
  clips: RenderClip[];
  /** Stored basename of the uploaded audio, or null for a silent render. */
  audio: string | null;
  total: number;
  settings: RenderSettings;
}

export type JobPhase =
  | "new"
  | "preparing"
  | "rendering"
  | "muxing"
  | "done"
  | "error"
  | "cancelled";

export interface JobStatus {
  id: string;
  phase: JobPhase;
  /** Segments finished / total, meaningful during `rendering`. */
  done: number;
  total: number;
  message: string;
  error: string | null;
  outputBytes: number;
  elapsedMs: number;
}

export interface UploadResponse {
  ok: true;
  /** Server-side basename to reference from the render request. */
  stored: string;
  bytes: number;
}

export interface CreateJobResponse {
  ok: true;
  id: string;
}

export interface ErrorResponse {
  ok: false;
  error: string;
}

export const RESOLUTIONS: Resolution[] = [
  { label: "720p", width: 1280, height: 720 },
  { label: "1080p", width: 1920, height: 1080 },
  { label: "1440p", width: 2560, height: 1440 },
  { label: "4K", width: 3840, height: 2160 },
];

export const FPS_CHOICES = [24, 25, 30, 60] as const;

export const DEFAULT_SETTINGS: RenderSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  encoder: "libx264",
  zoomAmount: 0.08,
  audioFadeOut: 1.5,
  fileName: "slideshow.mp4",
};

/** Upper bound on images per render — a guard against a stray folder drop. */
export const MAX_IMAGES = 600;
