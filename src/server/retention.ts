import { tryAcquireRenderMaintenance } from "./editor/renderQueue";
import { promises as fs } from "node:fs";
import path from "node:path";
import { downloadExpired } from "@/lib/retention";
import { readDownloads } from "./downloadReceipts";
import { listWork, workDir, deleteWorkHistory } from "./work";
import { JOB_ID, jobRoot, getJob, listJobs, deleteJobHistory } from "./editor/jobs";
import { SegmentCache } from "./editor/segmentCache";

const scheduler = ((globalThis as { __retention?: {
  timer?: ReturnType<typeof setInterval>; running?: Promise<void>; last?: number; sweep?: () => Promise<void>;
} }).__retention ??= {});

export async function cleanupSavedFiles(now = Date.now()) {
  // A hot update must never interfere with a render using uploaded media/cache.
  if (listJobs().some(job => job.controller || ["preparing", "rendering", "muxing"].includes(job.status.phase))) return;
  const release = tryAcquireRenderMaintenance();
  if (!release) return;
  try {
    for (const batch of await listWork()) {
      if (!["done", "cancelled", "interrupted"].includes(batch.phase)) continue;
      const receipts = await readDownloads(workDir(batch.id));
      const files = batch.jobs.flatMap((job, index) => (job.files ?? []).map((_, image) => ({
        at: receipts[`${index}:${image}`], finishedAt: job.finishedAt ?? batch.createdAt,
      })));
      // Never delete uncollected results or infer downloads for historical work.
      if (files.length && files.every(file => file.at >= file.finishedAt && downloadExpired(file.at, now))) {
        await deleteWorkHistory(batch.id);
      }
    }
    const root = path.resolve(jobRoot());
    for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !JOB_ID.test(entry.name)) continue;
      const dir = path.resolve(root, entry.name);
      if (path.dirname(dir) !== root) continue;
      const receipts = await readDownloads(dir);
      const job = getJob(entry.name);
      if (!downloadExpired(receipts.output, now)) continue;
      if (job) {
        if (job.controller || job.status.phase !== "done" || receipts.output < job.startedAt) continue;
        await deleteJobHistory(job.id);
      } else {
        // Receipt is durable even when the in-memory editor registry was restarted.
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
    const cache = new SegmentCache();
    await cache.prepare();
  } finally { release(); }
}

/** Activity boots the timer in the current process without restarting the server. */
export function startRetention() {
  scheduler.sweep = () => cleanupSavedFiles();
  const tick = () => {
    if (scheduler.running || Date.now() - (scheduler.last ?? 0) < 60_000) return;
    scheduler.last = Date.now();
    scheduler.running = scheduler.sweep!().catch(error => console.error("Saved-file cleanup failed", error))
      .finally(() => { scheduler.running = undefined; });
  };
  if (!scheduler.timer) { scheduler.timer = setInterval(tick, 60_000); scheduler.timer.unref(); }
  tick();
}
