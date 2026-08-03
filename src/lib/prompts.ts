import type { CharacterRef, PromptItem } from "@/types";

/** Matches `@1`, `@12` — a character reference tag. */
export const CHARACTER_TAG_RE = /@(\d+)/g;

export function extractCharacterIds(line: string): number[] {
  const ids = new Set<number>();
  for (const match of line.matchAll(CHARACTER_TAG_RE)) {
    ids.add(Number(match[1]));
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * One non-blank line = one prompt. Tags are left in the displayed text; only the
 * referenced ids are lifted out.
 */
export function parsePrompts(text: string): PromptItem[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((raw, index) => ({
      id: `p${index}-${hashLine(raw)}`,
      raw,
      referencedCharacterIds: extractCharacterIds(raw),
    }));
}

/**
 * Which characters get attached to a given prompt: every pinned character, plus
 * any character explicitly tagged in that prompt. Deduplicated, ordered by id.
 */
export function resolveCharactersForPrompt(
  prompt: PromptItem,
  characters: CharacterRef[]
): CharacterRef[] {
  const wanted = new Set<number>(prompt.referencedCharacterIds);
  for (const character of characters) {
    if (character.pinned) wanted.add(character.id);
  }
  return characters
    .filter((character) => wanted.has(character.id))
    .sort((a, b) => a.id - b.id);
}

/** Tags in the text that don't correspond to an uploaded character (typo protection). */
export function unknownTagIds(
  prompts: PromptItem[],
  characters: CharacterRef[]
): number[] {
  const known = new Set(characters.map((c) => c.id));
  const unknown = new Set<number>();
  for (const prompt of prompts) {
    for (const id of prompt.referencedCharacterIds) {
      if (!known.has(id)) unknown.add(id);
    }
  }
  return [...unknown].sort((a, b) => a - b);
}

function hashLine(line: string): string {
  let hash = 0;
  for (let i = 0; i < line.length; i++) {
    hash = (hash * 31 + line.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}
