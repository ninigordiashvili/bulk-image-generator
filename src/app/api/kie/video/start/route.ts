import { NextResponse } from "next/server";
import { AccountConfigError, findAccount } from "@/server/accounts";
import { KieError, createTask, createVeoTask, uploadReference } from "@/server/kie";
import { findVideoModel } from "@/lib/videoModels";
import { MAX_CUT_SECONDS, cutAudio } from "@/server/audio/clips";
import type { VideoStartRequest, VideoStartResponse } from "@/types";

/** Only creates the task — the long wait happens on the client's terms. */
export const maxDuration = 120;

function fail(error: string, status = 400, retryable = false) {
  return NextResponse.json<VideoStartResponse>(
    { ok: false, error, retryable },
    { status }
  );
}

export async function POST(request: Request) {
  let body: VideoStartRequest;
  try {
    body = (await request.json()) as VideoStartRequest;
  } catch {
    return fail("Malformed request body.");
  }

  const { accountId, model, prompt, image, duration, resolution, aspectRatio, audio } =
    body;

  if (!accountId) return fail("No account selected.");
  if (!image?.base64) return fail("No source image for this shot.");

  const spec = findVideoModel(model);
  if (!spec) return fail(`Unknown video model "${model}".`);

  if (spec.input === "audio") {
    // The voice track is the clip, so it's the one thing that can't be missing.
    // The prompt is optional here — kie requires the field, not its content.
    if (!audio?.sourceId) return fail(`${spec.label} needs a voice track for this shot.`);
    if (!(audio.duration > 0)) return fail("That audio cut has no length.");
    if (audio.duration > MAX_CUT_SECONDS) {
      return fail(
        `${spec.label} accepts at most ${MAX_CUT_SECONDS / 60} minutes of audio; this cut is ${Math.round(audio.duration)}s.`
      );
    }
  } else {
    if (!prompt?.trim()) return fail("Prompt is empty.");
    if (!spec.durations.includes(duration)) {
      return fail(
        `${spec.label} does not support ${duration}s clips. Allowed: ${spec.durations.join(", ")}s.`
      );
    }
    if (!spec.resolutions.includes(resolution)) {
      return fail(
        `${spec.label} does not support ${resolution}. Allowed: ${spec.resolutions.join(", ")}.`
      );
    }
  }

  let account;
  try {
    account = await findAccount(accountId);
  } catch (error) {
    return fail(
      error instanceof AccountConfigError ? error.message : "Failed to load account.",
      500
    );
  }

  try {
    // Both APIs animate from a URL, never bytes. Uploads are cached by content,
    // so re-running a shot doesn't re-upload the same still.
    const imageUrl = await uploadReference(
      account.apiKey,
      image.base64,
      image.mimeType,
      request.signal
    );

    if (spec.input === "audio") {
      // Cut on the server rather than in the browser: ffmpeg is already here,
      // it can cut to the millisecond instead of the nearest frame, and it
      // hands back a 240 KB AAC clip instead of a multi-megabyte WAV.
      const cut = await cutAudio(
        audio!.sourceId,
        audio!.start,
        audio!.duration,
        request.signal
      );
      const audioUrl = await uploadReference(
        account.apiKey,
        cut.base64,
        cut.mimeType,
        request.signal
      );

      const taskId = await createTask(
        account.apiKey,
        spec.requestModel,
        {
          image_url: imageUrl,
          audio_url: audioUrl,
          // Required by the schema, but an empty string is valid and the model
          // is driven by the audio, so an absent prompt is not an error.
          prompt: prompt?.trim() ?? "",
        },
        request.signal
      );
      return NextResponse.json<VideoStartResponse>({ ok: true, taskId });
    }

    if (spec.api === "veo") {
      const taskId = await createVeoTask(
        account.apiKey,
        {
          prompt: prompt.trim(),
          imageUrls: [imageUrl],
          model: spec.requestModel,
          aspect_ratio: aspectRatio,
          resolution,
          duration,
        },
        request.signal
      );
      return NextResponse.json<VideoStartResponse>({ ok: true, taskId });
    }

    // Grok rides the ordinary market API, and wants `duration` as a *string* —
    // a number there is rejected as a validation error.
    const taskId = await createTask(
      account.apiKey,
      spec.requestModel,
      {
        image_urls: [imageUrl],
        prompt: prompt.trim(),
        duration: String(duration),
        resolution,
        aspect_ratio: aspectRatio,
      },
      request.signal
    );
    return NextResponse.json<VideoStartResponse>({ ok: true, taskId });
  } catch (error) {
    if (error instanceof KieError) {
      return fail(`Account "${account.label}": ${error.message}`, 502, error.retryable);
    }
    return fail(
      `Account "${account.label}": ${error instanceof Error ? error.message : "Unexpected error."}`,
      502,
      true
    );
  }
}
