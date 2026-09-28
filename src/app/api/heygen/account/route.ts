import { heygenApi } from "@/server/heygen";
export const runtime = "nodejs";
export async function GET() {
  try {
    const result = await heygenApi<{ data: { wallet?: { remaining_balance?: number; currency?: string } } }>("users/me");
    return Response.json({ ok: true, account: { id: "main", label: "HeyGen", provider: "heygen" }, wallet: result.data.wallet });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Could not connect to HeyGen." }, { status: 400 });
  }
}
