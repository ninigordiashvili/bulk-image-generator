import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";

export async function serveFile(request: Request, file: string, mimeType: string, name: string, downloaded?: () => Promise<void>) {
  const { size } = await fs.stat(file);
  const headers = new Headers({ "Content-Type": mimeType, "Cache-Control": "no-store", "Accept-Ranges": "bytes" });
  if (new URL(request.url).searchParams.has("download")) headers.set("Content-Disposition", `attachment; filename="${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  const range = request.headers.get("range");
  let start = 0, end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  headers.set("Content-Length", String(end - start + 1));
  const stream = createReadStream(file, { start, end });
  if (downloaded && new URL(request.url).searchParams.has("download") && start === 0 && end === size - 1) {
    stream.once("end", () => { void downloaded().catch(error => console.error("Download receipt failed", error)); });
  }
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: range ? 206 : 200, headers });
}
