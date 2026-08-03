import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AccountProblem, KieAccountSecret } from "@/types";

const CONFIG_FILE = "kie-accounts.json";

const PLACEHOLDERS = new Set([
  "PASTE_KIE_API_KEY_HERE",
  "PASTE_SECOND_KIE_API_KEY_HERE",
  "your-kie-api-key",
]);

export class AccountConfigError extends Error {}

export interface LoadedAccounts {
  accounts: KieAccountSecret[];
  problems: AccountProblem[];
}

/**
 * Reads kie.ai API keys from the gitignored config in the project root, falling
 * back to `KIE_API_KEY` when the file is absent. Server-only — the keys in here
 * must never be serialized to the client.
 *
 * Per-entry failures do NOT throw: a single half-configured account is reported
 * as a problem so the accounts that *are* usable stay usable. Only a file that
 * exists but can't be understood at all is fatal.
 */
export async function loadAccounts(): Promise<LoadedAccounts> {
  const fromEnv = envAccount();

  let raw: string;
  try {
    raw = await readFile(path.join(process.cwd(), CONFIG_FILE), "utf8");
  } catch {
    if (fromEnv) return { accounts: [fromEnv], problems: [] };
    throw new AccountConfigError(
      `No kie.ai key configured. Copy ${CONFIG_FILE}.example to ${CONFIG_FILE} and paste your key from https://kie.ai/api-key, or set KIE_API_KEY.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AccountConfigError(`${CONFIG_FILE} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new AccountConfigError(`${CONFIG_FILE} must contain a JSON array.`);
  }

  const accounts: KieAccountSecret[] = [];
  const problems: AccountProblem[] = [];
  const seenIds = new Set<string>();

  parsed.forEach((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const id = str(record.id);
    const label = str(record.label) || id || `entry ${index}`;
    const apiKey = str(record.apiKey);

    if (!id) {
      problems.push({
        id: `entry-${index}`,
        label,
        reason: `Entry ${index} has no "id".`,
      });
      return;
    }
    if (seenIds.has(id)) {
      problems.push({
        id,
        label,
        reason: `Duplicate id "${id}" — only the first entry with this id is used.`,
      });
      return;
    }
    seenIds.add(id);

    if (!apiKey) {
      problems.push({
        id,
        label,
        reason: `No "apiKey". Create one at https://kie.ai/api-key.`,
      });
      return;
    }
    if (PLACEHOLDERS.has(apiKey)) {
      problems.push({
        id,
        label,
        reason: `Still has the placeholder apiKey. Paste your kie.ai key, or delete this entry.`,
      });
      return;
    }

    accounts.push({ id, label, apiKey, source: "file" });
  });

  // The env key is a convenience fallback, so a configured file wins for the
  // same id rather than shadowing what the user deliberately wrote down.
  if (fromEnv && !seenIds.has(fromEnv.id)) accounts.push(fromEnv);

  return { accounts, problems };
}

function envAccount(): KieAccountSecret | null {
  const apiKey = str(process.env.KIE_API_KEY);
  if (!apiKey || PLACEHOLDERS.has(apiKey)) return null;
  return { id: "env", label: "KIE_API_KEY (env)", apiKey, source: "env" };
}

export async function findAccount(accountId: string): Promise<KieAccountSecret> {
  const { accounts, problems } = await loadAccounts();
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (account) return account;

  // If the id exists but was rejected, say why rather than "no such account".
  const problem = problems.find((candidate) => candidate.id === accountId);
  throw new AccountConfigError(
    problem
      ? `Account "${problem.label}" is not usable: ${problem.reason}`
      : `No account with id "${accountId}" in ${CONFIG_FILE}.`
  );
}

/** Last four characters of a key — enough to tell two accounts apart, safely. */
export function keyHint(apiKey: string): string {
  return apiKey.length <= 4 ? "••••" : `••••${apiKey.slice(-4)}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
