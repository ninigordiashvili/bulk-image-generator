import { createHash } from "node:crypto";
import type { TaskInput } from "@/types";

const API_BASE = "https://api.kie.ai";
/**
 * Uploads live on a different host to the rest of the API. The docs advertise
 * `api.kie.ai/api/file-base64-upload`, but that path 404s — verified 2026-07-31;
 * this is the host that actually accepts the upload.
 */
const UPLOAD_URL = "https://kieai.redpandaai.co/api/file-base64-upload";

/** Task states kie reports. Anything not terminal means "keep polling". */
const TERMINAL_STATES = new Set(["success", "fail"]);

const POLL_INITIAL_MS = 2000;
const POLL_MAX_MS = 6000;
/** Comfortably inside the route's maxDuration, so we report rather than get killed. */
const POLL_DEADLINE_MS = 240_000;

/** Video takes far longer than an image, and polls more slowly to match. */
const VIDEO_POLL_MAX_MS = 15_000;
const VIDEO_POLL_DEADLINE_MS = 840_000;

/**
 * How many polls in a row may fail before a task is given up on. kie's gateway
 * intermittently answers `record-info` with a 502 and an HTML body while a task
 * is still rendering — observed repeatedly against Veo on 2026-07-31. Treating
 * that as fatal abandons work that has already been billed.
 */
const MAX_CONSECUTIVE_POLL_ERRORS = 10;

/**
 * Uploaded reference images are reused across a batch: 150 prompts sharing two
 * pinned characters should be two uploads, not three hundred. kie deletes the
 * files after 3 days, so entries are dropped well before that.
 *
 * The cache holds the in-flight promise rather than the finished URL, because
 * the first few concurrent jobs all start before any of them finishes — caching
 * only completed uploads would still let the batch's opening burst duplicate.
 */
const UPLOAD_TTL_MS = 12 * 60 * 60 * 1000;
const uploadCache = new Map<string, { url: Promise<string>; storedAt: number }>();

export class KieError extends Error {
  constructor(
    message: string,
    /** False when nothing about this failure can change between attempts. */
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "KieError";
  }
}

interface KieEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

export interface TaskRecord {
  taskId: string;
  state: string;
  resultJson?: string | null;
  failCode?: string | number | null;
  failMsg?: string | null;
  creditsConsumed?: number | null;
}

/**
 * kie reports failures three ways — HTTP status, an envelope `code`, and a
 * `failCode` on the finished task — with the same meanings. This maps all of
 * them, so an auth or credit problem halts the batch instead of being retried
 * 150 times.
 */
function isRetryableCode(code: number): boolean {
  if (code === 429) return true;
  // 501 is kie's "generation failed", which is often a transient model hiccup.
  if (code >= 500) return true;
  return false;
}

function describeCode(code: number, message: string): string {
  switch (code) {
    case 401:
      return `kie.ai rejected the API key (401). Check it at https://kie.ai/api-key. Raw: ${message}`;
    case 402:
      return `kie.ai account is out of credits (402). Top up at https://kie.ai. Raw: ${message}`;
    case 404:
      return `kie.ai has no such model or endpoint (404). Check the model id. Raw: ${message}`;
    case 422:
      return `kie.ai rejected the request as invalid (422) — usually a field this model doesn't accept, or a value outside its allowed set. Raw: ${message}`;
    case 429:
      return `kie.ai rate limited the request (429). Lower concurrency. Raw: ${message}`;
    default:
      return `kie.ai returned ${code}: ${message}`;
  }
}

async function call<T>(
  path: string,
  apiKey: string,
  init: RequestInit & { signal?: AbortSignal }
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new KieError("Cancelled.", false);
    }
    throw new KieError(
      `Could not reach kie.ai: ${error instanceof Error ? error.message : String(error)}`,
      true
    );
  }

  const payload = (await response.json().catch(() => null)) as KieEnvelope<T> | null;
  if (!payload) {
    throw new KieError(
      `kie.ai returned ${response.status} with an unreadable body.`,
      isRetryableCode(response.status)
    );
  }

  const code = payload.code ?? response.status;
  if (code !== 200 || !response.ok) {
    const status = response.ok ? code : response.status;
    throw new KieError(
      describeCode(status, payload.msg ?? response.statusText),
      isRetryableCode(status)
    );
  }
  if (payload.data === undefined || payload.data === null) {
    throw new KieError("kie.ai returned a success envelope with no data.", true);
  }
  return payload.data;
}

export async function getCredits(
  apiKey: string,
  signal?: AbortSignal
): Promise<number> {
  const data = await call<number>("/api/v1/chat/credit", apiKey, {
    method: "GET",
    signal,
  });
  return typeof data === "number" ? data : Number(data) || 0;
}

export async function createTask(
  apiKey: string,
  model: string,
  input: TaskInput,
  signal?: AbortSignal
): Promise<string> {
  const data = await call<{ taskId?: string; recordId?: string }>(
    "/api/v1/jobs/createTask",
    apiKey,
    { method: "POST", body: JSON.stringify({ model, input }), signal }
  );
  const taskId = data.taskId ?? data.recordId;
  if (!taskId) throw new KieError("kie.ai created a task with no id.", true);
  return taskId;
}

export async function getTask(
  apiKey: string,
  taskId: string,
  signal?: AbortSignal
): Promise<TaskRecord> {
  return call<TaskRecord>(
    `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
    apiKey,
    { method: "GET", signal }
  );
}

/**
 * Polls until the task settles. kie recommends callbacks for production, but a
 * callback needs a public URL — this app runs on localhost against the user's
 * own key, so polling is the only option that works out of the box.
 */
export async function awaitTask(
  apiKey: string,
  taskId: string,
  signal?: AbortSignal,
  // Video tasks run minutes rather than seconds, so the caller sets the pace.
  options: PollOptions = {}
): Promise<TaskRecord> {
  return pollUntilSettled(
    () => getTask(apiKey, taskId, signal),
    (record) => TERMINAL_STATES.has(record.state),
    (record) =>
      `kie.ai task ${taskId} was still "${record?.state ?? "pending"}" after ${Math.round(
        (options.deadlineMs ?? POLL_DEADLINE_MS) / 1000
      )}s. It may yet finish and still be billed — check https://kie.ai before re-running it.`,
    signal,
    options
  );
}

export const VIDEO_POLL: PollOptions = {
  deadlineMs: VIDEO_POLL_DEADLINE_MS,
  maxWaitMs: VIDEO_POLL_MAX_MS,
};

interface PollOptions {
  deadlineMs?: number;
  maxWaitMs?: number;
}

/**
 * Polls until a task settles, tolerating transient failures along the way.
 *
 * The task is already created and billed by the time this runs, so a gateway
 * blip must not abandon it: only a genuinely terminal error (bad key, no
 * credits) or a long run of consecutive failures ends the loop early.
 */
async function pollUntilSettled<T>(
  read: () => Promise<T>,
  isSettled: (record: T) => boolean,
  describeStuck: (record: T | null) => string,
  signal: AbortSignal | undefined,
  { deadlineMs = POLL_DEADLINE_MS, maxWaitMs = POLL_MAX_MS }: PollOptions
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  let wait = POLL_INITIAL_MS;
  let consecutiveErrors = 0;
  let last: T | null = null;

  for (;;) {
    if (signal?.aborted) throw new KieError("Cancelled.", false);
    await sleep(wait, signal);
    if (signal?.aborted) throw new KieError("Cancelled.", false);

    try {
      last = await read();
      consecutiveErrors = 0;
      if (isSettled(last)) return last;
    } catch (error) {
      // Terminal means the next poll would fail identically — auth, credits, a
      // cancelled request. Anything else is worth another look.
      if (error instanceof KieError && !error.retryable) throw error;
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) throw error;
    }

    if (Date.now() > deadline) throw new KieError(describeStuck(last), true);
    wait = Math.min(maxWaitMs, Math.round(wait * 1.4));
  }
}

/** Result URLs from a successful task, in the order kie returned them. */
export function resultUrls(record: TaskRecord): string[] {
  if (!record.resultJson) return [];
  try {
    const parsed = JSON.parse(record.resultJson) as { resultUrls?: unknown };
    return Array.isArray(parsed.resultUrls)
      ? parsed.resultUrls.filter((url): url is string => typeof url === "string")
      : [];
  } catch {
    return [];
  }
}

/** Turns a failed task record into the error the queue should act on. */
export function taskFailure(record: TaskRecord): KieError {
  const code = Number(record.failCode);
  const message = record.failMsg?.trim() || "kie.ai reported the task failed.";
  if (Number.isFinite(code) && code !== 0) {
    return new KieError(describeCode(code, message), isRetryableCode(code));
  }
  // No usable code: assume retryable, since one extra attempt costs less than
  // silently giving up on something that would have worked.
  return new KieError(message, true);
}

/**
 * Uploads a reference image and returns its public URL. kie's image fields take
 * URLs only — never bytes — so every character in the library has to go through
 * here before it can be attached to a prompt.
 */
export function uploadReference(
  apiKey: string,
  base64: string,
  mimeType: string,
  signal?: AbortSignal
): Promise<string> {
  const digest = createHash("sha256")
    .update(apiKey)
    .update(base64)
    .digest("hex")
    .slice(0, 32);

  const cached = uploadCache.get(digest);
  if (cached && Date.now() - cached.storedAt < UPLOAD_TTL_MS) return cached.url;

  const pending = performUpload(apiKey, base64, mimeType, digest, signal);
  uploadCache.set(digest, { url: pending, storedAt: Date.now() });
  // A failed upload must not be remembered, or every later job in the batch
  // inherits the same rejection and the retry budget buys nothing.
  pending.catch(() => uploadCache.delete(digest));
  return pending;
}

/**
 * kie serves the uploaded file back by URL, and some of its models sniff the
 * type from the extension rather than the header — so this has to be right for
 * audio as well as images.
 */
function extensionForUpload(mimeType: string): string {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("aac")) return "aac";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("audio/mp4") || mimeType.includes("m4a")) return "m4a";
  return "jpg";
}

async function performUpload(
  apiKey: string,
  base64: string,
  mimeType: string,
  digest: string,
  signal?: AbortSignal
): Promise<string> {
  const extension = extensionForUpload(mimeType);

  let response: Response;
  try {
    response = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        base64Data: `data:${mimeType};base64,${base64}`,
        uploadPath: mimeType.startsWith("audio/")
          ? "audio/bulk-image-generator"
          : "images/bulk-image-generator",
        fileName: `ref-${digest}.${extension}`,
      }),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new KieError("Cancelled.", false);
    }
    throw new KieError(
      `Could not upload the file to kie.ai: ${
        error instanceof Error ? error.message : String(error)
      }`,
      true
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | { code?: number; msg?: string; data?: { downloadUrl?: string } }
    | null;
  const url = payload?.data?.downloadUrl;

  if (!response.ok || !url) {
    const code = payload?.code ?? response.status;
    throw new KieError(
      `Upload to kie.ai failed — ${describeCode(code, payload?.msg ?? response.statusText)}`,
      isRetryableCode(code)
    );
  }

  return url;
}

// ---------------------------------------------------------------------------
// Veo — kie's dedicated video namespace
// ---------------------------------------------------------------------------

/**
 * Veo doesn't ride on `jobs/createTask`. It has its own endpoints, its own
 * request shape (camelCase `imageUrls`, top-level settings rather than a nested
 * `input`), and reports completion with a numeric `successFlag` instead of a
 * state string.
 */
export interface VeoRecord {
  taskId: string;
  /** 0 = still generating, 1 = success, anything else = failed. */
  successFlag: number;
  response?: { resultUrls?: string[]; resolution?: string } | null;
  errorCode?: number | null;
  errorMessage?: string | null;
}

export interface VeoRequestBody {
  prompt: string;
  imageUrls?: string[];
  model: string;
  aspect_ratio?: string;
  resolution?: string;
  duration?: number;
}

export async function createVeoTask(
  apiKey: string,
  body: VeoRequestBody,
  signal?: AbortSignal
): Promise<string> {
  const data = await call<{ taskId?: string }>("/api/v1/veo/generate", apiKey, {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });
  if (!data.taskId) throw new KieError("kie.ai created a Veo task with no id.", true);
  return data.taskId;
}

/** A single read of a Veo task, for callers doing their own polling. */
export async function getVeoTask(
  apiKey: string,
  taskId: string,
  signal?: AbortSignal
): Promise<VeoRecord> {
  return call<VeoRecord>(
    `/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`,
    apiKey,
    { method: "GET", signal }
  );
}

export async function awaitVeoTask(
  apiKey: string,
  taskId: string,
  signal?: AbortSignal
): Promise<VeoRecord> {
  return pollUntilSettled(
    () =>
      call<VeoRecord>(
        `/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`,
        apiKey,
        { method: "GET", signal }
      ),
    (record) => record.successFlag !== 0,
    () =>
      `Veo task ${taskId} was still generating after ${Math.round(
        VIDEO_POLL_DEADLINE_MS / 1000
      )}s. The clip may yet finish and still be billed — check https://kie.ai before re-running it.`,
    signal,
    VIDEO_POLL
  );
}

/** Turns a failed Veo record into the error the queue should act on. */
export function veoFailure(record: VeoRecord): KieError {
  const code = Number(record.errorCode);
  const message = record.errorMessage?.trim() || "Veo reported the task failed.";
  if (Number.isFinite(code) && code !== 0) {
    return new KieError(describeCode(code, message), isRetryableCode(code));
  }
  return new KieError(message, true);
}

/** Downloads a finished image so it can be stored locally — kie's URLs expire. */
export async function fetchImageBytes(
  url: string,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; mimeType: string }> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new KieError("Cancelled.", false);
    }
    throw new KieError(
      `Could not download the generated image: ${
        error instanceof Error ? error.message : String(error)
      }`,
      true
    );
  }
  if (!response.ok) {
    throw new KieError(
      `Could not download the generated image (${response.status} from ${url}).`,
      true
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
  return { bytes, mimeType };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}
