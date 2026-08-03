import { NextResponse } from "next/server";
import { AccountConfigError, findAccount } from "@/server/accounts";
import {
  KieError,
  awaitTask,
  createTask,
  fetchImageBytes,
  resultUrls,
  taskFailure,
  uploadReference,
} from "@/server/kie";
import { readImageDimensions } from "@/lib/imageMeta";
import { findModel, referenceLimit, type KieModelSpec } from "@/lib/kieModels";
import type {
  GeneratedImagePayload,
  GenerateRequest,
  GenerateResponse,
  ModelInput,
  TaskInput,
} from "@/types";

/** kie tasks are async; the route polls to completion so the client stays simple. */
export const maxDuration = 300;

/**
 * Bad input and bad config are never worth a second attempt — nothing about them
 * changes between calls in the same batch, so they default to non-retryable.
 */
function fail(error: string, status = 400, retryable = false) {
  return NextResponse.json<GenerateResponse>(
    { ok: false, error, retryable },
    { status }
  );
}

export async function POST(request: Request) {
  let body: GenerateRequest;
  try {
    body = (await request.json()) as GenerateRequest;
  } catch {
    return fail("Malformed request body.");
  }

  const {
    accountId,
    model,
    prompt,
    styleBible,
    referenceImages = [],
    input = {},
    imageField,
    imageSingle,
  } = body;

  if (!accountId) return fail("No account selected.");
  if (!model?.trim()) return fail("No model selected.");
  if (!prompt?.trim()) return fail("Prompt is empty.");

  const text = [styleBible?.trim(), prompt.trim()].filter(Boolean).join("\n");

  // Known models get their input checked against the published schema first.
  // kie answers an unknown field with a flat 422, which halts the whole batch —
  // catching it here costs nothing and says exactly which field was wrong.
  const spec = findModel(model);
  if (spec && text.length > spec.promptMax) {
    return fail(
      `Prompt is ${text.length} characters but ${spec.label} accepts at most ${spec.promptMax}. Shorten the style bible or the prompt.`
    );
  }

  const taskInput: TaskInput = spec ? sanitize(input, spec) : { ...input };
  taskInput.prompt = text;

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
    // Reference images: kie takes URLs only, so upload first. Uploads are cached
    // by content, so a pinned character costs one upload per batch, not per job.
    const limit = spec ? referenceLimit(spec) : referenceImages.length;
    const attachable = imageField ? referenceImages.slice(0, limit) : [];

    if (attachable.length > 0 && imageField) {
      const urls = await Promise.all(
        attachable.map((image) =>
          uploadReference(account.apiKey, image.base64, image.mimeType, request.signal)
        )
      );
      // A single-URL field can't take an array, so the extras are dropped above.
      taskInput[imageField] = imageSingle ? urls[0] : urls;
    }

    const taskId = await createTask(account.apiKey, model, taskInput, request.signal);
    const record = await awaitTask(account.apiKey, taskId, request.signal);

    if (record.state !== "success") throw taskFailure(record);

    const urls = resultUrls(record);
    if (urls.length === 0) {
      // Success with no image is odd enough to be worth another attempt.
      throw new KieError(
        `kie.ai reported task ${taskId} succeeded but returned no image URL.`,
        true
      );
    }

    const images: GeneratedImagePayload[] = await Promise.all(
      urls.map(async (url) => {
        const { bytes, mimeType } = await fetchImageBytes(url, request.signal);
        const dimensions = readImageDimensions(bytes);
        return {
          base64: bytes.toString("base64"),
          mimeType,
          width: dimensions?.width ?? 0,
          height: dimensions?.height ?? 0,
          resolution: dimensions
            ? `${dimensions.width}×${dimensions.height}`
            : "unknown",
          sourceUrl: url,
        };
      })
    );

    return NextResponse.json<GenerateResponse>({
      ok: true,
      taskId,
      images,
      // What kie actually billed — the only authoritative cost number there is.
      credits: record.creditsConsumed ?? 0,
    });
  } catch (error) {
    if (error instanceof KieError) {
      return fail(
        `Account "${account.label}": ${error.message}`,
        502,
        error.retryable
      );
    }
    return fail(
      `Account "${account.label}": ${error instanceof Error ? error.message : "Unexpected error."}`,
      502,
      true
    );
  }
}

/**
 * Keeps only fields the model declares, and only values its enum allows. The
 * client reconciles too, but a stale persisted setting shouldn't be able to
 * reach kie and burn the batch on a 422.
 */
function sanitize(input: ModelInput, spec: KieModelSpec): ModelInput {
  const clean: ModelInput = {};
  for (const field of spec.options) {
    const value = input[field.name];
    if (value === undefined) continue;
    if (field.enum && !field.enum.includes(String(value))) continue;
    clean[field.name] = value;
  }
  return clean;
}
