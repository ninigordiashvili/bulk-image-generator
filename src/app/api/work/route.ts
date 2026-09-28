import { createWork, listWork } from "@/server/work";
import { canRender } from "@/server/editor/host";
export const runtime = "nodejs";
export async function GET() { return Response.json({ ok: true, batches: await listWork() }, { headers: { "Cache-Control": "no-store" } }); }
export async function POST(request: Request) {
  if (!canRender()) return Response.json({ ok: false, error: "Background generation needs the local app server." }, { status: 501 });
  try { return Response.json({ ok: true, status: await createWork(await request.json()) }); }
  catch (error) { return Response.json({ ok: false, error: error instanceof Error ? error.message : "Could not create batch." }, { status: 400 }); }
}
