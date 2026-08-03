"use client";

import { useEffect } from "react";
import { creditsToUsd, formatCredits, formatUsd } from "@/lib/pricing";
import { useGenerationStore } from "@/store/generationStore";

export function AccountSelector({ disabled }: { disabled: boolean }) {
  const accounts = useGenerationStore((state) => state.accounts);
  const accountProblems = useGenerationStore((state) => state.accountProblems);
  const accountsError = useGenerationStore((state) => state.accountsError);
  const accountsLoading = useGenerationStore((state) => state.accountsLoading);
  const accountId = useGenerationStore((state) => state.settings.accountId);
  const credits = useGenerationStore((state) => state.credits);
  const creditsError = useGenerationStore((state) => state.creditsError);
  const setSettings = useGenerationStore((state) => state.setSettings);
  const loadAccounts = useGenerationStore((state) => state.loadAccounts);
  const refreshCredits = useGenerationStore((state) => state.refreshCredits);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const selected = accounts.find((account) => account.id === accountId);

  return (
    <section className="panel">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="panel-title mb-0">kie.ai account</h2>
        {selected && (
          <span className="font-mono text-[11px] text-muted">{selected.keyHint}</span>
        )}
      </div>

      <select
        className="field"
        value={accountId}
        disabled={disabled || accountsLoading || accounts.length === 0}
        onChange={(event) => setSettings({ accountId: event.target.value })}
      >
        {accounts.length === 0 && (
          <option value="">
            {accountsLoading ? "Loading accounts…" : "No usable accounts"}
          </option>
        )}
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.label}
          </option>
        ))}
      </select>

      {/* The balance is the only hard limit on a batch, so it leads. */}
      {selected && (
        <p className="mt-2 text-xs">
          {credits === null ? (
            creditsError ? (
              <span className="text-amber-400">{creditsError}</span>
            ) : (
              <span className="text-muted">Checking balance…</span>
            )
          ) : (
            <span className="text-muted">
              Balance{" "}
              <span className="font-semibold text-foreground">
                {formatCredits(credits)}
              </span>{" "}
              ≈ {formatUsd(creditsToUsd(credits))}
            </span>
          )}
        </p>
      )}

      {/* File-level failure — nothing could be read at all. */}
      {accountsError && (
        <p className="mt-2 text-xs leading-relaxed text-red-400">{accountsError}</p>
      )}

      {/* Per-entry failures. Any usable accounts above still work. */}
      {accountProblems.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {accountProblems.map((problem) => (
            <li
              key={`${problem.id}-${problem.reason.slice(0, 24)}`}
              className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-300"
            >
              <span className="font-semibold">{problem.label}</span> {problem.reason}
            </li>
          ))}
        </ul>
      )}

      {!accountsError && accountProblems.length === 0 && (
        <p className="mt-2 text-xs text-muted">
          Keys stay in <code className="text-foreground">kie-accounts.json</code> on
          the server — each account spends its own credit balance.
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => void loadAccounts()}
          disabled={accountsLoading}
        >
          Reload accounts
        </button>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => void refreshCredits()}
          disabled={!accountId}
        >
          Refresh balance
        </button>
      </div>
    </section>
  );
}
