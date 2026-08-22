import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

/**
 * ffmpeg ships with the app rather than being expected on the PATH. Rendering
 * is the one thing this editor does; making it depend on a system install the
 * machine may not have would mean the app is broken for half its users on
 * arrival. `serverExternalPackages` in next.config keeps these two out of the
 * bundle so the resolved paths still point at the real binaries.
 */
export const FFMPEG = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string);
export const FFPROBE = process.env.FFPROBE_PATH || ffprobeStatic.path;

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  /**
   * Called with each `key=value` line ffmpeg writes under `-progress pipe:1`.
   * Only useful for the long-running passes; the per-image segments finish too
   * quickly for it to be worth wiring up.
   */
  onProgress?: (key: string, value: string) => void;
}

/**
 * Runs a binary to completion. stderr is kept but capped — a failing ffmpeg can
 * emit a megabyte of repeated frame warnings, and only the tail ever says why.
 */
export function run(
  bin: string,
  args: string[],
  options: RunOptions = {}
): Promise<RunResult> {
  const { signal, onProgress } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Cancelled."));
      return;
    }

    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout = (stdout + text).slice(-8000);
      if (!onProgress) return;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const split = line.indexOf("=");
        if (split > 0) {
          onProgress(line.slice(0, split).trim(), line.slice(split + 1).trim());
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });

    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new Error("Cancelled."));
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new FfmpegError(`${bin.split("/").pop()} exited with ${code}`, stderr));
      }
    });
  });
}

/** Container duration in seconds, or 0 when the file has none ffprobe can read. */
export async function probeDuration(
  file: string,
  signal?: AbortSignal
): Promise<number> {
  const { stdout } = await run(
    FFPROBE,
    [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { signal }
  );
  const value = Number.parseFloat(stdout.trim());
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** True if the ffmpeg we shipped can actually use this encoder on this machine. */
export async function encoderWorks(name: string): Promise<boolean> {
  try {
    await run(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=320x180:r=10:d=0.3",
      "-c:v", name, "-frames:v", "3", "-f", "null", "-",
    ]);
    return true;
  } catch {
    return false;
  }
}
