"use client";
import { HelpTip } from "./HelpTip";
import { downloadWorkFiles } from "@/lib/downloadWork";
import { SavedFileCleanup } from "./SavedFileCleanup";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ActivityEntry, WorkStatus } from "@/types/work";
import type { JobStatus } from "@/types/editor";
import { durationLabel, WorkTiming } from "./WorkTiming";
const active = (phase: string) => ["running", "cancelling", "preparing", "rendering", "muxing"].includes(phase);

function useActivity() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch("/api/activity", { signal: controller.signal });
        if (!response.ok) throw new Error("Could not reach Activity. Reconnecting…");
        const data = await response.json();
        if (alive) { setEntries(data.entries); setError(""); }
      } catch (error) { if (alive) setError(error instanceof Error ? error.message : "Reconnecting…"); }
      if (alive) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, []);
  return { entries, error, removeEntry: (id: string) => setEntries(current => current.filter(entry => entry.id !== id)) };
}
export function ActivityBanner() {
  const { entries, error } = useActivity();
  const processing = entries.filter(entry => active(entry.phase));
  return <aside className="sticky top-0 z-50 border-b border-line bg-surface-2 px-4 py-2 text-xs flex flex-wrap items-center gap-3">
    <SavedFileCleanup />
    <Link className="font-semibold text-accent underline" href="/activity">Activity{processing.length ? ` · ${processing.length} processing` : " · recent results"}</Link>
    {processing.slice(0, 3).map(entry => <Link key={entry.id} href={entry.href} className="text-foreground underline">
      {entry.label}: {entry.done}/{entry.total || "…"} · {durationLabel(entry.elapsedMs)} elapsed
    </Link>)}
    {error && <span role="status">{error}</span>}
  </aside>;
}
export function ActivityPage({ initialSelection = null }: { initialSelection?: { id: string; kind: string } | null }) {
  const { entries, error, removeEntry } = useActivity();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadMessage, setDownloadMessage] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [deletingAll, setDeletingAll] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ id: string; kind: string } | null>(initialSelection);
  const [batch, setBatch] = useState<WorkStatus | null>(null);
  const [render, setRender] = useState<JobStatus | null>(null);
  const [actionError, setActionError] = useState("");
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(selected.kind === "render" ? `/api/editor/job/${selected.id}` : `/api/work/${selected.id}`, { signal: controller.signal });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error);
        if (alive) { if (selected.kind === "render") setRender(data.status); else setBatch(data.status); setActionError(""); }
      } catch (error) { if (alive) setActionError(error instanceof Error ? error.message : "Reconnecting…"); }
      if (alive) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, [selected]);
  const action = async (entry: { id: string; kind: string }, retry?: true | string) => {
    try {
      const url = entry.kind === "render" ? `/api/editor/job/${entry.id}?keep=1` : `/api/work/${entry.id}`;
      const response = await fetch(url, retry ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ retry }) } : { method: "DELETE" });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error);
    } catch (error) { setActionError(error instanceof Error ? error.message : "Action failed. Try again."); }
  };
  const downloadBatch = async (id: string) => {
    setDownloading(id); setDownloadError(""); setDownloadMessage("Preparing download...");
    try {
      await downloadWorkFiles(id, progress => setDownloadMessage(
        progress.current === progress.total
          ? `${progress.total} downloads requested. Check your browser downloads.`
          : `Starting downloads: ${progress.current}/${progress.total}`));
    } catch (error) {
      setDownloadMessage("");
      setDownloadError(error instanceof Error ? error.message : "Download failed. Try again.");
    } finally { setDownloading(null); }
  };
  const downloadButton = (id: string) => <button className="btn-primary" disabled={deletingAll || downloading !== null || deleting === id}
    onClick={() => void downloadBatch(id)}>{downloading === id ? "Starting downloads..." : "Download all"}</button>;
  const deleteHistory = async (entry: ActivityEntry) => {
    if (!window.confirm("Delete this Activity entry and all its saved files? Downloads already saved to your computer will remain.")) return;
    setDeleting(entry.id);
    try {
      const response = await fetch("/api/activity?" + new URLSearchParams({ id: entry.id, kind: entry.kind }), { method: "DELETE" });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error);
      if (selected?.id === entry.id) {
        setSelected(null); setBatch(null); setRender(null);
        window.history.replaceState(null, "", "/activity");
      }
      removeEntry(entry.id);
      setActionError("");
    } catch (error) { setActionError(error instanceof Error ? error.message : "Could not delete history."); }
    finally { setDeleting(null); }
  };
  const deletableEntries = entries.filter(entry => ["done", "error", "cancelled", "interrupted"].includes(entry.phase));
  const deleteAllHistory = async () => {
    const targets = [...deletableEntries];
    if (!window.confirm("Delete all " + targets.length + " finished Activity entries, their saved files, and the server video-render cache? Active generations and exports will keep running. Downloads and browser galleries will remain.")) return;
    setDeletingAll(true); setDeleteMessage("Deleting finished history, files and cache...");
    let deleted = 0;
    const failures: string[] = [];
    try {
      for (const entry of targets) {
        try {
          const response = await fetch("/api/activity?" + new URLSearchParams({ id: entry.id, kind: entry.kind }), { method: "DELETE" });
          const result = await response.json();
          if (!response.ok || !result.ok) throw new Error(result.error || "Could not delete entry.");
          removeEntry(entry.id);
          deleted++;
          if (selected?.id === entry.id) {
            setSelected(null); setBatch(null); setRender(null);
            window.history.replaceState(null, "", "/activity");
          }
        } catch (error) { failures.push(error instanceof Error ? error.message : "Could not delete entry."); }
        setDeleteMessage("Deleted " + deleted + " of " + targets.length + " entries...");
      }
      let cacheMessage = "";
      try {
        const response = await fetch("/api/activity/cache", { method: "DELETE" });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || "Could not clear render cache.");
        cacheMessage = ` Cleared ${result.files} render-cache files (${(result.bytes / 1024 ** 2).toFixed(1)} MB).`;
      } catch (error) {
        cacheMessage = " Render cache was not cleared: " + (error instanceof Error ? error.message : "Try again later.");
      }
      setDeleteMessage("Deleted " + deleted + " finished entries and their saved files." +
        (failures.length ? " " + failures.length + " could not be deleted: " + failures[0] : "") + cacheMessage + " Active jobs were left running.");
    } finally { setDeletingAll(false); }
  };
  return <main className="mx-auto w-full max-w-6xl space-y-5 p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold">Activity</h1><Link className="text-accent underline" href="/">Back to generator</Link></div>
    <div className="flex flex-wrap items-center gap-2">
    <span className="text-xs text-muted">Downloads</span> <HelpTip label="Download help">Files download individually. If your browser asks, allow multiple downloads for this site. Check the browser download list for blocked or failed transfers.</HelpTip>
    <span className="text-xs text-muted">Background</span> <HelpTip label="Background activity">Generation and video exports continue on the app server when you close or refresh your browser. Reopen them here from any browser. Keep the server computer awake and the app server running.</HelpTip>
    <span className="text-xs text-muted">Saved files</span> <HelpTip label="Saved files and cleanup">Downloaded app copies expire 48 hours after the first download. Undownloaded results are kept. Shared render cache is kept until its exports have also passed that download window. Delete history removes a finished entry and its saved files. The bulk cleanup also clears the server video-render cache when no export is active. Active jobs, browser galleries and downloaded files remain.</HelpTip>
    </div>
    <button className="btn-ghost text-red-400" disabled={deletingAll || deleting !== null || downloading !== null} onClick={() => void deleteAllHistory()}>{deletingAll ? "Deleting history, files & cache..." : "Delete all history, files & cache"}</button>
    {deleteMessage && <p role="status" className="text-sm text-muted">{deleteMessage}</p>}
    {(error || actionError) && <p role="alert" className="text-amber-400">{actionError || error}</p>}
    {downloadMessage && <p role="status" className="text-sm text-muted">{downloadMessage}</p>}
    {downloadError && <p role="alert" className="text-amber-400">{downloadError}</p>}
    {!entries.length && !error && <p>No saved batches or exports yet.</p>}
    <div className="space-y-2">{entries.map(entry => <section key={entry.id} className="panel flex flex-wrap items-center justify-between gap-3">
      <button className="text-left" onClick={() => { setBatch(null); setRender(null); setSelected({ id: entry.id, kind: entry.kind === "render" ? "render" : "batch" }); window.history.replaceState(null, "", entry.href); }}>
        <span className="font-semibold text-accent underline">{entry.label}</span><span className="ml-3 text-xs text-muted">{new Date(entry.createdAt).toLocaleString()}</span>
        <p className="text-sm">{entry.phase} · {entry.done}/{entry.total || "…"} · elapsed {durationLabel(entry.elapsedMs)}{active(entry.phase) && entry.remainingMs !== null ? ` · about ${durationLabel(entry.remainingMs)} remaining` : ""}</p>
        {entry.succeeded !== undefined && <p className="text-xs text-muted">{entry.succeeded} successful · <span className={(entry.failed ?? 0) > 0 ? "text-red-400" : undefined}>{entry.failed} failed or cancelled</span></p>}
        {entry.error && <p className="text-xs text-red-400">{entry.error}</p>}
      </button>
      <div className="flex gap-3">{entry.kind !== "render" && entry.phase === "done" && (entry.succeeded ?? 0) > 0 && downloadButton(entry.id)}{entry.outputUrl && <a className="btn-primary" href={entry.outputUrl}>Download video</a>}
        {(active(entry.phase) || entry.phase === "uploading") && <button className="btn-ghost" onClick={() => void action(entry)}>Cancel</button>}
        {["done", "error", "cancelled", "interrupted"].includes(entry.phase) && <button className="btn-ghost text-red-400" disabled={deletingAll || deleting !== null || downloading === entry.id} onClick={() => void deleteHistory(entry)}>{deleting === entry.id ? "Deleting..." : "Delete history & files"}</button>}</div>
    </section>)}</div>
    {render && <section className="panel space-y-3"><h2 className="text-lg font-semibold">Video export</h2><p>{render.message} · {durationLabel(render.elapsedMs)} elapsed</p>
      <progress className="w-full" value={render.done} max={render.total || 1} />
      {render.phase === "done" && <><video className="w-full" controls src={`/api/editor/job/${render.id}/output`} /><a className="btn-primary inline-block" href={`/api/editor/job/${render.id}/output?download=1`}>Download video</a></>}
      {render.error && <p className="text-red-400">{render.error}</p>}
    </section>}
    {batch && <section className="panel space-y-4"><h2 className="text-lg font-semibold">{batch.kind === "image" ? "Image" : "Video"} batch · {batch.accountId}</h2>
      {batch.phase === "done" && batch.progress.succeeded > 0 && downloadButton(batch.id)}
      <WorkTiming status={batch} /><progress className="w-full" value={batch.progress.completed} max={batch.total} />
      {batch.phase === "uploading" && <p>Inputs have not all been saved. Return to the original upload page, or cancel this draft and submit again. Generation has not started.</p>}
      {!active(batch.phase) && batch.jobs.some(job => ["error", "cancelled"].includes(job.status)) && <button className="btn-ghost" disabled={deletingAll || deleting === batch.id} onClick={() => void action(batch, true)}>Retry failed / cancelled items</button>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{batch.jobs.map(job => <article key={job.id} className="rounded border border-line p-3 space-y-2">
        <p className="text-xs text-muted">#{job.promptIndex + 1} · {job.status}</p><p className="text-sm line-clamp-3">{job.prompt}</p>
        {job.error && <p className="text-xs text-red-400">{job.error}</p>}
        {job.files?.map(file => <div key={file.url}>{file.mimeType.startsWith("video/") ? <video className="w-full" controls preload="none" src={file.url} /> :
          // These authenticated local result URLs need no image optimizer.
          // eslint-disable-next-line @next/next/no-img-element
          <img className="w-full" loading="lazy" src={file.url} alt={job.prompt} />}
          <a className="text-accent underline text-sm" href={`${file.url}&download=1`}>Download {file.name}</a></div>)}
      </article>)}</div>
    </section>}
  </main>;
}
