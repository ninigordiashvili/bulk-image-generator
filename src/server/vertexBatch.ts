import { GoogleAuth } from "google-auth-library";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { GenerateRequest, GenerateResponse } from "@/types";
import type { WorkInput } from "@/types/work";
import { readImageDimensions } from "@/lib/imageMeta";
import { VERTEX_BATCH_MODEL, VERTEX_BATCH_IMAGE_USD, batchInputEstimate,
  VERTEX_BATCH_INPUT_PER_TOKEN, VERTEX_BATCH_TEXT_PER_TOKEN, VERTEX_BATCH_IMAGE_PER_TOKEN } from "@/lib/vertexBatch";
import { findVertexAccount, type VertexAccount } from "./vertexAccounts";
import { guardSpend } from "./vertex";
import { saveUsage, setBatchReservation } from "./vertexUsage";

export interface VertexBatchState {
  attempt: number; indices: number[]; account: VertexAccount; bucket: string; prefix: string;
  hashes: Record<string, number[]>; assigned: Record<string, number>; imported: number[];
  name?: string; state: string; attempted?: boolean; terminal?: boolean; cancelSent?: boolean;
  estimateUsd: number; submittedAt?: number; outputDirectory?: string; error?: string;
}
interface CloudJob {
  name: string; state: string; error?: { message?: string };
  outputInfo?: { gcsOutputDirectory?: string };
}
interface Part { text?: string; inlineData?: { data: string; mimeType: string }; fileData?: { fileUri: string; mimeType: string }; thought?: boolean }
interface BatchRequest { contents: { role: string; parts: Part[] }[]; generationConfig: { responseModalities: string[]; imageConfig: { imageSize: string; aspectRatio?: string } } }
interface OutputRow {
  request?: BatchRequest; status?: string | { message?: string; code?: number };
  response?: {
    candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number;
      candidatesTokensDetails?: { modality: string; tokenCount: number }[] };
  };
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
// Ignore Google's added null/default fields. Identical requests are assigned to separate copies.
export function batchRequestHash(request: Pick<BatchRequest, "contents">) {
  return hash(JSON.stringify(request.contents.map(content => content.parts.map(part => part.text != null
    ? { text: part.text } : part.fileData ? { fileUri: part.fileData.fileUri, mimeType: part.fileData.mimeType }
      : { inlineData: part.inlineData }))));
}
export class CloudError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export class VertexBatchCloud {
  private auth: GoogleAuth;
  constructor(readonly account: VertexAccount) {
    this.auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      ...(account.credentials === "adc" ? {} : { keyFilename: path.resolve(account.credentials) }) });
  }
  async request(url: string, init: RequestInit = {}) {
    const token = await this.auth.getAccessToken();
    if (!token) throw new Error("Google Cloud sign-in is required for this account.");
    const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers }, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      const body = await response.text();
      let message = `Google returned HTTP ${response.status}.`;
      try { message = JSON.parse(body).error?.message || message; } catch { /* Do not expose HTML or credentials. */ }
      throw new CloudError(message, response.status);
    }
    return response;
  }
  async json<T>(url: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const r = await this.request(url, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    return r.json();
  }
  get parent() { return `https://aiplatform.googleapis.com/v1/projects/${this.account.projectId}/locations/global/batchPredictionJobs`; }
  async ensureBucket(bucket: string) {
    try {
      await this.json(`https://storage.googleapis.com/storage/v1/b/${bucket}`);
    } catch (error) {
      if (!(error instanceof CloudError) || error.status !== 404) throw error;
      try {
        await this.json(`https://storage.googleapis.com/storage/v1/b?project=${this.account.projectId}`, {
          name: bucket, location: "US", storageClass: "STANDARD",
          iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" },
          softDeletePolicy: { retentionDurationSeconds: "0" },
          lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 14 } }] },
          labels: { application: "bulk-image-generator" },
        });
      } catch (createError) {
        if (!(createError instanceof CloudError) || createError.status !== 409) throw createError;
        await this.json(`https://storage.googleapis.com/storage/v1/b/${bucket}`);
      }
    }
  }
  async upload(bucket: string, name: string, bytes: Buffer, mime: string) {
    await this.request(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(name)}`, {
      method: "POST", headers: { "Content-Type": mime }, body: new Uint8Array(bytes),
    });
    return `gs://${bucket}/${name}`;
  }
  async list(bucket: string, prefix: string) {
    const objects: { name: string }[] = [];
    let pageToken = "";
    do {
      const q = new URLSearchParams({ prefix, ...(pageToken ? { pageToken } : {}) });
      const page = await this.json<{ items?: { name: string }[]; nextPageToken?: string }>(`https://storage.googleapis.com/storage/v1/b/${bucket}/o?${q}`);
      objects.push(...(page.items ?? [])); pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return objects;
  }
  download(bucket: string, name: string) {
    return this.request(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}?alt=media`);
  }
  async recover(prefix: string) {
    let pageToken = "";
    do {
      const q = new URLSearchParams({ filter: `displayName="${prefix}"`, ...(pageToken ? { pageToken } : {}) });
      const result = await this.json<{ batchPredictionJobs?: CloudJob[]; nextPageToken?: string }>(`${this.parent}?${q}`);
      if (result.batchPredictionJobs?.length) return result.batchPredictionJobs[0];
      pageToken = result.nextPageToken ?? "";
    } while (pageToken);
    return undefined;
  }
  async submit(state: VertexBatchState) {
    return this.json<CloudJob>(this.parent, {
      displayName: state.prefix, model: `publishers/google/models/${VERTEX_BATCH_MODEL}`,
      inputConfig: { instancesFormat: "jsonl", gcsSource: { uris: [`gs://${state.bucket}/${state.prefix}/input.jsonl`] } },
      outputConfig: { predictionsFormat: "jsonl", gcsDestination: { outputUriPrefix: `gs://${state.bucket}/${state.prefix}/output/` } },
    });
  }
  get(name: string) { return this.json<CloudJob>(`https://aiplatform.googleapis.com/v1/${name}`); }
  cancel(name: string) { return this.json(`https://aiplatform.googleapis.com/v1/${name}:cancel`, {}); }
}

export function validateBatchInput(input: WorkInput, accountId: string) {
  const req = input.request as GenerateRequest;
  if (input.provider !== "vertex" || req.accountId !== accountId || req.model !== VERTEX_BATCH_MODEL) throw new Error("Batch supports only Gemini 3.1 Flash Lite Image on the selected Vertex account.");
  const prompt = [req.styleBible, req.prompt].filter(Boolean).join("\n\n");
  if (!prompt.trim() || prompt.length > 8000) throw new Error("Batch prompts must contain 1–8,000 characters including the style bible.");
  if (req.input?.image_size && req.input.image_size !== "1K") throw new Error("Image batch supports 1K resolution only.");
  const ratio = req.input?.aspect_ratio;
  if (ratio && !["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"].includes(String(ratio))) throw new Error("Unsupported batch aspect ratio.");
  if (!Array.isArray(req.referenceImages) || req.referenceImages.length > 14) throw new Error("Use at most 14 reference images per prompt.");
  for (const ref of req.referenceImages) {
    if (!ref || !["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"].includes(ref.mimeType)
      || typeof ref.base64 !== "string" || !ref.base64.length || ref.base64.length > Math.ceil(7 * 1024 ** 2 / 3) * 4
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(ref.base64)) throw new Error("Reference images must be valid images under 7 MB.");
  }
  return { req, prompt };
}

export interface BatchCallbacks {
  id: string; accountId: string; directory: string; indices: number[];
  attempts: VertexBatchState[]; signal: AbortSignal;
  save: () => Promise<void>;
  result: (index: number, result: GenerateResponse) => Promise<void>;
}
export async function runVertexImageBatch(options: BatchCallbacks) {
  const { id, directory, accountId, attempts, save, signal } = options;
  let state = attempts.at(-1);
  const readInput = async (index: number): Promise<WorkInput> => JSON.parse(await fs.readFile(path.join(directory, `input-${index}.json`), "utf8"));
  if (!state || state.terminal) {
    if (!options.indices.length) return;
    const account = await findVertexAccount(accountId);
    let estimateUsd = 0;
    for (const index of options.indices) {
      const { req, prompt } = validateBatchInput(await readInput(index), accountId);
      estimateUsd += VERTEX_BATCH_IMAGE_USD + batchInputEstimate(prompt, req.referenceImages.length);
    }
    const attempt = attempts.length;
    state = { attempt, indices: options.indices, account: { ...account },
      bucket: `bulk-images-${hash(account.projectId).slice(0, 24)}`, prefix: `batch-${id}-${attempt}`,
      hashes: {}, assigned: {}, imported: [], estimateUsd, state: "PREPARING" };
    attempts.push(state); await save();
  }
  const cloud = new VertexBatchCloud(state.account);
  const reservationId = `${id}:${state.attempt}`;
  if (!state.attempted) {
    try {
      signal.throwIfAborted();
      await cloud.ensureBucket(state.bucket);
      const uploaded = new Map<string, string>();
      const lines: string[] = [];
      state.hashes = {};
      for (const index of state.indices) {
        signal.throwIfAborted();
        const { req, prompt } = validateBatchInput(await readInput(index), accountId);
        const parts: Part[] = [];
        for (const ref of req.referenceImages) {
          const bytes = Buffer.from(ref.base64, "base64");
          const key = hash(bytes);
          let uri = uploaded.get(key);
          if (!uri) { uri = await cloud.upload(state.bucket, `${state.prefix}/references/${key}`, bytes, ref.mimeType); uploaded.set(key, uri); }
          parts.push({ text: ref.label || "Reference image" }, { fileData: { fileUri: uri, mimeType: ref.mimeType } });
        }
        parts.push({ text: prompt });
        const request: BatchRequest = { contents: [{ role: "user", parts }], generationConfig: {
          responseModalities: ["IMAGE"], imageConfig: { imageSize: "1K", ...(req.input?.aspect_ratio ? { aspectRatio: String(req.input.aspect_ratio) } : {}) },
        } };
        (state.hashes[batchRequestHash(request)] ??= []).push(index);
        lines.push(JSON.stringify({ request }));
      }
      await cloud.upload(state.bucket, `${state.prefix}/input.jsonl`, Buffer.from(lines.join("\n") + "\n"), "application/jsonl");
      signal.throwIfAborted();
      const release = guardSpend(state.account, state.estimateUsd);
      try { setBatchReservation(reservationId, accountId, state.estimateUsd); } finally { release(); }
      // Persist intent before POST. After ambiguous acceptance, only lookup/poll is safe.
      state.attempted = true; state.submittedAt = Date.now(); state.state = "SUBMITTING"; await save();
      try {
        const job = await cloud.submit(state);
        state.name = job.name; state.state = job.state; await save();
      } catch (error) {
        if (error instanceof CloudError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          state.terminal = true; state.state = "REJECTED"; state.error = error.message;
          setBatchReservation(reservationId, accountId, 0); await save();
          for (const index of state.indices) await options.result(index, { ok: false, error: `Google rejected the batch: ${error.message}`, retryable: false });
          return;
        }
        state.error = "Submission response was lost. Checking Google for the accepted job; no duplicate submission will be sent."; await save();
      }
    } catch (error) {
      if (!state.attempted) { state.terminal = true; state.state = signal.aborted ? "JOB_STATE_CANCELLED" : "REJECTED"; setBatchReservation(reservationId, accountId, 0); await save(); }
      throw error;
    }
  }
  if (!state.name) {
    const found = await cloud.recover(state.prefix);
    if (!found) throw new Error("Google's submission status is uncertain. Use Retry to check again without resubmitting. Review the batch in Google Cloud if it remains missing.");
    state.name = found.name; state.state = found.state; state.error = undefined; await save();
  }
  for (;;) {
    try {
      const job = await cloud.get(state.name);
      state.state = job.state; state.outputDirectory = job.outputInfo?.gcsOutputDirectory; state.error = job.error?.message;
      await save();
      if (["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED", "JOB_STATE_PARTIALLY_SUCCEEDED"].includes(job.state)) break;
      if (signal.aborted && !state.cancelSent) {
        await cloud.cancel(state.name); state.cancelSent = true; await save();
      }
    } catch (error) {
      state.error = `Waiting to reconnect to Google: ${error instanceof Error ? error.message : "Connection failed"}`;
      await save();
    }
    // Cancel wakes this wait, then polls until Google confirms termination.
    await delay(30_000, undefined, signal.aborted ? undefined : { signal }).catch(() => {});
  }
  // A terminal provider job can still contain completed rows after cancellation/failure.
  const prefix = state.outputDirectory?.replace(`gs://${state.bucket}/`, "") ?? `${state.prefix}/output/`;
  if (prefix.startsWith("gs://")) throw new Error("Google returned an unexpected batch output bucket.");
  const objects = await cloud.list(state.bucket, prefix);
  for (const object of objects.filter(item => item.name.endsWith(".jsonl"))) {
    const response = await cloud.download(state.bucket, object.name);
    if (!response.body) throw new Error("Batch output download is empty.");
    const reader = createInterface({ input: Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of reader) {
      const outputKey = `${object.name}:${lineNumber++}`;
      if (!line.trim()) continue;
      const row: OutputRow = JSON.parse(line);
      if (!row.request?.contents) throw new Error("Batch output is missing its original request; cannot safely match images to prompts.");
      const used = new Set(Object.values(state.assigned));
      const index = state.assigned[outputKey] ?? state.hashes[batchRequestHash(row.request)]?.find(index => !used.has(index));
      if (index === undefined) throw new Error("Batch output could not be matched to its original prompt.");
      if (state.imported.includes(index)) continue;
      state.assigned[outputKey] = index; await save();
      const candidate = row.response?.candidates?.[0];
      const parts = candidate?.content?.parts?.filter(part => !part.thought) ?? [];
      const image = parts.find(part => part.inlineData?.data || part.fileData?.mimeType?.startsWith("image/"));
      let result: GenerateResponse;
      if (image) {
        let bytes: Buffer; let mimeType: string;
        if (image.inlineData) { bytes = Buffer.from(image.inlineData.data, "base64"); mimeType = image.inlineData.mimeType; }
        else {
          const file = image.fileData!; const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(file.fileUri);
          if (!match || match[1] !== state.bucket) throw new Error("Unexpected image output location.");
          bytes = Buffer.from(await (await cloud.download(match[1], match[2])).arrayBuffer()); mimeType = file.mimeType;
        }
        const dimensions = readImageDimensions(bytes);
        if (!dimensions) throw new Error("Google returned an invalid image file.");
        result = { ok: true, taskId: state.name, credits: 0, images: [{ base64: bytes.toString("base64"), mimeType,
          width: dimensions.width, height: dimensions.height, resolution: `${dimensions.width}×${dimensions.height}`, sourceUrl: "" }] };
      } else {
        const error = typeof row.status === "string" ? row.status : row.status?.message;
        result = { ok: false, retryable: false, error: error || row.response?.promptFeedback?.blockReason || candidate?.finishReason || "Google returned no image for this prompt." };
      }
      const usage = row.response?.usageMetadata;
      if (usage || result.ok) {
        const imageTokens = usage?.candidatesTokensDetails?.filter(detail => detail.modality === "IMAGE").reduce((n, detail) => n + detail.tokenCount, 0);
        const outputTokens = usage?.candidatesTokenCount ?? 0;
        const imageCost = imageTokens !== undefined ? imageTokens * VERTEX_BATCH_IMAGE_PER_TOKEN : result.ok ? VERTEX_BATCH_IMAGE_USD : 0;
        const textTokens = Math.max(0, outputTokens - (imageTokens ?? (result.ok ? 1120 : 0))) + (usage?.thoughtsTokenCount ?? 0);
        const usd = imageCost + (usage?.promptTokenCount ?? 0) * VERTEX_BATCH_INPUT_PER_TOKEN + textTokens * VERTEX_BATCH_TEXT_PER_TOKEN;
        saveUsage({ at: state.submittedAt!, accountId, model: VERTEX_BATCH_MODEL, kind: "image", units: result.ok ? 1 : 0, usd, estimated: true }, false, `vertex-batch:${state.name}:${index}`);
      }
      await options.result(index, result);
      state.imported.push(index); await save();
    }
  }
  for (const index of state.indices) if (!state.imported.includes(index)) {
    await options.result(index, { ok: false, retryable: false, error: state.error || `Google batch ended with ${state.state}; no completed image for this prompt.` });
  }
  state.terminal = true; setBatchReservation(reservationId, accountId, 0); await save();
}
