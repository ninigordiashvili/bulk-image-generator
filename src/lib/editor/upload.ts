import type { ErrorResponse, UploadResponse } from "@/types/editor";

/**
 * Well under the 10 MB the proxy will buffer for a single request. Anything
 * past that limit is dropped without an error, so the chunk size is the one
 * number here that isn't a matter of taste.
 */
const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * `voice` is one of several takes waiting to be joined into a bed; `audio` is
 * the bed itself, of which a job holds only one.
 */
export type UploadKind = "image" | "audio" | "voice";

export interface UploadTarget {
  jobId: string;
  kind: UploadKind;
  file: File;
}

/** Sends one file to the job directory, a chunk at a time, in order. */
export async function uploadFile(
  { jobId, kind, file }: UploadTarget,
  onBytes?: (sent: number) => void,
  signal?: AbortSignal
): Promise<string> {
  const base = `/api/editor/job/${jobId}/upload`;
  let stored: string | null = null;
  let offset = 0;

  do {
    const chunk = file.slice(offset, offset + CHUNK_BYTES);
    const query = new URLSearchParams({
      kind,
      name: file.name,
      offset: String(offset),
    });
    if (stored) query.set("stored", stored);

    const response = await fetch(`${base}?${query}`, {
      method: "POST",
      body: chunk,
      headers: { "Content-Type": "application/octet-stream" },
      signal,
    });

    const payload = (await response
      .json()
      .catch(() => null)) as UploadResponse | ErrorResponse | null;

    if (!response.ok || !payload?.ok) {
      throw new Error(
        payload && "error" in payload
          ? payload.error
          : `Upload of ${file.name} failed (${response.status}).`
      );
    }

    stored = payload.stored;
    offset += chunk.size;
    onBytes?.(offset);
    // A zero-byte file still needs its one empty chunk to create the file.
  } while (offset < file.size);

  return stored!;
}

/** Uploads many files with a few in flight at once, reporting bytes as they go. */
export async function uploadAll(
  jobId: string,
  files: { key: string; kind: UploadKind; file: File }[],
  onProgress: (sentBytes: number, doneCount: number) => void,
  signal?: AbortSignal,
  concurrency = 4
): Promise<Map<string, string>> {
  const stored = new Map<string, string>();
  const sent = new Array<number>(files.length).fill(0);
  let done = 0;
  let next = 0;

  const report = () =>
    onProgress(
      sent.reduce((sum, value) => sum + value, 0),
      done
    );

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const index = next++;
      if (index >= files.length) return;
      const entry = files[index];
      const name = await uploadFile(
        { jobId, kind: entry.kind, file: entry.file },
        (bytes) => {
          sent[index] = bytes;
          report();
        },
        signal
      );
      stored.set(entry.key, name);
      done += 1;
      report();
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, worker)
  );

  return stored;
}
