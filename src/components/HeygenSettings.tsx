"use client";

import { useEffect, useState } from "react";
import { heygenSource, type HeygenLook, type HeygenOptions } from "@/lib/heygen";
import { videoModel } from "@/lib/videoModels";

const requests = new Map<string, Promise<HeygenLook[]>>();
function loadLooks(ownership: string) {
  let pending = requests.get(ownership);
  if (!pending) {
    pending = (async () => {
      const looks: HeygenLook[] = [];
      let token = "";
      do {
        const response = await fetch(`/api/heygen/avatars?${new URLSearchParams({ ownership, token })}`);
        const result = await response.json();
        if (!result.ok) throw new Error(result.error || "Could not load avatars.");
        looks.push(...result.data);
        token = result.has_more ? result.next_token || "" : "";
      } while (token);
      return looks;
    })().catch(error => { requests.delete(ownership); throw error; });
    requests.set(ownership, pending);
  }
  return pending;
}

export function HeygenSettings({ model, resolution, aspectRatio, options = {}, disabled, onChange }: {
  model: string; resolution: string; aspectRatio: string; options?: HeygenOptions; disabled: boolean;
  onChange: (patch: { resolution?: string; aspectRatio?: string; heygen?: HeygenOptions }) => void;
}) {
  const spec = videoModel(model);
  const source = heygenSource(model, options);
  const [ownership, setOwnership] = useState("private");
  const [looks, setLooks] = useState<HeygenLook[]>([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (source !== "avatar") return;
    let active = true;
    void loadLooks(ownership).then(result => { if (active) { setLooks(result); setError(""); } })
      .catch(cause => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [source, ownership, revision]);
  const set = (patch: Partial<HeygenOptions>) => onChange({ heygen: { ...options, ...patch } });
  const look = looks.find(item => item.id === options.avatarId);
  const photo = source !== "avatar" || (look?.avatar_type ?? options.avatarType) === "photo_avatar";
  const resolutions = spec.requestModel === "avatar_iii" && photo ? spec.resolutions.filter(r => r !== "4k") : spec.resolutions;
  return <fieldset disabled={disabled} className="space-y-3 rounded border border-line p-3 text-xs disabled:opacity-60">
    <legend className="px-1 text-muted">HeyGen settings</legend>
    <div className="flex flex-wrap gap-3">
      <label>Character source<select aria-label="HeyGen character source" className="field mt-1" value={source} onChange={e => set({ source: e.target.value as HeygenOptions["source"] })}>
        {spec.requestModel === "avatar_iv" && <option value="image">Animate source image directly</option>}
        <option value="photo">Create / reuse Photo Avatar from source image</option>
        <option value="avatar">Saved or stock HeyGen avatar</option>
      </select></label>
      <label>Quality<select aria-label="HeyGen quality" className="field mt-1" value={resolution} onChange={e => onChange({ resolution: e.target.value })}>
        {resolutions.map(value => <option key={value}>{value}</option>)}
      </select></label>
      <label>Aspect ratio<select aria-label="HeyGen aspect ratio" className="field mt-1" value={aspectRatio} onChange={e => onChange({ aspectRatio: e.target.value })}>
        {spec.aspectRatios.map(value => <option key={value} value={value}>{value === "auto" ? "Auto — match source" : value}</option>)}
      </select></label>
      <label>Framing<select className="field mt-1" value={options.fit ?? "auto"} onChange={e => set({ fit: e.target.value as HeygenOptions["fit"] })}>
        <option value="auto">Automatic</option><option value="contain">Keep entire image</option><option value="cover">Fill frame (may crop)</option>
      </select></label>
    </div>
    {source === "avatar" && <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <select aria-label="HeyGen avatar library" className="field w-auto" value={ownership} onChange={e => setOwnership(e.target.value)}><option value="private">My avatars</option><option value="public">Stock avatars</option></select>
        <select aria-label="HeyGen avatar" className="field min-w-48 flex-1" value={options.avatarId ?? ""} onChange={e => set({ avatarId: e.target.value, avatarType: looks.find(item => item.id === e.target.value)?.avatar_type })}>
          <option value="">{loading ? "Loading avatars…" : "Select an avatar"}</option>
          {options.avatarId && !looks.some(item => item.id === options.avatarId) && <option value={options.avatarId}>{options.avatarId}</option>}
          {looks.map(item => <option key={item.id} value={item.id} disabled={!!item.supported_api_engines?.length && !item.supported_api_engines.includes(spec.requestModel)}>{item.name} — {item.avatar_type.replaceAll("_", " ")}{item.supported_api_engines?.length && !item.supported_api_engines.includes(spec.requestModel) ? " (different engine required)" : ""}</option>)}
        </select>
        <button type="button" className="btn-ghost" onClick={() => { requests.delete(ownership); setRevision(value => value + 1); }}>Refresh avatars</button>
      </div>
      <label className="block text-muted">Or enter an avatar / look ID<input className="field mt-1" value={options.avatarId ?? ""} onChange={e => set({ avatarId: e.target.value.trim() })} /></label>
      <p className="text-muted">Auto uses the saved avatar’s source proportions. This selection replaces the row’s image for generation.</p>
      {error && <p className="text-red-400">{error}</p>}
    </div>}
    {source === "photo" && <p className="text-muted">Creates a reusable avatar once per unique image. HeyGen may charge separately for avatar creation; the $1/min estimate covers video duration.</p>}
    {spec.requestModel === "avatar_iii" && <p className="text-muted">Avatar III uses the selected audio; motion prompts and expression controls are unavailable.</p>}
    {photo && spec.requestModel === "avatar_iv" && <label className="block">Expression level<select className="field mt-1 w-auto" value={options.expressiveness ?? "low"} onChange={e => set({ expressiveness: e.target.value as HeygenOptions["expressiveness"] })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>}
    {source === "avatar" && look && !photo && spec.requestModel === "avatar_iv" && <p className="text-muted">Avatar IV video avatars do not support motion prompts.</p>}
    <details><summary className="cursor-pointer text-muted">More output settings</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label>File format<select className="field mt-1" value={options.outputFormat ?? "mp4"} onChange={e => set({ outputFormat: e.target.value as HeygenOptions["outputFormat"] })}><option value="mp4">MP4</option><option value="webm">WebM — transparent (supported avatars)</option></select></label>
      <label>Video title<input className="field mt-1" maxLength={200} value={options.title ?? ""} onChange={e => set({ title: e.target.value })} /></label>
      <label><input type="checkbox" checked={!!options.captions} onChange={e => set({ captions: e.target.checked })} /> Burn captions into video</label>
      {options.outputFormat !== "webm" && <>
        <label><input type="checkbox" checked={!!options.removeBackground} onChange={e => set({ removeBackground: e.target.checked })} /> Remove background (supported avatars)</label>
        <label>Background color<input className="field mt-1" placeholder="Original background, or #ffffff" value={options.backgroundColor ?? ""} onChange={e => set({ backgroundColor: e.target.value })} /></label>
        <label>Background image URL<input className="field mt-1" placeholder="https://… (overrides color)" value={options.backgroundUrl ?? ""} onChange={e => set({ backgroundUrl: e.target.value })} /></label>
      </>}
      {spec.requestModel === "avatar_v" && <label>Animation reference look ID (optional)<input className="field mt-1" value={options.referenceLookId ?? ""} onChange={e => set({ referenceLookId: e.target.value.trim() })} /><span className="text-muted">Motion prompts require a compatible animation reference.</span></label>}
    </div></details>
    <p className="text-muted">Length follows the selected audio cut. Final video timing is accurate to the video frame. Estimate: $1/minute at every quality; provider charges may differ.</p>
  </fieldset>;
}
