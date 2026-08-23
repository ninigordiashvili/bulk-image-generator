/**
 * Files named `1`, `2`, `10` must run 1, 2, 10 — not 1, 10, 2.
 *
 * This works on the names the user gave their files, which is why it lives
 * here rather than on the server: by the time a track has been uploaded it is
 * called `voice-004`, and that number records the order it happened to arrive
 * in. Sorting those would put a batch back into upload order, which is exactly
 * the mistake this exists to avoid.
 */
export function inScriptOrder<T>(items: T[], nameOf: (item: T) => string): T[] {
  const numberIn = (item: T) => {
    const match = nameOf(item).replace(/\.[^.]+$/, "").match(/\d+/);
    return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
  };
  return [...items].sort(
    (a, b) =>
      numberIn(a) - numberIn(b) ||
      nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true })
  );
}
