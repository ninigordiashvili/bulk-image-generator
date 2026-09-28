import { cancelWork, setWorkConcurrency, startWork, uploadWork, workResult, workStatus } from "@/server/work";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
const fail = (error: unknown) => Response.json({ ok: false, error: error instanceof Error ? error.message : "Batch request failed." }, { status: 400 });
export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const index = new URL(request.url).searchParams.get("result");
    return Response.json(index === null ? { ok: true, status: await workStatus(id) } : await workResult(id, Number(index)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error); }
}
export async function PUT(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const params = new URL(request.url).searchParams;
    const bytes = new Uint8Array(await request.arrayBuffer());
    return Response.json({ ok: true, received: await uploadWork(id, Number(params.get("index")), Number(params.get("offset")), Number(params.get("total")), bytes) });
  } catch (error) { return fail(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    if (body.concurrency !== undefined) return Response.json({ ok: true, status: await setWorkConcurrency(id, body.concurrency) });
    const retry = body.retry === true || typeof body.retry === "string" ? body.retry : undefined;
    return Response.json({ ok: true, status: await startWork(id, retry) });
  } catch (error) { return fail(error); }
}
export async function DELETE(_request: Request, context: Context) {
  try { return Response.json({ ok: true, status: await cancelWork((await context.params).id) }); }
  catch (error) { return fail(error); }
}
