import type { ModelInput } from "@/types";

/**
 * kie.ai bills in credits, and its docs don't publish a per-model rate — the
 * authoritative number is `creditsConsumed` on the finished task record. So
 * rather than shipping a price table that silently rots, the app *learns*:
 * every completed job records what it actually cost, keyed by the exact input
 * it ran with, and estimates come from those observations.
 *
 * The seed below is measured, not guessed, so a first-run estimate isn't blank.
 */
export interface CreditRate {
  /** Mean credits per image observed for this signature. */
  credits: number;
  samples: number;
}

export type CreditRates = Record<string, CreditRate>;

/**
 * All measured on 2026-07-31 against a real account, not taken from a price page.
 *
 * - nano-banana-2 at 1K billed 8.0 credits for one 1024×1024 image
 *   (`creditsConsumed` on the finished task).
 * - Grok image-to-video at 6s/480p billed 9.6 credits, likewise.
 * - Veo 3.1 Lite at 4s/720p cost 30 credits, measured as the *balance delta* —
 *   kie's Veo namespace reports no per-task credit figure at all, so this is the
 *   only way to know, and it's why Veo spend elsewhere is marked as estimated.
 */
const SEEDED_RATES: CreditRates = {
  "nano-banana-2|resolution=1K": { credits: 8, samples: 1 },
  "grok-imagine/image-to-video|resolution=480p": { credits: 9.6, samples: 1 },
  "veo3_lite|resolution=720p": { credits: 30, samples: 1 },
};

/**
 * $0.005 per credit, derived from that same measurement against kie.ai's
 * published $0.04 for a 1K Nano Banana 2 image. Credits are the real unit —
 * this only exists to put a familiar number next to them.
 */
export const USD_PER_CREDIT = 0.005;

/**
 * Fields that plausibly change the price. Keying a learned rate on the whole
 * input would treat a prompt tweak as a new price; keying on the model alone
 * would average 1K and 4K together.
 */
const PRICING_FIELDS = [
  "resolution",
  "quality",
  "image_resolution",
  "image_size",
  "rendering_speed",
  "enable_pro",
  "num_images",
  "max_images",
  "n",
];

/** Stable key for "this model run with these price-relevant settings". */
export function rateKey(model: string, input: ModelInput): string {
  const parts = PRICING_FIELDS.filter((field) => input[field] !== undefined).map(
    (field) => `${field}=${input[field]}`
  );
  return [model, ...parts].join("|");
}

/**
 * Best known credits-per-image, most specific first: this exact configuration,
 * then any observation of the same model, then the seeds. Null when the model
 * has never been run — the UI says so rather than inventing a number.
 */
export function creditsPerImage(
  model: string,
  input: ModelInput,
  learned: CreditRates
): number | null {
  const key = rateKey(model, input);
  const exact = learned[key] ?? SEEDED_RATES[key];
  if (exact) return exact.credits;

  const prefix = `${model}|`;
  const sameModel = Object.entries({ ...SEEDED_RATES, ...learned }).filter(
    ([candidate]) => candidate === model || candidate.startsWith(prefix)
  );
  if (sameModel.length === 0) return null;

  const total = sameModel.reduce((sum, [, rate]) => sum + rate.credits, 0);
  return total / sameModel.length;
}

/** Folds one observation into the running mean for its signature. */
export function recordRate(
  rates: CreditRates,
  model: string,
  input: ModelInput,
  creditsForRun: number,
  imageCount: number
): CreditRates {
  if (imageCount <= 0 || creditsForRun <= 0) return rates;
  const key = rateKey(model, input);
  const previous = rates[key] ?? SEEDED_RATES[key];
  const observed = creditsForRun / imageCount;
  if (!previous) return { ...rates, [key]: { credits: observed, samples: 1 } };

  const samples = previous.samples + 1;
  return {
    ...rates,
    [key]: {
      credits: (previous.credits * previous.samples + observed) / samples,
      samples,
    },
  };
}

export function estimateCredits(
  imageCount: number,
  model: string,
  input: ModelInput,
  learned: CreditRates
): number | null {
  const rate = creditsPerImage(model, input, learned);
  return rate === null ? null : imageCount * rate;
}

export function formatCredits(credits: number): string {
  const rounded = Math.round(credits * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)} cr`;
}

export function creditsToUsd(credits: number): number {
  return credits * USD_PER_CREDIT;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** "12 cr (~$0.06)" — credits lead, dollars are the parenthetical. */
export function formatSpend(credits: number): string {
  return `${formatCredits(credits)} (~${formatUsd(creditsToUsd(credits))})`;
}
