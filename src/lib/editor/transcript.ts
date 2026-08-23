/**
 * Reading a transcript, and finding the moments in it worth putting on screen.
 *
 * The parsing half is lifted from the transcript importer that used to sit in
 * the generator: it already handled the three shapes a transcript arrives in
 * (YouTube's panel, SRT, VTT) and there was no reason to write it twice.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  const once = (value: string) =>
    value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name: string) => {
      const known = ENTITIES[name.toLowerCase()];
      if (known) return known;
      if (name.startsWith("#x") || name.startsWith("#X")) {
        return String.fromCodePoint(parseInt(name.slice(2), 16));
      }
      if (name.startsWith("#")) {
        return String.fromCodePoint(Number(name.slice(1)));
      }
      return match;
    });
  return once(once(text));
}

/** Collapses the line breaks YouTube puts mid-sentence into single spaces. */

function tidy(text: string): string {
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

/** One caption line: when it starts, and what is said. */
export interface TranscriptCue {
  start: number;
  text: string;
}

const CUE_TIME_RE =
  /^[([]?\s*(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?(?:[.,](\d{1,3}))?\s*[)\]]?/;

/** Lines that carry no text: SRT indices and the VTT header. */
const NOISE_RE = /^(?:\d+|WEBVTT.*|NOTE\b.*)$/;

/**
 * Reads a transcript that was copied out of YouTube's own panel, or an SRT or
 * VTT file, into timed cues.
 *
 * This is the path that always works. YouTube stopped serving its caption
 * endpoint to plain server requests, but the transcript is three clicks away in
 * the player — … → Show transcript → copy — and the tedious part was never
 * getting the text, it was turning a wall of timestamps into cues.
 *
 * Both layouts are handled: a timestamp alone on its line with the text
 * beneath, and a timestamp with its text on the same line.
 */
export function parsePastedTranscript(input: string): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  let open: TranscriptCue | null = null;

  // A transcript pasted out of a document often runs several cues together on
  // one line — `(0:00) ... (0:05) ...`. Breaking before each bracketed stamp
  // lets one line-based pass read both that and the one-per-line layout.
  // Only bracketed stamps are split on: a bare `3:30` mid-sentence is as likely
  // to be a time being talked about as a cue.
  const normalised = input.replace(/(?!^)[([](\d{1,3}:\d{1,2}(?::\d{1,2})?)[)\]]/g, "\n($1)");

  for (const line of normalised.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || NOISE_RE.test(trimmed)) continue;

    const match = trimmed.match(CUE_TIME_RE);
    if (match) {
      // Three colon-separated parts are h:mm:ss; two are m:ss.
      const [, a, b, c, fraction] = match;
      const seconds = c
        ? Number(a) * 3600 + Number(b) * 60 + Number(c)
        : Number(a) * 60 + Number(b);
      const start = seconds + (fraction ? Number(`0.${fraction}`) : 0);

      // An SRT range line (`00:00:01,000 --> 00:00:04,000`) carries no text of
      // its own; the caption follows on the next line.
      const rest = trimmed.slice(match[0].length).replace(/^-->.*$/, "").trim();

      open = { start, text: rest };
      cues.push(open);
      continue;
    }

    if (open) open.text = open.text ? `${open.text} ${trimmed}` : trimmed;
  }

  return cues
    .map((cue) => ({ start: cue.start, text: tidy(cue.text) }))
    .filter((cue) => cue.text.length > 0);
}

// ---------------------------------------------------------------------------
// Finding the moments worth putting on screen
// ---------------------------------------------------------------------------

/** What kind of thing was spotted, which is only used to group the list. */
export type MomentKind =
  | "year"
  | "countdown"
  | "count"
  | "ordinal"
  | "money"
  | "percent"
  | "big number";

export interface MomentCandidate {
  /** Stable across re-scans of the same transcript, so ticks survive an edit. */
  id: string;
  kind: MomentKind;
  /** The phrase itself — what goes on screen unless it's edited. */
  text: string;
  /** Where in the narration it is spoken. */
  start: number;
  /** The whole line it came from, so it can be recognised in the list. */
  context: string;
}

/**
 * The patterns. Order matters: the first one to claim a stretch of text wins,
 * so `Top 5` is a countdown rather than a bare number, and `1969` is a year
 * rather than a big number.
 *
 * Deliberately narrow. A transcript is wall-to-wall digits — every duration,
 * every aside — and a detector that flags all of them just moves the work from
 * finding the moments to rejecting them.
 */
const PATTERNS: { kind: MomentKind; re: RegExp }[] = [
  // One trailing word only: "Top 5 things" is a title card, the rest of the
  // sentence is not.
  { kind: "countdown", re: /\btop\s+\d{1,3}(?:\s+[a-z]+)?/gi },
  { kind: "year", re: /\b(?:1[0-9]{3}|20[0-9]{2})\b/g },
  {
    kind: "count",
    re: /\b\d{1,3}\s+(?:things|parts|ways|reasons|steps|facts|secrets|rules|lessons|tips|mistakes|signs|questions|types|kinds|levels|stages)\b/gi,
  },
  { kind: "money", re: /[$€£]\s?\d[\d,.]*(?:\s?(?:million|billion|trillion|thousand|k|bn))?/gi },
  { kind: "percent", re: /\b\d{1,3}(?:\.\d+)?\s?(?:%|per\s?cent\b)/gi },
  { kind: "big number", re: /\b\d{1,3}(?:,\d{3})+\b|\b\d{1,4}\s?(?:million|billion|trillion)\b/gi },
  { kind: "ordinal", re: /\b\d{1,3}(?:st|nd|rd|th)\b/gi },
];

/**
 * Where inside its own line a phrase is spoken.
 *
 * A caption line runs for a few seconds, and a phrase at the end of it is
 * spoken seconds after the line's timestamp. Interpolating on character
 * position is not exact — nobody speaks at a constant rate — but it is much
 * closer than pinning everything to the start of the line, and the time is
 * editable afterwards anyway.
 */
function timeOfPhrase(cue: TranscriptCue, nextStart: number | null, index: number): number {
  if (!cue.text.length) return cue.start;
  const span = nextStart === null ? 0 : Math.max(0, Math.min(nextStart - cue.start, 12));
  return cue.start + (index / cue.text.length) * span;
}

/** Every phrase in the transcript that might be worth showing. */
export function findMoments(cues: TranscriptCue[]): MomentCandidate[] {
  const found: MomentCandidate[] = [];

  cues.forEach((cue, cueIndex) => {
    const nextStart = cueIndex + 1 < cues.length ? cues[cueIndex + 1].start : null;
    // Character ranges already claimed by an earlier, more specific pattern.
    const taken: [number, number][] = [];
    const overlaps = (from: number, to: number) =>
      taken.some(([a, b]) => from < b && to > a);

    for (const { kind, re } of PATTERNS) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(cue.text)) !== null) {
        const from = match.index;
        const to = from + match[0].length;
        if (overlaps(from, to)) continue;
        taken.push([from, to]);

        const text = match[0].trim().replace(/\s+/g, " ");
        found.push({
          id: `${cueIndex}:${from}:${kind}`,
          kind,
          text,
          start: timeOfPhrase(cue, nextStart, from),
          context: cue.text,
        });
      }
    }
  });

  return found.sort((a, b) => a.start - b.start);
}
