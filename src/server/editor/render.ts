import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ClipKind,
  ClipZoom,
  FilmLook,
  RenderClip,
  RenderRequest,
  RenderSettings,
  TextMoment,
} from "@/types/editor";
import { MAX_MOMENTS } from "@/types/editor";
import { overlayChain } from "./textOverlay";
import { FFMPEG, FfmpegError, probeDuration, run } from "./ffmpeg";
import { outputPath, resolveInside, setPhase, type Job } from "./jobs";

/**
 * Leave a couple of cores for the OS and the dev server. Each worker is a whole
 * ffmpeg, and both the zoom filter and libx264 thread internally on top of
 * this, so going wider stops paying off well before the core count — measured
 * flat between 4 and 9 workers on a 10-core machine.
 */
const CONCURRENCY = Math.max(2, Math.min(6, os.cpus().length - 2));

/** A clip's boundaries in whole frames, and how to build it. */
export interface PlannedSegment {
  index: number;
  /** Absolute path to the source, or null for a black gap. */
  source: string | null;
  kind: ClipKind;
  zoom: ClipZoom;
  film: boolean;
  frames: number;
  /** Seconds of the source to use; only meaningful for a video source. */
  sourceSeconds: number;
  /** How much the slot outruns the footage. 1 means play at normal speed. */
  stretch: number;
  /**
   * Where this segment sits in the finished film. Text moments are placed
   * against the narration, not against a clip, so they need this to be rebased
   * onto the segment's own clock.
   */
  startSeconds: number;
  endSeconds: number;
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
  dir: string,
  maxStretch = 2.5
): PlannedSegment[] {
  const frameAt = (time: number) => Math.round(time * fps);
  const segments: PlannedSegment[] = [];

  clips.forEach((clip, index) => {
    const frames = frameAt(clip.end) - frameAt(clip.start);
    if (frames < 1) return;

    const slotSeconds = frames / fps;
    const sourceSeconds = clip.sourceSeconds ?? 0;
    // A motion clip is slowed to fill its slot. An avatar never is: its length
    // is its speech, and stretching it would put the lips out of time.
    const stretch =
      clip.kind === "motion" && sourceSeconds > 0
        ? Math.min(maxStretch, Math.max(1, slotSeconds / sourceSeconds))
        : 1;

    segments.push({
      index,
      source: clip.file ? path.join(dir, "images", clip.file) : null,
      kind: clip.file ? clip.kind : "still",
      zoom: clip.file ? clip.zoom : "none",
      film: clip.file ? clip.film : false,
      frames,
      sourceSeconds,
      stretch,
      // From the frame numbers, not from clip.start — the cut is placed by
      // rounding, and a moment has to line up with where the cut actually
      // landed rather than where it was asked for.
      startSeconds: frameAt(clip.start) / fps,
      endSeconds: frameAt(clip.end) / fps,
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
  frames: number,
  zoom: ClipZoom,
  amount: number
): string {
  if (zoom === "none" || amount <= 0) return "";
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

  // Fit is the caller's job: a still needs it first, a video clip has already
  // had it, and doing it twice would resample for nothing.
  return (
    `perspective=` +
    `x0='${halfX}-${dx}':y0='${halfY}-${dy}':` +
    `x1='${halfX}+${dx}':y1='${halfY}-${dy}':` +
    `x2='${halfX}-${dx}':y2='${halfY}+${dy}':` +
    `x3='${halfX}+${dx}':y3='${halfY}+${dy}':` +
    // Cubic keeps roughly twice the fine detail of linear here, for about a
    // quarter more time.
    `sense=source:eval=frame:interpolation=cubic`
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


/**
 * The old-film treatment.
 *
 * Four things, and the two that matter most only exist in motion:
 *
 *  - grain that re-randomises every frame (`allf=t`), not a fixed overlay —
 *    static grain reads as a dirty lens, moving grain reads as film;
 *  - flicker: a slow exposure drift with an occasional brighter pulse riding on
 *    top, described below;
 *  - vignette and faded curves, which are just the look sitting still.
 *
 * No gate weave. A real projector drifts a pixel or two and it is authentic,
 * but over a slideshow of stills it reads as camera shake rather than as film,
 * and shake is not what anyone is asking a film look for.
 *
 * Grain is noise, and noise is what H.264 spends bits on, so a heavy setting
 * will grow the file noticeably. That's the honest cost, not a bug.
 */
/**
 * Exposure flicker.
 *
 * This was two fast oscillators (2.1Hz and 4.7Hz), and it strobed. `eq` applies
 * brightness in coarse quanta — a change lands as a jump of about three and a
 * half grey levels, never something smaller — so a fast wobble doesn't read as
 * a gentle shimmer, it reads as a stream of little flashes. Measured on a flat
 * grey field: brightness moved on 44-79% of all frames, up to 24 times a
 * second, and never held still for more than a fifth of a second.
 *
 * So the wobble is slow enough that the quantisation has nothing to bite on,
 * and the *flash* is now a deliberate, isolated event: a brief pulse every six
 * to nine seconds, which is what a worn print actually does. Same measurement
 * on the settings below: brightness moves on 2-6% of frames, and sits perfectly
 * still for five to eight seconds between pulses.
 *
 * The two drift periods are deliberately non-harmonic, so the pattern doesn't
 * line up with itself and start sounding like a loop.
 */
interface Flicker {
  /** Amplitude and period of the two drift oscillators. */
  a1: number; p1: number;
  a2: number; p2: number;
  /** Height, spacing and width of the pulse. */
  pulse: number; every: number; width: number;
}

function flickerExpression(f: Flicker): string {
  return (
    `${f.a1}*sin(2*PI*t/${f.p1})+${f.a2}*sin(2*PI*t/${f.p2})` +
    `+${f.pulse}*exp(-pow((mod(t,${f.every})-${f.every / 2})/${f.width},2))`
  );
}

export function filmChain(look: FilmLook): string {
  if (look === "off") return "";

  const preset = {
    subtle: {
      grain: 6, vignette: "PI/5", sat: 0.9, contrast: 1.03,
      flicker: { a1: 0.004, p1: 12.7, a2: 0.003, p2: 7.3, pulse: 0.016, every: 9.1, width: 0.13 },
    },
    medium: {
      grain: 13, vignette: "PI/4.2", sat: 0.76, contrast: 1.08,
      flicker: { a1: 0.006, p1: 11.3, a2: 0.004, p2: 6.7, pulse: 0.026, every: 7.3, width: 0.13 },
    },
    heavy: {
      grain: 24, vignette: "PI/3.6", sat: 0.55, contrast: 1.14,
      flicker: { a1: 0.007, p1: 10.1, a2: 0.004, p2: 6.1, pulse: 0.040, every: 5.9, width: 0.14 },
    },
  }[look];

  const parts: string[] = [];

  parts.push(
    `eq=saturation=${preset.sat}:contrast=${preset.contrast}` +
      `:brightness='${flickerExpression(preset.flicker)}':eval=frame`,
    `curves=r='0/0.05 0.5/0.52 1/0.95':g='0/0.045 1/0.94':b='0/0.08 1/0.88'`,
    `vignette=${preset.vignette}`,
    `noise=alls=${preset.grain}:allf=t+u`
  );

  return parts.join(",");
}

/**
 * A video source, fitted to the frame.
 *
 * `stretch` above 1 slows the clip to fill its slot, and the interpolation is
 * the expensive part of the whole render — around 70 seconds per stretched
 * clip at 1080p. It earns that: repeating frames instead would judder, and
 * judder is the thing the user was avoiding by hand.
 *
 * `tpad` covers the case where the footage still falls short after stretching
 * — the last frame holds rather than the segment ending early and knocking
 * everything after it out of place.
 */
export function videoChain(
  width: number,
  height: number,
  fps: number,
  frames: number,
  stretch: number
): string {
  const parts = [fitChain(width, height)];

  if (stretch > 1.001) {
    parts.push(
      `setpts=${stretch.toFixed(4)}*PTS`,
      `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`
    );
  } else {
    parts.push(`fps=${fps}`);
  }

  const seconds = (frames / fps).toFixed(3);
  parts.push(
    `tpad=stop_mode=clone:stop_duration=${seconds}`,
    `trim=duration=${seconds}`,
    "setpts=PTS-STARTPTS",
    `fps=${fps}`
  );

  return parts.join(",");
}

/** The full argument list for one segment. */
export function segmentArgs(
  segment: PlannedSegment,
  settings: RenderSettings,
  outDir: string,
  moments: TextMoment[] = []
): string[] {
  const { width, height, fps } = settings;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  const isVideo = segment.kind !== "still";

  let chain: string;

  if (segment.source === null) {
    args.push("-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=${fps}`);
    chain = "format=yuv420p";
  } else if (isVideo) {
    // An avatar is cut at the point the talking stops, so the picture doesn't
    // sit on a closed mouth while the narration carries on underneath.
    if (segment.sourceSeconds > 0) args.push("-t", segment.sourceSeconds.toFixed(3));
    args.push("-i", segment.source);
    chain = videoChain(width, height, fps, segment.frames, segment.stretch);
  } else {
    // `-framerate` matters: perspective animates on the frame counter, so the
    // stream has to arrive at the output rate or the move runs at the wrong
    // speed and the segment comes out the wrong length.
    args.push("-loop", "1", "-framerate", String(fps), "-i", segment.source);
    chain = `${fitChain(width, height)},fps=${fps}`;
  }

  // The move goes on after the source is fitted and at the output rate — which
  // is also what lets a motion clip take one. It never did before: the video
  // branch simply had no zoom in it, so the setting was accepted and ignored.
  if (segment.source !== null) {
    const amount =
      segment.kind === "motion" ? settings.zoomAmountMotion : settings.zoomAmount;
    const move = zoomChain(width, height, segment.frames, segment.zoom, amount);
    if (move) chain = `${chain},${move}`;
  }

  // The look goes on last, over whatever the clip turned out to be — and only
  // where the settings allow it, which is never on a talking face.
  const film = segment.film ? filmChain(settings.film) : "";

  // Text sits above the look: grain and vignette belong to the picture, and a
  // caption is not part of the picture.
  const text = overlayChain(moments, segment.startSeconds, segment.endSeconds, height);

  args.push("-vf", [chain, film, text, "format=yuv420p"].filter(Boolean).join(","));

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

/**
 * The concat list, with every segment's length declared rather than measured.
 *
 * This is the whole of the export drift. The concat demuxer places each file at
 * the sum of the lengths of the files before it, and where a file doesn't say
 * how long it is, it has to work it out by reading the tail and taking the last
 * timestamp it can find. MPEG-TS carries no duration, so every segment is
 * measured that way, and on a segment whose final packets don't yield a clean
 * answer the estimate comes back one frame short. The next segment is then laid
 * down 33ms early, its first frame lands on a timestamp the previous segment
 * already used, and — because the offsets accumulate — everything from there to
 * the end of the film moves up with it.
 *
 * Measured on a 16-minute export: 28,950 frames but 28,933 distinct timestamps.
 * Seventeen of the 134 joins lost a frame each, every one of them on a
 * segment's *first* packet, for 567ms of picture running ahead of the
 * narration by the end. It is invisible at 0:00 and worst at the tail, which is
 * why it reads as the avatars slipping out of sync rather than as a join fault.
 *
 * Nothing here needs estimating: a segment is encoded with `-frames:v frames`,
 * so it is `frames / fps` long to the tick. Declaring that is exact, it leaves
 * the packets untouched — this is still a stream copy — and it does not go near
 * frame numbering, which is what broke when this was attacked from the other
 * end (see the reverted `setts` attempt: renumbering works in decode order and
 * H.264 does not decode in display order).
 *
 * Six decimals is the demuxer's own microsecond resolution. The worst rounding
 * is half a microsecond per segment, so a thousand-segment film would still be
 * inside a thousandth of a frame.
 */
export function concatList(segments: PlannedSegment[], fps: number): string {
  return (
    segments
      .map(
        (segment) =>
          // Paths are resolved relative to the list file, so bare names are
          // enough and nothing in the job's own directory name can need
          // quoting. `duration` applies to the file declared above it.
          `file '${segment.file}'\nduration ${(segment.frames / fps).toFixed(6)}`
      )
      .join("\n") + "\n"
  );
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

    const segments = planSegments(clips, settings.fps, job.dir, settings.maxStretch);
    if (segments.length === 0) {
      throw new Error("Every clip rounded away to nothing at this frame rate.");
    }

    job.status.total = segments.length;
    setPhase(job, "rendering", `Rendering ${segments.length} clips…`);

    // Sorted and capped here rather than trusted from the request: the chain
    // is built per segment, and an unbounded list would be an unbounded filter
    // graph on every one of them.
    const moments = (request.moments ?? [])
      .filter((moment) => moment.text.trim().length > 0 && moment.duration > 0)
      .slice(0, MAX_MOMENTS)
      .sort((a, b) => a.start - b.start);

    await renderSegments(job, segments, settings, segmentDir, controller, moments);

    setPhase(job, "muxing", "Joining clips and adding audio…");

    const listPath = path.join(segmentDir, "list.txt");
    await fs.writeFile(listPath, concatList(segments, settings.fps));

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
    // reads again once the MP4 exists — but they are also the only way to
    // re-run a join on real content, and join faults have not reproduced on
    // generated sources. `KEEP_SEGMENTS=1` retries a suspect mux in seconds
    // instead of re-rendering the film to get back to the same place.
    if (process.env.KEEP_SEGMENTS !== "1") {
      await fs.rm(segmentDir, { recursive: true, force: true }).catch(() => {});
    }
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
  controller: AbortController,
  moments: TextMoment[]
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
        await run(FFMPEG, segmentArgs(segment, settings, segmentDir, moments), { signal });
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
