import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Vertex accounts, so more than one Google account can be used from the app.
 *
 * This mirrors `accounts.ts` deliberately — same gitignored-file-in-the-root
 * shape, same "one broken entry must not disable the working ones" rule — but
 * what it holds is different in a way that matters. kie.ai accounts hold a
 * secret. Vertex accounts hold a *pointer* to a credential: either the machine's
 * Application Default Credentials, or a path to a key file. No secret is ever
 * stored in this repo, and none is ever sent to the browser.
 *
 * Two accounts need two credential sources because ADC is singular: one
 * `gcloud auth application-default login` per machine, one account. So at most
 * one entry can use `"adc"`; any other needs its own `keyFile`, which may be
 * either a service-account key or a copy of an ADC file captured while that
 * account was logged in.
 */

const CONFIG_FILE = "vertex-accounts.json";

export class VertexAccountError extends Error {}

export interface VertexAccount {
  id: string;
  label: string;
  projectId: string;
  /** Default endpoint; per-model locations still override this. */
  location: string;
  /**
   * `"adc"` uses the machine's Application Default Credentials. Anything else is
   * a path to a credentials JSON file — absolute, or relative to the project
   * root. The file is read by the Google auth library, never by us.
   */
  credentials: "adc" | string;
  /** Per-account quota, since it is granted per project and differs per account. */
  imageRequestsPerMinute?: number;
  videoRequestsPerMinute?: number;
  /**
   * How many calls of each kind may run at once for this account.
   *
   * Deliberately here rather than in `.env.local`: this file is re-read on every
   * request, so it can be changed while a batch is queued and takes effect on
   * the next call. Editing an env var restarts the dev server instead, and the
   * storyboard does not survive a page reload — the shots hold megabytes of
   * base64 each and are never persisted, so a restart costs whatever was typed.
   */
  imageConcurrency?: number;
  videoConcurrency?: number;
  /** Credit remaining, for display only — Google exposes no API for it. */
  creditUsd?: number;
}

/** What the browser is allowed to see: no paths, no project ids. */
export interface VertexAccountPublic {
  id: string;
  label: string;
  imageRequestsPerMinute?: number;
  videoRequestsPerMinute?: number;
  creditUsd?: number;
}

export interface LoadedVertexAccounts {
  accounts: VertexAccount[];
  problems: { id: string; problem: string }[];
}

const PLACEHOLDER = /PASTE_|YOUR_|CHANGE_ME/i;

/**
 * Reads the account list. A missing file is not an error: it falls back to a
 * single account built from the environment, which is exactly the setup that
 * existed before multiple accounts were supported.
 */
export async function loadVertexAccounts(): Promise<LoadedVertexAccounts> {
  const fallback = envAccount();

  let raw: string;
  try {
    raw = await readFile(path.join(process.cwd(), CONFIG_FILE), "utf8");
  } catch {
    return fallback
      ? { accounts: [fallback], problems: [] }
      : {
          accounts: [],
          problems: [
            {
              id: "-",
              problem:
                `No ${CONFIG_FILE} and no GOOGLE_CLOUD_PROJECT. Copy ` +
                `${CONFIG_FILE}.example to ${CONFIG_FILE}, or set the env vars.`,
            },
          ],
        };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A file that exists but cannot be parsed is fatal: silently falling back
    // would spend the wrong account's credits.
    throw new VertexAccountError(`${CONFIG_FILE} is not valid JSON.`);
  }

  if (!Array.isArray(parsed)) {
    throw new VertexAccountError(`${CONFIG_FILE} must contain an array.`);
  }

  const accounts: VertexAccount[] = [];
  const problems: { id: string; problem: string }[] = [];
  const seen = new Set<string>();

  parsed.forEach((entry, index) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const where = id || `entry ${index + 1}`;

    if (!id) {
      problems.push({ id: where, problem: "Missing `id`." });
      return;
    }
    if (seen.has(id)) {
      problems.push({ id: where, problem: "Duplicate `id`." });
      return;
    }
    const projectId = typeof row.projectId === "string" ? row.projectId.trim() : "";
    if (!projectId || PLACEHOLDER.test(projectId)) {
      problems.push({ id: where, problem: "Missing or placeholder `projectId`." });
      return;
    }

    const credentials =
      typeof row.credentials === "string" && row.credentials.trim()
        ? row.credentials.trim()
        : "adc";

    seen.add(id);
    accounts.push({
      id,
      label: typeof row.label === "string" && row.label ? row.label : id,
      projectId,
      location:
        typeof row.location === "string" && row.location ? row.location : "us-central1",
      credentials,
      imageRequestsPerMinute: positive(row.imageRequestsPerMinute),
      videoRequestsPerMinute: positive(row.videoRequestsPerMinute),
      imageConcurrency: positive(row.imageConcurrency),
      videoConcurrency: positive(row.videoConcurrency),
      creditUsd: positive(row.creditUsd),
    });
  });

  if (accounts.length === 0 && fallback) accounts.push(fallback);
  return { accounts, problems };
}

export function publicView(account: VertexAccount): VertexAccountPublic {
  return {
    id: account.id,
    label: account.label,
    imageRequestsPerMinute: account.imageRequestsPerMinute,
    videoRequestsPerMinute: account.videoRequestsPerMinute,
    creditUsd: account.creditUsd,
  };
}

export async function findVertexAccount(
  id: string | undefined
): Promise<VertexAccount> {
  const { accounts } = await loadVertexAccounts();
  if (accounts.length === 0) {
    throw new VertexAccountError("No Vertex account is configured.");
  }
  if (!id) return accounts[0];
  const found = accounts.find((account) => account.id === id);
  if (!found) throw new VertexAccountError(`No Vertex account named "${id}".`);
  return found;
}

function positive(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The pre-multi-account setup, kept working. */
function envAccount(): VertexAccount | null {
  const projectId =
    process.env.GOOGLE_CLOUD_PROJECT || process.env.VERTEX_PROJECT_ID || "";
  if (!projectId) return null;
  return {
    id: "default",
    label: "Default (from .env.local)",
    projectId,
    location:
      process.env.GOOGLE_CLOUD_LOCATION || process.env.VERTEX_LOCATION || "us-central1",
    credentials: "adc",
    creditUsd: Number(process.env.VERTEX_CREDIT_USD) || undefined,
  };
}
