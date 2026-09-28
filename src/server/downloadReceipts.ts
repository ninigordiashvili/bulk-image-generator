import { createHash } from "node:crypto";
import os from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";

// Small receipts outlive the payload so other browsers can expire their copies.
const ROOT = process.env.DOWNLOAD_RECEIPTS_ROOT || path.join(os.tmpdir(), "bulk-generator-download-history");
function receiptPath(dir: string) { return path.join(ROOT, createHash("sha256").update(path.resolve(dir)).digest("hex") + ".json"); }
const writes = ((globalThis as { __downloadWrites?: Map<string, Promise<void>> }).__downloadWrites ??= new Map());
export async function readDownloads(dir: string): Promise<Record<string, number>> {
  try { return JSON.parse(await fs.readFile(receiptPath(dir), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
/** Preserve the first download timestamp, including across server restarts. */
export async function recordDownload(dir: string, key: string, notBefore = 0) {
  const pending = (writes.get(dir) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const receipts = await readDownloads(dir);
    if (receipts[key] >= notBefore && receipts[key] > 0) return;
    receipts[key] = Date.now();
    await fs.mkdir(ROOT, { recursive: true });
    const file = receiptPath(dir);
    await fs.writeFile(file + ".tmp", JSON.stringify(receipts));
    await fs.rename(file + ".tmp", file);
  });
  writes.set(dir, pending);
  try { await pending; } finally { if (writes.get(dir) === pending) writes.delete(dir); }
}
