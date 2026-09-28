import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { FFMPEG, FFPROBE, run } from "./editor/ffmpeg";

/** Keep the selected recording intact. Video time is bounded by its frame grid. */
export async function finishHeygenVideo(bytes: Uint8Array, audio: { base64: string; seconds: number }, mime: string, signal: AbortSignal) {
  const root = path.resolve(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(root, "bulk-heygen-"));
  const extension = mime.includes("webm") ? "webm" : "mp4";
  const input = path.join(dir, "input." + extension), voice = path.join(dir, "voice.wav"), output = path.join(dir, "output." + extension);
  try {
    await fs.writeFile(input, bytes);
    await fs.writeFile(voice, Buffer.from(audio.base64, "base64"));
    const probe = JSON.parse((await run(FFPROBE, ["-v", "error", "-show_streams", "-show_format", "-of", "json", input], { signal })).stdout);
    const video = probe.streams?.find((stream: { codec_type: string }) => stream.codec_type === "video");
    if (!video) throw new Error("HeyGen returned a file without a video stream.");
    const duration = Number(video.duration ?? probe.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not verify HeyGen video duration.");
    // Copy video losslessly when its duration already matches; only repair actual mismatch.
    const repair = Math.abs(duration - audio.seconds) > 0.05;
    const codec = extension === "webm"
      ? ["-c:v", "libvpx-vp9", "-crf", "18", "-b:v", "0", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0"]
      : ["-c:v", "libx264", "-crf", "16", "-preset", "fast"];
    await run(FFMPEG, ["-y", "-threads", "1", ...(extension === "webm" ? ["-c:v", "libvpx-vp9"] : []), "-i", input, "-i", voice,
      "-map", "0:v:0", "-map", "1:a:0", "-t", String(audio.seconds),
      ...(repair ? ["-vf", `tpad=stop_mode=clone:stop_duration=${Math.max(0, audio.seconds - duration) + 0.1},trim=duration=${audio.seconds},setpts=PTS-STARTPTS`, ...codec] : ["-c:v", "copy"]),
      "-threads", "1", "-filter_threads", "1", "-c:a", extension === "webm" ? "libopus" : "aac", "-b:a", "192k",
      ...(extension === "mp4" ? ["-movflags", "+faststart"] : []), output], { signal });
    const finalProbe = JSON.parse((await run(FFPROBE, ["-v", "error", "-show_format", "-of", "json", output], { signal })).stdout);
    if (Math.abs(Number(finalProbe.format?.duration) - audio.seconds) > 0.1) throw new Error("HeyGen video duration could not be matched to the selected audio. Retry reuses the generated video.");
    return new Uint8Array(await fs.readFile(output));
  } finally {
    if (path.dirname(path.resolve(dir)) === root && path.basename(dir).startsWith("bulk-heygen-")) await fs.rm(dir, { recursive: true, force: true });
  }
}
