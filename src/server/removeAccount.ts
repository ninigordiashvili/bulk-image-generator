import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { withIdleAccount } from "./work";

/** Remove only the app configuration; provider accounts, key files and usage remain. */
export async function removeAccount(provider: "kie" | "vertex", id: string) {
  if (!id || id.length > 200) throw new Error("Select an account to remove.");
  return withIdleAccount(provider, id, () => {
    const name = provider === "vertex" ? "vertex-accounts.json" : "kie-accounts.json";
    const file = path.join(process.cwd(), name);
    let raw: string | undefined;
    try { raw = readFileSync(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const entries = raw === undefined ? [] : JSON.parse(raw);
    if (!Array.isArray(entries)) throw new Error("Account configuration is invalid.");
    const exists = entries.some(entry => entry?.id === id);
    const envKie = provider === "kie" && id === "env" && !!process.env.KIE_API_KEY;
    const envVertex = provider === "vertex" && id === "default" && raw === undefined
      && !!(process.env.GOOGLE_CLOUD_PROJECT || process.env.VERTEX_PROJECT_ID);
    if (!exists && !envKie && !envVertex) throw new Error("Account not found. Reload accounts and try again.");
    const remaining = entries.filter(entry => entry?.id !== id);
    // Prevent the environment fallback from immediately reappearing in the list.
    if (envKie) remaining.push({ id: "env", disabled: true });
    const backupDir = path.join(process.cwd(), ".local");
    mkdirSync(backupDir, { recursive: true });
    if (raw !== undefined) writeFileSync(path.join(backupDir, `${provider}-accounts-before-removal-${randomUUID()}.json`), raw, { flag: "wx" });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(remaining, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, file);
  });
}
