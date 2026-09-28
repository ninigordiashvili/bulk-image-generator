import { removeAccount } from "@/server/removeAccount";
import { accountUsage } from "@/server/vertexUsage";
import { NextResponse } from "next/server";
import {
  addVertexAccount,
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
        usage: accountUsage(account.id, account.creditUsd),
        // Vertex never reads a key from the environment the way kie can, but the
        // picker keys off this field, so an env-derived fallback says so.
        source: account.credentials === "adc" ? "env" : "file",
        limits: {
          imagePerMinute: account.imageRequestsPerMinute ?? 2,
          videoPerMinute: account.videoRequestsPerMinute ?? 1,
          imageConcurrency: account.imageConcurrency ?? 2,
          videoConcurrency: account.videoConcurrency ?? 1,
        },
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

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const creditUsd = body.creditUsd === undefined || body.creditUsd === ""
      ? undefined
      : Number(body.creditUsd);
    if (creditUsd !== undefined && (!Number.isFinite(creditUsd) || creditUsd < 0)) {
      throw new VertexAccountError("Starting credit must be a non-negative number.");
    }

    await addVertexAccount({
      id: typeof body.id === "string" ? body.id : "",
      label: typeof body.label === "string" ? body.label : "",
      projectId: typeof body.projectId === "string" ? body.projectId : "",
      location: typeof body.location === "string" ? body.location : undefined,
      credentials: typeof body.credentials === "string" ? body.credentials : "adc",
      creditUsd,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof VertexAccountError ? error.message : "Could not add Vertex account.";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    await removeAccount("vertex", new URL(request.url).searchParams.get("id") ?? "");
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Could not remove account." }, { status: 409 });
  }
}
