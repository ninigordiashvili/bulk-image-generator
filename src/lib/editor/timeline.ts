import type { ClipZoom, LeadIn, ZoomDirection } from "@/types/editor";

/** An image as the editor holds it, before it's been placed on the timeline. */
export interface TimelineInput {
  id: string;
  label: string;
  /** Parsed from the filename; null means the name carried no cue. */
  seconds: number | null;
  excluded: boolean;
}

export interface TimelineClip {
  /** null for a black gap — a lead-in, or a slot no image claimed. */
  imageId: string | null;
  label: string;
  start: number;
  end: number;
  index: number;
}

export interface Timeline {
  clips: TimelineClip[];
  /** Length of the finished video. */
  total: number;
  warnings: string[];
  /** Images that got a slot, in play order — what the counters report. */
  placed: number;
}

export interface TimelineOptions {
  items: TimelineInput[];
  /** Length of the loaded audio, or 0 when there is none. */
  audioDuration: number;
  /** How long the last image holds when there's no audio to run out. */
  tailSeconds: number;
  leadIn: LeadIn;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Places every image on a timeline that runs from 0 to the end of the audio.
 *
 * An image holds the screen from its own cue until the next image's cue, and
 * the last one holds until the audio stops. That single rule is the whole
 * format: nothing about the video is described anywhere but in the filenames.
 */
export function buildTimeline({
  items,
  audioDuration,
  tailSeconds,
  leadIn,
}: TimelineOptions): Timeline {
  const warnings: string[] = [];
  const usable: TimelineInput[] = [];

  for (const item of items) {
    if (item.excluded) continue;
    if (item.seconds === null || Number.isNaN(item.seconds)) {
      warnings.push(`${item.label} — no timestamp in the filename, skipped.`);
      continue;
    }
    if (item.seconds < 0) {
      warnings.push(`${item.label} — negative timestamp, skipped.`);
      continue;
    }
    usable.push(item);
  }

  // Ties break on label so the order is stable across reloads rather than
  // depending on whatever sequence the file picker handed them over in.
  usable.sort(
    (a, b) => a.seconds! - b.seconds! || a.label.localeCompare(b.label)
  );

  const deduped: TimelineInput[] = [];
  for (const item of usable) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.seconds === item.seconds) {
      warnings.push(
        `${item.label} — same timestamp as ${previous.label}, skipped.`
      );
      continue;
    }
    deduped.push(item);
  }

  if (deduped.length === 0) {
    return { clips: [], total: 0, warnings, placed: 0 };
  }

  const hasAudio = audioDuration > 0;
  const lastCue = deduped[deduped.length - 1].seconds!;
  const total = round(hasAudio ? audioDuration : lastCue + tailSeconds);

  const inRange = deduped.filter((item) => {
    if (item.seconds! < total) return true;
    warnings.push(
      `${item.label} — starts at or after the end of the audio, skipped.`
    );
    return false;
  });

  if (inRange.length === 0) {
    return { clips: [], total, warnings, placed: 0 };
  }

  const clips: TimelineClip[] = [];
  const first = inRange[0].seconds!;

  // Nothing claims the time before the first cue. Holding the first image over
  // it is usually what's wanted; black is the literal reading of the filenames.
  if (first > 0 && leadIn === "black") {
    clips.push({
      imageId: null,
      label: "Lead-in",
      start: 0,
      end: round(first),
      index: 0,
    });
  }

  inRange.forEach((item, i) => {
    const isLast = i === inRange.length - 1;
    const start = i === 0 && leadIn === "hold" ? 0 : round(item.seconds!);
    const end = round(isLast ? total : inRange[i + 1].seconds!);
    if (end <= start) return;
    clips.push({ imageId: item.id, label: item.label, start, end, index: 0 });
  });

  clips.forEach((clip, i) => (clip.index = i));

  return { clips, total, warnings, placed: inRange.length };
}

/** Resolves `alternate` against a clip's position; everything else is fixed. */
export function clipZoom(direction: ZoomDirection, index: number): ClipZoom {
  if (direction === "alternate") return index % 2 === 0 ? "in" : "out";
  return direction;
}

/** Index of the clip covering `time`, or -1. Binary search — the preview
 *  calls this once per animation frame over a list that can be hundreds long. */
export function clipAt(clips: TimelineClip[], time: number): number {
  let low = 0;
  let high = clips.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (time < clips[mid].start) high = mid - 1;
    else if (time >= clips[mid].end) low = mid + 1;
    else return mid;
  }
  // Past the end, the last clip is still what's on screen.
  return time >= 0 && clips.length > 0 && time >= clips[clips.length - 1].end
    ? clips.length - 1
    : -1;
}
