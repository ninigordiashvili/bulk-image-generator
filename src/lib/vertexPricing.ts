/**
 * What a generation costs, so the app can show spend against the $300 credit.
 *
 * **These rates are not authoritative and the app says so wherever it shows a
 * number.** Google publishes them at https://cloud.google.com/vertex-ai/pricing
 * and changes them; nothing in this repo can read them back, and the Cloud
 * Billing API exposes no "credit remaining" figure either — a budget can be
 * queried, a balance cannot. So the honest design is: count exactly, price
 * approximately, and never present the result as a bill.
 *
 * Override any rate from `.env.local` without touching this file:
 *
 *   VERTEX_PRICE_IMAGE_gemini-2.5-flash-image=0.039
 *   VERTEX_PRICE_VIDEO_veo-3.1-lite-generate-001=0.15
 *
 * Image rates are dollars per image. Video rates are dollars per second of
 * output, which is how Veo bills — an 8s clip is eight times a 1s one, and that
 * is the difference between the credit lasting weeks and lasting an afternoon.
 */

export interface Rate {
  /** Dollars per image, or per second of video. */
  usd: number;
  unit: "image" | "second";
  /** False until a human has checked it against Google's published price. */
  verified: boolean;
}

/**
 * Placeholders, deliberately round. They exist so the counter has something to
 * multiply on day one, not because they are right. Replace them from the
 * pricing page — or via env — before trusting any total.
 */
const IMAGE_RATES: Record<string, number> = {
  "gemini-2.5-flash-image": 0.04,
  "gemini-3.1-flash-lite-image": 0.02,
  "gemini-3-pro-image-preview": 0.13,
  "imagen-4.0-fast-generate-001": 0.02,
  "imagen-4.0-generate-001": 0.04,
};

/**
 * Video is priced per second, and *audio changes the rate* — Veo bills a silent
 * clip more cheaply than one it has scored. So there are two tables, and the
 * caller's `generateAudio` choice picks between them. Getting this wrong is not
 * a rounding error: it was the difference between a quoted $1.20 and a real
 * $0.24 for one 8-second clip.
 */
const VIDEO_RATES_SILENT: Record<string, number> = {
  // Checked by the user against Vertex AI Studio on 2026-08-27.
  "veo-3.1-lite-generate-001": 0.03,
};

const VIDEO_RATES_AUDIO: Record<string, number> = {
  // Unverified: audio is known to cost more, but by how much is not confirmed.
  // Override with VERTEX_PRICE_VIDEO_AUDIO_veo-3.1-lite-generate-001=…
  "veo-3.1-lite-generate-001": 0.15,
};

/** Rates a human has confirmed, so the UI stops labelling them as estimates. */
const CONFIRMED = new Set(["video:silent:veo-3.1-lite-generate-001"]);

const DEFAULT_IMAGE_USD = 0.04;
const DEFAULT_VIDEO_USD = 0.4;

/** Env wins over the table, so a rate can be corrected without a deploy. */
function override(kind: "IMAGE" | "VIDEO" | "VIDEO_AUDIO", model: string): number | null {
  const raw = process.env[`VERTEX_PRICE_${kind}_${model}`];
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function imageRate(model: string): Rate {
  const custom = override("IMAGE", model);
  if (custom !== null) return { usd: custom, unit: "image", verified: true };
  const known = IMAGE_RATES[model];
  return {
    usd: known ?? DEFAULT_IMAGE_USD,
    unit: "image",
    verified: false,
  };
}

export function videoRate(model: string, withAudio = false): Rate {
  const custom = override(withAudio ? "VIDEO_AUDIO" : "VIDEO", model);
  if (custom !== null) return { usd: custom, unit: "second", verified: true };

  const table = withAudio ? VIDEO_RATES_AUDIO : VIDEO_RATES_SILENT;
  const known = table[model];
  return {
    usd: known ?? DEFAULT_VIDEO_USD,
    unit: "second",
    verified: CONFIRMED.has(`video:${withAudio ? "audio" : "silent"}:${model}`),
  };
}

/** The credit being spent against, so the UI can show what is left of it. */
export function creditBudgetUsd(): number {
  const value = Number(process.env.VERTEX_CREDIT_USD);
  return Number.isFinite(value) && value > 0 ? value : 300;
}

/**
 * A hard ceiling on what this app may spend, checked before every call.
 *
 * Not a nicety: a bulk run is a loop that spends money per iteration, and the
 * gap between "test it" and "it generated four hundred images" is one bad
 * prompt list. `VERTEX_SPEND_CAP_USD` stops the loop rather than trusting
 * whoever pressed the button to be watching.
 */
export function spendCapUsd(): number | null {
  const raw = process.env.VERTEX_SPEND_CAP_USD;
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
