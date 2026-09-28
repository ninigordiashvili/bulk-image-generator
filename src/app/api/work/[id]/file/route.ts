import path from "node:path";
import { workDir, workResult, workStatus, recordWorkDownload } from "@/server/work";
import { serveFile } from "@/server/serveFile";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const params = new URL(request.url).searchParams;
    const index = Number(params.get("index"));
    const result = await workResult(id, index);
    if (!result.ok) throw new Error("No result.");
    const job = (await workStatus(id)).jobs[index];
    if ("video" in result) return serveFile(request, path.join(workDir(id), `video-${index}.bin`), result.mimeType, job.files![0].name, () => recordWorkDownload(id, index));
    const imageIndex = Number(params.get("image") || 0);
    const image = result.images[imageIndex];
    if (!image) throw new Error("Image not found.");
    const name = job.files![imageIndex].name;
    const bytes = Buffer.from(image.base64, "base64");
    let sent = false;
    const stream = new ReadableStream({
      async pull(controller) {
        if (!sent) { sent = true; controller.enqueue(bytes); return; }
        controller.close();
        if (params.has("download")) await recordWorkDownload(id, index, imageIndex).catch(error => console.error("Download receipt failed", error));
      },
    }, { highWaterMark: 0 });
    return new Response(stream, { headers: { "Content-Type": image.mimeType, "Cache-Control": "no-store",
      ...(params.has("download") ? { "Content-Disposition": `attachment; filename="${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}` } : {}) } });
  } catch (error) { return new Response(error instanceof Error ? error.message : "Result unavailable.", { status: 404 }); }
}
