import type { CharacterRef, PromptItem } from "@/types";

/** Matches `@1`, `@12` — a character reference tag. */
export const CHARACTER_TAG_RE = /@(\d+)/g;

/**
 * A line that is nothing but `#something` names the file its image will be
 * saved as. It exists so a batch can come out of here already named for the
 * timestamps the video editor reads — `#0-00` produces `0-00.png`, which drops
 * straight onto the timeline at 0:00.
 */
export const CUE_LINE_RE = /^#[ \t]*(\S+)[ \t]*$/;

/**
 * The same thing written on one line: `#0-00 a wide shot of the valley`.
 *
 * Both forms are natural to type and there is no reason to accept only one.
 * This one is deliberately narrower, though: the tag has to look like a
 * timestamp — digits with dashes, dots or colons between them — because a
 * prompt's *first word* is very often an ordinary hashtag, and turning
 * `#cinematic wide shot` into a file called `cinematic.png` would be worse
 * than not reading it at all. A tag alone on its line stays unrestricted,
 * since a line with nothing else on it can only have been meant as a name.
 */
export const INLINE_CUE_RE = /^#[ \t]*(\d+(?:[-_.:]\d+)*)[ \t]+(\S.*)$/;

/** Everything else is replaced: this ends up as a filename on three platforms. */
const UNSAFE_TAG_CHARS = /[^A-Za-z0-9._-]+/g;

/** Normalises a raw tag into something safe to write to disk, or null. */
export function sanitizeCueTag(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(UNSAFE_TAG_CHARS, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : null;
}

/** The tag if this line is a cue line, else null. */
export function cueTagOf(line: string): string | null {
  const match = line.trim().match(CUE_LINE_RE);
  return match ? sanitizeCueTag(match[1]) : null;
}

/** True for a line that opens a block, tag readable or not. */
export function isCueLine(line: string): boolean {
  return CUE_LINE_RE.test(line.trim());
}

/** A cue and its prompt sharing one line, or null if this isn't that. */
export function inlineCueOf(line: string): { tag: string; rest: string } | null {
  const match = line.trim().match(INLINE_CUE_RE);
  if (!match) return null;
  const tag = sanitizeCueTag(match[1]);
  return tag ? { tag, rest: match[2].trim() } : null;
}

/** True for either form, which is what decides whether cues are in play at all. */
export function hasCue(line: string): boolean {
  return isCueLine(line) || inlineCueOf(line) !== null;
}

/**
 * The first cue tag in a free-text prompt. Used by the video storyboard, where
 * a prompt is one textarea per row rather than a list.
 */
export function cueTagIn(text: string): string | null {
  for (const line of text.split("\n")) {
    const tag = cueTagOf(line) ?? inlineCueOf(line)?.tag ?? null;
    if (tag) return tag;
  }
  return null;
}

/** The prompt without its cues — a filename is not part of the prompt. */
export function stripCueLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isCueLine(line))
    .map((line) => inlineCueOf(line)?.rest ?? line)
    .join("\n")
    .trim();
}

export function extractCharacterIds(line: string): number[] {
  const ids = new Set<number>();
  for (const match of line.matchAll(CHARACTER_TAG_RE)) {
    ids.add(Number(match[1]));
  }
  return [...ids].sort((a, b) => a - b);
}

interface PromptBlock {
  raw: string;
  tag: string | null;
}

/**
 * Splits the box into prompts, in one of two modes.
 *
 * Without any `#tag` lines it's one prompt per non-blank line, which is how
 * this has always worked. The moment a cue line appears the whole box switches
 * to blocks: `#0-00` opens a prompt and every line under it belongs to that
 * prompt until the next cue. That's the only way a prompt can span lines, and
 * it's what makes a 500-character shot description readable in the box.
 *
 * `@N` tags stay in the text; only the ids are lifted out. Cue lines do not —
 * a filename has no business being sent to the model.
 */
export function parsePrompts(text: string): PromptItem[] {
  const lines = text.split("\n");
  const blocks = lines.some(hasCue) ? taggedBlocks(lines) : onePerLine(lines);
  return blocks.map((block, index) => ({
    id: `p${index}-${hashLine(block.raw)}`,
    raw: block.raw,
    tag: block.tag,
    referencedCharacterIds: extractCharacterIds(block.raw),
  }));
}

function onePerLine(lines: string[]): PromptBlock[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((raw) => ({ raw, tag: null }));
}

function taggedBlocks(lines: string[]): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  let open: PromptBlock | null = null;

  const flush = () => {
    // A cue with nothing under it isn't a prompt; the input panel calls it out
    // rather than letting it quietly become one fewer image than expected.
    if (open && open.raw.length > 0) blocks.push(open);
    open = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (isCueLine(trimmed)) {
      flush();
      open = { raw: "", tag: cueTagOf(trimmed) };
      continue;
    }
    const inline = inlineCueOf(trimmed);
    if (inline) {
      // Tag and prompt on one line is a whole prompt by itself. It still opens
      // a block, so a continuation line underneath belongs to it.
      flush();
      open = { raw: inline.rest, tag: inline.tag };
      continue;
    }
    if (trimmed.length === 0) continue;
    if (open) open.raw = open.raw ? `${open.raw}\n${trimmed}` : trimmed;
    // Text above the first cue keeps the one-per-line reading, so a stray
    // untagged prompt at the top still runs.
    else blocks.push({ raw: trimmed, tag: null });
  }
  flush();

  return blocks;
}

/** Cue mistakes worth surfacing before a batch spends anything. */
export function cueIssues(text: string): { empty: string[]; duplicates: string[] } {
  const lines = text.split("\n");
  if (!lines.some(hasCue)) return { empty: [], duplicates: [] };

  const empty: string[] = [];
  let openTag: string | null = null;
  let openHasText = false;

  const close = () => {
    if (openTag !== null && !openHasText) empty.push(openTag);
    openTag = null;
    openHasText = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (isCueLine(trimmed)) {
      close();
      openTag = cueTagOf(trimmed) ?? trimmed;
      continue;
    }
    const inline = inlineCueOf(trimmed);
    if (inline) {
      close();
      // It carries its own text, so it can never be one of the empty ones.
      openTag = inline.tag;
      openHasText = true;
      continue;
    }
    if (trimmed.length > 0) openHasText = true;
  }
  close();

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const prompt of parsePrompts(text)) {
    if (!prompt.tag) continue;
    if (seen.has(prompt.tag)) duplicates.add(prompt.tag);
    seen.add(prompt.tag);
  }

  return { empty, duplicates: [...duplicates] };
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
