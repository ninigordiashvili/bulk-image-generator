import { GoogleGenAI } from "@google/genai";
import {
  findVertexImageModel,
  findVertexVideoModel,
  locationFor,
  requestsPerMinuteFor,
} from "@/lib/vertexModels";
import type { VertexAccount } from "./vertexAccounts";
import {
  creditBudgetUsd,
  imageRate,
  spendCapUsd,
  videoRate,
  type Rate,
} from "@/lib/vertexPricing";

/**
 * Vertex AI as a second generation provider, alongside kie.ai.
 *
 * Two things differ from the kie client and both shape this file.
 *
 * The first is credentials. kie takes an API key per account, so a key travels
 * with every request. Vertex takes none: the official SDK is constructed with
 * `vertexai: true` and picks up Application Default Credentials from the
 * machine — `gcloud auth application-default login`, or a service account on a
 * deployed host. There is deliberately no key in this file, nothing read from
 * the request body, and nothing to paste into the UI. If ADC is missing the SDK
 * says so and `describeAuth` turns that into an instruction rather than a stack
 * trace.
 *
 * The second is quota. kie meters by credits on the account, so the client-side
 * `GenerationQueue` bounding a batch to a few at a time is enough. Vertex meters
 * by requests per minute against the *project*, which every tab, every batch and
 * every retry share. A client-side limit cannot see that, so the limiter lives
 * here, on the server, where it is the one place all traffic passes through.
 */

/** ADC is per-machine, so only the target needs configuring. Never a key. */
const PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT || process.env.VERTEX_PROJECT_ID || "";
const LOCATION =
  process.env.GOOGLE_CLOUD_LOCATION || process.env.VERTEX_LOCATION || "us-central1";

/**
 * How many Vertex calls may be in flight for the whole server, and how closely
 * their starts may be spaced.
 *
 * These are separate limits because they fail differently. Concurrency bounds
 * how much work sits open at once — useful for video, where one call can run for
 * minutes. Spacing bounds the *rate* of new calls, which is what a per-minute
 * quota actually counts, and it is the one that matters for bulk stills: sixty
 * images fired three-at-a-time still arrive as a burst if each returns quickly.
 */
/**
 * Concurrency is per kind, not shared. Images and video draw on separate GCP
 * quotas (2/min and 1/min here), so one pool would let a batch of video starve
 * the stills or the reverse. Two lanes keep each within its own limit.
 */
const CONCURRENCY_IMAGE = positiveInt(process.env.VERTEX_CONCURRENCY_IMAGE, 2);
const CONCURRENCY_VIDEO = positiveInt(process.env.VERTEX_CONCURRENCY_VIDEO, 1);
const QPM = positiveInt(process.env.VERTEX_QPM, 60);

/** Attempts per call before a 429 is handed back to the queue as retryable. */
const MAX_ATTEMPTS = positiveInt(process.env.VERTEX_MAX_ATTEMPTS, 4);
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 120_000;

/** How long a video operation may stay unfinished before we stop waiting. */
const VIDEO_TIMEOUT_MS = positiveInt(process.env.VERTEX_VIDEO_TIMEOUT_MS, 600_000);
const VIDEO_POLL_MS = 10_000;

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export class VertexError extends Error {
  constructor(
    message: string,
    /**
     * Mirrors the kie client's contract so the queue can treat both providers
     * alike: `false` means nothing about a second attempt would differ, so the
     * retry budget is not spent on it.
     */
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = "VertexError";
  }
}

/**
 * Held on globalThis for the same reason the job registry is: the dev server
 * re-evaluates route modules on edit, and a limiter that resets on every save
 * would silently stop limiting halfway through a batch.
 */
interface Lane {
  active: number;
  waiting: Array<() => void>;
}

interface Limiter {
  lanes: Record<"image" | "video", Lane>;
  /**
   * Earliest time the next call may start, *per model*. Vertex quota is granted
   * per base model — 2/min for the image models, 1/min for Veo — so one shared
   * rate would either starve the images or overrun the video. Concurrency stays
   * global because that bounds work in flight, not request rate.
   */
  nextStart: Map<string, number>;
}

const limiter: Limiter = ((
  globalThis as { __vertexLimiter?: Limiter }
).__vertexLimiter ??= {
  lanes: { image: { active: 0, waiting: [] }, video: { active: 0, waiting: [] } },
  nextStart: new Map(),
});

// Surviving a hot reload is the point of holding this on globalThis, but it also
// means an object built by an *older* version of this file can outlive it. When
// `nextStart` changed from a number to a per-model Map, the stale object kept
// the number and every call threw. Re-shaping here costs nothing and turns a
// crash into a dropped schedule.
if (!(limiter.nextStart instanceof Map) || !limiter.lanes?.image) {
  limiter.nextStart = new Map();
  limiter.lanes = {
    image: { active: 0, waiting: [] },
    video: { active: 0, waiting: [] },
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Admits one call, then holds the slot until `release` is called.
 *
 * Spacing is claimed *before* the wait, not after it — `nextStart` moves forward
 * the moment a caller is admitted, so twenty callers arriving together take
 * twenty distinct slots instead of all reading the same timestamp, waiting the
 * same interval and departing as one burst.
 */
async function acquire(
  account: VertexAccount,
  model: string,
  kind: "image" | "video",
  signal?: AbortSignal
): Promise<() => void> {
  if (signal?.aborted) throw new VertexError("Cancelled.", false);

  const lane = limiter.lanes[kind];
  // The account's own figure wins, and it is re-read from disk on every request,
  // so widening a lane mid-batch needs no restart — which matters because a
  // restart reloads the page and the storyboard is not persisted.
  const ceiling =
    kind === "video"
      ? (account.videoConcurrency ?? CONCURRENCY_VIDEO)
      : (account.imageConcurrency ?? CONCURRENCY_IMAGE);

  while (lane.active >= ceiling) {
    await new Promise<void>((resume) => lane.waiting.push(resume));
    if (signal?.aborted) throw new VertexError("Cancelled.", false);
  }

  lane.active += 1;

  // Quota is granted per project, so the *account* decides the rate, not the
  // model alone — the same Veo model is 1/min on one account and 50/min on the
  // other. The account's own figure wins where it has one; the model's is the
  // fallback; the env value is a ceiling over both.
  const perAccount =
    kind === "video" ? account.videoRequestsPerMinute : account.imageRequestsPerMinute;
  const qpm = Math.min(QPM, perAccount ?? requestsPerMinuteFor(model, QPM));
  const interval = Math.ceil(60_000 / Math.max(1, qpm));

  // Keyed by account too: two accounts have separate quota pools and must not
  // queue behind each other.
  const rateKey = `${account.id}:${model}`;
  const now = Date.now();
  const startAt = Math.max(now, limiter.nextStart.get(rateKey) ?? 0);
  limiter.nextStart.set(rateKey, startAt + interval);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lane.active -= 1;
    lane.waiting.shift()?.();
  };

  if (startAt > now) {
    try {
      await sleep(startAt - now);
    } catch {
      release();
      throw new VertexError("Cancelled.", false);
    }
  }
  if (signal?.aborted) {
    release();
    throw new VertexError("Cancelled.", false);
  }

  return release;
}

/** Pushes one model's queue back when Vertex says its quota is spent. */
function penalise(rateKey: string, ms: number) {
  limiter.nextStart.set(
    rateKey,
    Math.max(limiter.nextStart.get(rateKey) ?? 0, Date.now() + ms)
  );
}

/**
 * One client per location, because location is a property of the *model*, not
 * of the app. `gemini-3.1-flash-lite-image` is served only from `global` and
 * 404s on `us-central1`; Veo answers on `us-central1`. A single client pinned to
 * one region cannot reach both, and the failure looks exactly like a wrong model
 * id — which is how it went unnoticed for a while.
 */
const clients = new Map<string, GoogleGenAI>();

/**
 * The SDK, built once per location. `vertexai: true` is what selects Vertex over
 * the consumer Gemini API — it is the difference between billing this project's
 * cloud account and needing an API key, so it is not optional here.
 */
function genai(account: VertexAccount, location: string): GoogleGenAI {
  if (!account.projectId) {
    throw new VertexError(
      `Account "${account.id}" has no projectId.`,
      false
    );
  }
  const key = `${account.id}:${location}`;
  let client = clients.get(key);
  if (!client) {
    client = new GoogleGenAI({
      vertexai: true,
      project: account.projectId,
      location,
      // "adc" means the machine login; anything else is a credentials file, which
      // is what lets two Google accounts be live at once — ADC itself is
      // singular, so the second account could not exist without this.
      ...(account.credentials === "adc"
        ? {}
        : { googleAuthOptions: { keyFilename: account.credentials } }),
    });
    clients.set(key, client);
  }
  return client;
}

/** Where a model has to be called from, defaulting to the configured region. */
function locationOf(model: string): string {
  return locationFor(model, LOCATION);
}

export function vertexTarget(): { project: string; location: string } {
  return { project: PROJECT, location: LOCATION };
}

/** Digs the useful part out of whatever the SDK or the API threw. */
function describe(error: unknown): { message: string; status?: number } {
  if (error instanceof VertexError) return { message: error.message, status: error.status };
  const raw = error instanceof Error ? error.message : String(error);
  const status = Number(/\b(4\d\d|5\d\d)\b/.exec(raw)?.[1]);
  try {
    const parsed = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? "");
    const inner = parsed?.error ?? parsed;
    if (inner?.message) {
      return { message: String(inner.message), status: Number(inner.code) || status };
    }
  } catch {
    // Not JSON — the raw message is the best we have.
  }
  return { message: raw, status: Number.isFinite(status) ? status : undefined };
}

/**
 * Turns a failure into something the operator can act on.
 *
 * The 404 case earns its wording. Vertex answers "model not found" and "your
 * project may not use this model" with the *same* status and nearly the same
 * sentence, so the obvious reading — a typo in the model id — is wrong about as
 * often as it is right. `preflight()` below is what actually separates them.
 */
function classify(error: unknown): VertexError {
  const { message, status } = describe(error);
  const lower = message.toLowerCase();

  if (lower.includes("could not load the default credentials") ||
      lower.includes("application default credentials")) {
    return new VertexError(
      "No Application Default Credentials on this machine. Run: " +
        "gcloud auth application-default login",
      false,
      401
    );
  }
  if (status === 401 || status === 403) {
    return new VertexError(
      `Vertex refused the request for project ${PROJECT} (${status}). ` +
        `Check that ADC is the account that owns the project. Raw: ${message}`,
      false,
      status
    );
  }
  if (status === 404) {
    return new VertexError(
      `Vertex has no such model in ${LOCATION}, or project ${PROJECT} has no ` +
        `access to it (404). These are different problems with the same status — ` +
        `run the preflight to tell them apart. Raw: ${message}`,
      false,
      404
    );
  }
  if (status === 429 || lower.includes("resource_exhausted") || lower.includes("quota")) {
    return new VertexError(
      `Vertex quota exhausted for project ${PROJECT} (429). Lower VERTEX_QPM or ` +
        `request more quota. Raw: ${message}`,
      true,
      429
    );
  }
  if (status && status >= 500) {
    return new VertexError(`Vertex is having trouble (${status}). Raw: ${message}`, true, status);
  }
  if (status === 400) {
    return new VertexError(`Vertex rejected the request (400). Raw: ${message}`, false, 400);
  }
  return new VertexError(message || "Vertex call failed.", true, status);
}

/** Seconds Vertex asked us to wait, when it says so. */
function retryAfterMs(error: unknown): number | null {
  const { message } = describe(error);
  const match = /retry(?:\s|-)?(?:after|delay)"?[:\s]+"?(\d+(?:\.\d+)?)s?/i.exec(message);
  return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

/**
 * One Vertex call, limited and retried.
 *
 * Only 429 and 5xx come back here for another go. Everything else — a bad model
 * id, a project without access, malformed input — fails identically every time,
 * so retrying it just multiplies the wait before the operator sees the message
 * that would have told them what to fix.
 */
async function call<T>(
  account: VertexAccount,
  model: string,
  kind: "image" | "video",
  run: () => Promise<T>,
  signal?: AbortSignal,
  label = "Vertex"
): Promise<T> {
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const release = await acquire(account, model, kind, signal);
    try {
      return await run();
    } catch (error) {
      const failure = classify(error);
      const last = attempt >= MAX_ATTEMPTS;

      if (!failure.retryable || last) {
        if (failure.retryable && last) {
          throw new VertexError(
            `${label} still failing after ${MAX_ATTEMPTS} attempts. ${failure.message}`,
            true,
            failure.status
          );
        }
        throw failure;
      }

      // Full jitter: a batch that hits the same quota wall at the same instant
      // must not come back in step and hit it again together.
      const asked = retryAfterMs(error);
      const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
      const wait = asked ?? Math.round(backoff * (0.5 + Math.random() * 0.5));

      if (failure.status === 429) penalise(`${account.id}:${model}`, wait);
      release();
      await sleep(wait);
      continue;
    } finally {
      release();
    }
  }
}

/**
 * What this server has spent since it started.
 *
 * In memory, and on globalThis so an edit in dev doesn't zero it mid-batch. It
 * is a running estimate, not an account balance: Google exposes no API for the
 * remaining credit on a billing account, so the only honest way to show "what's
 * left of the $300" is to count what we asked for and price it ourselves. The
 * counts are exact; the money is as good as the rate table.
 */
export interface UsageEntry {
  at: number;
  accountId: string;
  model: string;
  kind: "image" | "video";
  /** Images generated, or seconds of video. */
  units: number;
  usd: number;
  estimated: boolean;
}

interface Ledger {
  entries: UsageEntry[];
  since: number;
  /**
   * Money committed by calls that have started but not yet recorded. Without
   * this the cap only sees *finished* work, so N concurrent calls each check
   * against the same total and all pass — the ceiling is then overshot by
   * roughly one call per lane, which grows with concurrency exactly when the
   * cap matters most.
   */
  reserved: number;
}

const ledger: Ledger = ((globalThis as { __vertexLedger?: Ledger }).__vertexLedger ??= {
  entries: [],
  since: Date.now(),
  reserved: 0,
});

// Same hot-reload hazard as the limiter: a ledger built before `reserved`
// existed survives the module edit without it, and NaN arithmetic would then
// disable the cap silently.
if (typeof ledger.reserved !== "number") ledger.reserved = 0;

/** Bounded so a long-lived dev server can't grow the ledger without limit. */
const LEDGER_MAX = 5_000;

function record(entry: UsageEntry) {
  ledger.entries.push(entry);
  if (ledger.entries.length > LEDGER_MAX) {
    ledger.entries.splice(0, ledger.entries.length - LEDGER_MAX);
  }
}

export function spentUsd(): number {
  return ledger.entries.reduce((total, entry) => total + entry.usd, 0);
}

export function usageSummary() {
  const spent = spentUsd();
  const budget = creditBudgetUsd();
  const cap = spendCapUsd();
  const byModel = new Map<string, { units: number; usd: number; kind: string; calls: number }>();

  for (const entry of ledger.entries) {
    const row = byModel.get(entry.model) ?? { units: 0, usd: 0, kind: entry.kind, calls: 0 };
    row.units += entry.units;
    row.usd += entry.usd;
    row.calls += 1;
    byModel.set(entry.model, row);
  }

  // Grouped by account as well as by model: with two Google accounts the only
  // number that matters when choosing one is what is left on *that* account.
  const byAccount = new Map<string, { usd: number; calls: number }>();
  for (const entry of ledger.entries) {
    const row = byAccount.get(entry.accountId) ?? { usd: 0, calls: 0 };
    row.usd += entry.usd;
    row.calls += 1;
    byAccount.set(entry.accountId, row);
  }

  return {
    since: ledger.since,
    spentUsd: Number(spent.toFixed(4)),
    byAccount: [...byAccount.entries()].map(([accountId, row]) => ({
      accountId,
      calls: row.calls,
      usd: Number(row.usd.toFixed(4)),
    })),
    creditBudgetUsd: budget,
    remainingUsd: Number(Math.max(0, budget - spent).toFixed(4)),
    spendCapUsd: cap,
    capRemainingUsd: cap === null ? null : Number(Math.max(0, cap - spent).toFixed(4)),
    calls: ledger.entries.length,
    byModel: [...byModel.entries()].map(([model, row]) => ({
      model,
      kind: row.kind,
      calls: row.calls,
      units: Number(row.units.toFixed(2)),
      usd: Number(row.usd.toFixed(4)),
    })),
    recent: ledger.entries.slice(-20),
    /**
     * Set whenever any rate came from the placeholder table rather than from an
     * env override, so the UI can label the figure instead of implying it is a
     * bill.
     */
    ratesUnverified: ledger.entries.some((entry) => entry.estimated),
    note:
      "Spend is estimated locally: Google publishes no API for remaining credit " +
      "on a billing account. Counts are exact; dollars depend on the rate table.",
  };
}

/**
 * Refuses the call if it would carry spend past the configured ceiling.
 *
 * Checked before the request rather than after, because after is too late — the
 * point of a cap is that the run stops on its own during an unattended bulk job.
 */
function noteSpend(
  accountId: string,
  model: string,
  kind: "image" | "video",
  units: number,
  rate: Rate
) {
  record({
    at: Date.now(),
    accountId,
    model,
    kind,
    units,
    usd: units * rate.usd,
    estimated: !rate.verified,
  });
}

function guardSpend(estimate: number): () => void {
  const cap = spendCapUsd();
  if (cap !== null) {
    const committed = spentUsd() + ledger.reserved;
    if (committed + estimate > cap) {
      throw new VertexError(
        `Refusing to spend: this call would take the session to about ` +
          `$${(committed + estimate).toFixed(2)}, past the VERTEX_SPEND_CAP_USD ` +
          `of $${cap.toFixed(2)}. Raise the cap in .env.local to continue.`,
        false
      );
    }
  }

  // Held whether or not a cap is set, so `reserved` always reflects what is in
  // flight and a cap added later starts from the truth.
  ledger.reserved += estimate;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ledger.reserved = Math.max(0, ledger.reserved - estimate);
  };
}

export interface VertexImage {
  base64: string;
  mimeType: string;
}

export interface ImageRequest {
  account: VertexAccount;
  model: string;
  prompt: string;
  count?: number;
  aspectRatio?: string;
  /** `imageConfig.imageSize` — the resolution tier, e.g. "1K". */
  imageSize?: string;
  negativePrompt?: string;
  seed?: number;
  /** Vertex refuses a seed while watermarking is on; they are mutually exclusive. */
  addWatermark?: boolean;
  personGeneration?: string;
  safetySetting?: string;
  signal?: AbortSignal;
}

/**
 * Images.
 *
 * One path, not two. The Imagen `:predict` family is gone from this app — it is
 * unavailable on the project *and* deprecated in the SDK, which now routes image
 * models through `generateContent`. Everything here is a Gemini image model:
 * one image per call, sized and shaped by `imageConfig`.
 */
export async function generateImages(request: ImageRequest): Promise<VertexImage[]> {
  const { account, model, prompt, count = 1, aspectRatio, imageSize, signal } = request;
  const spec = findVertexImageModel(model);
  const wanted = Math.max(1, Math.min(spec?.maxImages ?? 4, count));
  const rate = imageRate(model);
  const location = locationOf(model);

  const imageConfig: Record<string, string> = {};
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
  if (imageSize) imageConfig.imageSize = imageSize;

  const images: VertexImage[] = [];

  // One call per image, deliberately serial: they share the limiter, and on a
  // project this rate-limited a partial result beats a batch that fails whole.
  for (let index = 0; index < wanted; index += 1) {
    // The hold is taken before the call and released after it, so a second
    // concurrent call sees this one's cost even though nothing is recorded yet.
    const releaseHold = guardSpend(rate.usd);
    let response;
    try {
      response = await call(
        account,
        model,
        "image",
        () =>
          genai(account, location).models.generateContent({
            model,
            contents: prompt,
            config: {
              responseModalities: ["IMAGE"],
              ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
            },
          }),
        signal,
        `${model}`
      );
    } finally {
      releaseHold();
    }

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.find((part) => part.inlineData?.data);

    if (!inline?.inlineData?.data) {
      const finish = response.candidates?.[0]?.finishReason;
      throw new VertexError(
        finish && finish !== "STOP"
          ? `${model} returned no image (${finish}) — usually the safety filter.`
          : `${model} answered without an image part.`,
        false
      );
    }

    images.push({
      base64: inline.inlineData.data,
      mimeType: inline.inlineData.mimeType ?? "image/png",
    });
    noteSpend(account.id, model, "image", 1, rate);
  }

  return images;
}

export interface VideoRequest {
  account: VertexAccount;
  model: string;
  prompt: string;
  /** Base64 still to animate, for the image-to-video models. */
  image?: { base64: string; mimeType: string };
  aspectRatio?: string;
  /** "720p" or "1080p" — both confirmed on Veo 3.1 Lite. */
  resolution?: string;
  durationSeconds?: number;
  /**
   * Whether Veo scores the clip. Defaults to *off*, which is both the cheaper
   * rate and what this app wants: every clip here gets the user's own narration
   * laid under it by the editor, so a generated soundtrack would only be
   * something to strip out later.
   */
  generateAudio?: boolean;
  /** Where Vertex should write the result; without it the bytes come inline. */
  outputGcsUri?: string;
  signal?: AbortSignal;
}

export interface VertexVideo {
  base64?: string;
  uri?: string;
  mimeType: string;
}

/**
 * Video is a long-running operation, not a response.
 *
 * The limiter slot is released as soon as the job is *accepted*, not held for
 * the minutes it then runs. Polling is cheap and uncapped by the media quota,
 * and holding the slot would let four videos block every still in the batch.
 */
export async function generateVideo(request: VideoRequest): Promise<VertexVideo[]> {
  const {
    account,
    model,
    prompt,
    image,
    aspectRatio,
    durationSeconds,
    resolution,
    generateAudio = false,
    outputGcsUri,
    signal,
  } = request;

  // Checked here rather than left to Veo. An out-of-range duration is rejected
  // *after* the operation is created, so the round trip costs a minute and the
  // failure looks like a render fault instead of a bad parameter.
  const spec = findVertexVideoModel(model);
  if (spec && durationSeconds && !spec.durations.includes(durationSeconds)) {
    throw new VertexError(
      `${spec.label} accepts ${spec.durations.join(", ")} seconds, not ${durationSeconds}.`,
      false
    );
  }

  const seconds = durationSeconds ?? spec?.durations[0] ?? 8;
  const rate = videoRate(model, generateAudio);
  // Veo bills per second of output, so the whole clip is the unit of spend —
  // this is the call that empties a credit balance, not the stills.
  // Held for the whole operation, not just the request: a Veo clip runs for
  // minutes, and without the hold every other clip started in that window would
  // check the cap against a total that ignores this one.
  const releaseHold = guardSpend(rate.usd * seconds);

  let videos;
  try {
    const config: Record<string, unknown> = { generateAudio };
    if (aspectRatio) config.aspectRatio = aspectRatio;
    if (resolution) config.resolution = resolution;
    if (durationSeconds) config.durationSeconds = durationSeconds;
    if (outputGcsUri) config.outputGcsUri = outputGcsUri;

    const location = locationOf(model);

    let operation = await call(
      account,
      model,
      "video",
      () =>
        genai(account, location).models.generateVideos({
          model,
          prompt,
          ...(image ? { image: { imageBytes: image.base64, mimeType: image.mimeType } } : {}),
          config,
        }),
      signal,
      `Veo (${model})`
    );

    const deadline = Date.now() + VIDEO_TIMEOUT_MS;

    while (!operation.done) {
      if (signal?.aborted) throw new VertexError("Cancelled.", false);
      if (Date.now() > deadline) {
        throw new VertexError(
          `Veo did not finish within ${Math.round(VIDEO_TIMEOUT_MS / 1000)}s. It may yet ` +
            `complete and still be billed — check the operation in the Cloud console.`,
          false
        );
      }
      await sleep(VIDEO_POLL_MS);
      try {
        operation = await genai(account, location).operations.getVideosOperation({ operation });
      } catch (error) {
        throw classify(error);
      }
    }

    if (operation.error) {
      throw new VertexError(
        `Veo failed: ${operation.error.message ?? JSON.stringify(operation.error)}`,
        false
      );
    }

    const made = (operation.response?.generatedVideos ?? [])
      .map((entry) => ({
        base64: entry.video?.videoBytes,
        uri: entry.video?.uri,
        mimeType: entry.video?.mimeType ?? "video/mp4",
      }))
      .filter((video) => video.base64 || video.uri);

    if (made.length === 0) {
      throw new VertexError("Veo finished but returned no video.", false);
    }

    videos = made;
  } finally {
    releaseHold();
  }

  noteSpend(account.id, model, "video", seconds * videos.length, rate);
  return videos;
}

export interface ModelProbe {
  model: string;
  kind: "image" | "video";
  available: boolean;
  detail: string;
}

/**
 * Asks the project which models it may actually use.
 *
 * This exists because Vertex answers a misspelled model id and a model the
 * project is not entitled to with the same 404, and no amount of reading the
 * error tells them apart. The probe sends a request that is *well formed* but
 * cannot generate — Vertex validates the payload before it looks the model up,
 * so an empty-instances 400 proves nothing, while a well-formed request against
 * a missing model returns the 404 we are looking for.
 *
 * Images are settled with a real one-image call, which is the only honest test
 * and costs a fraction of a cent. Video is not: a Veo call that succeeds bills
 * for a whole clip, so video is reported as `unknown` rather than started.
 */
export async function preflight(
  account: VertexAccount,
  models: { image: string[]; video: string[] }
): Promise<ModelProbe[]> {
  const out: ModelProbe[] = [];

  for (const model of models.image) {
    try {
      await generateImages({ account, model, prompt: "a plain red square", count: 1 });
      out.push({ model, kind: "image", available: true, detail: "generated a test image" });
    } catch (error) {
      const failure = error instanceof VertexError ? error : classify(error);
      out.push({
        model,
        kind: "image",
        available: false,
        detail: `${failure.status ?? "?"} — ${failure.message}`,
      });
    }
  }

  for (const model of models.video) {
    out.push({
      model,
      kind: "video",
      available: false,
      detail:
        "not probed — starting a Veo job bills for a full clip, so this is left " +
        "to a real render rather than tested here",
    });
  }

  return out;
}
