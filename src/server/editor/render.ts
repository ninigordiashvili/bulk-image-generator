import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ClipZoom,
  RenderClip,
  RenderRequest,
  RenderSettings,
} from "@/types/editor";
import { FFMPEG, FfmpegError, probeDuration, run } from "./ffmpeg";
import { outputPath, resolveInside, setPhase, type Job } from "./jobs";

/**
 * Leave a couple of cores for the OS and the dev server. Each worker is a whole
 * ffmpeg, and both the zoom filter and libx264 thread internally on top of
 * this, so going wider stops paying off well before the core count — measured
 * flat between 4 and 9 workers on a 10-core machine.
 */
const CONCURRENCY = Math.max(2, Math.min(6, os.cpus().length - 2));

/** A clip's boundaries in whole frames. */
export interface PlannedSegment {
  index: number;
  /** Absolute path to the source image, or null for a black gap. */
  source: string | null;
  zoom: ClipZoom;
  frames: number;
  file: string;
}

/**
 * Every cut is placed by rounding its absolute time to the nearest frame, and a
 * clip's length is the difference between its own boundaries. Sizing each clip
 * from its own duration instead would let the rounding error accumulate, and by
 * the hundredth image a 10-minute video would have drifted several frames off
 * the narration.
 */
export function planSegments(
  clips: RenderClip[],
  fps: number,
  dir: string
): PlannedSegment[] {
  const frameAt = (time: number) => Math.round(time * fps);
  const segments: PlannedSegment[] = [];

  clips.forEach((clip, index) => {
    const frames = frameAt(clip.end) - frameAt(clip.start);
    if (frames < 1) return;
    segments.push({
      index,
      source: clip.file ? path.join(dir, "images", clip.file) : null,
      zoom: clip.file ? clip.zoom : "none",
      frames,
      file: `seg-${String(index).padStart(4, "0")}.ts`,
    });
  });

  return segments;
}

/** Scale-and-letterbox to the output frame. Sources are already 16:9 in the
 *  normal case, so the pad is a no-op that only earns its keep on a stray one. */
function fitChain(width: number, height: number): string {
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=bicubic,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`
  );
}

/**
 * The Ken Burns move, as a per-frame perspective transform.
 *
 * `perspective` maps a quadrilateral of the source onto the whole output frame,
 * and — the reason it's here — its corners are floats resolved to a 256th of a
 * pixel. Shrinking that quadrilateral frame by frame is a centre zoom whose
 * crop window can sit *between* pixels.
 *
 * The obvious filter for this, `zoompan`, cannot: it truncates its crop origin
 * to a whole source pixel. A gentle zoom moves that origin by well under a
 * pixel per frame, so the picture holds still for two or three frames and then
 * snaps — measured at 70% of frames frozen on an 8s clip at 8%, which reads as
 * shake rather than drift. Supersampling only shrinks the steps; it cannot
 * remove them, and the extra up-then-down resample costs real sharpness.
 * Working at 1:1 here is both smoother and visibly sharper.
 */
export function zoomChain(
  width: number,
  height: number,
  fps: number,
  frames: number,
  zoom: ClipZoom,
  amount: number
): string {
  const span = Math.max(1, frames - 1);
  const a = amount.toFixed(4);
  // `on` is the output frame index, so this runs 1 → 1+amount across the clip.
  const z =
    zoom === "out"
      ? `((1+${a})-(on/${span})*${a})`
      : `(1+(on/${span})*${a})`;

  // Half the source rectangle that fills the frame at the current zoom.
  const halfX = (width / 2).toFixed(3);
  const halfY = (height / 2).toFixed(3);
  const dx = `(${width}/(2*${z}))`;
  const dy = `(${height}/(2*${z}))`;

  return (
    `${fitChain(width, height)},` +
    `perspective=` +
    `x0='${halfX}-${dx}':y0='${halfY}-${dy}':` +
    `x1='${halfX}+${dx}':y1='${halfY}-${dy}':` +
    `x2='${halfX}-${dx}':y2='${halfY}+${dy}':` +
    `x3='${halfX}+${dx}':y3='${halfY}+${dy}':` +
    // Cubic keeps roughly twice the fine detail of linear here, for about a
    // quarter more time.
    `sense=source:eval=frame:interpolation=cubic,` +
    `fps=${fps},format=yuv420p`
  );
}

/**
 * H.264 settings for the segments. Every segment is encoded identically so the
 * final pass can concatenate them by copying the streams instead of decoding
 * and re-encoding ten minutes of video a second time.
 */
export function codecArgs(settings: RenderSettings): string[] {
  if (settings.encoder === "h264_videotoolbox") {
    // The hardware encoder takes a bitrate, not a quality target. A slideshow
    // is cheap to code, so this is deliberately generous.
    const bits = settings.width * settings.height * settings.fps * 0.19;
    const mbps = Math.min(60, Math.max(4, Math.round(bits / 1_000_000)));
    return [
      "-c:v", "h264_videotoolbox",
      "-b:v", `${mbps}M`,
      "-profile:v", "high",
      "-pix_fmt", "yuv420p",
      "-allow_sw", "1",
    ];
  }

  // Pinned so the SPS is byte-identical across segments, which is what makes
  // the copy-concat safe. x264 would pick these itself, but not by contract.
  const level =
    settings.height <= 1080 ? "4.2" : settings.height <= 1440 ? "5.1" : "5.2";

  return [
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-profile:v", "high",
    "-level", level,
    "-pix_fmt", "yuv420p",
  ];
}

/** The full argument list for one segment. */
export function segmentArgs(
  segment: PlannedSegment,
  settings: RenderSettings,
  outDir: string
): string[] {
  const { width, height, fps } = settings;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];

  if (segment.source === null) {
    args.push(
      "-f", "lavfi",
      "-i", `color=c=black:s=${width}x${height}:r=${fps}`,
      "-vf", "format=yuv420p"
    );
  } else if (segment.zoom === "none") {
    // A still: one decode, then the same frame held for the whole slot.
    args.push(
      "-loop", "1", "-framerate", String(fps),
      "-i", segment.source,
      "-vf", `${fitChain(width, height)},fps=${fps},format=yuv420p`
    );
  } else {
    // `-framerate` matters: perspective animates on the frame counter, so the
    // stream has to arrive at the output rate or the move runs at the wrong
    // speed and the segment comes out the wrong length.
    args.push(
      "-loop", "1", "-framerate", String(fps),
      "-i", segment.source,
      "-vf",
      zoomChain(
        width, height, fps,
        segment.frames,
        segment.zoom,
        settings.zoomAmount
      )
    );
  }

  args.push(
    "-frames:v", String(segment.frames),
    "-an",
    ...codecArgs(settings),
    // MPEG-TS carries no container-level timing to disagree with, which is what
    // makes a hundred separately encoded pieces join cleanly.
    "-muxdelay", "0",
    "-muxpreload", "0",
    "-f", "mpegts",
    path.join(outDir, segment.file)
  );

  return args;
}

/** The final pass: join the segments without re-encoding, lay the audio under. */
export function muxArgs(
  listPath: string,
  audioPath: string | null,
  total: number,
  settings: RenderSettings,
  destination: string
): string[] {
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-progress", "pipe:1", "-nostats",
    "-fflags", "+genpts",
    "-f", "concat", "-safe", "0", "-i", listPath,
  ];

  if (audioPath) args.push("-i", audioPath);

  args.push("-map", "0:v:0");
  if (audioPath) args.push("-map", "1:a:0");

  args.push("-c:v", "copy");

  if (audioPath) {
    const fade = Math.min(settings.audioFadeOut, total);
    if (fade > 0) {
      args.push("-af", `afade=t=out:st=${(total - fade).toFixed(3)}:d=${fade.toFixed(3)}`);
    }
    args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000");
  } else {
    args.push("-an");
  }

  args.push(
    "-t", total.toFixed(3),
    "-movflags", "+faststart",
    destination
  );

  return args;
}

/**
 * Validates the request against the job's own files, then renders. Resolves
 * when the job reaches a terminal phase; the caller doesn't await it, the
 * client polls `job.status` instead.
 */
export async function renderJob(job: Job, request: RenderRequest): Promise<void> {
  const controller = new AbortController();
  job.controller = controller;
  job.startedAt = Date.now();
  job.status.error = null;
  job.status.outputBytes = 0;
  job.status.done = 0;
  setPhase(job, "preparing", "Checking the timeline…");

  try {
    const settings = request.settings;
    const segmentDir = path.join(job.dir, "segments");
    await fs.rm(segmentDir, { recursive: true, force: true });
    await fs.mkdir(segmentDir, { recursive: true });

    // Every referenced image has to be one this job actually received.
    for (const clip of request.clips) {
      if (clip.file === null) continue;
      const full = resolveInside(job, "images", clip.file);
      if (!full) throw new Error(`Rejected image name "${clip.file}".`);
      await fs.access(full).catch(() => {
        throw new Error(`Image "${clip.file}" was never uploaded.`);
      });
    }

    let audioPath: string | null = null;
    let total = request.total;

    if (request.audio) {
      audioPath = resolveInside(job, "", request.audio);
      if (!audioPath) throw new Error(`Rejected audio name "${request.audio}".`);
      const probed = await probeDuration(audioPath, controller.signal);
      if (probed <= 0) {
        throw new Error("Could not read a duration from the audio file.");
      }
      // The browser's own reading of the duration built the timeline, but
      // ffmpeg's is the one the render has to agree with, so it wins.
      total = probed;
    }

    if (!(total > 0)) throw new Error("The timeline has no duration.");

    // Clamp the tail to the authoritative total and drop anything past it.
    const clips: RenderClip[] = [];
    for (const clip of request.clips) {
      if (clip.start >= total) continue;
      clips.push({ ...clip, end: Math.min(clip.end, total) });
    }
    if (clips.length === 0) throw new Error("The timeline has no clips.");
    // The last clip always runs to the end, so no audio is left over silent.
    clips[clips.length - 1].end = total;

    const segments = planSegments(clips, settings.fps, job.dir);
    if (segments.length === 0) {
      throw new Error("Every clip rounded away to nothing at this frame rate.");
    }

    job.status.total = segments.length;
    setPhase(job, "rendering", `Rendering ${segments.length} clips…`);

    await renderSegments(job, segments, settings, segmentDir, controller);

    setPhase(job, "muxing", "Joining clips and adding audio…");

    const listPath = path.join(segmentDir, "list.txt");
    // Paths are resolved relative to the list file, so bare names are enough
    // and nothing in the job's own directory name can need quoting.
    await fs.writeFile(
      listPath,
      segments.map((segment) => `file '${segment.file}'`).join("\n") + "\n"
    );

    const destination = outputPath(job);
    await run(
      FFMPEG,
      muxArgs(listPath, audioPath, total, settings, destination),
      {
        signal: controller.signal,
        onProgress: (key, value) => {
          // `out_time_ms` is a long-standing misnomer that reports the same
          // microseconds as `out_time_us`; either will do.
          if (key !== "out_time_us") return;
          const seconds = Number(value) / 1_000_000;
          // Before the first frame lands ffmpeg reports INT64_MIN here, which
          // is finite and would otherwise render as a percentage in the
          // trillions.
          if (!Number.isFinite(seconds) || seconds < 0) return;
          const percent = Math.max(
            0,
            Math.min(100, Math.round((seconds / total) * 100))
          );
          job.status.message =
            percent >= 100
              ? "Finalising the MP4…"
              : `Joining clips and adding audio — ${percent}%`;
        },
      }
    );

    const stat = await fs.stat(destination);
    job.status.outputBytes = stat.size;
    job.status.done = segments.length;
    setPhase(job, "done", "Render complete.");

    // The segments are a few hundred megabytes of intermediates that nothing
    // reads again once the MP4 exists.
    await fs.rm(segmentDir, { recursive: true, force: true }).catch(() => {});
  } catch (error) {
    if (job.cancelRequested) {
      setPhase(job, "cancelled", "Render cancelled.");
    } else {
      job.status.error = describe(error);
      setPhase(job, "error", "Render failed.");
    }
    await fs
      .rm(path.join(job.dir, "segments"), { recursive: true, force: true })
      .catch(() => {});
  } finally {
    job.controller = null;
  }
}

/**
 * Runs the segment encodes a few at a time, counting them off as they land.
 * The first failure aborts the rest: they're all encoding the same broken
 * settings, so letting them finish only delays the error by a minute.
 */
async function renderSegments(
  job: Job,
  segments: PlannedSegment[],
  settings: RenderSettings,
  segmentDir: string,
  controller: AbortController
): Promise<void> {
  const { signal } = controller;
  let next = 0;
  let failure: Error | null = null;

  const worker = async () => {
    for (;;) {
      if (signal.aborted) return;
      const index = next++;
      if (index >= segments.length) return;
      const segment = segments[index];
      try {
        await run(FFMPEG, segmentArgs(segment, settings, segmentDir), { signal });
      } catch (error) {
        if (signal.aborted) return;
        const name = segment.source ? path.basename(segment.source) : "black gap";
        failure = new Error(
          `Clip ${segment.index + 1} (${name}): ${describe(error)}`
        );
        controller.abort();
        return;
      }
      job.status.done += 1;
      job.status.message = `Rendering clips — ${job.status.done} of ${segments.length}`;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, segments.length) }, worker)
  );

  if (failure) throw failure;
  if (signal.aborted) throw new Error("Cancelled.");
}

function describe(error: unknown): string {
  if (error instanceof FfmpegError) {
    const tail = error.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" · ");
    return tail ? `${error.message} — ${tail}` : error.message;
  }
  return error instanceof Error ? error.message : "Unexpected error.";
}
