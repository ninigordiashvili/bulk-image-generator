import type {
  AccountsResponse,
  CreditsResponse,
  GenerateRequest,
  GenerateResponse,
  VideoStartRequest,
  VideoStartResponse,
  VideoStatusResponse,
} from "@/types";

/**
 * One POST per image. The route creates the kie.ai task and polls it to
 * completion, so the client never sees a task id or a pending state — a job is
 * in flight until it comes back with bytes. Never throws; failures come back as
 * `{ ok: false, error }`.
 */
export async function generateImage(
  request: GenerateRequest,
  options: { signal?: AbortSignal } = {}
): Promise<GenerateResponse> {
  try {
    const response = await fetch("/api/kie/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: options.signal,
    });

    const payload = (await response.json().catch(() => null)) as
      | GenerateResponse
      | null;

    if (!payload) {
      return { ok: false, error: `Server returned ${response.status}.` };
    }
    return payload;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, error: "Cancelled." };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Network error.",
    };
  }
}

/** Creates the kie task and returns immediately with its id. */
export async function startVideo(
  request: VideoStartRequest,
  options: { signal?: AbortSignal } = {}
): Promise<VideoStartResponse> {
  try {
    const response = await fetch("/api/kie/video/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: options.signal,
    });
    const payload = (await response.json().catch(() => null)) as
      | VideoStartResponse
      | null;
    if (!payload) return { ok: false, error: `Server returned ${response.status}.` };
    return payload;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, error: "Cancelled." };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Network error.",
    };
  }
}

/** One poll of a running task. */
export async function pollVideo(
  accountId: string,
  taskId: string,
  model: string,
  signal?: AbortSignal
): Promise<VideoStatusResponse> {
  try {
    const query = new URLSearchParams({ accountId, taskId, model });
    const response = await fetch(`/api/kie/video/status?${query}`, { signal });
    const payload = (await response.json().catch(() => null)) as
      | VideoStatusResponse
      | null;
    if (!payload) return { ok: false, error: `Server returned ${response.status}.` };
    return payload;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, error: "Cancelled." };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Network error.",
      retryable: true,
    };
  }
}

/**
 * Pulls the finished clip through the server proxy. kie's CDN sends no CORS
 * headers, so the page can't fetch it directly — and it has to be fetched,
 * because the URL expires long before the gallery does.
 */
export async function downloadVideoBlob(
  videoUrl: string,
  signal?: AbortSignal
): Promise<{ ok: true; blob: Blob } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `/api/kie/video/file?url=${encodeURIComponent(videoUrl)}`,
      { signal }
    );
    if (!response.ok) {
      return {
        ok: false,
        error: `Could not download the clip (${response.status}): ${await response
          .text()
          .catch(() => "")}`.trim(),
      };
    }
    return { ok: true, blob: await response.blob() };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, error: "Cancelled." };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Network error.",
    };
  }
}

export async function fetchAccounts(): Promise<
  AccountsResponse | { ok: false; error: string }
> {
  try {
    const response = await fetch("/api/accounts");
    const payload = (await response.json().catch(() => null)) as
      | AccountsResponse
      | { ok: false; error: string }
      | null;
    return payload ?? { ok: false, error: `Server returned ${response.status}.` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Network error.",
    };
  }
}

export async function fetchCredits(accountId: string): Promise<CreditsResponse> {
  try {
    const response = await fetch(
      `/api/accounts/credits?accountId=${encodeURIComponent(accountId)}`
    );
    const payload = (await response.json().catch(() => null)) as
      | CreditsResponse
      | null;
    return payload ?? { ok: false, error: `Server returned ${response.status}.` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Network error.",
    };
  }
}
