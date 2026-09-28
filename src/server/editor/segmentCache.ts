import { downloadExpired } from "@/lib/retention";
import { readDownloads, recordDownload } from "../downloadReceipts";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FFMPEG } from "./ffmpeg";

const MAX_AGE = 48 * 60 * 60 * 1000;
// Bump when rendering behavior changes outside the generated FFmpeg arguments.
const VERSION = "segments-v1";

/** Shared across export sessions; only complete encodes are published. */
export class SegmentCache {
  readonly dir = process.env.EDITOR_CACHE_DIR || path.join(os.tmpdir(), "bulk-generator-segment-cache");
  private hashes = new Map<string, Promise<string>>();
  private pending = new Map<string, Promise<void>>();

  async prepare() {
    await fs.mkdir(this.dir, { recursive: true });
    await this.prune();
  }

  private digest(file: string): Promise<string> {
    let digest = this.hashes.get(file);
    if (!digest) {
      digest = (async () => {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        return hash.digest("hex");
      })();
      this.hashes.set(file, digest);
    }
    return digest;
  }

  async key(args: string[]): Promise<string> {
    const normalized = args.slice(0, -1);
    for (let i = 0; i < normalized.length; i++) {
      if (normalized[i] === "-i" && normalized[i - 1] !== "lavfi") {
        normalized[i + 1] = `sha256:${await this.digest(normalized[i + 1])}`;
      }
    }
    const binary = await fs.stat(FFMPEG);
    return createHash("sha256").update(JSON.stringify([
      VERSION, FFMPEG, binary.size, binary.mtimeMs, normalized,
    ])).digest("hex");
  }

  async materialize(args: string[], encode: (args: string[]) => Promise<unknown>): Promise<boolean> {
    const key = await this.key(args);
    const cached = path.join(this.dir, `${key}.ts`);
    const destination = args[args.length - 1];
    let reused = true;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = (async () => {
        const stat = await fs.stat(cached).catch(() => null);
        if (stat && stat.size > 0) return;
        reused = false;
        const temporary = path.join(this.dir, `${key}-${randomUUID()}.tmp`);
        try {
          await encode([...args.slice(0, -1), temporary]);
          await fs.rename(temporary, cached);
        } finally {
          await fs.rm(temporary, { force: true }).catch(() => {});
        }
      })();
      this.pending.set(key, pending);
    }
    await pending;
    await fs.copyFile(cached, destination);
    const now = new Date();
    await fs.utimes(cached, now, now);
    // Track each export using this segment. Shared cache must not expire while
    // any owning export is still undownloaded or inside its 48-hour window.
    const owner = path.dirname(path.dirname(destination));
    await recordDownload(path.join(this.dir, key), owner, now.getTime());
    return reused;
  }

  /** Remove only owned cache files whose exports have passed download retention. */
  async prune() {
    const entries = await fs.readdir(this.dir);
    const files = await Promise.all(entries.filter(name => /^[a-f0-9]{64}(?:-[a-f0-9-]+)?\.(ts|tmp)$/.test(name))
      .map(async name => ({ file: path.join(this.dir, name), stat: await fs.stat(path.join(this.dir, name)) })));
    files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const { file, stat } of files) {
      // Another app process may still be writing a temporary encode.
      if (file.endsWith(".tmp") && Date.now() - stat.mtimeMs <= MAX_AGE) continue;
      if (file.endsWith(".tmp")) {
        await fs.rm(file, { force: true });
        continue;
      }
      const owners = await readDownloads(path.join(this.dir, path.basename(file, ".ts")));
      const downloads = await Promise.all(Object.entries(owners).map(async ([dir, usedAt]) => {
        const receipt = await readDownloads(dir);
        return receipt.output >= usedAt && downloadExpired(receipt.output);
      }));
      // Legacy cache with no ownership record is retained rather than guessing.
      if (downloads.length > 0 && downloads.every(Boolean)) await fs.rm(file, { force: true });
    }
  }

  /** Called only when no export is active; remove cache segments and abandoned encodes. */
  async clear(): Promise<{ files: number; bytes: number }> {
    const names = await fs.readdir(this.dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    let files = 0;
    let bytes = 0;
    for (const name of names) {
      if (!/^[a-f0-9]{64}(?:-[a-f0-9-]+)?\.(?:ts|tmp)$/.test(name)) continue;
      const file = path.join(this.dir, name);
      const stat = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat?.isFile()) continue;
      await fs.rm(file, { force: true });
      files++;
      bytes += stat.size;
    }
    return { files, bytes };
  }
}
