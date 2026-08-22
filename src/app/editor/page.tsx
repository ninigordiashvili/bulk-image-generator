import type { Metadata } from "next";
import { VideoEditor } from "@/components/editor/VideoEditor";
import { canRender } from "@/server/editor/host";

/**
 * Rendered per request, not at build time. Whether this copy can render video
 * is a property of the machine it's running on, and prerendering would bake in
 * whatever was true on the build machine — telling a deployed copy it can
 * export, or a local one that it can't.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Video Editor — Bulk AI Generator",
  description: "Assemble timestamped images and an audio track into an MP4.",
};

export default function EditorPage() {
  // Read on the server so the page can say this before anything is uploaded,
  // rather than failing at export time after a few hundred megabytes.
  return <VideoEditor renderable={canRender()} />;
}
