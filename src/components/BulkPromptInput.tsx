"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { CHARACTER_TAG_RE, parsePrompts } from "@/lib/prompts";
import { useGenerationStore } from "@/store/generationStore";
import { findModel, referenceLimit } from "@/lib/kieModels";
import { MAX_PROMPTS, MAX_PROMPT_CHARS } from "@/types";

/** Splits a line into plain text and `@N` tokens, marking tokens with no character. */
function highlightLine(line: string, knownIds: Set<number>): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of line.matchAll(CHARACTER_TAG_RE)) {
    const start = match.index!;
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
  const nonBlank = useMemo(
    () => lines.filter((line) => line.trim().length > 0),
    [lines],
  );
  const overLength = nonBlank.filter((line) => line.length > MAX_PROMPT_CHARS);
  const unknownTags = useMemo(() => {
    const unknown = new Set<string>();
    for (const line of nonBlank) {
      for (const match of line.matchAll(CHARACTER_TAG_RE)) {
        if (!knownIds.has(Number(match[1]))) unknown.add(match[0]);
      }
    }
    return [...unknown];
  }, [nonBlank, knownIds]);

  const overPromptLimit = nonBlank.length > MAX_PROMPTS;

  // Pinned + tagged characters are merged per prompt; anything past what the
  // selected model accepts on one call would be silently dropped.
  const refLimit = referenceLimit(findModel(model));
  const overRefLimit = useMemo(() => {
    if (refLimit === 0) return 0;
    const pinned = characters
      .filter((character) => character.pinned)
      .map((c) => c.id);
    return parsePrompts(promptText).filter(
      (prompt) =>
        new Set([
          ...pinned,
          ...prompt.referencedCharacterIds.filter((id) => knownIds.has(id)),
        ]).size > refLimit,
    ).length;
  }, [promptText, characters, knownIds, refLimit]);

  // The opposite failure, and the quieter one: references are uploaded but none
  // reach the model, because the prompt describes them in prose ("the attached
  // photo") instead of tagging them, and none are marked used-everywhere. Those
  // prompts generate a brand-new face every time and nothing looks wrong.
  const promptsWithoutRefs = useMemo(() => {
    if (characters.length === 0 || refLimit === 0) return 0;
    if (characters.some((character) => character.pinned)) return 0;
    return parsePrompts(promptText).filter(
      (prompt) =>
        prompt.referencedCharacterIds.filter((id) => knownIds.has(id)).length === 0,
    ).length;
  }, [promptText, characters, knownIds, refLimit]);

  return (
    <section className="panel">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="panel-title mb-0">Prompts — one per line</h2>
        <span
          className={`text-xs ${overPromptLimit ? "text-red-400" : "text-muted"}`}
        >
          {nonBlank.length} / {MAX_PROMPTS}
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
            "@1 and @2 sitting in a cafe, @1 is laughing\n@1 walking home under streetlights\nwide shot of the empty cafe at dawn"
          }
          className="relative w-full resize-y bg-transparent px-3 py-2 font-mono text-sm leading-6 text-foreground caret-white outline-none placeholder:text-muted disabled:cursor-not-allowed"
        />
      </div>

      <div className="mt-2 space-y-1 text-xs">
        {overPromptLimit && (
          <p className="text-red-400">
            {nonBlank.length} prompts — over the {MAX_PROMPTS} limit. Only the
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
        {!overPromptLimit &&
          overLength.length === 0 &&
          unknownTags.length === 0 &&
          overRefLimit === 0 && (
            <p className="text-muted">
              Tagged characters are attached to that prompt; pinned ones are
              attached to every prompt.
            </p>
          )}
      </div>
    </section>
  );
}
