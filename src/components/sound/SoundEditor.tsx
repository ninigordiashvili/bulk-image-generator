"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatDuration } from "@/lib/editor/format";
import { useVoiceoverStore } from "@/store/voiceoverStore";

const AUDIO = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;

/**
 * Turns a folder of recorded takes into one narration bed.
 *
 * Its own tool rather than a panel in the video editor: joining takes is what
 * you do once when the narration comes back from wherever it was recorded, and
 * editing is what you do afterwards with the result. The handoff between them
 * is a file.
 */
export function SoundEditor({ renderable }: { renderable: boolean }) {
  const files = useVoiceoverStore((state) => state.files);
  const busy = useVoiceoverStore((state) => state.busy);
  const error = useVoiceoverStore((state) => state.error);
  const report = useVoiceoverStore((state) => state.report);
  const url = useVoiceoverStore((state) => state.url);
  const urlMp3 = useVoiceoverStore((state) => state.urlMp3);
  const maxGap = useVoiceoverStore((state) => state.maxGap);
  const keepGap = useVoiceoverStore((state) => state.keepGap);
  const leadIn = useVoiceoverStore((state) => state.leadIn);

  const addFiles = useVoiceoverStore((state) => state.addFiles);
  const remove = useVoiceoverStore((state) => state.remove);
  const clear = useVoiceoverStore((state) => state.clear);
  const setPacing = useVoiceoverStore((state) => state.setPacing);
  const join = useVoiceoverStore((state) => state.join);

  const [dragging, setDragging] = useState(false);
  const folderInput = useRef<HTMLInputElement | null>(null);

  // `webkitdirectory` isn't in the DOM typings, and it's the only way to hand
  // over a whole folder of takes in one go.
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  const locked = busy || !renderable;
  const take = (list: FileList | File[]) => {
    const picked = [...list].filter(
      (file) => AUDIO.test(file.name) || file.type.startsWith("audio/")
    );
    if (picked.length) addFiles(picked);
  };

  return (
    <main className="mx-auto w-full max-w-[1100px] space-y-4 px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Sound editor</h1>
          <p className="mt-1 text-xs text-muted">
            Joins a folder of voiceover takes into one narration bed and shortens
            the long pauses. Runs locally with ffmpeg.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/" className="pill">
            ← Generator
          </Link>
          <Link href="/editor" className="pill">
            Video editor →
          </Link>
        </div>
      </header>

      {!renderable && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="text-sm font-medium text-amber-300">
            This deployment can&rsquo;t join audio.
          </p>
          <p className="mt-1 text-xs text-amber-200/80">
            Joining shells out to ffmpeg and keeps the takes on disk between
            requests, neither of which a serverless host offers. Run{" "}
            <span className="font-mono">npm run dev</span> on your own machine.
            Image and video generation work fine here.
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
        <section className="panel space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="panel-title mb-0">Takes</p>
            {files.length > 0 && (
              <button
                type="button"
                disabled={locked}
                onClick={clear}
                className="text-xs text-muted hover:text-foreground disabled:opacity-40"
              >
                clear
              </button>
            )}
          </div>

          <div
            onDragOver={(event) => {
              event.preventDefault();
              if (!locked) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (!locked) take(event.dataTransfer.files);
            }}
            className={`rounded-lg border border-dashed p-4 text-center transition ${
              dragging ? "border-accent bg-accent/10" : "border-line bg-surface-2"
            } ${locked ? "opacity-50" : ""}`}
          >
            <p className="text-sm text-foreground">Drop your takes here</p>
            <p className="mt-1 text-xs text-muted">
              Named <span className="font-mono">1</span>,{" "}
              <span className="font-mono">2</span>, <span className="font-mono">3</span>…
              — they run in that order, and{" "}
              <span className="font-mono">10</span> comes after{" "}
              <span className="font-mono">9</span>, not after{" "}
              <span className="font-mono">1</span>.
            </p>

            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <label className={`pill ${locked ? "pointer-events-none opacity-50" : "cursor-pointer"}`}>
                Choose files
                <input
                  type="file"
                  accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus"
                  multiple
                  className="hidden"
                  disabled={locked}
                  onChange={(event) => {
                    take(event.target.files ?? []);
                    event.target.value = "";
                  }}
                />
              </label>
              <label className={`pill ${locked ? "pointer-events-none opacity-50" : "cursor-pointer"}`}>
                Choose folder
                <input
                  ref={folderInput}
                  type="file"
                  multiple
                  className="hidden"
                  disabled={locked}
                  onChange={(event) => {
                    take(event.target.files ?? []);
                    event.target.value = "";
                  }}
                />
              </label>
            </div>
          </div>

          {files.length > 0 && (
            <ol className="max-h-[28rem] space-y-1 overflow-y-auto">
              {files.map((file, index) => (
                <li
                  key={file.name}
                  className="flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5 text-sm"
                >
                  <span className="w-6 shrink-0 text-right font-mono text-xs text-muted">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={file.name}>
                    {file.name}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted">
                    {(file.size / 1024 / 1024).toFixed(1)} MB
                  </span>
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => remove(file.name)}
                    className="shrink-0 text-xs text-muted hover:text-red-400 disabled:opacity-40"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>

        <div className="space-y-4">
          <div className="panel space-y-3">
            <p className="panel-title">Pauses</p>

            <label className="block">
              <span className="flex items-baseline justify-between text-xs text-muted">
                <span>Shorten anything longer than</span>
                <span className="font-mono text-foreground">{maxGap.toFixed(1)}s</span>
              </span>
              <input
                type="range"
                min={0.3}
                max={4}
                step={0.1}
                value={maxGap}
                disabled={locked}
                onChange={(event) => setPacing({ maxGap: Number(event.target.value) })}
                className="mt-1 w-full accent-[var(--accent)] disabled:opacity-40"
              />
            </label>

            <label className="block">
              <span className="flex items-baseline justify-between text-xs text-muted">
                <span>…down to</span>
                <span className="font-mono text-foreground">{keepGap.toFixed(2)}s</span>
              </span>
              <input
                type="range"
                min={0.1}
                max={Math.max(0.2, maxGap)}
                step={0.05}
                value={keepGap}
                disabled={locked}
                onChange={(event) => setPacing({ keepGap: Number(event.target.value) })}
                className="mt-1 w-full accent-[var(--accent)] disabled:opacity-40"
              />
            </label>

            <label className="block">
              <span className="flex items-baseline justify-between text-xs text-muted">
                <span>Breath before the next word</span>
                <span className="font-mono text-foreground">{leadIn.toFixed(2)}s</span>
              </span>
              <input
                type="range"
                min={0}
                max={Math.max(0.05, keepGap)}
                step={0.05}
                value={leadIn}
                disabled={locked}
                onChange={(event) => setPacing({ leadIn: Number(event.target.value) })}
                className="mt-1 w-full accent-[var(--accent)] disabled:opacity-40"
              />
            </label>

            <p className="text-[11px] text-muted">
              A pause shorter than the cap is left exactly as recorded — a breath
              between sentences is part of the read. The gap where two takes meet
              is treated as one pause rather than two.
            </p>
            <p className="text-[11px] text-muted">
              Speech is never touched. Silence detection calls a pause over a
              moment <em>after</em> the word has already started, so the cut
              stops short by the breath above and lets the real run-up back in —
              otherwise the first consonant gets shaved off and the join sounds
              clipped.
            </p>

            <button
              type="button"
              onClick={() => void join()}
              disabled={locked || files.length === 0}
              className="btn-primary w-full"
            >
              {busy
                ? "Joining…"
                : files.length === 0
                  ? "Add some takes"
                  : `Join ${files.length} take${files.length === 1 ? "" : "s"}`}
            </button>
          </div>

          {error && (
            <p className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
              {error}
            </p>
          )}

          {report && url && (
            <div className="panel space-y-3">
              <p className="panel-title">Result</p>
              <p className="text-sm text-foreground">
                {formatDuration(report.originalDuration)} →{" "}
                <span className="font-medium">{formatDuration(report.duration)}</span>
              </p>
              <p className="text-xs text-muted">
                {report.parts} takes joined, {report.tightened} pause
                {report.tightened === 1 ? "" : "s"} shortened,{" "}
                {report.removed.toFixed(1)}s of dead air removed.
              </p>
              <audio src={url} controls className="w-full" />
              <div className="grid grid-cols-2 gap-2">
                <a href={url} download="narration.m4a" className="btn-primary text-center">
                  narration.m4a
                </a>
                <a
                  href={urlMp3 ?? url}
                  download="narration.mp3"
                  className="btn-primary text-center"
                >
                  narration.mp3
                </a>
              </div>
              <p className="text-[11px] text-muted">
                Drop this into the{" "}
                <Link href="/editor" className="underline hover:text-foreground">
                  video editor
                </Link>{" "}
                as the audio bed.
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
