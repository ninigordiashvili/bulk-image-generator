import { listHeygenLooks } from "@/server/heygen";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const result = await listHeygenLooks(params.get("ownership") === "public" ? "public" : "private", params.get("token") || "");
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Could not load HeyGen avatars." }, { status: 400 });
  }
}
