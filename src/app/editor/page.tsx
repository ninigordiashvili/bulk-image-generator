import type { Metadata } from "next";
import { VideoEditor } from "@/components/editor/VideoEditor";

export const metadata: Metadata = {
  title: "Video Editor — Bulk AI Generator",
  description: "Assemble timestamped images and an audio track into an MP4.",
};

export default function EditorPage() {
  return <VideoEditor />;
}
