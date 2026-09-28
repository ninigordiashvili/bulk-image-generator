/** User-selected estimate, independent of HeyGen's actual billing rates. */
export const HEYGEN_USD_PER_MINUTE = 1;
export const heygenEstimate = (seconds: number) => Math.max(0, seconds) / 60 * HEYGEN_USD_PER_MINUTE;

export interface HeygenOptions {
  source?: "image" | "photo" | "avatar";
  avatarId?: string;
  avatarType?: HeygenLook["avatar_type"];
  expressiveness?: "low" | "medium" | "high";
  fit?: "auto" | "contain" | "cover";
  removeBackground?: boolean;
  backgroundColor?: string;
  backgroundUrl?: string;
  outputFormat?: "mp4" | "webm";
  captions?: boolean;
  referenceLookId?: string;
  title?: string;
}

export interface HeygenLook {
  id: string;
  name: string;
  avatar_type: "photo_avatar" | "digital_twin" | "studio_avatar";
  supported_api_engines: string[];
  image_width?: number;
  image_height?: number;
  preview_image_url?: string;
  status?: string;
}

export function heygenSource(model: string, options?: HeygenOptions) {
  return options?.source ?? (model === "heygen:avatar_iv" ? "image" : "photo");
}
