import type {
  GenerationJob,
  QueueProgress,
  QueueState,
} from "@/types";

export type JobResult =
  | { ok: true; resolutionMismatch?: boolean }
  | {
      ok: false;
      error: string;
      /**
       * `false` means the failure is terminal — config, auth or tier problems
       * that are identical on every attempt. The queue skips backoff entirely
       * rather than burning the retry budget on a guaranteed failure. Absent or
       * `true` retries as normal. A manual Retry still works either way.
       */
      retryable?: boolean;
    };

export type JobRunner = (
  job: GenerationJob,
  signal: AbortSignal
) => Promise<JobResult>;

interface QueueEventMap {
  "job:update": GenerationJob;
  "queue:state": QueueState;
  "queue:progress": QueueProgress;
  /** A whole-batch failure stopped the run. Payload is the originating error. */
  "queue:halted": string;
}

type Listener<K extends keyof QueueEventMap> = (payload: QueueEventMap[K]) => void;

const RETRY_BASE_DELAY_MS = 1200;

/**
 * Concurrency-limited runner over a fixed job list. Jobs are marked `generating`
 * synchronously before their async call so the in-flight count can never be
 * double-counted by a re-entrant pump.
 */
export class GenerationQueue {
  private jobs = new Map<string, GenerationJob>();
  private pending: string[] = [];
  private inFlight = 0;
  private state: QueueState = "idle";
  private controller: AbortController | null = null;
  private listeners: {
    [K in keyof QueueEventMap]: Set<Listener<K>>;
  } = {
    "job:update": new Set(),
    "queue:state": new Set(),
    "queue:progress": new Set(),
    "queue:halted": new Set(),
  };

  /** Set once a terminal failure has stopped the batch; cleared on start/retry. */
  private haltReason: string | null = null;

  constructor(
    private options: {
      concurrency: number;
      retries: number;
      runJob: JobRunner;
    }
  ) {}

  on<K extends keyof QueueEventMap>(event: K, listener: Listener<K>): () => void {
    this.listeners[event].add(listener);
    return () => {
      this.listeners[event].delete(listener);
    };
  }

  private emit<K extends keyof QueueEventMap>(event: K, payload: QueueEventMap[K]) {
    for (const listener of this.listeners[event]) {
      (listener as Listener<K>)(payload);
    }
  }

  getState(): QueueState {
    return this.state;
  }

  getJobs(): GenerationJob[] {
    return [...this.jobs.values()];
  }

  getProgress(): QueueProgress {
    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "success") {
        succeeded++;
        completed++;
      } else if (job.status === "error" || job.status === "cancelled") {
        failed++;
        completed++;
      }
    }
    return {
      total: this.jobs.size,
      completed,
      succeeded,
      failed,
      inFlight: this.inFlight,
    };
  }

  /** Replaces any previous run. Jobs must arrive in `queued` state. */
  start(jobs: GenerationJob[]) {
    this.controller?.abort();
    this.jobs = new Map(jobs.map((job) => [job.id, { ...job }]));
    this.pending = jobs.map((job) => job.id);
    this.inFlight = 0;
    this.haltReason = null;
    this.controller = new AbortController();
    this.setState(jobs.length > 0 ? "running" : "done");
    this.emitProgress();
    this.pump();
  }

  cancel() {
    if (this.state !== "running") return;
    this.setState("cancelling");
    this.controller?.abort();
    this.pending = [];
    for (const job of this.jobs.values()) {
      if (job.status === "queued" || job.status === "retrying") {
        this.updateJob(job.id, { status: "cancelled", error: "Cancelled." });
      }
    }
    this.settleIfDone();
  }

  /**
   * Re-queues every failed and cancelled job. This is the counterpart to `halt`:
   * once the underlying cause is fixed, one action resumes the whole batch
   * instead of making the user click Retry on each of 150 rows.
   */
  retryFailed() {
    const retryable = [...this.jobs.values()].filter(
      (job) => job.status === "error" || job.status === "cancelled"
    );
    if (retryable.length === 0) return;

    this.haltReason = null;
    if (!this.controller || this.controller.signal.aborted) {
      this.controller = new AbortController();
    }
    for (const job of retryable) {
      this.updateJob(job.id, {
        status: "queued",
        attempts: 0,
        error: undefined,
        terminal: undefined,
      });
      this.pending.push(job.id);
    }
    this.setState("running");
    this.emitProgress();
    this.pump();
  }

  /** Re-runs a single finished-but-failed job without touching the rest. */
  retryJob(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (job.status === "generating" || job.status === "retrying") return;
    if (!this.controller || this.controller.signal.aborted) {
      this.controller = new AbortController();
    }
    // A single manual retry also lifts the halt — the user is asserting the
    // cause is fixed, and a fresh terminal failure will simply halt again.
    this.haltReason = null;
    // A manual retry is always allowed — the user may have just fixed the config
    // that made this terminal in the first place.
    this.updateJob(jobId, {
      status: "queued",
      attempts: 0,
      error: undefined,
      terminal: undefined,
    });
    this.pending.push(jobId);
    if (this.state !== "running") this.setState("running");
    this.emitProgress();
    this.pump();
  }

  setConcurrency(concurrency: number) {
    this.options.concurrency = concurrency;
    this.pump();
  }

  setRetries(retries: number) {
    this.options.retries = retries;
  }

  private setState(state: QueueState) {
    if (this.state === state) return;
    this.state = state;
    this.emit("queue:state", state);
  }

  private updateJob(jobId: string, patch: Partial<GenerationJob>) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const next = { ...job, ...patch };
    this.jobs.set(jobId, next);
    this.emit("job:update", next);
  }

  private emitProgress() {
    this.emit("queue:progress", this.getProgress());
  }

  private pump() {
    while (
      this.state === "running" &&
      this.inFlight < this.options.concurrency &&
      this.pending.length > 0
    ) {
      const jobId = this.pending.shift()!;
      const job = this.jobs.get(jobId);
      if (!job || job.status === "cancelled") continue;
      // Claim the slot synchronously, before any await.
      this.inFlight++;
      this.updateJob(jobId, { status: "generating" });
      this.emitProgress();
      void this.run(jobId);
    }
    this.settleIfDone();
  }

  private async run(jobId: string) {
    const signal = this.controller!.signal;
    try {
      const job = this.jobs.get(jobId)!;
      const result = await this.options.runJob(job, signal);

      if (signal.aborted) {
        this.updateJob(jobId, { status: "cancelled", error: "Cancelled." });
        return;
      }

      if (result.ok) {
        this.updateJob(jobId, {
          status: "success",
          error: undefined,
          resolutionMismatch: result.resolutionMismatch,
        });
        return;
      }

      const attempts = (this.jobs.get(jobId)?.attempts ?? 0) + 1;
      if (result.retryable !== false && attempts <= this.options.retries) {
        this.updateJob(jobId, {
          status: "retrying",
          attempts,
          error: result.error,
        });
        // Linear backoff: 1.2s, 2.4s, 3.6s, ...
        await delay(RETRY_BASE_DELAY_MS * attempts, signal);
        if (signal.aborted) {
          this.updateJob(jobId, { status: "cancelled", error: "Cancelled." });
          return;
        }
        this.updateJob(jobId, { status: "queued" });
        this.pending.unshift(jobId);
        return;
      }

      const terminal = result.retryable === false;
      this.updateJob(jobId, {
        status: "error",
        attempts,
        error: result.error,
        terminal,
      });

      // Terminal failures are config, auth, billing or model-availability
      // problems — every remaining job shares the same account and settings, so
      // they would all fail the same way. Stop rather than grinding through them.
      if (terminal) this.halt(result.error);
    } catch (error) {
      this.updateJob(jobId, {
        status: "error",
        error: error instanceof Error ? error.message : "Unexpected error.",
      });
    } finally {
      this.inFlight--;
      this.emitProgress();
      this.pump();
    }
  }

  /**
   * Drops every queued job because the batch as a whole can't succeed. In-flight
   * calls are left to finish — they're already paid for, and one of them may well
   * come back with an image.
   */
  private halt(reason: string) {
    if (this.haltReason) return;
    this.haltReason = reason;

    for (const jobId of this.pending) {
      const job = this.jobs.get(jobId);
      if (!job || job.status !== "queued") continue;
      this.updateJob(jobId, {
        status: "cancelled",
        error:
          "Stopped — an earlier job failed for a reason that affects the whole batch. Fix the cause, then Retry.",
      });
    }
    this.pending = [];

    this.emit("queue:halted", reason);
    this.emitProgress();
    this.settleIfDone();
  }

  getHaltReason(): string | null {
    return this.haltReason;
  }

  private settleIfDone() {
    if (this.state === "idle" || this.state === "done") return;
    if (this.inFlight === 0 && this.pending.length === 0) {
      this.setState("done");
      this.emitProgress();
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
