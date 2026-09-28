import type { TextMoment } from "@/types/editor";

export interface TextPhase {
  text: string;
  from: number;
  to: number;
  /** Horizontal offset in font sizes; digit slots stay fixed as more appear. */
  offset: number;
}

/** Bounded, inexpensive drawtext layers shared with the canvas preview. */
export function textPhases(moment: TextMoment): TextPhase[] {
  const text = moment.text.trim();
  const duration = moment.duration;
  if (moment.animation === "stagger" && /^\d{1,6}$/.test(text)) {
    const step = Math.min(0.14, duration * 0.4 / Math.max(1, text.length - 1));
    return [...text].map((digit, index) => ({
      text: digit, from: index * step, to: duration,
      offset: (index - (text.length - 1) / 2) * 0.65,
    }));
  }
  if (moment.animation === "count" && /^\d{4}$/.test(text)) {
    const target = Number(text);
    const first = Math.max(0, target - 20);
    const steps = target - first;
    const travel = Math.min(0.8, duration * 0.4);
    return Array.from({ length: steps + 1 }, (_, index) => ({
      text: String(first + index).padStart(4, "0"),
      from: steps ? travel * (1 - Math.sqrt(1 - index / steps)) : 0,
      to: index === steps ? duration : travel * (1 - Math.sqrt(1 - (index + 1) / steps)),
      offset: 0,
    }));
  }
  return [{ text: moment.text, from: 0, to: duration, offset: 0 }];
}
