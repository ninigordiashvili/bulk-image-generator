import type { ClipKind, ClipZoom, LeadIn, ZoomDirection } from "@/types/editor";

/** A dropped file as the timeline sees it, before it's been placed. */
export interface TimelineInput {
  id: string;
  label: string;
  kind: ClipKind;
  /** Parsed from the filename; null means the name carried no cue. */
  seconds: number | null;
  /**
   * Where a talking clip's audio actually matches the bed. Overrides the
   * filename, because half a second of drift is the difference between lips
   * that match and lips that don't.
   */
  alignedStart?: number | null;
  /**
   * How long the clip holds the screen once placed. For an avatar this is the
   * talking, silence already excluded. Undefined for a still, which has no
   * length of its own.
   */
  fixedLength?: number;
  excluded: boolean;
}

export interface TimelineClip {
  /** null for a black gap — a lead-in, or a slot no visual claimed. */
  sourceId: string | null;
  label: string;
  kind: ClipKind;
  start: number;
  end: number;
  index: number;
  /** True when nothing may push or shorten this clip: it owns its length. */
  anchored: boolean;
}

export interface Timeline {
  clips: TimelineClip[];
  total: number;
  warnings: string[];
  /** Visuals that got a slot — what the counters report. */
  placed: number;
}

export interface TimelineOptions {
  items: TimelineInput[];
  /** Length of the loaded audio, or 0 when there is none. */
  audioDuration: number;
  /** How long the last visual holds when there's no audio to run out. */
  tailSeconds: number;
  leadIn: LeadIn;
  /**
   * Shorter than this and a still or motion clip is skipped rather than
   * flashed. Avatars are exempt — they're never squeezed in the first place.
   */
  minVisualSeconds: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Lays every visual out along the audio.
 *
 * The base rule is unchanged: a filename is a cue, and a visual holds the
 * screen until the next one's cue. What talking clips add is that they own
 * their position: an avatar is placed where its speech was matched against the
 * bed, and nothing is allowed to move it. Everything else gives way to that,
 * including — where two talking clips overlap — the tail of the earlier one.
 *
 * That ordering matters more than it looks. A still arriving late is a cut in
 * the wrong place; an avatar arriving late is a face speaking words that are
 * not being heard, and the error compounds down the film because each clip
 * pushed late pushes the next one further. Losing the tail of a clip that has
 * finished talking is the cheapest thing on the table.
 *
 * When giving way squeezes a still below `minVisualSeconds`, it's dropped
 * instead: a quarter-second flash of an image reads as a glitch, and the
 * following image would rather have the room.
 */
export function buildTimeline({
  items,
  audioDuration,
  tailSeconds,
  leadIn,
  minVisualSeconds,
}: TimelineOptions): Timeline {
  const warnings: string[] = [];
  const usable: TimelineInput[] = [];

  for (const item of items) {
    if (item.excluded) continue;
    const cue = item.alignedStart ?? item.seconds;
    if (cue === null || cue === undefined || Number.isNaN(cue)) {
      warnings.push(`${item.label} — no timestamp in the filename, skipped.`);
      continue;
    }
    if (cue < 0) {
      warnings.push(`${item.label} — negative timestamp, skipped.`);
      continue;
    }
    usable.push({ ...item, seconds: cue });
  }

  // Ties break on label so the order is stable across reloads rather than
  // depending on whatever sequence the file picker handed them over in.
  usable.sort(
    (a, b) => a.seconds! - b.seconds! || a.label.localeCompare(b.label)
  );

  const deduped: TimelineInput[] = [];
  for (const item of usable) {
    const previous = deduped[deduped.length - 1];
    // Two visuals at the same instant is a naming mistake, except when one of
    // them is anchored — an avatar and a still can legitimately share a cue,
    // and the still simply waits.
    if (
      previous &&
      previous.seconds === item.seconds &&
      previous.fixedLength === undefined &&
      item.fixedLength === undefined
    ) {
      warnings.push(`${item.label} — same timestamp as ${previous.label}, skipped.`);
      continue;
    }
    deduped.push(item);
  }

  if (deduped.length === 0) {
    return { clips: [], total: 0, warnings, placed: 0 };
  }

  const hasAudio = audioDuration > 0;
  const lastItem = deduped[deduped.length - 1];
  const lastEnd = lastItem.seconds! + (lastItem.fixedLength ?? tailSeconds);
  const total = round(hasAudio ? audioDuration : lastEnd);

  const inRange = deduped.filter((item) => {
    if (item.seconds! < total) return true;
    warnings.push(`${item.label} — starts at or after the end of the audio, skipped.`);
    return false;
  });

  if (inRange.length === 0) {
    return { clips: [], total, warnings, placed: 0 };
  }

  // ---- pass one: starts. Nothing may begin before the previous clip ends. ----
  interface Slot {
    item: TimelineInput;
    start: number;
    end: number | null;
    anchored: boolean;
  }

  const slots: Slot[] = [];
  let cursor = 0;

  for (const item of inRange) {
    if (item.fixedLength !== undefined) {
      // A talking clip sits where its speech was matched to the bed, and
      // nothing may move it. Moving it is not a compromise, it is the whole
      // defect: the lips play against narration they were never speaking.
      //
      // It used to give way to whatever ran into it, and the damage compounded
      // — each avatar pushed late pushed the next one later still. Measured on
      // five clips overlapping by half a second each: 0, 500, 1000, 1500 and
      // 2000ms out, so the opening looked right and everything from the middle
      // on was visibly wrong. That is the report this fixes.
      const start = item.seconds!;
      const previous = slots[slots.length - 1];
      if (previous && previous.end !== null && previous.end > start + 0.001) {
        // The clip before overruns it, so the clip before gives way. What it
        // loses is its tail, which is a face that has already stopped talking;
        // what it saves is every lip sync from here to the end of the film.
        const lost = previous.end - start;
        if (previous.anchored) {
          warnings.push(
            `${previous.item.label} — its last ${lost.toFixed(1)}s is cut off by ` +
              `${item.label} starting. Both keep their lip sync; if the tail matters, ` +
              `move one of the two cues.`
          );
        }
        previous.end = Math.max(previous.start, start);
      }
      const end = Math.min(total, start + item.fixedLength);
      slots.push({ item, start, end, anchored: true });
      cursor = end;
    } else {
      const start = Math.max(item.seconds!, cursor);
      slots.push({ item, start, end: null, anchored: false });
      cursor = start;
    }
  }

  // Lead-in: the time before the first visual belongs to nobody.
  const first = slots[0];
  if (first.start > 0 && leadIn === "hold" && !first.anchored) {
    first.start = 0;
  }

  // ---- pass two: ends, then drop anything squeezed too thin ----
  for (;;) {
    // A cue that follows an anchored clip was written before anyone knew how
    // long that clip would be — the avatar's length comes from its speech, not
    // from the filename. So the next visual simply follows on rather than
    // leaving the screen black until its stale cue comes round.
    for (let i = 1; i < slots.length; i++) {
      if (!slots[i].anchored && slots[i - 1].anchored && slots[i - 1].end !== null) {
        slots[i].start = slots[i - 1].end!;
      }
    }

    for (let i = 0; i < slots.length; i++) {
      if (slots[i].anchored) continue;
      slots[i].end = i + 1 < slots.length ? slots[i + 1].start : total;
    }

    const victim = slots.findIndex(
      (slot) => !slot.anchored && (slot.end ?? 0) - slot.start < minVisualSeconds - 0.001
    );
    if (victim < 0) break;

    const dropped = slots[victim];
    const successor = slots[victim + 1];
    warnings.push(
      `${dropped.item.label} — only ${((dropped.end ?? 0) - dropped.start).toFixed(1)}s of room, ` +
        `skipped` +
        (successor && !successor.anchored
          ? `; ${successor.item.label} starts ${(successor.start - dropped.start).toFixed(1)}s earlier instead.`
          : ".")
    );
    slots.splice(victim, 1);
    // The next flexible visual inherits the freed slot.
    if (slots[victim] && !slots[victim].anchored) slots[victim].start = dropped.start;
  }

  const clips: TimelineClip[] = [];

  if (slots.length > 0 && slots[0].start > 0) {
    clips.push({
      sourceId: null,
      label: "Lead-in",
      kind: "still",
      start: 0,
      end: round(slots[0].start),
      index: 0,
      anchored: false,
    });
  }

  for (const slot of slots) {
    const end = round(Math.min(total, slot.end ?? total));
    const start = round(slot.start);
    if (end <= start) continue;
    clips.push({
      sourceId: slot.item.id,
      label: slot.item.label,
      kind: slot.item.kind,
      start,
      end,
      index: 0,
      anchored: slot.anchored,
    });
  }

  // Nothing black between visuals. A hole can only survive the pull-back when
  // both sides are anchored, and the honest fix there is the warning above, not
  // a flash of black — so the earlier clip holds its last frame across it.
  for (let i = 1; i < clips.length; i++) {
    if (clips[i].start - clips[i - 1].end > 0.001) {
      clips[i - 1].end = clips[i].start;
    }
  }

  // Same at the end: an avatar that stops talking before the narration does
  // holds rather than cutting to black.
  const lastClip = clips[clips.length - 1];
  if (lastClip && lastClip.end < total - 0.001) lastClip.end = total;

  clips.forEach((clip, i) => (clip.index = i));

  return {
    clips,
    total,
    warnings,
    placed: clips.filter((clip) => clip.sourceId !== null).length,
  };
}

/** Resolves `alternate` against a clip's position; everything else is fixed. */
export function clipZoom(direction: ZoomDirection, index: number): ClipZoom {
  if (direction === "alternate") return index % 2 === 0 ? "in" : "out";
  return direction;
}

/**
 * Index of the clip covering `time`, or -1. Binary search — the preview calls
 * this once per animation frame over a list that can be hundreds long.
 */
export function clipAt(clips: TimelineClip[], time: number): number {
  let low = 0;
  let high = clips.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (time < clips[mid].start) high = mid - 1;
    else if (time >= clips[mid].end) low = mid + 1;
    else return mid;
  }
  return time >= 0 && clips.length > 0 && time >= clips[clips.length - 1].end
    ? clips.length - 1
    : -1;
}
