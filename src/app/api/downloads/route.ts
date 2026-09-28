import { workDir } from "@/server/work";
import { readDownloads } from "@/server/downloadReceipts";
import { recordWorkDownload, workStatus } from "@/server/work";
export const runtime = "nodejs";
/** Called only after a gallery file or finished ZIP is handed to the browser. */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (Array.isArray(body.files)) {
      if (body.files.length > 1000) throw new Error("Too many files.");
      const cache = new Map<string, Record<string, number>>();
      const files = [];
      for (const file of body.files) {
        if (!cache.has(file.workId)) cache.set(file.workId, await readDownloads(workDir(file.workId)));
        const at = cache.get(file.workId)![`${file.workIndex}:${file.imageIndex ?? 0}`];
        if (at && at >= file.createdAt) files.push({ id: file.id, store: file.store, at });
      }
      return Response.json({ ok: true, files });
    }
    if (typeof body.id !== "string") throw new Error("Batch required.");
    if (body.all === true) {
      const batch = await workStatus(body.id);
      if (batch.phase !== "done") throw new Error("Batch is not finished.");
      for (const [index, job] of batch.jobs.entries()) {
        for (let image = 0; image < (job.files?.length ?? 0); image++) await recordWorkDownload(body.id, index, image);
      }
    } else {
      await recordWorkDownload(body.id, body.index, body.image ?? 0);
    }
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Could not record download." }, { status: 400 });
  }
}
