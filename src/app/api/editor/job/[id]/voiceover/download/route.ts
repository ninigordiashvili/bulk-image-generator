import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { getJob } from "@/server/editor/jobs";

/**
 * Hands back the joined narration bed. The browser then treats it exactly like
 * a file that was dropped on the editor, which keeps one path through the rest
 * of the app rather than a second kind of audio that behaves almost the same.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/editor/job/[id]/voiceover/download">
) {
  const { id } = await context.params;
  const job = getJob(id);
  if (!job) return new Response("No such editing session.", { status: 404 });

  const file = path.join(job.dir, "voice-bed.m4a");
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) return new Response("Nothing has been joined for this session.", { status: 404 });

  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: {
      "Content-Type": "audio/mp4",
      "Content-Length": String(stat.size),
      "Cache-Control": "no-store",
      "Content-Disposition": 'inline; filename="narration.m4a"',
    },
  });
}
