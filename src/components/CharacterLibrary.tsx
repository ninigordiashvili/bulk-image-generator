"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { loadReferenceImage } from "@/lib/imageFile";
import { findModel, referenceLimit } from "@/lib/kieModels";
import { useGenerationStore } from "@/store/generationStore";

export function CharacterLibrary({ disabled }: { disabled: boolean }) {
  const characters = useGenerationStore((state) => state.characters);
  const model = useGenerationStore((state) => state.settings.model);
  const addCharacter = useGenerationStore((state) => state.addCharacter);
  const updateCharacter = useGenerationStore((state) => state.updateCharacter);
  const removeCharacter = useGenerationStore((state) => state.removeCharacter);

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pinnedCount = characters.filter((character) => character.pinned).length;
  // Every kie model takes a different number of reference images, and some take
  // none at all — the limit follows whichever model is selected.
  const spec = findModel(model);
  const refLimit = referenceLimit(spec);

  async function ingest(files: FileList | File[]) {
    setError(null);
    for (const file of Array.from(files)) {
      try {
        const loaded = await loadReferenceImage(file);
        addCharacter({
          label: file.name.replace(/\.[^.]+$/, "").slice(0, 40),
          base64: loaded.base64,
          mimeType: loaded.mimeType,
          // Uploading a reference means "use this". Referring to it in prose —
          // "the attached photo" — is invisible to the tag parser, so an
          // opt-in default silently produced reference-free generations.
          pinned: true,
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not read file.");
      }
    }
  }

  return (
    <section className="panel">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="panel-title mb-0">Character library</h2>
        <span className="text-xs text-muted">
          {characters.length} refs · {pinnedCount} pinned
        </span>
      </div>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!disabled && event.dataTransfer.files.length) {
            void ingest(event.dataTransfer.files);
          }
        }}
        onClick={() => !disabled && inputRef.current?.click()}
        className={`cursor-pointer rounded-lg border border-dashed px-4 py-6 text-center text-xs transition ${
          dragging ? "border-accent bg-accent/10" : "border-line"
        } ${disabled ? "cursor-not-allowed opacity-50" : "hover:border-accent"}`}
      >
        <span className="text-muted">
          Drop reference images here, or click to pick. Each gets the next number —
          use <code className="text-foreground">@1</code>,{" "}
          <code className="text-foreground">@2</code> in prompts.
        </span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files) void ingest(event.target.files);
          event.target.value = "";
        }}
      />

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      {characters.length > 0 && refLimit === 0 && (
        <p className="mt-2 text-xs text-amber-400">
          {spec?.label ?? "This model"} is text-to-image only — reference images
          are ignored for it. Pick a model that accepts image input to use these.
        </p>
      )}

      {refLimit > 0 && pinnedCount > refLimit && (
        <p className="mt-2 text-xs text-amber-400">
          {pinnedCount} characters are pinned but {spec?.label} accepts only{" "}
          {refLimit} reference image{refLimit === 1 ? "" : "s"} per call — extras
          will be dropped.
        </p>
      )}

      {characters.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-3">
          {characters.map((character) => (
            <div
              key={character.id}
              className="w-36 rounded-lg border border-line bg-surface-2 p-2"
            >
              <div className="relative mb-2 aspect-square overflow-hidden rounded-md bg-black/40">
                <Image
                  src={`data:${character.mimeType};base64,${character.base64}`}
                  alt={character.label}
                  fill
                  unoptimized
                  className="object-cover"
                />
                <span className="badge absolute top-1 left-1">@{character.id}</span>
              </div>

              <input
                className="field mb-2 px-2 py-1 text-xs"
                value={character.label}
                disabled={disabled}
                onChange={(event) =>
                  updateCharacter(character.id, { label: event.target.value })
                }
              />

              <label
                className={`mb-2 flex cursor-pointer items-center gap-2 text-[11px] ${
                  character.pinned ? "text-foreground" : "text-amber-400"
                }`}
                title={
                  character.pinned
                    ? "Attached to every prompt in the batch."
                    : `Not attached to any prompt unless that prompt tags @${character.id}.`
                }
              >
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={character.pinned}
                  disabled={disabled}
                  onChange={(event) =>
                    updateCharacter(character.id, { pinned: event.target.checked })
                  }
                />
                {character.pinned ? "Used in every prompt" : `Only when tagged @${character.id}`}
              </label>

              <button
                type="button"
                className="w-full rounded-md border border-line px-2 py-1 text-[11px] text-muted transition hover:border-red-500 hover:text-red-400 disabled:opacity-40"
                disabled={disabled}
                onClick={() => removeCharacter(character.id)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
