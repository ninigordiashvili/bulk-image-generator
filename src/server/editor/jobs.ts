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
const ROOT = path.join(os.tmpdir(), "bulk-generator-editor");

/** Jobs older than this are swept when a new one is created. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

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

export async function createJob(): Promise<Job> {
  await sweep();
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
  const job = getJob(id);
  if (!job) return;
  cancelJob(job);
  registry.delete(id);
  await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Drops stale job directories. Renders write hundreds of megabytes of
 * intermediates, and a tab closed mid-export would otherwise leave them behind
 * until the OS got round to clearing its temp dir.
 */
async function sweep(): Promise<void> {
  const cutoff = Date.now() - MAX_AGE_MS;

  for (const [id, job] of registry) {
    if (job.createdAt < cutoff && !job.controller) {
      registry.delete(id);
      await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const entries = await fs.readdir(ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || registry.has(entry.name)) continue;
    const dir = path.join(ROOT, entry.name);
    const stat = await fs.stat(dir).catch(() => null);
    // Orphans from a previous server process: nothing is tracking them, so age
    // is the only signal, and anything old enough is safe to remove.
    if (stat && stat.mtimeMs < cutoff) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
