"use client";

/**
 * Working out what a dropped video clip actually is, in the browser.
 *
 * Three questions, all answerable without a server round trip:
 *
 *  - How long is it, and what shape? A `<video>` element's metadata.
 *  - Is it a talking avatar or a silent motion clip? Whether it has an audio
 *    track at all, and if it does, whether that audio is a piece of the
 *    narration bed.
 *  - Where exactly does it belong, and where does the talking stop?
 *    Cross-correlation against the bed, and the tail of its own envelope.
 *
 * The alignment matters more than it sounds. A filename says `0-14`, but the
 * cut it was generated from started at 14.37, and half a second of drift is
 * the difference between lips that match and lips that don't.
 */

import type { ClipKind } from "@/types/editor";

/** Envelope resolution. 10 ms is finer than any misalignment worth chasing. */
export const ENVELOPE_HZ = 100;

/**
 * Below this correlation, a clip's audio isn't from the bed.
 *
 * A clip that really is a cut of the narration correlates almost perfectly with
 * it — the avatar model re-encodes the audio, but re-encoding does not change
 * the rhythm of loud and quiet. Measured over a real job: seventeen genuine
 * clips scored 0.983 to 1.000, and pieces of an unrelated narration searched
 * against the same bed reached at most 0.920.
 *
 * It used to be 0.55, which no genuine clip has ever needed and which
 * unrelated speech clears easily. That was survivable only while the search was
 * fenced to six seconds either side of the filename's cue, where there was
 * little opportunity to be wrong. Searching the whole bed removes the fence, so
 * the bar has to do the work the fence was doing.
 */
export const AVATAR_CONFIDENCE = 0.95;

/**
 * And how far the winning position must beat the best rival elsewhere.
 *
 * A genuine match is not just high, it is *alone*: the same seventeen clips beat
 * everything more than three seconds away by 0.044 to 0.391, while the foreign
 * pieces — whose winning position is only the luckiest of many similar ones —
 * managed at most 0.027. Two tests rather than one, because the gap on this
 * one is narrow and the gap on the score is not.
 */
export const AVATAR_MARGIN = 0.035;

/**
 * How far apart two candidate positions have to score before the better one is
 * simply believed.
 *
 * Closer than this and correlation cannot honestly separate them, so the
 * filename breaks the tie. Measured across a real job: sixteen of seventeen
 * clips beat everything else in a fifteen-minute bed by 0.11 to 0.39, and the
 * seventeenth — two seconds long — by 0.044. Two seconds of speech really is
 * ambiguous; six is not.
 */
const TIE_MARGIN = 0.05;

/** Coarse pass resolution: a tenth of the envelope, so 100ms. */
const COARSE = 10;

/** How many coarse peaks are worth refining at full resolution. */
const CANDIDATES = 24;

/** Quiet enough to count as "stopped talking". Insensitive over ±10 dB. */
const SILENCE_FLOOR_DB = -35;

/** Ignore a gap shorter than this — it's a breath, not the end of a sentence. */
const MIN_TAIL_SECONDS = 0.25;

export interface Envelope {
  /** Loudness per 10 ms, log-scaled so quiet detail survives. */
  values: Float32Array;
  perSecond: number;
}

export interface ClipFacts {
  duration: number;
  width: number;
  height: number;
  /** Null when the file has no audio track — which makes it a motion clip. */
  envelope: Envelope | null;
  /** Where the talking stops. Equals `duration` when nothing is trimmed. */
  speechEnd: number;
}

export interface Placement {
  start: number;
  /** 0-1. Below AVATAR_CONFIDENCE the clip isn't from this bed. */
  confidence: number;
  /**
   * How far this position beat the best one well away from it. A genuine match
   * stands alone; a coincidence has rivals just as good.
   */
  margin: number;
}

/** Loudness envelope of decoded audio, mixed to mono. */
export function envelopeOf(buffer: AudioBuffer): Envelope {
  const hop = Math.max(1, Math.round(buffer.sampleRate / ENVELOPE_HZ));
  const count = Math.floor(buffer.length / hop);
  const values = new Float32Array(count);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
    buffer.getChannelData(c)
  );

  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) {
      let mixed = 0;
      for (const channel of channels) mixed += channel[j];
      mixed /= channels.length;
      sum += mixed * mixed;
    }
    // Log scale: speech rhythm lives in the quiet parts as much as the loud.
    values[i] = Math.log10(1 + Math.sqrt(sum / hop) * 32767);
  }

  return { values, perSecond: ENVELOPE_HZ };
}

async function decodeAudio(file: Blob): Promise<AudioBuffer | null> {
  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioCtx();
  try {
    return await context.decodeAudioData(await file.arrayBuffer());
  } catch {
    // No audio track, or one this browser can't read. Either way the clip is
    // treated as silent, which is exactly right for a generated motion clip.
    return null;
  } finally {
    void context.close();
  }
}

function videoMetadata(
  file: Blob
): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const element = document.createElement("video");
    element.preload = "metadata";
    element.muted = true;
    const done = (value: { duration: number; width: number; height: number } | null) => {
      URL.revokeObjectURL(url);
      element.removeAttribute("src");
      if (value) resolve(value);
      else reject(new Error("That video couldn't be read by this browser."));
    };
    element.onloadedmetadata = () =>
      done(
        Number.isFinite(element.duration) && element.duration > 0
          ? {
              duration: element.duration,
              width: element.videoWidth,
              height: element.videoHeight,
            }
          : null
      );
    element.onerror = () => done(null);
    element.src = url;
  });
}

/**
 * The moment the talking stops, from the clip's own envelope.
 *
 * Only a run of quiet that reaches the end of the clip counts: a pause in the
 * middle of a sentence is not the end of the performance.
 */
export function speechEndOf(envelope: Envelope, duration: number): number {
  const { values, perSecond } = envelope;
  if (values.length === 0) return duration;

  let peak = 0;
  for (const value of values) if (value > peak) peak = value;
  if (peak <= 0) return duration;

  // The envelope is log10(1 + rms), so the threshold has to be taken there too.
  const floor = Math.log10(1 + Math.pow(10, SILENCE_FLOOR_DB / 20) * 32767);
  const threshold = Math.min(floor, peak * 0.5);

  let last = values.length - 1;
  while (last >= 0 && values[last] < threshold) last--;
  if (last < 0) return duration;

  const end = (last + 1) / perSecond;
  const trimmed = duration - end;
  return trimmed >= MIN_TAIL_SECONDS ? end : duration;
}

/** Normalised cross-correlation of `clip` against `bed` at one offset. */
function correlationAt(
  bedValues: Float32Array,
  clipValues: Float32Array,
  clipMean: number,
  clipNorm: number,
  at: number
): number {
  let mean = 0;
  for (let i = 0; i < clipValues.length; i++) mean += bedValues[at + i];
  mean /= clipValues.length;

  let dot = 0;
  let variance = 0;
  for (let i = 0; i < clipValues.length; i++) {
    const centred = bedValues[at + i] - mean;
    dot += centred * (clipValues[i] - clipMean);
    variance += centred * centred;
  }
  return dot / ((Math.sqrt(variance) || 1) * clipNorm);
}

/** Mean and spread of an envelope, which the correlation needs on every offset. */
function statsOf(values: Float32Array): { mean: number; norm: number } {
  let mean = 0;
  for (const value of values) mean += value;
  mean /= values.length || 1;
  let variance = 0;
  for (const value of values) variance += (value - mean) ** 2;
  return { mean, norm: Math.sqrt(variance) || 1 };
}

/** Every `by`th sample, averaged — the coarse pass runs on this. */
function decimated(values: Float32Array, by: number): Float32Array {
  const count = Math.floor(values.length / by);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let k = 0; k < by; k++) sum += values[i * by + k];
    out[i] = sum / by;
  }
  return out;
}

/**
 * Finds where `clip` sits inside `bed`.
 *
 * Normalised cross-correlation, so it doesn't care that the avatar model
 * re-encoded the audio at a different level and sample rate — only that the
 * pattern of loud and quiet still matches.
 *
 * The whole bed is searched, and `hintSeconds` only breaks ties. It used to be
 * a fence: six seconds either side of the filename's cue and nowhere else.
 * That holds while the cue is roughly right, and fails badly when it isn't —
 * the search returns the best position *in the wrong window*, which either
 * places the clip somewhere it never belonged or scores low enough to demote it
 * to a motion clip, and a motion clip gets time-stretched to fill its slot. A
 * talking head slowed to fit is as far out of sync as it is possible to be, and
 * the fence is why. Cues drift for ordinary reasons — the narration was re-cut,
 * the files were named from an earlier pass — and none of them should cost the
 * lip sync.
 *
 * Correlation decides when it can, and it usually can by a wide margin. Only
 * when two places are within `TIE_MARGIN` does the cue choose between them,
 * which is the case the fence existed for: a clip too short to be distinctive.
 *
 * Coarse-to-fine, because the whole bed at full resolution is a hundredfold
 * more work than the window was, and a fifteen-minute bed against seventy clips
 * has to stay interactive.
 */
export function locate(
  bed: Envelope,
  clip: Envelope,
  hintSeconds: number | null
): Placement {
  const bedValues = bed.values;
  const clipValues = clip.values;
  if (clipValues.length === 0 || bedValues.length <= clipValues.length) {
    return { start: Math.max(0, hintSeconds ?? 0), confidence: 0, margin: 0 };
  }

  const limit = bedValues.length - clipValues.length;
  const clipStats = statsOf(clipValues);

  // Coarse pass over everything.
  const coarseBed = decimated(bedValues, COARSE);
  const coarseClip = decimated(clipValues, COARSE);
  const coarseLimit = coarseBed.length - coarseClip.length;

  const peaks: { at: number; score: number }[] = [];
  if (coarseClip.length > 0 && coarseLimit > 0) {
    const coarseStats = statsOf(coarseClip);
    for (let at = 0; at <= coarseLimit; at++) {
      peaks.push({
        at,
        score: correlationAt(coarseBed, coarseClip, coarseStats.mean, coarseStats.norm, at),
      });
    }
    peaks.sort((a, b) => b.score - a.score);
  }

  // Refine the best few at full resolution. Neighbouring coarse offsets are the
  // same peak seen twice, so they are spread out before refining.
  const chosen: number[] = [];
  for (const peak of peaks) {
    if (chosen.length >= CANDIDATES) break;
    if (chosen.some((other) => Math.abs(other - peak.at) < 3)) continue;
    chosen.push(peak.at);
  }
  if (chosen.length === 0) chosen.push(0);

  const found: Placement[] = [];
  for (const coarseAt of chosen) {
    const from = Math.max(0, (coarseAt - 2) * COARSE);
    const to = Math.min(limit, (coarseAt + 2) * COARSE);
    let bestScore = -Infinity;
    let bestAt = from;
    for (let at = from; at <= to; at++) {
      const score = correlationAt(bedValues, clipValues, clipStats.mean, clipStats.norm, at);
      if (score > bestScore) {
        bestScore = score;
        bestAt = at;
      }
    }
    found.push({ start: bestAt / bed.perSecond, confidence: bestScore, margin: 0 });
  }

  const best = found.reduce((a, b) => (b.confidence > a.confidence ? b : a));

  // How alone the winner is: the best of everything that isn't near it. A
  // genuine match towers over the rest of the bed; a coincidence does not.
  const RIVAL_GAP_SECONDS = 3;
  let rival = -Infinity;
  for (const one of found) {
    if (Math.abs(one.start - best.start) < RIVAL_GAP_SECONDS) continue;
    if (one.confidence > rival) rival = one.confidence;
  }
  const margin = rival === -Infinity ? best.confidence : best.confidence - rival;

  const answer = (pick: Placement): Placement => ({
    start: pick.start,
    confidence: Math.max(0, pick.confidence),
    margin,
  });

  if (hintSeconds === null) return answer(best);

  // Anything this close is a tie on the evidence, so the filename decides.
  const tied = found.filter((one) => one.confidence >= best.confidence - TIE_MARGIN);
  return answer(
    tied.reduce((a, b) =>
      Math.abs(b.start - hintSeconds) < Math.abs(a.start - hintSeconds) ? b : a
    )
  );
}

/** The envelope up to `seconds`, for comparing only the part that has sound. */
function trimTo(envelope: Envelope, seconds: number): Envelope {
  const count = Math.max(1, Math.round(seconds * envelope.perSecond));
  return count >= envelope.values.length
    ? envelope
    : { values: envelope.values.subarray(0, count), perSecond: envelope.perSecond };
}

/** Everything the timeline needs to know about a dropped video file. */
export async function analyseClip(file: Blob): Promise<ClipFacts> {
  const [meta, audio] = await Promise.all([videoMetadata(file), decodeAudio(file)]);
  const envelope = audio ? envelopeOf(audio) : null;
  return {
    ...meta,
    envelope,
    speechEnd: envelope ? speechEndOf(envelope, meta.duration) : meta.duration,
  };
}

/** The bed's envelope, so clips have something to be located against. */
export async function analyseBed(file: Blob): Promise<Envelope | null> {
  const audio = await decodeAudio(file);
  return audio ? envelopeOf(audio) : null;
}

/**
 * Decides what a clip is and where it goes.
 *
 * A clip with no audio is a motion clip and keeps its filename's cue. A clip
 * whose audio matches the bed is an avatar and takes the matched position. A
 * clip with audio that *doesn't* match is left as a motion clip at its cue —
 * with a confidence low enough for the UI to say so.
 */
export function classify(
  facts: ClipFacts,
  bed: Envelope | null,
  cueSeconds: number | null
): { kind: ClipKind; start: number; confidence: number } {
  if (!facts.envelope || !bed) {
    return { kind: "motion", start: cueSeconds ?? 0, confidence: 0 };
  }

  // Match on the talking only. A clip usually ends with a beat of silence that
  // the bed does not have at that moment, and letting that tail into the
  // comparison drags a genuine match down — far enough, on a short clip, to
  // look like no match at all.
  const speech = trimTo(facts.envelope, facts.speechEnd);
  const placement = locate(bed, speech, cueSeconds);
  // Both tests: near-perfect, and alone. Either on its own lets a piece of some
  // other recording through, and a clip wrongly called an avatar is anchored at
  // a position its lips were never speaking.
  if (placement.confidence < AVATAR_CONFIDENCE || placement.margin < AVATAR_MARGIN) {
    return { kind: "motion", start: cueSeconds ?? placement.start, confidence: placement.confidence };
  }
  return { kind: "avatar", start: placement.start, confidence: placement.confidence };
}
