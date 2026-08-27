import { NextResponse } from "next/server";
import {
  VertexAccountError,
  loadVertexAccounts,
  type VertexAccount,
} from "@/server/vertexAccounts";
import type { AccountsResponse } from "@/types";

/**
 * The Vertex accounts, in the same shape as `/api/accounts`.
 *
 * Matching the kie response deliberately: the account picker is one component
 * and should stay one component. What differs is only what goes in `keyHint`,
 * which for kie is a masked key and here is the thing you actually need to see
 * when choosing between two Google accounts — the credit left and the rate the
 * project is allowed.
 *
 * Nothing sensitive crosses the wire: no project ids, no credential paths.
 */
function hint(account: VertexAccount): string {
  const parts: string[] = [];
  if (account.creditUsd) parts.push(`$${account.creditUsd} credit`);
  if (account.imageRequestsPerMinute) {
    parts.push(`${account.imageRequestsPerMinute} img/min`);
  }
  if (account.videoRequestsPerMinute) {
    parts.push(`${account.videoRequestsPerMinute} video/min`);
  }
  return parts.join(" · ") || "Vertex AI";
}

export async function GET() {
  try {
    const { accounts, problems } = await loadVertexAccounts();
    return NextResponse.json<AccountsResponse>({
      ok: true,
      accounts: accounts.map((account) => ({
        id: account.id,
        label: account.label,
        keyHint: hint(account),
        // Vertex never reads a key from the environment the way kie can, but the
        // picker keys off this field, so an env-derived fallback says so.
        source: account.credentials === "adc" ? "env" : "file",
      })),
      problems: problems.map(({ id, problem }) => ({
        id,
        label: id,
        reason: problem,
      })),
    });
  } catch (error) {
    const message =
      error instanceof VertexAccountError
        ? error.message
        : "Failed to read Vertex account config.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
