import type { EffectRange, FilmLook, MotionRange, RenderSettings } from "@/types/editor";

export const FILM_LABELS: Record<FilmLook, string> = { off: "Off", subtle: "Subtle film", medium: "Medium film", heavy: "Heavy film", monochrome: "Black and white", sepia: "Sepia", warm: "Warm", cool: "Cool", vignette: "Vignette only" };
export const MOTION_LABELS = { pan: "Gentle pan", panZoom: "Pan and zoom", drift: "Subtle drift" };
export const MAX_EFFECT_RANGES = 40;

/** Three colon groups always mean minutes:seconds:milliseconds, never hours. */
export function parseEffectTime(text: string): number | null {
  const s = text.trim();
  const precise = /^(\d+):([0-5]?\d):(\d{3})$/.exec(s);
  if (precise) return Number(precise[1]) * 60 + Number(precise[2]) + Number(precise[3]) / 1000;
  const minutes = /^(\d+):([0-5]?\d)(?:\.(\d{1,3}))?$/.exec(s);
  if (minutes) return Number(minutes[1]) * 60 + Number(minutes[2]) + Number('0.' + (minutes[3] || '0'));
  if (/^\d+(?:\.\d{1,3})?$/.test(s)) return Number(s);
  return null;
}
export function formatEffectTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  return Math.floor(ms / 60000) + ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0') + ':' + String(ms % 1000).padStart(3, '0');
}
export function rangeError(ranges: EffectRange[]): string | null {
  if (ranges.length > MAX_EFFECT_RANGES) return 'Use at most 40 ranges.';
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end) || r.start < 0 || r.end <= r.start || r.end > 604800) return 'End must be after start (maximum 7 days).';
    if (i && r.start < sorted[i - 1].end) return 'Ranges in the same list cannot overlap.';
  }
  return null;
}
export function validateEffectSettings(raw: RenderSettings): string | null {
  for (const [name, ranges] of [['Motion', raw.motionRanges], ['Film', raw.filmRanges]] as const) {
    if (ranges === undefined) continue;
    if (!Array.isArray(ranges) || ranges.some(r => !r || typeof r !== 'object')) return name + ' ranges are invalid.';
    const error = rangeError(ranges);
    if (error) return name + ': ' + error;
  }
  if (raw.motionRanges?.some(r => !Object.hasOwn(MOTION_LABELS, r.effect) || !['left', 'right', 'up', 'down'].includes(r.direction) || !Number.isFinite(r.amount) || r.amount < 0.01 || r.amount > 0.2)) return 'Invalid motion effect, direction or strength.';
  if (raw.filmRanges?.some(r => !Object.hasOwn(FILM_LABELS, r.look))) return 'Invalid film look.';
  return null;
}
export function filmAt(settings: Pick<RenderSettings, 'film' | 'filmRanges' | 'filmRangesEnabled'>, time: number): FilmLook {
  return settings.filmRangesEnabled ? settings.filmRanges?.find(r => time >= r.start && time < r.end)?.look ?? 'off' : settings.film;
}
export function intersectRanges<T extends EffectRange>(ranges: T[] | undefined, start: number, end: number): T[] {
  return (ranges ?? []).filter(r => r.start < end && r.end > start);
}

/** Spread entry and exit across the clip/range instead of a quick 0.6s push. */
export function motionRampSeconds(length: number): number {
  return Math.max(0.001, length) / 2;
}

/** A crop-window centre offset as a fraction of the fitted frame. */
export function motionPose(r: MotionRange, start: number, end: number, time: number, base: number) {
  const length = Math.max(0.001, end - start);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const smooth = (v: number) => v * v * (3 - 2 * v);
  const p = clamp((time - start) / length);
  const ramp = motionRampSeconds(length);
  const envelope = smooth(clamp((time - start) / ramp)) * smooth(clamp((end - time) / ramp));
  const scale = base + envelope * (1 + r.amount + (r.effect === 'panZoom' ? r.amount * smooth(p) : 0) - base);
  const travel = r.effect === 'drift' ? Math.sin(p * 2 * Math.PI) : 2 * smooth(p) - 1;
  const margin = (1 - 1 / scale) * 0.4;
  const sign = r.direction === 'left' || r.direction === 'up' ? 1 : -1;
  const shift = travel * margin * envelope * sign;
  const vertical = r.direction === 'up' || r.direction === 'down';
  return { scale, x: vertical ? 0 : shift, y: vertical ? shift : r.effect === 'drift' ? Math.sin(p * Math.PI) * margin * envelope : 0 };
}
