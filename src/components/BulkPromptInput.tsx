"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  CHARACTER_TAG_RE,
  INLINE_CUE_RE,
  cueIssues,
  isCueLine,
  parsePrompts,
} from "@/lib/prompts";
import { useGenerationStore } from "@/store/generationStore";
import { findModel, referenceLimit } from "@/lib/kieModels";
import { MAX_PROMPTS, MAX_PROMPT_CHARS } from "@/types";

/** Splits a line into plain text and `@N` tokens, marking tokens with no character. */
const CUE_MARK =
  "rounded-sm bg-emerald-500/25 text-transparent underline decoration-emerald-400 decoration-2 underline-offset-2";

function highlightLine(line: string, knownIds: Set<number>): ReactNode[] {
  // A cue is a filename, not prompt text, and reads better as one block.
  if (isCueLine(line)) {
    return [
      <mark key="cue" className={CUE_MARK}>
        {line}
      </mark>,
    ];
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;

  // A cue can also open a line that carries its prompt as well; only the cue
  // itself is marked, and the rest of the line highlights as normal.
  const inline = line.match(INLINE_CUE_RE);
  if (inline) {
    const cue = line.slice(0, line.length - inline[2].length);
    nodes.push(
      <mark key="inline-cue" className={CUE_MARK}>
        {cue}
      </mark>
    );
    cursor = cue.length;
  }

  for (const match of line.matchAll(CHARACTER_TAG_RE)) {
    const start = match.index!;
    if (start < cursor) continue;
    if (start > cursor) nodes.push(line.slice(cursor, start));
    const known = knownIds.has(Number(match[1]));
    nodes.push(
      <mark
        key={`${start}-${match[0]}`}
        className={
          known
            ? "rounded-sm bg-accent/30 text-transparent underline decoration-accent decoration-2 underline-offset-2"
            : "rounded-sm bg-red-500/30 text-transparent underline decoration-red-400 decoration-wavy decoration-2 underline-offset-2"
        }
      >
        {match[0]}
      </mark>,
    );
    cursor = start + match[0].length;
  }
  if (cursor < line.length) nodes.push(line.slice(cursor));
  return nodes;
}

export function BulkPromptInput({ disabled }: { disabled: boolean }) {
  const promptText = useGenerationStore((state) => state.promptText);
  const setPromptText = useGenerationStore((state) => state.setPromptText);
  const characters = useGenerationStore((state) => state.characters);
  const model = useGenerationStore((state) => state.settings.model);

  const overlayRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);

  const knownIds = useMemo(
    () => new Set(characters.map((character) => character.id)),
    [characters],
  );

  const lines = useMemo(() => promptText.split("\n"), [promptText]);
  // One parse feeds every counter and warning below, so the panel can never
  // disagree with what the queue is about to run.
  const prompts = useMemo(() => parsePrompts(promptText), [promptText]);
  const tagged = useMemo(() => prompts.filter((prompt) => prompt.tag), [prompts]);
  const issues = useMemo(() => cueIssues(promptText), [promptText]);

  const overLength = prompts.filter((prompt) => prompt.raw.length > MAX_PROMPT_CHARS);
  const unknownTags = useMemo(() => {
    const unknown = new Set<string>();
    for (const prompt of prompts) {
      for (const match of prompt.raw.matchAll(CHARACTER_TAG_RE)) {
        if (!knownIds.has(Number(match[1]))) unknown.add(match[0]);
      }
    }
    return [...unknown];
  }, [prompts, knownIds]);

  const overPromptLimit = prompts.length > MAX_PROMPTS;

  // Pinned + tagged characters are merged per prompt; anything past what the
  // selected model accepts on one call would be silently dropped.
  const refLimit = referenceLimit(findModel(model));
  const overRefLimit = useMemo(() => {
    if (refLimit === 0) return 0;
    const pinned = characters
      .filter((character) => character.pinned)
      .map((c) => c.id);
    return prompts.filter(
      (prompt) =>
        new Set([
          ...pinned,
          ...prompt.referencedCharacterIds.filter((id) => knownIds.has(id)),
        ]).size > refLimit,
    ).length;
  }, [prompts, characters, knownIds, refLimit]);

  // The opposite failure, and the quieter one: references are uploaded but none
  // reach the model, because the prompt describes them in prose ("the attached
  // photo") instead of tagging them, and none are marked used-everywhere. Those
  // prompts generate a brand-new face every time and nothing looks wrong.
  const promptsWithoutRefs = useMemo(() => {
    if (characters.length === 0 || refLimit === 0) return 0;
    if (characters.some((character) => character.pinned)) return 0;
    return prompts.filter(
      (prompt) =>
        prompt.referencedCharacterIds.filter((id) => knownIds.has(id)).length === 0,
    ).length;
  }, [prompts, characters, knownIds, refLimit]);

  return (
    <section className="panel">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="panel-title mb-0">
          Prompts — {tagged.length > 0 ? "one per #cue" : "one per line"}
        </h2>
        <span
          className={`text-xs ${overPromptLimit ? "text-red-400" : "text-muted"}`}
        >
          {tagged.length > 0 && (
            <span className="text-emerald-400">{tagged.length} named · </span>
          )}
          {prompts.length} / {MAX_PROMPTS}
        </span>
      </div>

      <div
        className={`relative rounded-lg border bg-surface-2 transition ${
          focused ? "border-accent" : "border-line"
        } ${disabled ? "opacity-50" : ""}`}
      >
        {/* Mirror layer: same metrics as the textarea, draws the @N highlights. */}
        <div
          ref={overlayRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg px-3 py-2 font-mono text-sm leading-6 whitespace-pre-wrap text-transparent"
        >
          {lines.map((line, index) => (
            <div key={index}>
              {highlightLine(line, knownIds)}
              {line.length === 0 ? "​" : ""}
            </div>
          ))}
        </div>

        <textarea
          value={promptText}
          disabled={disabled}
          spellCheck={false}
          rows={10}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => setPromptText(event.target.value)}
          onScroll={(event) => {
            if (overlayRef.current) {
              overlayRef.current.scrollTop = event.currentTarget.scrollTop;
            }
          }}
          placeholder={
            "#0-00 Wolves howling on a dark ridge above an empty valley at night\n#0-05 Small canvas wall tent pitched on a grassy bench above a creek\n\n— the prompt can also go on the line below its #cue\n— or one prompt per line, with no #cues, to name files by their text"
          }
          className="relative w-full resize-y bg-transparent px-3 py-2 font-mono text-sm leading-6 text-foreground caret-white outline-none placeholder:text-muted disabled:cursor-not-allowed"
        />
      </div>

      <div className="mt-2 space-y-1 text-xs">
        {overPromptLimit && (
          <p className="text-red-400">
            {prompts.length} prompts — over the {MAX_PROMPTS} limit. Only the
            first {MAX_PROMPTS} would run; trim the list.
          </p>
        )}
        {overLength.length > 0 && (
          <p className="text-amber-400">
            {overLength.length} prompt{overLength.length === 1 ? "" : "s"}{" "}
            exceed {MAX_PROMPT_CHARS} characters.
          </p>
        )}
        {overRefLimit > 0 && (
          <p className="text-amber-400">
            {overRefLimit} prompt{overRefLimit === 1 ? "" : "s"} resolve to more
            than {refLimit} reference image{refLimit === 1 ? "" : "s"} (pinned +
            tagged) — the extras will be dropped from those calls.
          </p>
        )}
        {promptsWithoutRefs > 0 && (
          <p className="text-amber-400">
            {promptsWithoutRefs} prompt{promptsWithoutRefs === 1 ? "" : "s"} will
            run with <strong>no reference images</strong> — you have{" "}
            {characters.length} uploaded, but none is marked “Used in every
            prompt” and {promptsWithoutRefs === 1 ? "it doesn't" : "they don't"}{" "}
            tag one with @1. Describing a reference in the prompt text (“the
            attached photo”) does not attach it, so the model will invent a new
            face each time.
          </p>
        )}
        {unknownTags.length > 0 && (
          <p className="text-red-400">
            Unknown character tag{unknownTags.length === 1 ? "" : "s"}:{" "}
            {unknownTags.join(", ")} — no such reference image uploaded.
          </p>
        )}
        {issues.empty.length > 0 && (
          <p className="text-red-400">
            Cue{issues.empty.length === 1 ? "" : "s"} with no prompt underneath:{" "}
            {issues.empty.map((tag) => `#${tag}`).join(", ")} — nothing will be
            generated for {issues.empty.length === 1 ? "it" : "them"}.
          </p>
        )}
        {issues.duplicates.length > 0 && (
          <p className="text-amber-400">
            Repeated cue{issues.duplicates.length === 1 ? "" : "s"}:{" "}
            {issues.duplicates.map((tag) => `#${tag}`).join(", ")} — two images
            can&rsquo;t share a filename, so the later one is saved as{" "}
            <span className="font-mono">{issues.duplicates[0]} (2)</span> and
            won&rsquo;t be placed on the timeline.
          </p>
        )}
        {!overPromptLimit &&
          overLength.length === 0 &&
          unknownTags.length === 0 &&
          overRefLimit === 0 &&
          issues.empty.length === 0 &&
          issues.duplicates.length === 0 && (
            <p className="text-muted">
              {tagged.length > 0 ? (
                <>
                  Each <span className="font-mono text-emerald-400">#cue</span>{" "}
                  names its image on download —{" "}
                  <span className="font-mono">#{tagged[0].tag}</span> saves as{" "}
                  <span className="font-mono">{tagged[0].tag}.png</span>, which
                  the video editor reads as its timestamp. Lines under a cue
                  belong to that prompt.
                </>
              ) : (
                <>
                  Tagged characters are attached to that prompt; pinned ones are
                  attached to every prompt. Start a line with{" "}
                  <span className="font-mono text-emerald-400">#0-00</span> to
                  name that prompt&rsquo;s image for the video editor — with the
                  prompt on the same line or the next one, whichever you prefer.
                </>
              )}
            </p>
          )}
      </div>
    </section>
  );
}
