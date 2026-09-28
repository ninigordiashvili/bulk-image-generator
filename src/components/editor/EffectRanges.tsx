"use client";
import { useState } from "react";
import type { FilmLook, FilmRange, MotionRange, RenderSettings, StillMotion, PanDirection } from "@/types/editor";
import { FILM_LABELS, MOTION_LABELS, MAX_EFFECT_RANGES, formatEffectTime, parseEffectTime, rangeError } from "@/lib/editor/timedEffects";

export function EffectRanges({ kind, settings, disabled, onSettings }: { kind: 'motion' | 'film'; settings: RenderSettings; disabled: boolean; onSettings: (patch: Partial<RenderSettings>) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [start, setStart] = useState('0:00:000');
  const [end, setEnd] = useState('5:00:000');
  const [effect, setEffect] = useState<StillMotion>('pan');
  const [direction, setDirection] = useState<PanDirection>('left');
  const [amount, setAmount] = useState(8);
  const [look, setLook] = useState<FilmLook>('subtle');
  const [error, setError] = useState('');
  const ranges = kind === 'motion' ? settings.motionRanges ?? [] : settings.filmRanges ?? [];
  const save = () => {
    const a = parseEffectTime(start), b = parseEffectTime(end);
    if (a === null || b === null) { setError('Use minutes:seconds:milliseconds, for example 5:08:434.'); return; }
    const common = { id: editing ?? ('effect-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)), start: a, end: b };
    const row = kind === 'motion' ? { ...common, effect, direction, amount: amount / 100 } : { ...common, look };
    const next = [...ranges.filter(r => r.id !== editing), row].sort((a,b)=>a.start-b.start);
    const problem = rangeError(next);
    if (problem) { setError(problem); return; }
    if (kind === 'motion') onSettings({ motionRanges: next as MotionRange[] });
    else onSettings({ filmRanges: next as FilmRange[], filmRangesEnabled: true });
    setEditing(null); setError(''); setStart(formatEffectTime(b)); setEnd(formatEffectTime(b + 300));
  };
  const remove = (id: string) => {
    if (kind === 'motion') onSettings({ motionRanges: (settings.motionRanges ?? []).filter(r=>r.id!==id) });
    else onSettings({ filmRanges: (settings.filmRanges ?? []).filter(r=>r.id!==id) });
    if (editing === id) { setEditing(null); setError(''); }
  };
  return <details className="border-t border-line pt-3" open={ranges.length > 0 || undefined}>
    <summary className="cursor-pointer text-xs font-medium">{kind === 'motion' ? 'Still image motion ranges' : 'Film look time ranges'} ({ranges.length})</summary>
    <div className="mt-3 space-y-3">
      <p className="text-[11px] text-muted">Minutes:seconds:milliseconds: 5:08:434 means 5 min 8.434 sec. You can also enter 5:08.434 or seconds. Timing follows the nearest video frame.</p>
      {kind === 'film' ? <label className="flex gap-2 text-xs"><input type="checkbox" checked={settings.filmRangesEnabled ?? false} disabled={disabled} onChange={e=>onSettings({filmRangesEnabled:e.target.checked})} />Use only these ranges (no film look outside them)</label> : <p className="text-[11px] text-muted">Overrides still image zoom inside each range, with a gentle ease in and out. Outside ranges, the zoom above applies. Enable Still images below to use these effects.</p>}
      {ranges.map(r=><div key={r.id} className="rounded border border-line p-2 text-xs space-y-1">
        <div>{formatEffectTime(r.start)} to {formatEffectTime(r.end)}</div>
        <div>{'effect' in r ? MOTION_LABELS[r.effect] + ' / ' + r.direction + ' / ' + Math.round(r.amount*100) + '%' : FILM_LABELS[r.look]}</div>
        <div className="flex gap-2"><button type="button" className="pill" disabled={disabled} onClick={()=>{setEditing(r.id);setStart(formatEffectTime(r.start));setEnd(formatEffectTime(r.end));setError('');if ('effect' in r) {setEffect(r.effect);setDirection(r.direction);setAmount(Math.round(r.amount*100));} else setLook(r.look);}}>Edit</button><button type="button" className="pill" disabled={disabled} onClick={()=>remove(r.id)}>Remove</button></div>
      </div>)}
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">Start<input aria-label={kind + ' range start'} className="field mt-1 w-full" value={start} disabled={disabled} onChange={e=>setStart(e.target.value)} placeholder="0:00:000" /></label>
        <label className="text-xs">End<input aria-label={kind + ' range end'} className="field mt-1 w-full" value={end} disabled={disabled} onChange={e=>setEnd(e.target.value)} placeholder="5:08:434" /></label>
      </div>
      {kind === 'motion' ? <>
        <select aria-label="Still motion effect" className="field w-full" disabled={disabled} value={effect} onChange={e=>setEffect(e.target.value as StillMotion)}>{Object.entries(MOTION_LABELS).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select>
        <select aria-label="Pan direction" className="field w-full" disabled={disabled} value={direction} onChange={e=>setDirection(e.target.value as PanDirection)}>{['left','right','up','down'].map(v=><option key={v} value={v}>{v}</option>)}</select>
        <label className="block text-xs">Motion strength: {amount}%<input aria-label="Motion strength" type="range" min={1} max={20} value={amount} disabled={disabled} onChange={e=>setAmount(Number(e.target.value))} className="w-full" /></label>
      </> : <select aria-label="Range film look" className="field w-full" disabled={disabled} value={look} onChange={e=>setLook(e.target.value as FilmLook)}>{Object.entries(FILM_LABELS).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select>}
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2"><button type="button" className="pill" disabled={disabled || (!editing && ranges.length >= MAX_EFFECT_RANGES)} onClick={save}>{editing ? 'Save range' : 'Add range'}</button>{editing && <button type="button" className="pill" onClick={()=>{setEditing(null);setError('');}}>Cancel edit</button>}</div>
      <p className="text-[11px] text-muted">Ranges in this list cannot overlap. Motion and film ranges can run together. Click {editing ? 'Save range' : 'Add range'} to apply the fields above.</p>
    </div>
  </details>;
}
