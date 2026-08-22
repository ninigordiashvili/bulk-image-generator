import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  AUDIO_EXTENSIONS,
  MAX_SOURCE_BYTES,
  SOURCE_ID,
  ensureRoot,
  extensionOf,
  findSource,
  sourcePath,
  sweep,
} from "@/server/audio/clips";
import { probeDuration } from "@/server/editor/ffmpeg";
import type { AudioUploadResponse, ErrorResponse } from "@/types";

export const maxDuration = 300;

function fail(error: string, status = 400) {
  return NextResponse.json<ErrorResponse>({ ok: false, error }, { status });
}

/**
 * Stores one voice track, a chunk at a time, under the hash the client
 * computed. Chunked for the same reason the editor's uploads are: this app runs
 * behind a proxy that buffers request bodies and silently truncates anything
 * past its limit, so a whole two-minute recording sent in one request would
 * arrive as a fragment with no error to notice.
 *
 * Because the id is a content hash, a source already on disk is reported back
 * as complete without transferring a byte.
 */
export async function POST(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const id = params.get("id") ?? "";
  const name = params.get("name") ?? "";
  const offset = Number(params.get("offset") ?? "0");
  const size = Number(params.get("size") ?? "0");

  if (!SOURCE_ID.test(id)) return fail("Malformed audio id.");
  if (!Number.isInteger(offset) || offset < 0) return fail("Bad chunk offset.");
  if (!Number.isFinite(size) || size <= 0) return fail("Missing file size.");
  if (size > MAX_SOURCE_BYTES) {
    return fail(
      `That recording is larger than the ${Math.round(MAX_SOURCE_BYTES / 1024 / 1024)} MB limit.`,
      413
    );
  }

  const extension = extensionOf(name);
  if (!AUDIO_EXTENSIONS.has(extension)) {
    return fail(
      `${name || "That file"} isn't an audio format this can read (${[...AUDIO_EXTENSIONS].join(", ")}).`
    );
  }

  await ensureRoot();

  const target = sourcePath(id, extension);
  if (!target) return fail("Could not place that file.", 500);

  if (offset === 0) {
    await sweep();
    // Same bytes, already here: skip the transfer entirely.
    const existing = await findSource(id);
    if (existing) {
      const stat = await fs.stat(existing).catch(() => null);
      if (stat?.size === size) {
        return NextResponse.json<AudioUploadResponse>({
          ok: true,
          id,
          bytes: stat.size,
          complete: true,
          duration: await probeDuration(existing),
        });
      }
    }
    await fs.writeFile(target, new Uint8Array(0));
  } else {
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) return fail("That upload was never started.", 409);
    if (stat.size !== offset) {
      return fail(
        `Chunk out of order: the file is ${stat.size} bytes but the chunk starts at ${offset}.`,
        409
      );
    }
  }

  const body = Buffer.from(await request.arrayBuffer());
  if (offset + body.byteLength > size) return fail("Chunk runs past the declared size.");

  await fs.appendFile(target, body);
  const written = offset + body.byteLength;
  const complete = written >= size;

  // Only probe once the file is whole — ffprobe on a partial file is a guess.
  const duration = complete ? await probeDuration(target) : 0;
  if (complete && duration <= 0) {
    await fs.rm(target, { force: true }).catch(() => {});
    return fail("That file has no readable audio track.");
  }

  return NextResponse.json<AudioUploadResponse>({
    ok: true,
    id,
    bytes: written,
    complete,
    duration,
  });
}
