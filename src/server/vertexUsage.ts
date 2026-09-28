import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface UsageRecord {
  at: number; accountId: string; model: string; kind: "image" | "video";
  units: number; usd: number; estimated: boolean;
}
const file = () => process.env.VERTEX_USAGE_FILE || path.join(process.cwd(), ".local", "vertex-usage.jsonl");
const state = (globalThis as typeof globalThis & { __vertexUsagePending?: Map<string, UsageRecord> });
const pending = state.__vertexUsagePending ??= new Map<string, UsageRecord>();

export function readUsage(): { entries: UsageRecord[]; error?: string } {
  const rows = new Map<string, UsageRecord>();
  let error: string | undefined;
  try {
    for (const line of readFileSync(file(), "utf8").split("\n").filter(Boolean)) {
      try {
        const row = JSON.parse(line);
        if (typeof row.id !== "string" || typeof row.accountId !== "string" || !Number.isFinite(row.usd) || row.usd < 0 || !Number.isFinite(row.at)) throw new Error("Invalid usage record");
        rows.set(row.id, row);
      } catch { error = "Some spending history could not be read; totals may be incomplete."; }
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") error = "Spending history could not be read.";
  }
  for (const [id, entry] of pending) rows.set(id, entry);
  if (pending.size) error = "Some spending history is not saved to disk yet.";
  return { entries: [...rows.values()], error };
}

export function saveUsage(entry: UsageRecord, legacy = false, stableId?: string) {
  const id = stableId ?? (legacy ? createHash("sha256").update(JSON.stringify(entry)).digest("hex") : randomUUID());
  pending.set(id, entry);
  try {
    mkdirSync(path.dirname(file()), { recursive: true });
    // Leading newline isolates an interrupted final write from future records.
    for (const [key, row] of pending) {
      appendFileSync(file(), "\n" + JSON.stringify({ ...row, id: key }) + "\n", "utf8");
      pending.delete(key);
    }
  } catch {
    // Never turn a successfully billed generation into a retry because disk failed.
    console.error("Vertex spending history could not be saved; retained in memory.");
  }
}

// Persist pending batch estimates so other calls see them after a server restart.
const reservationFile = () => `${file()}.reservations.json`;
function reservations(): Record<string, { accountId: string; usd: number }> {
  try { return JSON.parse(readFileSync(reservationFile(), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
export function reservedBatchUsd(accountId: string) {
  return Object.values(reservations()).filter(row => row.accountId === accountId).reduce((sum, row) => sum + row.usd, 0);
}
export function setBatchReservation(id: string, accountId: string, usd: number) {
  const rows = reservations();
  if (usd > 0) rows[id] = { accountId, usd }; else delete rows[id];
  mkdirSync(path.dirname(reservationFile()), { recursive: true });
  const temporary = `${reservationFile()}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(rows));
  renameSync(temporary, reservationFile());
}

export function accountUsage(accountId: string, creditUsd?: number) {
  const { entries, error } = readUsage();
  const rows = entries.filter(row => row.accountId === accountId);
  const spentUsd = rows.reduce((sum, row) => sum + row.usd, 0);
  return {
    spentUsd, remainingUsd: creditUsd === undefined ? null : Math.max(0, creditUsd - spentUsd),
    startingCreditUsd: creditUsd ?? null,
    since: rows.length ? Math.min(...rows.map(row => row.at)) : null,
    ratesUnverified: rows.some(row => row.estimated), error,
  };
}
