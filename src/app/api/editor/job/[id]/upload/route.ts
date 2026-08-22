import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getJob, resolveInside } from "@/server/editor/jobs";
import type { ErrorResponse, UploadResponse } from "@/types/editor";

export const maxDuration = 300;

/** Formats ffmpeg can decode and this workflow actually produces. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "mp4"]);

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_AUDIO_BYTES = 512 * 1024 * 1024;

function fail(error: string, status = 400) {
  return NextResponse.json<ErrorResponse>({ ok: false, error }, { status });
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * Takes one chunk of one file. Uploads are chunked rather than sent whole
 * because this app runs behind a proxy that buffers request bodies in memory
 * and silently truncates anything past its limit — a ten-minute WAV would
 * arrive as a fragment with no error to notice. Small chunks stay well under
 * it, and give the UI a real byte-level progress bar for free.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/editor/job/[id]/upload">
) {
  const { id } = await context.params;
  const job = getJob(id);
  if (!job) return fail("No such editing session — reload the page.", 404);
  if (job.controller) return fail("A render is already running for this session.", 409);

  const params = request.nextUrl.searchParams;
  const kind = params.get("kind");
  const name = params.get("name") ?? "";
  const offset = Number(params.get("offset") ?? "0");
  const stored = params.get("stored");

  if (kind !== "image" && kind !== "audio") return fail("Unknown upload kind.");
  if (!Number.isInteger(offset) || offset < 0) return fail("Bad chunk offset.");

  const extension = extensionOf(name);
  const allowed = kind === "image" ? IMAGE_EXTENSIONS : AUDIO_EXTENSIONS;
  if (!allowed.has(extension)) {
    return fail(
      `${name || "That file"} isn't a supported ${kind} format (${[...allowed].join(", ")}).`
    );
  }

  // The first chunk names the file; later chunks have to say which one they
  // belong to, and that name is checked against the job's own directory.
  let target: string;
  let storedName: string;

  if (offset === 0) {
    storedName =
      kind === "audio"
        ? `audio.${extension}`
        : `img-${String(job.nextImage++).padStart(4, "0")}.${extension}`;
    const resolved = resolveInside(job, kind === "audio" ? "" : "images", storedName);
    if (!resolved) return fail("Could not place that file.", 500);
    target = resolved;
    await fs.writeFile(target, new Uint8Array(0));
  } else {
    if (!stored) return fail("Continuation chunk with no file name.");
    const resolved = resolveInside(job, kind === "audio" ? "" : "images", stored);
    if (!resolved) return fail("Rejected file name.");
    target = resolved;
    storedName = stored;
    const existing = await fs.stat(target).catch(() => null);
    if (!existing) return fail("That upload was never started.", 409);
    if (existing.size !== offset) {
      return fail(
        `Chunk out of order: the file is ${existing.size} bytes but the chunk starts at ${offset}.`,
        409
      );
    }
  }

  const body = Buffer.from(await request.arrayBuffer());
  if (body.byteLength === 0 && offset === 0) return fail(`${name} is empty.`);

  const limit = kind === "audio" ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
  if (offset + body.byteLength > limit) {
    await fs.rm(target, { force: true }).catch(() => {});
    return fail(
      `${name} is larger than the ${Math.round(limit / 1024 / 1024)} MB limit for ${kind} files.`,
      413
    );
  }

  await fs.appendFile(target, body);
  const size = offset + body.byteLength;

  return NextResponse.json<UploadResponse>({
    ok: true,
    stored: path.basename(storedName),
    bytes: size,
  });
}
