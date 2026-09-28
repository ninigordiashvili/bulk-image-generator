"use client";
import { HelpTip } from "./HelpTip";

import { useEffect, useState, type FormEvent } from "react";
import { creditsToUsd, formatCredits, formatUsd } from "@/lib/pricing";
import { parsePrompts } from "@/lib/prompts";
import { activeModelId, useGenerationStore } from "@/store/generationStore";
import { useVideoStore } from "@/store/videoStore";
import { videoModel } from "@/lib/videoModels";
import { pendingVideoShots } from "@/lib/videoPrompts";
import {
  estimateImages,
  estimateVideos,
  formatDuration,
} from "@/lib/vertexEstimate";
import { MAX_PROMPTS } from "@/types";
import { VERTEX_BATCH_MODEL, VERTEX_BATCH_IMAGE_USD } from "@/lib/vertexBatch";

/**
 * `scope` says whose account is being chosen. The two tabs keep separate
 * selections: they used to share one, so picking an account for a video batch
 * silently moved the image tab — and any batch running on it — onto that
 * account.
 */
export function AccountSelector({
  disabled,
  scope = "images",
}: {
  disabled: boolean;
  scope?: "images" | "videos";
}) {
  const accounts = useGenerationStore((state) => state.accounts);
  const accountProblems = useGenerationStore((state) => state.accountProblems);
  const accountsError = useGenerationStore((state) => state.accountsError);
  const accountsLoading = useGenerationStore((state) => state.accountsLoading);
  const imageAccountId = useGenerationStore((state) => state.settings.accountId);
  const imageProvider = useGenerationStore((state) => state.settings.provider);
  const videoAccountId = useVideoStore((state) => state.accountId);
  const videoProvider = useVideoStore((state) => state.provider);
  const setVideoAccount = useVideoStore((state) => state.setAccount);

  const forVideos = scope === "videos";
  const [heygen, setHeygen] = useState<{ ok: boolean; wallet?: { remaining_balance?: number }; error?: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [showVertexForm, setShowVertexForm] = useState(false);
  const [vertexForm, setVertexForm] = useState({ id: "", label: "", projectId: "", location: "us-central1", credentials: "adc", creditUsd: "" });
  const [vertexFormError, setVertexFormError] = useState<string | null>(null);
  const [vertexFormSaving, setVertexFormSaving] = useState(false);
  const refreshHeygen = () => { void fetch("/api/heygen/account").then(r => r.json()).then(setHeygen).catch(() => setHeygen({ ok: false, error: "Could not connect to HeyGen." })); };
  useEffect(() => { if (forVideos) refreshHeygen(); }, [forVideos]);
  const accountId = forVideos ? videoAccountId : imageAccountId;
  const provider = forVideos ? videoProvider : imageProvider;
  const choose = (next: { provider: "kie" | "vertex" | "heygen"; accountId: string }) =>
    forVideos ? setVideoAccount(next) : next.provider !== "heygen" && setSettings({ ...next, provider: next.provider });
  const credits = useGenerationStore((state) => state.credits);
  const creditsError = useGenerationStore((state) => state.creditsError);
  const setSettings = useGenerationStore((state) => state.setSettings);
  const loadAccounts = useGenerationStore((state) => state.loadAccounts);
  const refreshCredits = useGenerationStore((state) => state.refreshCredits);

  async function removeSelectedAccount() {
    if (!selected || provider === "heygen") return;
    setRemoving(true);
    setRemoveError(null);
    try {
      const endpoint = provider === "vertex" ? "/api/vertex/accounts" : "/api/accounts";
      const response = await fetch(`${endpoint}?id=${encodeURIComponent(accountId)}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not remove account.");
      await loadAccounts();
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : "Could not remove account.");
    } finally { setRemoving(false); }
  }

  async function addVertexAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setVertexFormSaving(true);
    setVertexFormError(null);
    try {
      const response = await fetch("/api/vertex/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vertexForm),
      });
      const result = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not add Vertex account.");
      setVertexForm({ id: "", label: "", projectId: "", location: "us-central1", credentials: "adc", creditUsd: "" });
      setShowVertexForm(false);
      await loadAccounts();
    } catch (error) {
      setVertexFormError(error instanceof Error ? error.message : "Could not add Vertex account.");
    } finally {
      setVertexFormSaving(false);
    }
  }

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  // The video tab keeps its own selection, which starts empty and survives
  // reloads — so it has to be checked against the accounts that actually
  // exist, the way the image tab's is checked inside `loadAccounts`. Left
  // alone it would sit blank, or point at an account since removed.
  useEffect(() => {
    if (!forVideos || accountsLoading || videoProvider === "heygen" || disabled) return;
    if (accounts.length === 0) {
      if (videoAccountId) setVideoAccount({ provider: videoProvider, accountId: "" });
      return;
    }
    const valid = accounts.some(
      (account) => account.id === videoAccountId && account.provider === videoProvider
    );
    if (valid) return;
    const first = accounts[0];
    setVideoAccount({ provider: first.provider ?? "kie", accountId: first.id });
  }, [forVideos, accounts, accountsLoading, disabled, videoAccountId, videoProvider, setVideoAccount]);

  // Matched on provider too: both providers have an account called "main".
  const selected = accounts.find(
    (account) => account.id === accountId && account.provider === provider
  );
  const kieAccounts = accounts.filter((account) => account.provider !== "vertex");
  const vertexAccounts = accounts.filter((account) => account.provider === "vertex");
  const isVertex = provider === "vertex";
  useEffect(() => {
    if (!isVertex) return;
    const timer = setInterval(() => { void loadAccounts(); }, 30000);
    return () => clearInterval(timer);
  }, [isVertex, loadAccounts]);

  // The two pending batches, read straight from the stores that own them, so
  // the estimate follows what is actually queued rather than a typed-in number.
  const settings = useGenerationStore((state) => state.settings);
  const promptText = useGenerationStore((state) => state.promptText);
  const storedShots = useVideoStore((state) => state.shots);
  const videoInputMode = useVideoStore(state => state.inputMode);
  const videoPromptText = useVideoStore(state => state.promptText);

  const limits = selected?.limits;
  const imageBatch = !forVideos && settings.vertexImageMode === "batch" && settings.model === VERTEX_BATCH_MODEL;
  const imageCount =
    isVertex && !forVideos
      ? Math.min(parsePrompts(promptText).length, MAX_PROMPTS) * settings.imagesPerPrompt
      : 0;
  const imagePlan =
    isVertex && limits && imageCount > 0
      ? estimateImages(
          imageCount,
          activeModelId(settings),
          limits.imagePerMinute,
          limits.imageConcurrency
        )
      : null;

  // Before any shots exist the batch defaults are the only statement of intent
  // there is, so they stand in for it — a per-clip figure at the length
  // currently selected, which is what makes the duration pills show their price
  // before anything has been loaded.
  const videoDefaults = useVideoStore((state) => state.defaults);
  const shots = pendingVideoShots({ provider: videoProvider, inputMode: videoInputMode, promptText: videoPromptText, shots: storedShots, defaults: videoDefaults });
  const videoSpec = videoModel(shots.length ? shots[0].model : videoDefaults.model);
  const isVertexVideo = isVertex && !!limits && videoSpec.provider === "vertex";

  const videoPlan =
    isVertexVideo && forVideos && shots.length > 0
      ? estimateVideos(
          shots.map((shot) => shot.duration),
          videoSpec.requestModel,
          limits!.videoPerMinute,
          limits!.videoConcurrency,
          false,
          shots.map(shot => shot.resolution)
        )
      : null;

  const perClipPlan =
    isVertexVideo && forVideos && shots.length === 0
      ? estimateVideos(
          [videoDefaults.duration],
          videoSpec.requestModel,
          limits!.videoPerMinute,
          limits!.videoConcurrency,
          false,
          [videoDefaults.resolution]
        )
      : null;

  return (
    <section className="panel">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="panel-title mb-0">
          {forVideos ? "Video account" : "Image account"}
        </h2>
        {selected && (
          <span className="font-mono text-[11px] text-muted">{selected.keyHint}</span>
        )}
      </div>

      {/* The value is provider-qualified because an id alone is ambiguous —
          both providers ship an account called "main". Choosing here is what
          selects the provider; the model list downstream follows it. */}
      <div className="flex items-center gap-2">
      <select
        aria-label={forVideos ? "Video account" : "Image account"}
        className="field min-w-0 flex-1"
        value={`${provider}:${accountId}`}
        disabled={disabled || removing || accountsLoading || (accounts.length === 0 && !heygen?.ok)}
        onChange={(event) => {
          const [nextProvider, ...rest] = event.target.value.split(":");
          choose({
            provider: nextProvider === "heygen" && forVideos ? "heygen" : nextProvider === "vertex" ? "vertex" : "kie",
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
        {forVideos && <optgroup label="HeyGen"><option value="heygen:main">HeyGen  -  talking avatars</option></optgroup>}
      </select>
      {selected && provider !== "heygen" && <button
        type="button"
        className="btn-ghost shrink-0 p-2 text-muted hover:text-red-400"
        aria-label={`Remove ${selected.label} from app`}
        title={`Remove ${selected.label} from app`}
        disabled={disabled || accountsLoading || removing}
        onClick={() => void removeSelectedAccount()}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>}
      </div>
      {removeError && <p role="alert" className="mt-2 text-xs text-red-400">{removeError}</p>}

      {forVideos && provider === "heygen" && <p className="mt-2 text-xs text-muted">{heygen?.ok ? "API wallet: " + formatUsd(heygen.wallet?.remaining_balance ?? 0) : heygen?.error || "Checking HeyGen account - "}  -  Estimate: $1/minute.</p>}
      {/* The balance is the only hard limit on a kie batch, so it leads. Vertex
          bills the cloud account directly and publishes no balance API, so the
          quota — the thing that actually paces a Vertex run — is shown instead. */}
      {selected && isVertex && (
        <div className="mt-2 space-y-1 text-xs text-muted">
          {selected.usage && <>
            <p>Estimated app spending: <strong className="text-foreground">{formatUsd(selected.usage.spentUsd)}</strong></p>
            <p>Estimated credit left: <strong className="text-foreground">{selected.usage.remainingUsd === null ? "Starting balance needed" : formatUsd(selected.usage.remainingUsd)}</strong></p>
            <HelpTip label="Account estimates">Based on {selected.usage.startingCreditUsd === null ? "an unset starting credit" : formatUsd(selected.usage.startingCreditUsd) + " configured starting credit"} minus recorded successful generations. Earlier or outside usage, pending jobs, other charges and credit expiry are excluded. This is not your Google billing balance.</HelpTip>
            {selected.usage.ratesUnverified && <p className="text-amber-400">Some model prices are unverified estimates.</p>}
            {selected.usage.error && <p className="text-amber-400">{selected.usage.error}</p>}
          </>}
          <p>
            Rate limits{" "}
            <span className="font-semibold text-foreground">{selected.keyHint}</span>
          </p>

          {/* Time and money for what is actually queued. Both are estimates:
              the rate is real but a 429 or a slow model day moves it. */}
          {imagePlan && (
            <p>
              {imageCount} image{imageCount === 1 ? "" : "s"} ≈{" "}
              <span className="font-semibold text-foreground">
                {imageBatch ? "Google scheduled batch" : formatDuration(imagePlan.minutes)}
              </span>{" "}
              · <span className="font-semibold text-foreground">
                {formatUsd(imageBatch ? imageCount * VERTEX_BATCH_IMAGE_USD : imagePlan.usd)}
              </span>{" "}
              <span className="opacity-70">{imageBatch ? "image output; inputs/storage extra" : `(${imagePlan.boundBy}-bound)`}</span>
            </p>
          )}
          {videoPlan && (
            <p>
              {shots.length} clip{shots.length === 1 ? "" : "s"} ≈{" "}
              <span className="font-semibold text-foreground">
                {formatDuration(videoPlan.minutes)}
              </span>{" "}
              · <span className="font-semibold text-foreground">
                {formatUsd(videoPlan.usd)}
              </span>{" "}
              <span className="opacity-70">({videoPlan.boundBy}-bound)</span>
            </p>
          )}
          {perClipPlan && (
            <p>
              {videoDefaults.duration}s clip ={" "}
              <span className="font-semibold text-foreground">
                {formatUsd(perClipPlan.usd)}
              </span>{" "}
              each · about {perClipPlan.perMinute.toFixed(1)}/min
            </p>
          )}
          {!imagePlan && !videoPlan && !perClipPlan && (
            <HelpTip label="Account estimates">
              Add prompts or shots to see an estimated time and cost.
            </HelpTip>
          )}
        </div>
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
        <HelpTip label="Account credentials and quotas">
          {provider === "heygen" ? <>Your HeyGen key stays on the server. Each row uses its selected audio cut.</> : isVertex ? (
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
        </HelpTip>
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
          onClick={() => provider === "heygen" ? refreshHeygen() : isVertex ? void loadAccounts() : void refreshCredits()}
          disabled={!accountId || accountsLoading}
        >
          Refresh balance
        </button>
      </div>
      <button
        type="button"
        className="btn-ghost mt-2 text-xs"
        onClick={() => { setShowVertexForm((open) => !open); setVertexFormError(null); }}
      >
        {showVertexForm ? "Cancel" : "Add Vertex account"}
      </button>
      {showVertexForm && (
        <form className="mt-3 space-y-2 border-t border-white/10 pt-3" onSubmit={addVertexAccount}>
          <p className="text-xs text-muted">Add project metadata here. Put the service-account JSON on this server first, then enter its path below.</p>
          <div className="grid grid-cols-2 gap-2">
            {(["id", "label", "projectId", "location", "credentials", "creditUsd"] as const).map((field) => (
              <label key={field} className="text-xs text-muted">
                {field === "creditUsd" ? "Starting credit (USD)" : field}
                <input
                  className="field mt-1"
                  required={field === "id" || field === "projectId" || field === "credentials"}
                  type={field === "creditUsd" ? "number" : "text"}
                  min={field === "creditUsd" ? "0" : undefined}
                  step={field === "creditUsd" ? "0.01" : undefined}
                  placeholder={field === "credentials" ? "adc or ./vertex-new-key.json" : undefined}
                  value={vertexForm[field]}
                  onChange={(event) => setVertexForm((current) => ({ ...current, [field]: event.target.value }))}
                />
              </label>
            ))}
          </div>
          {vertexFormError && <p className="text-xs text-red-400">{vertexFormError}</p>}
          <button type="submit" className="btn-primary text-xs" disabled={vertexFormSaving}>
            {vertexFormSaving ? "Adding…" : "Add account"}
          </button>
        </form>
      )}
    </section>
  );
}
