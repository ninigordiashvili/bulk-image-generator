import { GenerationQueue, type JobResult } from "./GenerationQueue";
import type { GenerationJob, QueueState } from "@/types";
import type { WorkInput, WorkResult, WorkStatus } from "@/types/work";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// randomUUID is unavailable on plain-HTTP LAN origins; getRandomValues works there.
export function newBatchId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const value = await response.json();
  if (!response.ok || value.ok === false) throw new Error(value.error || `Request failed (${response.status}).`);
  return value;
}

/** The browser submits inputs and observes; it never owns provider execution. */
export class BackgroundQueue extends GenerationQueue {
  private id = newBatchId();
  private imported = new Set<string>();
  private stateValue: QueueState = "idle";
  private stopped = false;
  private accepted = false;
  private observer?: Promise<void>;
  private currentJobs: GenerationJob[] = [];
  constructor(private background: {
    execution?: "standard" | "vertex-batch";
    kind: "image" | "video"; accountId: string; concurrency: number;
    prepare: (job: GenerationJob) => Promise<WorkInput>;
    collect: (job: GenerationJob, result: WorkResult, origin: { workId: string; workIndex: number }) => Promise<JobResult>;
    onStatus: (status: WorkStatus) => void;
  }) { super({ concurrency: 1, retries: 1, runJob: async () => ({ ok: true }) }); }

  getState() { return this.stateValue; }
  getJobs() { return this.currentJobs; }
  private stateChanged(state: QueueState) { this.stateValue = state; this.emit("queue:state", state); }
  start(jobs: GenerationJob[]) {
    this.currentJobs = jobs;
    this.stateChanged("running");
    void this.submit(jobs).catch(error => {
      this.emit("queue:halted", `Inputs could not be saved: ${error instanceof Error ? error.message : "Upload failed."} Open Activity to check this batch before retrying.`);
      this.stateChanged("done");
    });
  }
  private async submit(jobs: GenerationJob[]) {
    const created = await json("/api/work", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: this.id, kind: this.background.kind, execution: this.background.execution, accountId: this.background.accountId, concurrency: this.background.concurrency, total: jobs.length }) });
    this.background.onStatus(created.status);
    this.accepted = true;
    if (this.stopped) {
      await json(`/api/work/${this.id}`, { method: "DELETE" });
      this.stateChanged("done");
      return;
    }
    for (let index = 0; index < jobs.length; index++) {
      if (this.stopped) return;
      const input = await this.background.prepare(jobs[index]);
      const bytes = new TextEncoder().encode(JSON.stringify(input));
      let offset = 0;
      while (offset < bytes.length) {
        if (this.stopped) return;
        const chunk = bytes.slice(offset, offset + 2 * 1024 ** 2);
        const url = `/api/work/${this.id}?index=${index}&offset=${offset}&total=${bytes.length}`;
        let result;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { result = await json(url, { method: "PUT", body: chunk }); break; }
          catch (error) { if (attempt === 2) throw error; await pause(1000); }
        }
        if (!result || result.received <= offset) throw new Error("Upload made no progress.");
        offset = result.received;
      }
      this.background.onStatus({ ...created.status, uploaded: index + 1 });
    }
    if (this.stopped) return;
    // Start is idempotent. If the response is lost, observing recovers the accepted batch.
    try { await json(`/api/work/${this.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); }
    catch { /* The polling loop checks whether Start was accepted. */ }
    this.observe();
  }
  private observe() {
    if (this.observer) return;
    this.observer = this.poll().finally(() => { this.observer = undefined; });
  }
  private async poll() {
    for (;;) {
      try {
        const { status }: { status: WorkStatus } = await json(`/api/work/${this.id}`);
        if (status.phase === "uploading" && status.uploaded === status.total && !this.stopped) {
          await json(`/api/work/${this.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          continue;
        }
        this.background.onStatus(status);
        this.currentJobs = status.jobs;
        for (const job of status.jobs) {
          this.emit("job:update", job);
          if (job.status === "success" && !this.imported.has(job.id)) {
            const result: WorkResult = await json(`/api/work/${this.id}?result=${status.jobs.indexOf(job)}`);
            const collected = await this.background.collect(job, result, { workId: this.id, workIndex: status.jobs.indexOf(job) });
            if (collected.ok) this.imported.add(job.id);
            else throw new Error(collected.error);
          }
        }
        this.emit("queue:progress", status.progress);
        if (["done", "cancelled", "interrupted"].includes(status.phase)) {
          if (status.error) this.emit("queue:halted", status.error);
          this.stateChanged("done");
          return;
        }
        this.stateChanged(status.phase === "cancelling" ? "cancelling" : "running");
      } catch { /* Reconnect indefinitely; a network failure must never cancel server work. */ }
      await pause(2000);
    }
  }
  cancel() {
    this.stopped = true;
    this.stateChanged("cancelling");
    void json(`/api/work/${this.id}`, { method: "DELETE" }).then(() => this.observe()).catch(() => {
      this.emit("queue:halted", "Cancel could not reach the server. Open Activity and retry Cancel.");
      this.observe();
    });
  }
  retryJob(id: string) { this.retry(id); }
  retryFailed() { this.retry(true); }
  private retry(retry: string | true) {
    this.stopped = false;
    void json(`/api/work/${this.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ retry }) })
      .then(() => { this.stateChanged("running"); this.observe(); })
      .catch(error => this.emit("queue:halted", error.message));
  }
  setConcurrency(concurrency: number) {
    this.background.concurrency = concurrency;
    if (this.accepted && this.stateValue === "running") {
      void json(`/api/work/${this.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ concurrency }) })
        .catch(error => this.emit("queue:halted", error.message));
    }
  }
}
