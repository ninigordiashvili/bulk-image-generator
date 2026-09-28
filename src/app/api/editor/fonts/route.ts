import { readFile } from "node:fs/promises";
import { STYLE_ORDER, TEXT_STYLES, type MomentStyle } from "@/lib/editor/textStyles";
import { fontFileFor } from "@/server/editor/textOverlay";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const style = new URL(request.url).searchParams.get("style") as MomentStyle;
  if (!STYLE_ORDER.includes(style)) return new Response("Unknown font", { status: 400 });
  const file = fontFileFor(TEXT_STYLES[style].files);
  if (!file) return new Response("Font unavailable", { status: 404 });
  return new Response(await readFile(file), { headers: { "Content-Type": "font/ttf", "Cache-Control": "private, max-age=3600" } });
}
