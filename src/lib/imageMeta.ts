export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Reads pixel dimensions straight out of the encoded bytes. Only needs PNG/JPEG/WEBP
 * (what the image API returns), so no decoder dependency.
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
}

function readPng(bytes: Uint8Array): ImageDimensions | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  if (!signature.every((byte, i) => bytes[i] === byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    // SOF0–SOF15, excluding the non-frame markers DHT (c4), JPG (c8) and DAC (cc).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
      };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
}

function readWebp(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null;
  const tag = (start: number) =>
    String.fromCharCode(...bytes.subarray(start, start + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = tag(12);
  if (format === "VP8X") {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  if (format === "VP8 ") {
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (format === "VP8L") {
    const bits =
      bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

/**
 * Buckets an image by its largest dimension. Tier sizes are nominal (a 16:9 "1K"
 * image is 1344×768), so the thresholds sit between the tiers rather than on them.
 */
export function classifyResolution(dimensions: ImageDimensions): string {
  const largest = Math.max(dimensions.width, dimensions.height);
  if (largest <= 1600) return "1K";
  if (largest <= 3200) return "2K";
  return "4K";
}

/**
 * Only meaningful for models whose `resolution` field names a tier. Anything
 * else the user asked for — "auto", a `quality` setting, an `image_size` preset
 * — has no tier to compare against, so it never counts as a mismatch.
 */
export function isResolutionMismatch(
  requested: string | undefined,
  dimensions: ImageDimensions | null
): boolean {
  if (!dimensions || !requested) return false;
  if (!/^[124]K$/.test(requested)) return false;
  return classifyResolution(dimensions) !== requested;
}
