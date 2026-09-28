import { performHeygenWork } from "./heygen";
import { NextRequest } from "next/server";
import { generateKieImage } from "./imageGeneration";
import { POST as vertexPost } from "@/app/api/vertex/generate/route";
import { POST as videoPost } from "@/app/api/kie/video/start/route";
import { GET as videoStatus } from "@/app/api/kie/video/status/route";
import { GET as videoFile } from "@/app/api/kie/video/file/route";
import type { GenerateRequest, GenerateResponse, VideoStartRequest, VideoStartResponse, VideoStatusResponse } from "@/types";
import type { WorkInput } from "@/types/work";
import { setTimeout as delay } from "node:timers/promises";

export interface Checkpoint { heygen?: { audioId?: string; imageId?: string; avatarId?: string; avatarSubmittedAt?: number; submittedAt?: number; failed?: boolean; attempt?: number }; taskId?: string; sourceUrl?: string; credits?: number; actualResolution?: string }
export type ProviderResult = GenerateResponse | { ok: true; video: true; bytes: Uint8Array; mimeType: string; credits: number; taskId: string; sourceUrl: string; actualResolution?: string };
const post = (body: unknown, signal: AbortSignal) => new Request("http://internal/generate", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
});

/** In-process calls share provider validation/quotas, but never a browser's signal. */
export async function performWork(kind: "image" | "video", input: WorkInput, requestId: string,
  checkpoint: Checkpoint, save: () => Promise<void>, signal: AbortSignal): Promise<ProviderResult> {
  if (kind === "image") {
    if (input.provider === "heygen") throw new Error("HeyGen is available for talking-avatar videos only.");
    const req = input.request as GenerateRequest;
    if (input.provider !== "vertex") return (await generateKieImage(post(req, signal), checkpoint, save)).json();
    const response = await vertexPost(post({ kind: "image", accountId: req.accountId, model: req.model,
      prompt: req.prompt, styleBible: req.styleBible, referenceImages: req.referenceImages,
      aspectRatio: req.input?.aspect_ratio, imageSize: req.input?.image_size, count: 1 }, signal));
    const result = await response.json();
    return result.ok ? { ok: true, taskId: requestId, credits: 0, images: result.images } : result;
  }
  const req = input.request as VideoStartRequest;
  if (input.provider === "heygen") return performHeygenWork(req, requestId, checkpoint, save, signal);
  if (input.provider === "vertex") {
    const response = await vertexPost(post({ kind: "video", ...req, requestId,
      durationSeconds: req.duration, generateAudio: false }, signal));
    const result = await response.json();
    if (!result.ok) return result;
    const video = result.videos?.[0];
    if (!video?.base64) return { ok: false, error: "Vertex returned no inline video. Clear outputGcsUri and retry." };
    return { ok: true, video: true, bytes: Buffer.from(video.base64, "base64"), mimeType: video.mimeType,
      taskId: requestId, sourceUrl: "", credits: 0 };
  }
  if (!checkpoint.taskId) {
    const result: VideoStartResponse = await (await videoPost(post(req, signal))).json();
    if (!result.ok) return result;
    checkpoint.taskId = result.taskId;
    await save();
  }
  while (!checkpoint.sourceUrl) {
    signal.throwIfAborted();
    const params = new URLSearchParams({ accountId: req.accountId, model: req.model, taskId: checkpoint.taskId! });
    const result: VideoStatusResponse = await (await videoStatus(new NextRequest(`http://internal/status?${params}`, { signal }))).json();
    if (!result.ok) {
      if (result.taskFailed) { checkpoint.taskId = undefined; await save(); return result; }
      if (!result.retryable) return result;
    } else if (result.state === "done") {
      Object.assign(checkpoint, { sourceUrl: result.videoUrl, credits: result.credits, actualResolution: result.actualResolution });
      await save();
      break;
    }
    await delay(5000, undefined, { signal });
  }
  const response = await videoFile(new NextRequest(`http://internal/file?${new URLSearchParams({ url: checkpoint.sourceUrl! })}`, { signal }));
  if (!response.ok) return { ok: false, error: "Video is generated but its download failed. Retry resumes the existing video.", retryable: true };
  return { ok: true, video: true, bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type") || "video/mp4", taskId: checkpoint.taskId!,
    sourceUrl: checkpoint.sourceUrl!, credits: checkpoint.credits ?? 0, actualResolution: checkpoint.actualResolution };
}
