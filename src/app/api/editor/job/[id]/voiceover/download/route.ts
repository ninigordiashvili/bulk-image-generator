import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { JOB_ID, jobRoot } from "@/server/editor/jobs";

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
  // The id is checked rather than looked up. Reading a finished file back is a
  // question about the disk, not about whether the server still remembers the
  // session: the join can outlive the registry entry, because the dev server
  // drops its in-memory state whenever it reloads the server modules — and a
  // long join writing tens of megabytes is itself enough to provoke that when
  // the scratch directory sits inside the dev root, which on Windows it does.
  // Losing the map that way used to strand audio that was sitting right there.
  // Sixteen hex characters can't escape the root, so this is the same guard
  // resolveInside applies, in the one shape this route needs.
  if (!JOB_ID.test(id)) return new Response("No such editing session.", { status: 404 });

  const asked = new URL(request.url).searchParams.get("format");
  const format = asked === "mp3" ? FORMATS.mp3 : FORMATS.m4a;

  const dir = path.join(jobRoot(), id);
  const file = path.join(dir, format.file);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) {
    // Which of the two it is matters to whoever is reading the message: a
    // swept session is gone for good, an unjoined one only needs the button.
    const session = await fs.stat(dir).catch(() => null);
    return new Response(
      session
        ? "Nothing has been joined for this session."
        : "That editing session is no longer on disk — join the takes again.",
      { status: 404 }
    );
  }

  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: {
      "Content-Type": format.type,
      "Content-Length": String(stat.size),
      "Cache-Control": "no-store",
      "Content-Disposition": `inline; filename="narration.${asked === "mp3" ? "mp3" : "m4a"}"`,
    },
  });
}
