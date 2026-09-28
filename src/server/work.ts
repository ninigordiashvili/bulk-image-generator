import { recordDownload } from "./downloadReceipts";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkInput, WorkItem, WorkResult, WorkStatus } from "@/types/work";
import { timing } from "@/types/work";
import { performWork, type Checkpoint } from "./workProvider";
import type { VertexBatchState } from "./vertexBatch";

export const WORK_ID = /^[a-f0-9-]{36}$/;
const ROOT = process.env.WORK_ROOT || path.join(os.tmpdir(), "bulk-generator-work");
interface RecordData {
  execution?: "standard" | "vertex-batch"; vertexBatches?: VertexBatchState[];
  id: string; kind: "image" | "video"; accountId: string; phase: WorkStatus["phase"];
  createdAt: number; startedAt?: number; finishedAt?: number; total: number; concurrency: number;
  jobs: WorkItem[]; checkpoints: Record<number, Checkpoint>; error?: string;
}
interface Live {
  data: RecordData; controller?: AbortController; running?: Promise<void>;
  writes: Promise<void>; upload: Promise<unknown>; deleting?: boolean;
}
const state = ((globalThis as { __backgroundWork?: { records: Map<string, Live>; ready?: Promise<void> } }).__backgroundWork
  ??= { records: new Map<string, Live>() });

export function workDir(id: string) {
  if (!WORK_ID.test(id)) throw new Error("Invalid batch ID.");
  return path.join(ROOT, id);
}
function write(live: Live) {
  const content = JSON.stringify(live.data);
  const operation = live.writes.catch(() => {}).then(async () => {
    const file = path.join(workDir(live.data.id), "status.json");
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, content);
    await fs.rename(temporary, file);
  });
  live.writes = operation;
  return operation;
}
async function ready() {
  state.ready ??= (async () => {
    await fs.mkdir(ROOT, { recursive: true });
    for (const id of await fs.readdir(ROOT)) {
      if (!WORK_ID.test(id) || state.records.has(id)) continue;
      try {
        const data: RecordData = JSON.parse(await fs.readFile(path.join(workDir(id), "status.json"), "utf8"));
        if (data.id !== id) continue;
        const live: Live = { data, writes: Promise.resolve(), upload: Promise.resolve() };
        if (["running", "cancelling"].includes(data.phase) && data.execution === "vertex-batch") {
          const cancelling = data.phase === "cancelling";
          data.phase = "interrupted";
          state.records.set(id, live);
          // Resume the saved provider job after initialization; never re-POST an uncertain submission.
          setTimeout(() => { void startWork(id, true).then(() => cancelling ? cancelWork(id) : undefined).catch(() => {}); }, 0);
        } else if (["running", "cancelling"].includes(data.phase)) {
          // A server restart is distinct from a browser refresh. Never silently
          // resubmit a billed operation whose acceptance is uncertain.
          data.phase = "interrupted";
          data.finishedAt = Date.now();
          data.error = "The app server restarted. Completed files are available; review before retrying unfinished items.";
          for (const job of data.jobs) if (["generating", "retrying", "queued"].includes(job.status)) {
            job.status = "error"; job.error = "Server restarted before this item was collected.";
          }
          await write(live);
        }
        state.records.set(id, live);
      } catch { /* Ignore incomplete creation directories, never start them. */ }
    }
  })();
  await state.ready;
}
async function get(id: string) {
  workDir(id);
  await ready();
  const live = state.records.get(id);
  if (!live || live.deleting) throw new Error("Batch not found.");
  return live;
}
export async function createWork(input: { id: string; kind: string; accountId: string; total: number; concurrency: number; execution?: "standard" | "vertex-batch" }) {
  await ready();
  workDir(input.id);
  if (!["image", "video"].includes(input.kind) || !input.accountId || input.accountId.length > 200
    || !Number.isInteger(input.total) || input.total < 1 || input.total > 10000) throw new Error("Invalid batch.");
  if (input.execution && !["standard", "vertex-batch"].includes(input.execution)) throw new Error("Invalid processing mode.");
  if (input.execution === "vertex-batch" && input.kind !== "image") throw new Error("Vertex batch mode supports images only.");
  const existing = state.records.get(input.id);
  if (existing) {
    if (existing.data.accountId !== input.accountId || existing.data.kind !== input.kind || existing.data.total !== input.total
      || (existing.data.execution ?? "standard") !== (input.execution ?? "standard")) throw new Error("Batch ID already used.");
    return snapshot(existing.data);
  }
  const live: Live = { data: { id: input.id, accountId: input.accountId, total: input.total, execution: input.execution,
    kind: input.kind as "image" | "video", phase: "uploading",
    concurrency: Math.max(1, Math.min(10, Math.floor(input.concurrency) || 1)),
    createdAt: Date.now(), jobs: [], checkpoints: {} }, writes: Promise.resolve(), upload: Promise.resolve() };
  state.records.set(input.id, live);
  try { await fs.mkdir(workDir(input.id), { recursive: true }); await write(live); }
  catch (error) { state.records.delete(input.id); throw error; }
  return snapshot(live.data);
}

export async function uploadWork(id: string, index: number, offset: number, total: number, bytes: Uint8Array) {
  const live = await get(id);
  const operation = live.upload.catch(() => {}).then(async () => {
    if (live.data.phase !== "uploading") throw new Error("This batch is no longer accepting uploads.");
    if (!Number.isInteger(index) || index < 0 || index >= live.data.total || !Number.isInteger(offset) || offset < 0
      || !Number.isInteger(total) || total < 1 || total > 128 * 1024 ** 2 || bytes.length > 2 * 1024 ** 2
      || !bytes.length || offset + bytes.length > total) throw new Error("Invalid upload chunk.");
    if (live.data.jobs[index]) return total;
    const temporary = path.join(workDir(id), `input-${index}.tmp`);
    const size = (await fs.stat(temporary).catch(() => null))?.size ?? 0;
    if (offset < size) return size; // Lost acknowledgement: do not append twice.
    if (offset !== size) throw new Error("Upload offset does not match.");
    await fs.appendFile(temporary, bytes);
    const received = offset + bytes.length;
    if (received === total) {
      const input: WorkInput = JSON.parse(await fs.readFile(temporary, "utf8"));
      if (!input.job || typeof input.job.id !== "string" || typeof input.job.prompt !== "string"
        || !["kie", "vertex", "heygen"].includes(input.provider) || !input.request || input.request.accountId !== live.data.accountId
        || !input.request.model) throw new Error("Invalid generation input.");
      if (live.data.jobs.some(job => job?.id === input.job.id)) throw new Error("Duplicate job ID.");
      if (live.data.execution === "vertex-batch") {
        const { validateBatchInput } = await import("./vertexBatch");
        validateBatchInput(input, live.data.accountId);
      }
      await fs.rename(temporary, path.join(workDir(id), `input-${index}.json`));
      const { job } = input;
      live.data.jobs[index] = { id: job.id, promptId: job.promptId, prompt: job.prompt,
        promptIndex: job.promptIndex, copyIndex: job.copyIndex, tag: job.tag,
        referencedCharacterIds: job.referencedCharacterIds ?? [], status: "queued", attempts: 0 };
      await write(live);
    }
    return received;
  });
  live.upload = operation;
  return operation;
}

function snapshot(data: RecordData): WorkStatus {
  const jobs = data.jobs.filter(Boolean).map(job => ({ ...job }));
  const succeeded = jobs.filter(job => job.status === "success").length;
  const failed = jobs.filter(job => ["error", "cancelled"].includes(job.status)).length;
  const completed = succeeded + failed;
  return { id: data.id, kind: data.kind, accountId: data.accountId, phase: data.phase,
    execution: data.execution, providerState: data.vertexBatches?.at(-1)?.state, providerJobName: data.vertexBatches?.at(-1)?.name,
    providerMessage: data.vertexBatches?.at(-1)?.error,
    createdAt: data.createdAt, startedAt: data.startedAt, finishedAt: data.finishedAt,
    total: data.total, uploaded: jobs.length, concurrency: data.concurrency, jobs, error: data.error,
    progress: { total: data.total, completed, succeeded, failed, inFlight: jobs.filter(job => ["generating", "retrying"].includes(job.status)).length },
    ...timing(data.startedAt, data.finishedAt, completed, data.total),
    ...(data.execution === "vertex-batch" && !data.finishedAt ? { remainingMs: null, estimatedFinishAt: null } : {}) };
}
export async function workStatus(id: string) { return snapshot((await get(id)).data); }
export async function listWork() { await ready(); return [...state.records.values()].map(live => snapshot(live.data)).sort((a, b) => b.createdAt - a.createdAt); }

export async function startWork(id: string, retry?: string | true) {
  const live = await get(id);
  await live.upload;
  if (live.deleting) throw new Error("Batch is being deleted.");
  if (live.data.phase === "cancelling") return snapshot(live.data);
  if (live.running && (live.data.phase !== "running" || live.data.jobs.every(job => ["success", "error", "cancelled"].includes(job.status)))) await live.running;
  if (live.running || live.data.phase === "running") {
    if (retry) {
      if (live.data.execution === "vertex-batch") return snapshot(live.data);
      for (const job of live.data.jobs) if (["error", "cancelled"].includes(job.status) && (retry === true || retry === job.id)) {
        job.status = "queued"; job.error = undefined; job.attempts = 0; job.finishedAt = undefined;
      }
      await write(live);
    }
    return snapshot(live.data);
  }
  if (!retry && live.data.phase !== "uploading") return snapshot(live.data);
  if (live.data.jobs.filter(Boolean).length !== live.data.total) throw new Error("Finish uploading all inputs before starting.");
  if (retry) {
    for (const job of live.data.jobs) if (["error", "cancelled"].includes(job.status) && (retry === true || retry === job.id)) {
      job.status = "queued"; job.error = undefined; job.attempts = 0; job.finishedAt = undefined;
    }
  }
  live.controller = new AbortController();
  live.data.phase = "running";
  live.data.startedAt ??= Date.now();
  live.data.finishedAt = undefined;
  live.data.error = undefined;
  // Claim synchronously, before persisting/returning, so duplicate Start requests cannot launch twice.
  const run = write(live).then(() => runBatch(live)).catch(async error => {
    live.data.phase = "interrupted";
    live.data.error = error instanceof Error ? error.message : "Batch failed.";
    live.data.finishedAt = Date.now();
    await write(live).catch(() => {});
  }).finally(() => { live.running = undefined; live.controller = undefined; });
  live.running = run;
  await live.writes;
  return snapshot(live.data);
}

async function runBatch(live: Live) {
  const { data } = live;
  const signal = live.controller!.signal;
  if (data.execution === "vertex-batch") {
    const { runVertexImageBatch } = await import("./vertexBatch");
    const pending = data.jobs.flatMap((job, index) => ["queued", "generating", "retrying"].includes(job.status) ? [index] : []);
    const existing = data.vertexBatches?.at(-1);
    const indices = existing && !existing.terminal ? existing.indices : pending;
    for (const index of indices) {
      const job = data.jobs[index];
      if (job.status !== "success") { job.status = "generating"; job.startedAt ??= Date.now(); job.error = undefined; }
    }
    await write(live);
    try {
      await runVertexImageBatch({ id: data.id, accountId: data.accountId, directory: workDir(data.id), indices,
        attempts: data.vertexBatches ??= [], signal, save: () => write(live),
        result: async (index, result) => {
          const job = data.jobs[index];
          if (result.ok) {
            const file = path.join(workDir(data.id), `result-${index}.json`);
            await fs.writeFile(`${file}.tmp`, JSON.stringify(result)); await fs.rename(`${file}.tmp`, file);
            const filename = (job.tag || `${job.promptIndex + 1}-${job.copyIndex + 1}`).replace(/[^\p{L}\p{N}_.-]/gu, "_").slice(0, 100);
            job.files = result.images.map((image, imageIndex) => ({ url: `/api/work/${data.id}/file?index=${index}&image=${imageIndex}`,
              mimeType: image.mimeType, name: `${filename}${imageIndex ? `-${imageIndex + 1}` : ""}.${image.mimeType.includes("jpeg") ? "jpg" : image.mimeType.includes("webp") ? "webp" : "png"}` }));
            job.status = "success"; job.error = undefined;
          } else { job.status = signal.aborted ? "cancelled" : "error"; job.error = result.error; }
          job.finishedAt = Date.now(); await write(live);
        } });
    } catch (error) {
      for (const index of indices) if (data.jobs[index].status !== "success") {
        data.jobs[index].status = "error"; data.jobs[index].error = error instanceof Error ? error.message : "Batch failed.";
      }
      throw error;
    }
    data.phase = signal.aborted ? "cancelled" : "done"; data.finishedAt = Date.now(); await write(live);
    return;
  }
  const worker = async () => {
    while (!signal.aborted) {
      const index = data.jobs.findIndex(job => job.status === "queued");
      if (index < 0) return;
      if (data.jobs.filter(job => ["generating", "retrying"].includes(job.status)).length >= data.concurrency) {
        await delay(250, undefined, { signal }).catch(() => {});
        continue;
      }
      const job = data.jobs[index];
      job.status = "generating";
      job.startedAt = Date.now();
      const checkpoint = (data.checkpoints[index] ??= {});
      try {
        await write(live);
        const input: WorkInput = JSON.parse(await fs.readFile(path.join(workDir(data.id), `input-${index}.json`), "utf8"));
        for (let attempt = 0; attempt < 2; attempt++) {
          signal.throwIfAborted();
          job.attempts = attempt;
          const result = await performWork(data.kind, input, `${data.id}-${index}`, checkpoint, () => write(live), signal);
          if (!result.ok) {
            if (!attempt) { job.status = "retrying"; job.error = result.error; await write(live); await delay(1500, undefined, { signal }); continue; }
            throw new Error(result.error);
          }
          const base = `/api/work/${data.id}/file?index=${index}`;
          let stored: WorkResult;
          const filename = (job.tag || `${job.promptIndex + 1}-${job.copyIndex + 1}`).replace(/[^\p{L}\p{N}_.-]/gu, "_").slice(0, 100);
          if ("video" in result) {
            const file = path.join(workDir(data.id), `video-${index}.bin`);
            await fs.writeFile(`${file}.tmp`, result.bytes);
            await fs.rename(`${file}.tmp`, file);
            const { bytes: _bytes, ...metadata } = result;
            void _bytes;
            stored = { ...metadata, url: base };
            job.files = [{ url: base, mimeType: result.mimeType, name: `${filename}.${result.mimeType.includes("webm") ? "webm" : "mp4"}` }];
          } else {
            stored = result;
            job.files = result.images.map((image, imageIndex) => ({ url: `${base}&image=${imageIndex}`,
              mimeType: image.mimeType, name: `${filename}${result.images.length > 1 ? `-${imageIndex + 1}` : ""}.${image.mimeType.includes("jpeg") ? "jpg" : image.mimeType.includes("webp") ? "webp" : "png"}` }));
          }
          const resultFile = path.join(workDir(data.id), `result-${index}.json`);
          await fs.writeFile(`${resultFile}.tmp`, JSON.stringify(stored));
          await fs.rename(`${resultFile}.tmp`, resultFile);
          job.status = "success";
          job.error = undefined;
          break;
        }
      } catch (error) {
        job.status = signal.aborted ? "cancelled" : "error";
        job.error = signal.aborted ? "Cancelled." : error instanceof Error ? error.message : "Generation failed.";
      }
      job.finishedAt = Date.now();
      await write(live);
    }
  };
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(10, data.total) },
    () => worker().catch(error => { live.controller?.abort(); throw error; })));
  const failedWorker = outcomes.find(outcome => outcome.status === "rejected");
  if (failedWorker?.status === "rejected") throw failedWorker.reason;
  for (const job of data.jobs) if (job.status === "queued") { job.status = "cancelled"; job.error = "Cancelled."; }
  data.phase = signal.aborted ? "cancelled" : "done";
  data.finishedAt = Date.now();
  await write(live);
}
export async function cancelWork(id: string) {
  const live = await get(id);
  if (live.data.execution === "vertex-batch" && live.data.phase === "interrupted" && live.data.vertexBatches?.some(batch => batch.attempted && !batch.terminal)) {
    await startWork(id, true);
  }
  if (["done", "cancelled", "interrupted"].includes(live.data.phase)) return snapshot(live.data);
  live.controller?.abort();
  live.data.phase = live.running ? "cancelling" : "cancelled";
  if (!live.running) live.data.finishedAt = Date.now();
  await write(live);
  return snapshot(live.data);
}
export async function setWorkConcurrency(id: string, concurrency: number) {
  const live = await get(id);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error("Concurrency must be between 1 and 10.");
  live.data.concurrency = concurrency;
  await write(live);
  return snapshot(live.data);
}
export async function workResult(id: string, index: number): Promise<WorkResult> {
  const live = await get(id);
  if (!Number.isInteger(index) || index < 0 || live.data.jobs[index]?.status !== "success") throw new Error("This result is not ready.");
  return JSON.parse(await fs.readFile(path.join(workDir(id), `result-${index}.json`), "utf8"));
}

/** Remove settled history without cancelling any workers. */
export async function deleteWorkHistory(id: string) {
  const live = await get(id);
  if (live.data.vertexBatches?.some(batch => batch.attempted && !batch.terminal)) throw new Error("Google may still be processing this batch. Resume checking it before deleting its saved job ID.");
  if (live.running || live.controller || !["done", "cancelled", "interrupted"].includes(live.data.phase)) {
    throw new Error("This batch is still active. Wait until it finishes before deleting it.");
  }
  live.deleting = true;
  try {
    // Wait for outstanding I/O, but failed uploads/writes must not prevent cleanup.
    await Promise.allSettled([live.upload, live.writes]);
    const target = path.resolve(workDir(id));
    if (path.dirname(target) !== path.resolve(ROOT)) throw new Error("Invalid batch directory.");
    await fs.rm(target, { recursive: true, force: true });
    state.records.delete(id);
  } catch (error) { live.deleting = false; throw error; }
}

export async function recordWorkDownload(id: string, index: number, image = 0) {
  const live = await get(id);
  const item = live.data.jobs[index];
  if (!Number.isInteger(index) || !Number.isInteger(image) || image < 0
    || item?.status !== "success" || !item.files?.[image]) throw new Error("File not found.");
  await recordDownload(workDir(id), `${index}:${image}`, item.finishedAt ?? live.data.createdAt);
}

/** Check again immediately before a synchronous account edit, including new uploads. */
export async function withIdleAccount<T>(provider: string, accountId: string, edit: () => T): Promise<T> {
  await ready();
  const known = new Map<Live, string>();
  for (const live of state.records.values()) {
    if (live.data.accountId !== accountId) continue;
    const first = live.data.jobs.findIndex(Boolean);
    if (first < 0) continue;
    try {
      const input: WorkInput = JSON.parse(await fs.readFile(path.join(workDir(live.data.id), `input-${first}.json`), "utf8"));
      known.set(live, input.provider);
    } catch { /* Unknown provider is protected until its input can be read. */ }
  }
  for (const live of state.records.values()) {
    if (live.data.accountId !== accountId || (known.has(live) && known.get(live) !== provider)) continue;
    if (live.running || live.controller || ["uploading", "running", "cancelling"].includes(live.data.phase)
      || live.data.vertexBatches?.some(batch => batch.attempted && !batch.terminal)) {
      throw new Error("This account has active work. Wait until it finishes before removing it.");
    }
  }
  // No await between the guard and the edit: another request cannot start work here.
  return edit();
}
