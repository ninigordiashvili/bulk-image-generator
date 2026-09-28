import type { GenerationJob, GenerateRequest, GenerateResponse, VideoProvider, QueueProgress, VideoStartRequest } from "@/types";

export interface WorkInput {
  job: GenerationJob;
  provider: VideoProvider;
  request: GenerateRequest | VideoStartRequest;
}
export type WorkResult = GenerateResponse | {
  ok: true; video: true; url: string; mimeType: string; credits: number;
  taskId: string; sourceUrl: string; actualResolution?: string;
};
export interface WorkFile { url: string; name: string; mimeType: string }
export interface WorkItem extends GenerationJob {
  startedAt?: number;
  finishedAt?: number;
  files?: WorkFile[];
}
export interface WorkStatus {
  execution?: "standard" | "vertex-batch";
  providerState?: string;
  providerJobName?: string;
  providerMessage?: string;
  id: string;
  kind: "image" | "video";
  accountId: string;
  phase: "uploading" | "running" | "cancelling" | "done" | "cancelled" | "interrupted";
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  elapsedMs: number;
  remainingMs: number | null;
  estimatedFinishAt: number | null;
  total: number;
  uploaded: number;
  concurrency: number;
  jobs: WorkItem[];
  progress: QueueProgress;
  error?: string;
}
export interface ActivityEntry {
  id: string; kind: "image" | "video" | "render";
  label: string; phase: string; done: number; total: number;
  elapsedMs: number; remainingMs: number | null; createdAt: number;
  href: string; outputUrl?: string; error?: string;
  succeeded?: number; failed?: number;
}

/** Throughput estimate, including queue/rate-limit waits; never a promise. */
export function timing(startedAt: number | undefined, finishedAt: number | undefined, completed: number, total: number, now = Date.now()) {
  const elapsedMs = startedAt ? Math.max(0, (finishedAt ?? now) - startedAt) : 0;
  const remainingMs = finishedAt ? 0 : completed > 0 && startedAt
    ? Math.max(0, Math.round(elapsedMs / completed * (total - completed))) : null;
  return { elapsedMs, remainingMs, estimatedFinishAt: remainingMs === null ? null : (finishedAt ?? now + remainingMs) };
}
