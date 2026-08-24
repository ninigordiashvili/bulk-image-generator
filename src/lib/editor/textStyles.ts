/**
 * The look of a text moment.
 *
 * One table, read by both renderers: `server/editor/textOverlay.ts` turns it
 * into drawtext options, `lib/editor/momentPreview.ts` into canvas calls. They
 * are only in step because neither has its own copy of these numbers.
 *
 * Every style names a real font *file* for the export, because ffmpeg's
 * fontconfig fallback picks whatever it finds and would give a different
 * typeface on a different machine. The candidate lists cover macOS, Windows and
 * a typical Linux install, and fall through to whatever else is present.
 */

export type MomentStyle = "modern" | "classic" | "oldSchool" | "newsreel" | "impact";

export interface StyleSpec {
  label: string;
  hint: string;
  /** Font files for the export, most-preferred first. */
  files: string[];
  /** The CSS stack the preview draws with, matched to the files above. */
  css: string;
  weight: number;
  /** RRGGBB, formatted per renderer. */
  colour: string;
  uppercase: boolean;
  /** Outline thickness as a fraction of frame height; 0 for none. */
  rim: number;
  rimAlpha: number;
  /** Drop shadow offset as a fraction of frame height; 0 for none. */
  shadow: number;
  shadowAlpha: number;
  /** A bar behind the words, for styles that want one. */
  box: boolean;
  boxAlpha: number;
}

const MAC = "/System/Library/Fonts/Supplemental";
const WIN = "C:/Windows/Fonts";
const DEJAVU = "/usr/share/fonts/truetype/dejavu";
const LIBERATION = "/usr/share/fonts/truetype/liberation";

export const TEXT_STYLES: Record<MomentStyle, StyleSpec> = {
  modern: {
    label: "Modern",
    hint: "Clean sans, thin dark edge. Reads on anything.",
    files: [
      `${MAC}/Arial Bold.ttf`,
      `${WIN}/arialbd.ttf`,
      "/System/Library/Fonts/HelveticaNeue.ttc",
      `${DEJAVU}/DejaVuSans-Bold.ttf`,
      `${LIBERATION}/LiberationSans-Bold.ttf`,
    ],
    css: '"Helvetica Neue", Arial, sans-serif',
    weight: 700,
    colour: "FFFFFF",
    uppercase: false,
    rim: 1 / 360,
    rimAlpha: 0.75,
    shadow: 1 / 540,
    shadowAlpha: 0.5,
    box: false,
    boxAlpha: 0,
  },
  classic: {
    label: "Classic",
    hint: "Serif, no outline, soft shadow. Quiet and filmic.",
    files: [
      `${MAC}/Georgia.ttf`,
      `${WIN}/georgia.ttf`,
      `${MAC}/Times New Roman.ttf`,
      `${WIN}/times.ttf`,
      `${DEJAVU}/DejaVuSerif.ttf`,
    ],
    css: 'Georgia, "Times New Roman", serif',
    weight: 400,
    colour: "FFFFFF",
    uppercase: false,
    rim: 0,
    rimAlpha: 0,
    shadow: 1 / 300,
    shadowAlpha: 0.6,
    box: false,
    boxAlpha: 0,
  },
  oldSchool: {
    label: "Old school",
    hint: "Warm cream serif with a heavy black edge, like a title card.",
    files: [
      `${MAC}/Georgia Bold.ttf`,
      `${WIN}/georgiab.ttf`,
      `${MAC}/Times New Roman Bold.ttf`,
      `${WIN}/timesbd.ttf`,
      `${DEJAVU}/DejaVuSerif-Bold.ttf`,
    ],
    css: 'Georgia, "Times New Roman", serif',
    weight: 700,
    // Not white: aged stock never is, and a warm cream sits in the picture
    // rather than on top of it.
    colour: "F2E4C4",
    uppercase: false,
    rim: 1 / 200,
    rimAlpha: 0.85,
    shadow: 1 / 260,
    shadowAlpha: 0.55,
    box: false,
    boxAlpha: 0,
  },
  newsreel: {
    label: "Newsreel",
    hint: "Uppercase monospace on a black bar. Documentary caption.",
    files: [
      `${MAC}/Courier New Bold.ttf`,
      `${WIN}/courbd.ttf`,
      "/System/Library/Fonts/Menlo.ttc",
      `${DEJAVU}/DejaVuSansMono-Bold.ttf`,
    ],
    css: '"Courier New", Menlo, monospace',
    weight: 700,
    colour: "FFFFFF",
    uppercase: true,
    rim: 0,
    rimAlpha: 0,
    shadow: 0,
    shadowAlpha: 0,
    box: true,
    boxAlpha: 0.62,
  },
  impact: {
    label: "Impact",
    hint: "Heavy uppercase with a thick outline. Loud.",
    files: [
      `${MAC}/Impact.ttf`,
      `${WIN}/impact.ttf`,
      `${MAC}/Arial Black.ttf`,
      `${WIN}/ariblk.ttf`,
      `${DEJAVU}/DejaVuSans-Bold.ttf`,
    ],
    css: 'Impact, "Arial Black", "Helvetica Neue", sans-serif',
    weight: 900,
    colour: "FFFFFF",
    uppercase: true,
    rim: 1 / 150,
    rimAlpha: 0.9,
    shadow: 0,
    shadowAlpha: 0,
    box: false,
    boxAlpha: 0,
  },
};

export const STYLE_ORDER: MomentStyle[] = [
  "modern",
  "classic",
  "oldSchool",
  "newsreel",
  "impact",
];

/** Falls back rather than throwing, so an unknown saved style still renders. */
export function styleOf(style: MomentStyle | undefined): StyleSpec {
  return TEXT_STYLES[style ?? "modern"] ?? TEXT_STYLES.modern;
}

/** What actually goes on screen, once the style has had its say. */
export function displayText(text: string, style: MomentStyle | undefined): string {
  const spec = styleOf(style);
  return spec.uppercase ? text.toUpperCase() : text;
}
