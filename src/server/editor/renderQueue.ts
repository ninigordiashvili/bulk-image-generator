/** One local export at a time, shared across route reloads. */
interface RenderQueue {
  active: boolean;
  waiting: (() => void)[];
}
const queue = ((globalThis as { __localRenderQueue?: RenderQueue }).__localRenderQueue ??= {
  active: false,
  waiting: [],
});

/** Cancellation removes a waiting export without interrupting the active one. */
export function acquireRender(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      const index = queue.waiting.indexOf(start);
      if (index >= 0) queue.waiting.splice(index, 1);
      reject(new Error("Cancelled."));
    };
    const start = () => {
      signal.removeEventListener("abort", cancelled);
      queue.active = true;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        queue.active = false;
        queue.waiting.shift()?.();
      });
    };
    if (signal.aborted) {
      reject(new Error("Cancelled."));
      return;
    }
    if (!queue.active) start();
    else {
      queue.waiting.push(start);
      signal.addEventListener("abort", cancelled, { once: true });
    }
  });
}

/** Cleanup never queues behind or interrupts an export, but excludes new renders while deleting cache. */
export function tryAcquireRenderMaintenance(): (() => void) | null {
  if (queue.active || queue.waiting.length) return null;
  queue.active = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    queue.active = false;
    queue.waiting.shift()?.();
  };
}
