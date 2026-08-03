export interface LoadedImageFile {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

const MAX_REFERENCE_EDGE = 768;
const JPEG_QUALITY = 0.9;

/**
 * Video stills are kept much larger than character references. A reference only
 * has to carry a likeness and must survive localStorage; a still is the literal
 * first frame of the clip, isn't persisted, and loses visible detail at 768px.
 */
const MAX_SHOT_EDGE = 1536;
const SHOT_QUALITY = 0.94;

/**
 * Reads a picked/dropped file and re-encodes it to a 768px long edge JPEG.
 * Reference images ride along in localStorage via the persist middleware, so a
 * full-size PNG per character would blow the ~5MB quota after three uploads —
 * 768px is well past what the model needs for character likeness anyway.
 */
export async function loadReferenceImage(file: File): Promise<LoadedImageFile> {
  return loadImage(file, MAX_REFERENCE_EDGE, JPEG_QUALITY);
}

/** The still a video clip is animated from. Same pipeline, gentler downscale. */
export async function loadShotImage(file: File): Promise<LoadedImageFile> {
  return loadImage(file, MAX_SHOT_EDGE, SHOT_QUALITY);
}

async function loadImage(
  file: File,
  maxEdge: number,
  quality: number
): Promise<LoadedImageFile> {
  if (!file.type.startsWith("image/")) {
    throw new Error(`${file.name} is not an image.`);
  }

  const dataUrl = await readAsDataUrl(file);
  const image = await decode(dataUrl);

  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas not available.");
  // Flatten onto white so transparent PNGs don't turn black in the JPEG.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const outputUrl = canvas.toDataURL("image/jpeg", quality);
  return {
    base64: outputUrl.slice(outputUrl.indexOf(",") + 1),
    mimeType: "image/jpeg",
    width,
    height,
  };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function decode(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not decode image."));
    image.src = dataUrl;
  });
}
