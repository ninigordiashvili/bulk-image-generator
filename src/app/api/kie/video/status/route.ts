import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AccountConfigError, findAccount } from "@/server/accounts";
import { KieError, getTask, getVeoTask, resultUrls } from "@/server/kie";
import { findVideoModel } from "@/lib/videoModels";
import type { VideoStatusResponse } from "@/types";

/** A single read of one task. Returns in well under a second. */
export const maxDuration = 60;

function fail(error: string, status = 400, retryable = false) {
  return NextResponse.json<VideoStatusResponse>(
    { ok: false, error, retryable },
    { status }
  );
}

/**
 * One poll of a running video task, for either API.
 *
 * The client drives the polling rather than the server blocking on it: a Veo
 * clip can take well over fifteen minutes, and an HTTP request held open that
 * long dies to any timeout between the browser and the route — losing track of
 * a task that has already been billed.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const accountId = params.get("accountId");
  const taskId = params.get("taskId");
  const model = params.get("model") ?? "";

  if (!accountId || !taskId) return fail("Missing accountId or taskId.");
  const spec = findVideoModel(model);
  if (!spec) return fail(`Unknown video model "${model}".`);

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
    if (spec.api === "veo") {
      const record = await getVeoTask(account.apiKey, taskId, request.signal);
      if (record.successFlag === 0) {
        return NextResponse.json<VideoStatusResponse>({ ok: true, state: "pending" });
      }
      if (record.successFlag === 1) {
        const videoUrl = record.response?.resultUrls?.[0];
        if (!videoUrl) {
          return fail(`Veo task ${taskId} succeeded but returned no video URL.`, 502, true);
        }
        return NextResponse.json<VideoStatusResponse>({
          ok: true,
          state: "done",
          videoUrl,
          // The Veo namespace reports no per-task credit figure; spend shows up
          // in the account balance instead.
          credits: 0,
          actualResolution: record.response?.resolution ?? undefined,
        });
      }
      return fail(
        record.errorMessage?.trim() || `Veo task ${taskId} failed.`,
        502,
        // A failed render can succeed on a resample; a rejected request cannot.
        !record.errorCode || record.errorCode >= 500
      );
    }

    const record = await getTask(account.apiKey, taskId, request.signal);
    if (record.state !== "success" && record.state !== "fail") {
      return NextResponse.json<VideoStatusResponse>({ ok: true, state: "pending" });
    }
    if (record.state === "fail") {
      const code = Number(record.failCode);
      return fail(
        record.failMsg?.trim() || `kie.ai task ${taskId} failed.`,
        502,
        !Number.isFinite(code) || code >= 500
      );
    }
    const videoUrl = resultUrls(record)[0];
    if (!videoUrl) {
      return fail(`kie.ai task ${taskId} succeeded but returned no video URL.`, 502, true);
    }
    return NextResponse.json<VideoStatusResponse>({
      ok: true,
      state: "done",
      videoUrl,
      credits: record.creditsConsumed ?? 0,
    });
  } catch (error) {
    if (error instanceof KieError) {
      // Transient read failures are the caller's to absorb — the task is still
      // running on kie's side regardless of what this one poll saw.
      return fail(error.message, 502, error.retryable);
    }
    return fail(
      error instanceof Error ? error.message : "Unexpected error.",
      502,
      true
    );
  }
}
