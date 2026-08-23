import type { Metadata } from "next";
import { SoundEditor } from "@/components/sound/SoundEditor";
import { canRender } from "@/server/editor/host";

export const metadata: Metadata = {
  title: "Sound Editor — Bulk AI Generator",
  description: "Join voiceover takes into one narration bed and tighten the pauses.",
};

/**
 * Rendered per request: whether this copy can run ffmpeg is a property of the
 * machine serving it, and prerendering would bake in whatever was true on the
 * build machine.
 */
export const dynamic = "force-dynamic";

export default function SoundPage() {
  return <SoundEditor renderable={canRender()} />;
}
