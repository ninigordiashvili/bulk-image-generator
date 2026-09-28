import { readUsage, saveUsage, reservedBatchUsd } from "./vertexUsage";
import { createHash } from "node:crypto";
import { GoogleGenAI, type GenerateVideosOperation } from "@google/genai";
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
 * How many Vertex calls may be in flight for each account, and how closely
 * their starts may be spaced.
 *
 * These are separate limits because they fail differently. Concurrency bounds
 * how much work sits open at once — useful for video, where one call can run for
 * minutes. Spacing bounds the *rate* of new calls, which is what a per-minute
 * quota actually counts, and it is the one that matters for bulk stills: sixty
 * images fired three-at-a-time still arrive as a burst if each returns quickly.
 */
/**
 * Concurrency is per account and kind. Images and video draw on separate GCP
 * quotas (2/min and 1/min here), so one pool would let a batch of video starve
 * the stills or the reverse. Two lanes keep each within its own limit.
 */
const CONCURRENCY_IMAGE = positiveInt(process.env.VERTEX_CONCURRENCY_IMAGE, 2);
const CONCURRENCY_VIDEO = positiveInt(process.env.VERTEX_CONCURRENCY_VIDEO, 1);
const QPM = positiveInt(process.env.VERTEX_QPM, 60);

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
     * alike. The queue retries every failed prompt once; this hint also helps
     * distinguish provider errors from temporary polling failures.
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
  lanes: Map<string, Lane>;
  /**
   * Earliest time the next call may start, *per model*. Vertex quota is granted
   * per base model — 2/min for the image models, 1/min for Veo — so one shared
   * rate would either starve the images or overrun the video. Rates are shared
   * only by accounts using the same Google Cloud project and model.
   */
  nextStart: Map<string, number>;
}

const limiter: Limiter = ((
  globalThis as { __vertexLimiter?: Limiter }
).__vertexLimiter ??= {
  lanes: new Map(),
  nextStart: new Map(),
});

// Surviving a hot reload is the point of holding this on globalThis, but it also
// means an object built by an *older* version of this file can outlive it. When
// `nextStart` changed from a number to a per-model Map, the stale object kept
// the number and every call threw. Re-shaping here costs nothing and turns a
// crash into a dropped schedule.
if (!(limiter.nextStart instanceof Map)) limiter.nextStart = new Map();
if (!(limiter.lanes instanceof Map)) limiter.lanes = new Map();

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new VertexError("Cancelled.", false)); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new VertexError("Cancelled.", false)); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Admits one call, then holds the slot until `release` is called.
 *
 * Claim each start only after waiting and rechecking the shared deadline.
 * A quota cooldown therefore also delays callers that were already waiting.
 */
async function acquire(
  account: VertexAccount,
  model: string,
  kind: "image" | "video",
  signal?: AbortSignal
): Promise<() => void> {
  if (signal?.aborted) throw new VertexError("Cancelled.", false);

  const laneKey = `${account.projectId}:${account.id}:${kind}`;
  let lane = limiter.lanes.get(laneKey);
  if (!lane) {
    lane = { active: 0, waiting: [] };
    limiter.lanes.set(laneKey, lane);
  }
  // The account's own figure wins, and it is re-read from disk on every request,
  // so widening a lane mid-batch needs no restart — which matters because a
  // restart reloads the page and the storyboard is not persisted.
  const ceiling =
    kind === "video"
      ? (account.videoConcurrency ?? CONCURRENCY_VIDEO)
      : (account.imageConcurrency ?? CONCURRENCY_IMAGE);

  while (lane.active >= ceiling) {
    const waiting = lane;
    await new Promise<void>((resolve, reject) => {
      const resume = () => { signal?.removeEventListener("abort", abort); resolve(); };
      const abort = () => {
        const index = waiting.waiting.indexOf(resume);
        if (index >= 0) waiting.waiting.splice(index, 1);
        reject(new VertexError("Cancelled.", false));
      };
      waiting.waiting.push(resume);
      signal?.addEventListener("abort", abort, { once: true });
    });
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

  // Different projects have independent quotas; aliases of one project share its quota.
  const rateKey = `${account.projectId}:${model}`;


  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lane.active -= 1;
    lane.waiting.shift()?.();
  };

  try {
    while (true) {
      if (signal?.aborted) throw new VertexError("Cancelled.", false);
      const now = Date.now();
      const wait = (limiter.nextStart.get(rateKey) ?? 0) - now;
      if (wait <= 0) {
        // No await between checking and claiming: concurrent callers cannot
        // consume the same slot. Failed attempts count toward the rate too.
        limiter.nextStart.set(rateKey, now + interval);
        break;
      }
      await sleep(Math.min(wait, 2_147_483_647), signal);
    }
  } catch (error) {
    release();
    throw error;
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
  const key = JSON.stringify([account.id, account.projectId, account.credentials, location]);
  let client = clients.get(key);
  if (!client) {
    client = new GoogleGenAI({
      vertexai: true,
      httpOptions: { retryOptions: { attempts: 1 } },
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
  const fields = error as { status?: number; code?: number } | null;
  const status = Number(fields?.status ?? fields?.code ?? /\b(4\d\d|5\d\d)\b/.exec(raw)?.[1]);
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
  if (status === 429 || (!status && (lower.includes("resource_exhausted") || lower.includes("quota exceeded") || lower.includes("quota exhausted")))) {
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

/** Respect Google's Retry-After header and structured RetryInfo delay. */
function retryAfterMs(error: unknown): number | null {
  const value = error as { response?: { headers?: Headers | Record<string, string> }; headers?: Headers | Record<string, string> } | null;
  const headers = value?.response?.headers ?? value?.headers;
  const header = headers instanceof Headers ? headers.get("retry-after") : headers?.["retry-after"];
  const waits: number[] = [];
  if (header) {
    const seconds = Number(header);
    const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(wait) && wait >= 0) waits.push(wait);
  }
  // The SDK preserves Google's JSON error, including RetryInfo, in message.
  const raw = error instanceof Error ? error.message : JSON.stringify(error) ?? "";
  const match = /retry(?:\s|-)?(?:after|delay)"?[:\s]+"?(\d+(?:\.\d+)?)s?/i.exec(raw);
  if (match) waits.push(Number(match[1]) * 1000);
  return waits.length ? Math.ceil(Math.max(...waits)) : null;
}

/** Quota failures wait and retry until success or cancellation. Other failures
 * retain the browser queue's one-retry policy. Every attempt uses the limiter. */
async function call<T>(
  account: VertexAccount, model: string, kind: "image" | "video",
  run: () => Promise<T>, signal?: AbortSignal, label = "Vertex"
): Promise<T> {
  let quotaFailures = 0;
  while (true) {
    const release = await acquire(account, model, kind, signal);
    try { return await run(); }
    catch (error) {
      if (signal?.aborted) throw new VertexError("Cancelled.", false);
      const failure = classify(error);
      if (failure.status !== 429) {
        throw new VertexError(label + ": " + failure.message, failure.retryable, failure.status);
      }
      // Start at 30 seconds, double up to five minutes, with a little jitter.
      // Google's longer requested delay always wins. The cooldown is shared
      // with every browser using this project/model, including queued calls.
      const backoff = Math.min(300_000, 30_000 * 2 ** Math.min(quotaFailures++, 4));
      const delay = Math.max(backoff + Math.floor(Math.random() * 3000), retryAfterMs(error) ?? 0);
      penalise(account.projectId + ":" + model, delay);
    } finally { release(); }
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
   * Money committed per account by calls that have started but not yet
   * recorded. Without this the cap only sees *finished* work, so N concurrent
   * calls each check against the same total and all pass — the ceiling is then
   * overshot by roughly one call per lane, which grows with concurrency exactly
   * when the cap matters most.
   */
  reserved: Map<string, number>;
}

const ledger: Ledger = ((globalThis as { __vertexLedger?: Ledger }).__vertexLedger ??= {
  entries: [],
  since: Date.now(),
  reserved: new Map(),
});

// Same hot-reload hazard as the limiter: a ledger built before `reserved`
// existed survives the module edit without it, and NaN arithmetic would then
// disable the cap silently.
if (!(ledger.reserved instanceof Map)) ledger.reserved = new Map();

/** Bounded so a long-lived dev server can't grow the ledger without limit. */
const LEDGER_MAX = 5_000;
const migration = globalThis as typeof globalThis & { __vertexUsageMigrated?: boolean };
if (!migration.__vertexUsageMigrated) {
  for (const entry of ledger.entries) saveUsage(entry, true);
  migration.__vertexUsageMigrated = true;
}

function record(entry: UsageEntry) {
  saveUsage(entry);
  ledger.entries.push(entry);
  if (ledger.entries.length > LEDGER_MAX) {
    ledger.entries.splice(0, ledger.entries.length - LEDGER_MAX);
  }
}

export function spentUsd(accountId?: string): number {
  return readUsage().entries.reduce(
    (total, entry) =>
      accountId && entry.accountId !== accountId ? total : total + entry.usd,
    0
  );
}

export function usageSummary() {
  const history = readUsage();
  const entries = history.entries;
  const spent = spentUsd();
  const budget = creditBudgetUsd();
  const cap = spendCapUsd();
  const byModel = new Map<string, { units: number; usd: number; kind: string; calls: number }>();

  for (const entry of entries) {
    const row = byModel.get(entry.model) ?? { units: 0, usd: 0, kind: entry.kind, calls: 0 };
    row.units += entry.units;
    row.usd += entry.usd;
    row.calls += 1;
    byModel.set(entry.model, row);
  }

  // Grouped by account as well as by model: with two Google accounts the only
  // number that matters when choosing one is what is left on *that* account.
  const byAccount = new Map<string, { usd: number; calls: number }>();
  for (const entry of entries) {
    const row = byAccount.get(entry.accountId) ?? { usd: 0, calls: 0 };
    row.usd += entry.usd;
    row.calls += 1;
    byAccount.set(entry.accountId, row);
  }

  return {
    since: entries.length ? Math.min(...entries.map(entry => entry.at)) : ledger.since,
    persistenceError: history.error,
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
    calls: entries.length,
    byModel: [...byModel.entries()].map(([model, row]) => ({
      model,
      kind: row.kind,
      calls: row.calls,
      units: Number(row.units.toFixed(2)),
      usd: Number(row.usd.toFixed(4)),
    })),
    recent: entries.slice(-20),
    /**
     * Whether any model *currently* in the ledger is still priced from an
     * unconfirmed rate. Read from today's table rather than from the flag each
     * entry was stamped with: confirming a rate should clear the warning, and
     * stamping is historical — an entry recorded before a rate was checked
     * would otherwise keep the ledger looking unverified for the life of the
     * process even though nothing about the number is in doubt any more.
     */
    ratesUnverified: [...byModel.entries()].some(([model, row]) =>
      row.kind === "video" ? !videoRate(model).verified : !imageRate(model).verified
    ),
    note:
      "Estimated recorded app spending only. Earlier and external usage, pending jobs, other charges and credit expiry are excluded.",
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

export function guardSpend(account: VertexAccount, estimate: number): () => void {
  // The account's own ceiling wins; the env value is the fallback for an
  // account that sets none.
  const cap = account.spendCapUsd ?? spendCapUsd();
  const held = ledger.reserved.get(account.id) ?? 0;

  if (cap !== null) {
    const committed = spentUsd(account.id) + held + reservedBatchUsd(account.id);
    if (committed + estimate > cap) {
      throw new VertexError(
        `Refusing to spend: this call would take account "${account.id}" to about ` +
          `$${(committed + estimate).toFixed(2)}, past its cap of $${cap.toFixed(2)}. ` +
          `Raise spendCapUsd in vertex-accounts.json to continue.`,
        false
      );
    }
  }

  // Held whether or not a cap is set, so `reserved` always reflects what is in
  // flight and a cap added later starts from the truth.
  ledger.reserved.set(account.id, held + estimate);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const now = ledger.reserved.get(account.id) ?? 0;
    ledger.reserved.set(account.id, Math.max(0, now - estimate));
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
  referenceImages?: { label?: string; base64: string; mimeType: string }[];
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
  const references = request.referenceImages ?? [];
  if (!Array.isArray(references) || references.length > (spec?.maxReferences ?? 0)) {
    throw new VertexError("Too many reference images for this model.", false, 400);
  }
  for (const reference of references) {
    if (!reference || typeof reference.base64 !== "string" || !reference.base64.length ||
        !["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"].includes(reference.mimeType) ||
        reference.base64.length > Math.ceil(7 * 1024 * 1024 / 3) * 4) {
      throw new VertexError("Invalid reference image. Use an image under 7 MB.", false, 400);
    }
  }
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
    const releaseHold = guardSpend(account, rate.usd);
    let response;
    try {
      response = await call(
        account,
        model,
        "image",
        () =>
          genai(account, location).models.generateContent({
            model,
            contents: [{ role: "user", parts: [
              ...references.flatMap((reference, index) => [
                { text: reference.label || `Reference image ${index + 1}` },
                { inlineData: { data: reference.base64, mimeType: reference.mimeType } },
              ]),
              { text: prompt },
            ] }],
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
  requestId?: string;
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

interface RememberedVideo {
  started: Promise<GenerateVideosOperation>;
  operation?: GenerateVideosOperation;
  billed: boolean;
  createdAt: number;
}
const videoOperations = ((globalThis as { __vertexVideoOperations?: Map<string, RememberedVideo> })
  .__vertexVideoOperations ??= new Map<string, RememberedVideo>());

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
  const rate = videoRate(model, generateAudio, resolution);
  // Veo bills per second of output, so the whole clip is the unit of spend —
  // this is the call that empties a credit balance, not the stills.
  // Held for the whole operation, not just the request: a Veo clip runs for
  // minutes, and without the hold every other clip started in that window would
  // check the cap against a total that ignores this one.
  const operationKey = request.requestId ? createHash("sha256").update(JSON.stringify([
    account.id, account.projectId, account.credentials, request.requestId, model, prompt, image,
    aspectRatio, durationSeconds, resolution, generateAudio, outputGcsUri,
  ])).digest("hex") : "";
  // Keep a bounded window of completed responses for connection-loss retries.
  for (const [key, cached] of videoOperations) {
    if (cached.operation?.done && (Date.now() - cached.createdAt > 60 * 60 * 1000 || videoOperations.size > 16)) {
      videoOperations.delete(key);
    }
  }
  let remembered = operationKey ? videoOperations.get(operationKey) : undefined;
  const releaseHold = remembered?.billed ? () => {} : guardSpend(account, rate.usd * seconds);

  let videos;
  try {
    const config: Record<string, unknown> = { generateAudio };
    if (aspectRatio) config.aspectRatio = aspectRatio;
    if (resolution) config.resolution = resolution;
    if (durationSeconds) config.durationSeconds = durationSeconds;
    if (outputGcsUri) config.outputGcsUri = outputGcsUri;

    const location = locationOf(model);

    if (!remembered) {
      remembered = { billed: false, createdAt: Date.now(), started: call(
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
      ) };
      if (operationKey) videoOperations.set(operationKey, remembered);
    }
    let operation: GenerateVideosOperation;
    try { operation = remembered.operation ?? await remembered.started; }
    catch (error) {
      if (operationKey) videoOperations.delete(operationKey);
      throw error;
    }
    remembered.operation = operation;

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
      await sleep(VIDEO_POLL_MS, signal);
      try {
        operation = await genai(account, location).operations.getVideosOperation({ operation });
        remembered.operation = operation;
      } catch (error) {
        throw classify(error);
      }
    }

    if (operation.error) {
      if (operationKey) videoOperations.delete(operationKey);
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
      if (operationKey) videoOperations.delete(operationKey);
      throw new VertexError("Veo finished but returned no video.", false);
    }

    videos = made;
  } finally {
    releaseHold();
  }

  if (!remembered?.billed) {
    noteSpend(account.id, model, "video", seconds * videos.length, rate);
    if (remembered) remembered.billed = true;
  }
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
