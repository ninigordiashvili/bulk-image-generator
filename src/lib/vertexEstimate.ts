import { findVertexImageModel, findVertexVideoModel } from "./vertexModels";
import { imageRate, videoRate } from "./vertexPricing";

/**
 * How long a batch will take, and what it will cost.
 *
 * The time is the part worth getting right, because the obvious answer is wrong
 * in both directions. Quota alone says 50 clips a minute on the second account;
 * the model says five, because each clip takes the better part of a minute and
 * only a few run at once. Concurrency alone says the images fly; quota says two
 * a minute. Whichever is *slower* is the answer:
 *
 *   per minute = min(quota, concurrency x 60 / seconds per call)
 *
 * Both figures come from measurement rather than from the docs — the quota was
 * read out of Cloud Quotas, the call time out of real runs. They are still
 * estimates: a 429, a slow model day, or a longer clip all move them, so this
 * is presented as "about", never as a promise.
 */

export interface BatchEstimate {
  /** Effective throughput after both limits are applied. */
  perMinute: number;
  minutes: number;
  usd: number;
  /** Which limit is actually binding — worth showing, since only one is fixable. */
  boundBy: "quota" | "concurrency";
}

function combine(
  count: number,
  quotaPerMinute: number,
  concurrency: number,
  secondsPerCall: number
): { perMinute: number; minutes: number; boundBy: "quota" | "concurrency" } {
  const byConcurrency = (concurrency * 60) / Math.max(1, secondsPerCall);
  const perMinute = Math.max(0.01, Math.min(quotaPerMinute, byConcurrency));
  return {
    perMinute,
    minutes: count / perMinute,
    boundBy: quotaPerMinute <= byConcurrency ? "quota" : "concurrency",
  };
}

export function estimateImages(
  count: number,
  model: string,
  quotaPerMinute: number,
  concurrency: number
): BatchEstimate {
  const spec = findVertexImageModel(model);
  const seconds = spec?.typicalCallSeconds ?? 10;
  const { perMinute, minutes, boundBy } = combine(
    count,
    quotaPerMinute,
    concurrency,
    seconds
  );
  return { perMinute, minutes, boundBy, usd: count * imageRate(model).usd };
}

export function estimateVideos(
  /** One entry per clip, because cost and call time both scale with length. */
  clipSeconds: number[],
  model: string,
  quotaPerMinute: number,
  concurrency: number,
  withAudio = false
): BatchEstimate {
  const spec = findVertexVideoModel(model);
  const fixed = spec?.typicalCallSeconds ?? 29;
  const perOutput = spec?.secondsPerOutputSecond ?? 2;

  const totalOutput = clipSeconds.reduce((sum, s) => sum + s, 0);
  const meanOutput = clipSeconds.length ? totalOutput / clipSeconds.length : 8;
  const secondsPerCall = fixed + perOutput * meanOutput;

  const { perMinute, minutes, boundBy } = combine(
    clipSeconds.length,
    quotaPerMinute,
    concurrency,
    secondsPerCall
  );
  return {
    perMinute,
    minutes,
    boundBy,
    usd: totalOutput * videoRate(model, withAudio).usd,
  };
}

/** "about 6 min" / "about 1h 15m" — deliberately vague at the top end. */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `~${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes - hours * 60);
  return rest === 0 ? `~${hours}h` : `~${hours}h ${rest}m`;
}
