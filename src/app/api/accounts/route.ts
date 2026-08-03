import { NextResponse } from "next/server";
import { AccountConfigError, keyHint, loadAccounts } from "@/server/accounts";
import type { AccountsResponse } from "@/types";

export async function GET() {
  try {
    const { accounts, problems } = await loadAccounts();
    // Only { id, label, keyHint, source } crosses the wire — never the key.
    return NextResponse.json<AccountsResponse>({
      ok: true,
      accounts: accounts.map(({ id, label, apiKey, source }) => ({
        id,
        label,
        keyHint: keyHint(apiKey),
        source,
      })),
      problems,
    });
  } catch (error) {
    // Only file-level failures land here; a bad single entry is a `problem`.
    const message =
      error instanceof AccountConfigError
        ? error.message
        : "Failed to read account config.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
