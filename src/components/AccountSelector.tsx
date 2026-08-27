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
  const provider = useGenerationStore((state) => state.settings.provider);
  const credits = useGenerationStore((state) => state.credits);
  const creditsError = useGenerationStore((state) => state.creditsError);
  const setSettings = useGenerationStore((state) => state.setSettings);
  const loadAccounts = useGenerationStore((state) => state.loadAccounts);
  const refreshCredits = useGenerationStore((state) => state.refreshCredits);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  // Matched on provider too: both providers have an account called "main".
  const selected = accounts.find(
    (account) => account.id === accountId && account.provider === provider
  );
  const kieAccounts = accounts.filter((account) => account.provider !== "vertex");
  const vertexAccounts = accounts.filter((account) => account.provider === "vertex");
  const isVertex = provider === "vertex";

  return (
    <section className="panel">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="panel-title mb-0">Account</h2>
        {selected && (
          <span className="font-mono text-[11px] text-muted">{selected.keyHint}</span>
        )}
      </div>

      {/* The value is provider-qualified because an id alone is ambiguous —
          both providers ship an account called "main". Choosing here is what
          selects the provider; the model list downstream follows it. */}
      <select
        className="field"
        value={`${provider}:${accountId}`}
        disabled={disabled || accountsLoading || accounts.length === 0}
        onChange={(event) => {
          const [nextProvider, ...rest] = event.target.value.split(":");
          setSettings({
            provider: nextProvider === "vertex" ? "vertex" : "kie",
            accountId: rest.join(":"),
          });
        }}
      >
        {accounts.length === 0 && (
          <option value="">
            {accountsLoading ? "Loading accounts…" : "No usable accounts"}
          </option>
        )}
        {kieAccounts.length > 0 && (
          <optgroup label="kie.ai">
            {kieAccounts.map((account) => (
              <option key={`kie:${account.id}`} value={`kie:${account.id}`}>
                {account.label}
              </option>
            ))}
          </optgroup>
        )}
        {vertexAccounts.length > 0 && (
          <optgroup label="Vertex AI (Google Cloud)">
            {vertexAccounts.map((account) => (
              <option key={`vertex:${account.id}`} value={`vertex:${account.id}`}>
                {account.label}
              </option>
            ))}
          </optgroup>
        )}
      </select>

      {/* The balance is the only hard limit on a kie batch, so it leads. Vertex
          bills the cloud account directly and publishes no balance API, so the
          quota — the thing that actually paces a Vertex run — is shown instead. */}
      {selected && isVertex && (
        <p className="mt-2 text-xs text-muted">
          Rate limits{" "}
          <span className="font-semibold text-foreground">{selected.keyHint}</span>
        </p>
      )}
      {selected && !isVertex && (
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
          {isVertex ? (
            <>
              Credentials stay in{" "}
              <code className="text-foreground">vertex-accounts.json</code> on the
              server — each account spends its own Google Cloud credit, and quota
              is granted per project, so the account decides the speed.
            </>
          ) : (
            <>
              Keys stay in <code className="text-foreground">kie-accounts.json</code>{" "}
              on the server — each account spends its own credit balance.
            </>
          )}
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
          disabled={!accountId || isVertex}
        >
          Refresh balance
        </button>
      </div>
    </section>
  );
}
