/**
 * Types shared by the video editor's client and its render API. The editor
 * assembles a slideshow from images whose filenames encode the timestamp they
 * should appear at, lays an audio track under it, and hands the whole thing to
 * ffmpeg on the server.
 */

/**
 * What a visual on the timeline is. The distinction drives everything that
 * follows: a talking clip owns its length and takes no effects, while a still
 * or a motion clip flexes to fit and wears whatever look is set.
 */
export type ClipKind = "still" | "motion" | "avatar";

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
  /**
   * Peak extra scale for a **still**, as a fraction: 0.08 = it ends 8% larger.
   * Named without a suffix because it predates the split and is what older
   * saved settings carry; renaming it would silently reset everyone's choice.
   */
  zoomAmount: number;
  /**
   * The same for a **motion clip**. Separate because the shot is already
   * moving, so the amount that reads as a gentle drift over a still is usually
   * too much on top of footage.
   */
  zoomAmountMotion: number;
  /** Seconds of audio fade at the tail. 0 disables it. */
  audioFadeOut: number;
  fileName: string;

  /** Old-film treatment: moving grain, flicker, vignette, faded curves. */
  film: FilmLook;
  /**
   * Which kinds the effects touch. Talking clips are excluded by default and
   * in practice always: a zoom on a speaking face reads as a mistake, and
   * grain over it fights the one thing the viewer is trying to read.
   */
  effectsOnStills: boolean;
  effectsOnMotion: boolean;

  /**
   * A still or motion clip shorter than this is skipped rather than flashed.
   * Avatars are exempt — they are never squeezed.
   */
  minVisualSeconds: number;
  /**
   * Cap on how far a motion clip may be slowed to fill its slot. Past roughly
   * 2.5x, interpolation starts inventing visible nonsense around fast motion.
   */
  maxStretch: number;
}

/** One slot on the timeline. `file` is null for a black gap. */
export interface RenderClip {
  file: string | null;
  kind: ClipKind;
  start: number;
  end: number;
  zoom: ClipZoom;
  /**
   * For a video source: how much of it to use, from its own start. An avatar
   * is cut here at the point the talking stops. Undefined for a still.
   */
  sourceSeconds?: number;
  /** Whether the film look applies — resolved from the settings and the kind. */
  film: boolean;
}

/** How heavy the old-film treatment is. */
export type FilmLook = "off" | "subtle" | "medium" | "heavy";

export interface RenderRequest {
  clips: RenderClip[];
  /** Stored basename of the uploaded audio, or null for a silent render. */
  audio: string | null;
  total: number;
  settings: RenderSettings;
  /** Text shown over the picture. Absent on an older client's request. */
  moments?: TextMoment[];
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

/** What joining a set of voice tracks did, so the UI can say so. */
export interface PaceReport {
  stored: string;
  storedMp3: string;
  noiseFloorDb: number;
  speechDb: number;
  thresholdDb: number;
  uncertain: boolean;
  duration: number;
  originalDuration: number;
  tightened: number;
  removed: number;
  longestGap: number;
  parts: number;
}

export interface PaceResponse {
  ok: true;
  report: PaceReport;
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
  zoomAmountMotion: 0.04,
  audioFadeOut: 1.5,
  fileName: "slideshow.mp4",
  film: "off",
  effectsOnStills: true,
  effectsOnMotion: true,
  minVisualSeconds: 2,
  maxStretch: 2.5,
};

/** Upper bound on visuals per render — a guard against a stray folder drop. */
export const MAX_IMAGES = 600;

/** Video containers the editor will take alongside stills. */
export const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "webm"] as const;

import type { MomentStyle } from "@/lib/editor/textStyles";

/** How a text moment arrives on screen. */
export type MomentAnimation = "rise" | "fade" | "drop";

/** The same list at runtime, for validating what a request claims. */
export const MOMENT_ANIMATIONS: MomentAnimation[] = ["rise", "fade", "drop"];

/**
 * A phrase shown over the picture at a given moment.
 *
 * Times are absolute against the narration, the same as cues — the renderer
 * rebases them onto whichever segments they land in.
 */
export interface TextMoment {
  id: string;
  text: string;
  start: number;
  duration: number;
  animation: MomentAnimation;
  /** Which look it wears. Absent on moments saved before styles existed. */
  style?: MomentStyle;
  /** How much the picture behind is dimmed, 0 to 0.8. */
  darken: number;
  /**
   * An image standing behind the text — a gradient plate, a bar, whatever was
   * attached. It belongs to the moment: it appears and fades with it, so it is
   * an effect on the text rather than a clip of its own, and it never takes a
   * slot on the timeline.
   *
   * Two references, because the two sides address it differently. `backdropId`
   * points at the file held in the browser, which is what the preview draws.
   * `backdropImage` is the name it was stored under on the server, filled in
   * during upload and the only one the renderer reads.
   */
  backdropId?: string;
  backdropImage?: string;
  /**
   * Height as a fraction of the frame, so the plate scales with the export
   * rather than being pinned to the pixels it was drawn at. Absent means full
   * width at the image's own aspect.
   */
  backdropHeight?: number;
  /** Scales the whole plate's opacity, 0 to 1. Its own alpha is kept. */
  backdropOpacity?: number;
  /** Text height as a fraction of frame height, so it scales with the export. */
  size: number;
  /**
   * Where the text sits, as a fraction of the frame — 0.5/0.5 is the centre,
   * which is where everything sat before this existed. Stored as fractions
   * rather than pixels so a moment placed against the 960-wide preview lands in
   * the same place in a 1920 or 3840 export.
   *
   * Optional because moments saved before dragging existed have neither, and
   * they must keep centring rather than collapsing into the corner.
   */
  x?: number;
  y?: number;
  /** Seconds to fade up on arrival. 0 snaps on. */
  fadeIn: number;
  /** And to fade away at the end. Counted inside `duration`, not added to it. */
  fadeOut: number;
}

export const MOMENT_DEFAULTS = {
  duration: 4,
  animation: "rise" as MomentAnimation,
  style: "modern" as MomentStyle,
  fadeIn: 0.35,
  fadeOut: 0.45,
  darken: 0.35,
  size: 0.12,
  x: 0.5,
  y: 0.5,
  // 510 of 1080, the height that was asked for, expressed so it holds at any
  // export size. Off by default: it is an effect, not a fixture.
  backdropHeight: 0,
  backdropOpacity: 1,
};

/** The height a backdrop takes when it is first switched on. */
export const BACKDROP_DEFAULT_HEIGHT = 510 / 1080;

export const MAX_MOMENTS = 60;
