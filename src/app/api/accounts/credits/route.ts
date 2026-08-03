import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AccountConfigError, findAccount } from "@/server/accounts";
import { KieError, getCredits } from "@/server/kie";
import type { CreditsResponse } from "@/types";

/**
 * Live balance for one account. Worth its own route rather than folding into
 * /api/accounts: listing accounts must stay instant and offline-safe, and this
 * one talks to kie.ai.
 */
export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId");
  if (!accountId) {
    return NextResponse.json<CreditsResponse>(
      { ok: false, error: "No accountId." },
      { status: 400 }
    );
  }

  try {
    const account = await findAccount(accountId);
    const credits = await getCredits(account.apiKey, request.signal);
    return NextResponse.json<CreditsResponse>({ ok: true, credits });
  } catch (error) {
    const message =
      error instanceof AccountConfigError || error instanceof KieError
        ? error.message
        : "Could not read the kie.ai balance.";
    return NextResponse.json<CreditsResponse>(
      { ok: false, error: message },
      { status: 502 }
    );
  }
}
