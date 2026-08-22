import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { getJob, outputPath } from "@/server/editor/jobs";

/**
 * Serves the finished MP4. Range requests are honoured because the editor plays
 * the result back in the page before you download it, and a `<video>` element
 * won't scrub a response that arrives as one undivided stream.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/editor/job/[id]/output">
) {
  const { id } = await context.params;
  const job = getJob(id);
  if (!job) return new Response("No such editing session.", { status: 404 });

  const file = outputPath(job);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) return new Response("This session has no rendered video.", { status: 404 });

  const url = new URL(request.url);
  const download = url.searchParams.get("download") === "1";
  const name = safeName(url.searchParams.get("name"));

  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
  });

  const range = request.headers.get("range");
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);

  if (match) {
    const size = stat.size;
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;

    if (!Number.isFinite(start) || start > end || start >= size) {
      return new Response("Range not satisfiable.", {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }

    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(toWebStream(file, start, end), { status: 206, headers });
  }

  headers.set("Content-Length", String(stat.size));
  return new Response(toWebStream(file), { status: 200, headers });
}

function toWebStream(file: string, start?: number, end?: number): ReadableStream {
  const node = createReadStream(file, start === undefined ? {} : { start, end });
  return Readable.toWeb(node) as ReadableStream;
}

/** Keeps a user-typed export name from steering the Content-Disposition. */
function safeName(raw: string | null): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/["\r\n\0]/g, "").trim();
  if (!cleaned) return "slideshow.mp4";
  return cleaned.toLowerCase().endsWith(".mp4") ? cleaned : `${cleaned}.mp4`;
}
