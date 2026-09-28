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
      /** Provider hint; every failed prompt still gets one automatic retry. */
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
  ) { this.options.retries = 1; }

  on<K extends keyof QueueEventMap>(event: K, listener: Listener<K>): () => void {
    this.listeners[event].add(listener);
    return () => {
      this.listeners[event].delete(listener);
    };
  }

  protected emit<K extends keyof QueueEventMap>(event: K, payload: QueueEventMap[K]) {
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
   * Re-queues failed and cancelled prompts; completed prompts stay untouched.
   */
  retryFailed() {
    if (this.state === "cancelling") return;
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
    if (job.status !== "error" && job.status !== "cancelled") return;
    if (this.state === "cancelling") return;
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
    const controller = this.controller!;
    const signal = controller.signal;
    try {
      const job = this.jobs.get(jobId)!;
      let result: JobResult;
      try { result = await this.options.runJob(job, signal); }
      catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : "Unexpected error." };
      }
      if (controller !== this.controller) return;
      if (signal.aborted) {
        this.updateJob(jobId, { status: "cancelled", error: "Cancelled." });
      } else if (result.ok) {
        this.updateJob(jobId, { status: "success", error: undefined, resolutionMismatch: result.resolutionMismatch });
      } else if (job.attempts < this.options.retries) {
        this.updateJob(jobId, { status: "retrying", attempts: 1, error: result.error });
        await delay(RETRY_BASE_DELAY_MS, signal);
        if (controller !== this.controller) return;
        if (signal.aborted) this.updateJob(jobId, { status: "cancelled", error: "Cancelled." });
        else {
          this.updateJob(jobId, { status: "queued" });
          this.pending.unshift(jobId);
        }
      } else {
        this.updateJob(jobId, { status: "error", error: result.error, terminal: false });
      }
    } finally {
      if (controller === this.controller) {
        this.inFlight--;
        this.emitProgress();
        this.pump();
      }
    }
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
