import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { getJob } from "@/server/editor/jobs";

/**
 * Hands back the joined narration bed, in either format it was written in.
 *
 * m4a is what the editor wants as an audio bed; mp3 is what everything else in
 * the world wants. Both come out of the same tightened audio, so picking one is
 * only a question of what you're handing it to.
 */
const FORMATS = {
  m4a: { file: "voice-bed.m4a", type: "audio/mp4" },
  mp3: { file: "voice-bed.mp3", type: "audio/mpeg" },
} as const;

export async function GET(
  request: Request,
  context: RouteContext<"/api/editor/job/[id]/voiceover/download">
) {
  const { id } = await context.params;
  const job = getJob(id);
  if (!job) return new Response("No such editing session.", { status: 404 });

  const asked = new URL(request.url).searchParams.get("format");
  const format = asked === "mp3" ? FORMATS.mp3 : FORMATS.m4a;

  const file = path.join(job.dir, format.file);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) return new Response("Nothing has been joined for this session.", { status: 404 });

  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: {
      "Content-Type": format.type,
      "Content-Length": String(stat.size),
      "Cache-Control": "no-store",
      "Content-Disposition": `inline; filename="narration.${asked === "mp3" ? "mp3" : "m4a"}"`,
    },
  });
}
