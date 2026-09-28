/** Saved app copies expire two days after their first download. */
export const RETENTION_MS = 48 * 60 * 60 * 1000;
export function downloadExpired(downloadedAt: number | undefined, now = Date.now()) {
  return typeof downloadedAt === "number" && Number.isFinite(downloadedAt)
    && downloadedAt > 0 && now - downloadedAt >= RETENTION_MS;
}
