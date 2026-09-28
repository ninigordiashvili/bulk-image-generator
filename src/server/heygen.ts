import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { VideoStartRequest } from "@/types";
import { heygenSource, type HeygenLook } from "@/lib/heygen";
import { videoModel } from "@/lib/videoModels";
import type { Checkpoint, ProviderResult } from "./workProvider";
import { finishHeygenVideo } from "./heygenMedia";

const BASE = "https://api.heygen.com/v3/";
export async function heygenKey() {
  const key = process.env.HEYGEN_API_KEY?.trim() || JSON.parse((await fs.readFile(path.join(process.cwd(), ".local/heygen.json"), "utf8")).replace(/^\uFEFF/, "")).apiKey;
  if (typeof key !== "string" || !key.trim()) throw new Error("Configure your HeyGen API key on the server.");
  return key.trim();
}

/** All retries of a mutation keep its original idempotency key. */
export async function heygenApi<T>(route: string, init: RequestInit = {}, signal?: AbortSignal, idempotencyKey?: string): Promise<T> {
  const key = await heygenKey();
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(BASE + route, { ...init, headers: { "x-api-key": key,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}), ...init.headers },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000), cache: "no-store" });
    } catch {
      signal?.throwIfAborted();
      if (attempt >= 5) throw new Error("HeyGen connection failed. Retry resumes the same submission.");
      await delay(Math.min(60000, 2000 * 2 ** attempt), undefined, { signal });
      continue;
    }
    const body = await response.json().catch(() => null);
    if (response.ok && body && !body.error) return body as T;
    const transient = response.status === 429 || response.status >= 500 || (response.status === 409 && body?.error?.code === "request_in_progress");
    if (transient && (response.status === 429 || attempt < 8)) {
      const retry = response.headers.get("retry-after");
      const seconds = retry ? Number(retry) || Math.max(0, (Date.parse(retry) - Date.now()) / 1000) : 0;
      await delay(Math.max(seconds * 1000 || 0, Math.min(60000, 2000 * 2 ** Math.min(attempt, 5))), undefined, { signal });
      continue;
    }
    throw new Error(`HeyGen: ${body?.error?.message || body?.message || `request failed (${response.status})`}`);
  }
}

export async function listHeygenLooks(ownership = "private", token = "") {
  const query = new URLSearchParams({ ownership, limit: "50", ...(token ? { token } : {}) });
  return heygenApi<{ data: HeygenLook[]; has_more?: boolean; next_token?: string }>("avatars/looks?" + query);
}

async function upload(base64: string, mime: string, name: string, id: string, signal: AbortSignal) {
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length > 32 * 1024 ** 2) throw new Error("HeyGen uploads must be between 1 byte and 32 MB.");
  const body = new FormData();
  body.append("file", new Blob([bytes], { type: mime }), name);
  const result = await heygenApi<{ data: { asset_id: string } }>("assets", { method: "POST", body }, signal, id);
  if (!result.data?.asset_id) throw new Error("HeyGen did not return an upload ID.");
  return result.data.asset_id;
}

export function buildHeygenRequest(req: VideoStartRequest, audioId: string, imageId?: string, look?: HeygenLook) {
  const spec = videoModel(req.model);
  if (spec.provider !== "heygen") throw new Error("Select a HeyGen model.");
  const opts = req.heygen ?? {};
  const source = heygenSource(req.model, opts);
  const engine = spec.requestModel;
  if (source === "image" && engine !== "avatar_iv") throw new Error("Direct image animation uses Avatar IV. Choose Photo Avatar for Avatar III or V.");
  if (source !== "avatar" && engine === "avatar_iii" && req.resolution === "4k") throw new Error("Avatar III Photo Avatars support up to 1080p.");
  if (look?.supported_api_engines?.length && !look.supported_api_engines.includes(engine)) throw new Error(`This avatar does not support ${spec.label}. Choose a supported engine.`);
  if (engine === "avatar_iii" && look?.avatar_type === "photo_avatar" && req.resolution === "4k") throw new Error("Avatar III Photo Avatars support up to 1080p.");
  if (!spec.resolutions.includes(req.resolution) || !spec.aspectRatios.includes(req.aspectRatio)) throw new Error("Select a supported HeyGen resolution and aspect ratio.");
  const photo = !look || look.avatar_type === "photo_avatar";
  const body: Record<string, unknown> = {
    type: source === "image" ? "image" : "avatar",
    ...(source === "image" ? { image: { type: "asset_id", asset_id: imageId } } : { avatar_id: look?.id || opts.avatarId }),
    audio_asset_id: audioId, resolution: req.resolution, aspect_ratio: req.aspectRatio,
    // Direct images implicitly use Avatar IV; their strict schema rejects engine.
    ...(source !== "image" ? { engine: { type: engine, ...(engine === "avatar_v" && opts.referenceLookId ? { reference_look_id: opts.referenceLookId } : {}) } } : {}),
    output_format: opts.outputFormat ?? "mp4",
  };
  if (req.prompt.trim() && engine !== "avatar_iii" && (photo || engine === "avatar_v")) body.motion_prompt = req.prompt.trim();
  if (photo && engine === "avatar_iv" && opts.expressiveness) body.expressiveness = opts.expressiveness;
  if (opts.fit && opts.fit !== "auto") body.fit = opts.fit;
  if (opts.outputFormat !== "webm") {
    if (opts.removeBackground) body.remove_background = true;
    if (opts.backgroundUrl) {
      if (!opts.backgroundUrl.startsWith("https://")) throw new Error("Background images require a public HTTPS URL.");
      body.background = { type: "image", url: opts.backgroundUrl };
    } else if (opts.backgroundColor) {
      if (!/^#[\da-f]{6}$/i.test(opts.backgroundColor)) throw new Error("Use a six-digit background color, for example #ffffff.");
      body.background = { type: "color", value: opts.backgroundColor };
    }
  }
  if (opts.captions) body.caption = { style: "default", file_format: "srt" };
  if (opts.title?.trim()) body.title = opts.title.trim().slice(0, 200);
  return body;
}

export async function performHeygenWork(req: VideoStartRequest, requestId: string, checkpoint: Checkpoint,
  save: () => Promise<void>, signal: AbortSignal): Promise<ProviderResult> {
  const audio = req.audio;
  if (!audio || !Number.isFinite(audio.seconds) || audio.seconds <= 0 || audio.seconds > 1800) throw new Error("Select an audio segment between 0 and 30 minutes.");
  if (audio.mimeType !== "audio/wav") throw new Error("HeyGen requires a WAV audio cut. Re-add the audio and try again.");
  validateHeygenAudio(audio);
  if (req.accountId !== "main") throw new Error("Unknown HeyGen account.");
  const state = (checkpoint.heygen ??= {});
  if (state.failed) {
    // A confirmed failed operation may be recreated only on an explicit retry.
    checkpoint.taskId = undefined;
    checkpoint.sourceUrl = undefined;
    state.failed = false;
    state.submittedAt = undefined;
    state.attempt = (state.attempt ?? 0) + 1;
    await save();
  }
  // Refuse replay after the provider's 24-hour idempotency window if acceptance is unknown.
  if (!checkpoint.taskId && state.submittedAt && Date.now() - state.submittedAt > 23 * 3600000) throw new Error("HeyGen submission status is uncertain and its safe retry window expired. Check HeyGen Activity before creating another job.");
  const source = heygenSource(req.model, req.heygen);
  if (!checkpoint.taskId) {
    if (source !== "avatar" && !req.image?.base64) throw new Error("Add a character image.");
    buildHeygenRequest(req, "validate", "validate");
    if (!state.audioId) { state.audioId = await upload(audio.base64, audio.mimeType, "voice.wav", requestId + "-audio", signal); await save(); }
    if (source !== "avatar" && !state.imageId) {
      if (!["image/png", "image/jpeg"].includes(req.image!.mimeType)) throw new Error("HeyGen requires a PNG or JPEG source image.");
      state.imageId = await upload(req.image!.base64, req.image!.mimeType, req.image!.mimeType === "image/png" ? "portrait.png" : "portrait.jpg", requestId + "-image", signal); await save();
    }
    if (source === "photo" && !state.avatarId) {
      // Reuse an image-created avatar across rows/batches; the file contains only provider IDs.
      const hash = createHash("sha256").update(await heygenKey()).update(req.image!.base64).digest("hex");
      const file = path.join(process.cwd(), ".local", "heygen-avatars", hash + ".json");
      const cached = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
      if (cached?.id) state.avatarId = cached.id;
      else {
        if (state.avatarSubmittedAt && Date.now() - state.avatarSubmittedAt > 23 * 3600000) throw new Error("Photo Avatar creation status is uncertain and its safe retry window expired. Check your HeyGen avatar library before retrying.");
        state.avatarSubmittedAt ??= Date.now();
        await save();
        const result = await heygenApi<{ data: { avatar_item: { id: string } } }>("avatars", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "photo", name: req.heygen?.title || "Bulk character", file: { type: "asset_id", asset_id: state.imageId } }),
        }, signal, "photo-" + hash);
        state.avatarId = result.data?.avatar_item?.id;
        if (!state.avatarId) throw new Error("HeyGen did not return a Photo Avatar ID.");
        await save();
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify({ id: state.avatarId }));
      }
      await save();
    }
    let look: HeygenLook | undefined;
    if (source !== "image") {
      const id = state.avatarId || req.heygen?.avatarId;
      if (!id) throw new Error("Choose a HeyGen avatar.");
      for (;;) {
        look = (await heygenApi<{ data: HeygenLook }>("avatars/looks/" + encodeURIComponent(id), {}, signal)).data;
        if (look.status === "failed") throw new Error("HeyGen Photo Avatar creation failed.");
        if (!look.status || look.status === "completed") break;
        await delay(10000, undefined, { signal });
      }
    }
    const body = buildHeygenRequest(req, state.audioId!, state.imageId, look);
    state.submittedAt ??= Date.now();
    await save();
    const result = await heygenApi<{ data: { video_id: string } }>("videos", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, signal, requestId + "-video-" + (state.attempt ?? 0));
    if (!result.data?.video_id) throw new Error("HeyGen did not return a video ID. Retry resumes the same submission.");
    checkpoint.taskId = result.data.video_id;
    await save();
  }
  // Always refresh the signed download URL, including after a failed download.
  for (;;) {
    const { data } = await heygenApi<{ data: { status: string; video_url?: string; failure_message?: string; error?: { message?: string } } }>("videos/" + encodeURIComponent(checkpoint.taskId!), {}, signal);
    if (data.status === "failed") {
      state.failed = true;
      await save();
      throw new Error(`HeyGen generation failed: ${data.failure_message || data.error?.message || "unknown provider error"}. Video ID: ${checkpoint.taskId}`);
    }
    if (data.status === "completed" && data.video_url) { checkpoint.sourceUrl = data.video_url; await save(); break; }
    await delay(10000, undefined, { signal });
  }
  const url = new URL(checkpoint.sourceUrl!);
  if (url.protocol !== "https:") throw new Error("HeyGen returned an invalid download URL.");
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]) });
  if (!response.ok) throw new Error("HeyGen video download failed. Retry downloads the existing video.");
  const mimeType = req.heygen?.outputFormat === "webm" ? "video/webm" : "video/mp4";
  const bytes = await finishHeygenVideo(new Uint8Array(await response.arrayBuffer()), audio, mimeType, signal);
  return { ok: true, video: true, bytes, mimeType, credits: 0, taskId: checkpoint.taskId!, sourceUrl: checkpoint.sourceUrl!, actualResolution: req.resolution };
}

/** Verify the duration from PCM samples before any paid generation request. */
export function validateHeygenAudio(audio: { base64: string; seconds: number }) {
  const bytes = Buffer.from(audio.base64, "base64");
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("Invalid WAV audio cut.");
  let rate = 0, length = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (size > bytes.length - start) throw new Error("Incomplete WAV audio cut.");
    if (id === "fmt " && size >= 16) {
      if (bytes.readUInt16LE(start) !== 1) throw new Error("Use an uncompressed PCM WAV audio cut.");
      rate = bytes.readUInt32LE(start + 8);
    }
    if (id === "data") length += size;
    offset = start + size + size % 2;
  }
  if (!rate || !length || Math.abs(length / rate - audio.seconds) > 0.001) throw new Error("Audio duration does not match the selected cut. Trim the audio again.");
}
