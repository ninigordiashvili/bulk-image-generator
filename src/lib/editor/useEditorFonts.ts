"use client";
import { useEffect, useState } from "react";
import { STYLE_ORDER, TEXT_STYLES } from "./textStyles";
let loading: Promise<void> | undefined;
export function useEditorFonts() {
  const [error, setError] = useState("");
  useEffect(() => {
    loading ??= Promise.all(STYLE_ORDER.map(async style => {
      const face = new FontFace("Editor-" + style, 'url("/api/editor/fonts?style=' + style + '")', { weight: String(TEXT_STYLES[style].weight) });
      document.fonts.add(await face.load());
    })).then(() => {});
    let active = true;
    loading.catch(() => { if (active) setError("A preview font could not load. Reload to retry before checking text placement."); loading = undefined; });
    return () => { active = false; };
  }, []);
  return error;
}
