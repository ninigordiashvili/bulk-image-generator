import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobPhase, JobStatus } from "@/types/editor";

export interface Job {
  id: string;
  dir: string;
  createdAt: number;
  startedAt: number;
  status: JobStatus;
  /** Set while a render is in flight; aborting it kills the ffmpeg children. */
  controller: AbortController | null;
  /**
   * Distinguishes the two reasons a render can be aborted. A failing segment
   * also aborts its siblings, so the signal alone can't say whether the user
   * asked to stop or something went wrong.
   */
  cancelRequested: boolean;
  /** Next image index, so uploads get collision-free names on the server. */
  nextImage: number;
  /** The same for voice tracks waiting to be joined into a bed. */
  nextVoice: number;
}

/** Uploads and intermediates are scratch — they live in the OS temp dir. */
const ROOT = process.env.EDITOR_WORK_ROOT || path.join(os.tmpdir(), "bulk-generator-editor");


/**
 * Held on globalThis rather than in a module-level const: the dev server
 * re-evaluates route modules on edit, and a job map that resets mid-render
 * would strand a running ffmpeg with nothing tracking it.
 */
const registry: Map<string, Job> = ((
  globalThis as { __editorJobs?: Map<string, Job> }
).__editorJobs ??= new Map());

export const JOB_ID = /^[0-9a-f]{16}$/;

export function jobRoot(): string {
  return ROOT;
}

export function getJob(id: string): Job | undefined {
  return JOB_ID.test(id) ? registry.get(id) : undefined;
}

/** Shared activity view, including exports whose browser has gone away. */
export function listJobs(): Job[] {
  return [...registry.values()].filter(job => job.startedAt > 0);
}

export async function createJob(): Promise<Job> {
  const id = randomBytes(8).toString("hex");
  const dir = path.join(ROOT, id);
  await fs.mkdir(path.join(dir, "images"), { recursive: true });
  await fs.mkdir(path.join(dir, "segments"), { recursive: true });

  const job: Job = {
    id,
    dir,
    createdAt: Date.now(),
    startedAt: 0,
    controller: null,
    cancelRequested: false,
    nextImage: 0,
    nextVoice: 0,
    status: {
      id,
      phase: "new",
      done: 0,
      total: 0,
      message: "Waiting for files.",
      error: null,
      outputBytes: 0,
      elapsedMs: 0,
    },
  };
  registry.set(id, job);
  return job;
}

export function setPhase(job: Job, phase: JobPhase, message: string) {
  job.status.phase = phase;
  job.status.message = message;
  job.status.elapsedMs = job.startedAt ? Date.now() - job.startedAt : 0;
}

export function snapshot(job: Job): JobStatus {
  return {
    ...job.status,
    elapsedMs: job.startedAt
      ? (job.status.phase === "done" ||
        job.status.phase === "error" ||
        job.status.phase === "cancelled"
          ? job.status.elapsedMs
          : Date.now() - job.startedAt)
      : 0,
  };
}

export function outputPath(job: Job): string {
  return path.join(job.dir, "output.mp4");
}

/**
 * Resolves a client-supplied basename inside one of the job's directories.
 * Returns null for anything that escapes it — the names come from our own
 * upload responses, but they arrive back over the wire, so they get checked.
 */
export function resolveInside(
  job: Job,
  sub: "images" | "",
  name: string
): string | null {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return null;
  }
  const base = sub ? path.join(job.dir, sub) : job.dir;
  const full = path.resolve(base, name);
  const prefix = path.resolve(base) + path.sep;
  return full.startsWith(prefix) ? full : null;
}

export function cancelJob(job: Job): void {
  job.cancelRequested = true;
  job.controller?.abort();
}

export async function discardJob(id: string): Promise<void> {
  if (!JOB_ID.test(id)) return;
  const job = getJob(id);
  if (job) {
    cancelJob(job);
    registry.delete(id);
  }
  // Removed by id rather than through the job, because the two can come apart:
  // a server reload empties the registry and leaves the directory, and the tab
  // that made it is the only thing that will ever ask for it to go. Skipping
  // the removal there left hundreds of megabytes of scratch behind until the
  // user explicitly discarded it.
  await fs.rm(path.join(ROOT, id), { recursive: true, force: true }).catch(() => {});
}

/** Activity deletion must never abort an export. */
export async function deleteJobHistory(id: string): Promise<void> {
  const job = getJob(id);
  if (!job) throw new Error("Export not found.");
  if (job.controller || !["done", "error", "cancelled"].includes(job.status.phase)) {
    throw new Error("This export is still active. Wait until it finishes before deleting it.");
  }
  const target = path.resolve(ROOT, id);
  if (path.dirname(target) !== path.resolve(ROOT)) throw new Error("Invalid export directory.");
  registry.delete(id);
  try { await fs.rm(target, { recursive: true, force: true }); }
  catch (error) { registry.set(id, job); throw error; }
}
