"use client";

import {
  FPS_CHOICES,
  RESOLUTIONS,
  type Encoder,
  type FilmLook,
  type LeadIn,
  type RenderSettings,
  type ZoomDirection,
} from "@/types/editor";

interface Props {
  settings: RenderSettings;
  /** Whether any talking clip is loaded — the exemption note only matters then. */
  hasAvatars: boolean;
  hasMotion: boolean;
  zoom: ZoomDirection;
  leadIn: LeadIn;
  tailSeconds: number;
  hasAudio: boolean;
  hasLeadIn: boolean;
  disabled: boolean;
  onSettings: (patch: Partial<RenderSettings>) => void;
  onZoom: (zoom: ZoomDirection) => void;
  onLeadIn: (leadIn: LeadIn) => void;
  onTailSeconds: (seconds: number) => void;
}

const ZOOM_OPTIONS: { value: ZoomDirection; label: string }[] = [
  { value: "none", label: "None" },
  { value: "in", label: "Zoom in" },
  { value: "out", label: "Zoom out" },
  { value: "alternate", label: "Alternate" },
];

export function SettingsPanel({
  settings,
  hasAvatars,
  hasMotion,
  zoom,
  leadIn,
  tailSeconds,
  hasAudio,
  hasLeadIn,
  disabled,
  onSettings,
  onZoom,
  onLeadIn,
  onTailSeconds,
}: Props) {
  return (
    <div className="space-y-4">
      <div className="panel space-y-3">
        <p className="panel-title">Motion</p>

        <div className="grid grid-cols-2 gap-2">
          {ZOOM_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              onClick={() => onZoom(option.value)}
              className={`pill ${zoom === option.value ? "pill-active" : ""}`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="block">
          <span className="flex items-baseline justify-between text-xs text-muted">
            <span>Amount — still images</span>
            <span className="font-mono text-foreground">
              {Math.round(settings.zoomAmount * 100)}%
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={20}
            step={1}
            value={Math.round(settings.zoomAmount * 100)}
            disabled={disabled || zoom === "none"}
            onChange={(event) =>
              onSettings({ zoomAmount: Number(event.target.value) / 100 })
            }
            className="mt-1 w-full accent-[var(--accent)] disabled:opacity-40"
          />
          <span className="text-[11px] text-muted">
            How much bigger a still ends than it started. 5–10% reads as a slow
            drift; past that it starts to feel like a push.
          </span>
        </label>

        <label className="block">
          <span className="flex items-baseline justify-between text-xs text-muted">
            <span>Amount — motion clips</span>
            <span className="font-mono text-foreground">
              {Math.round(settings.zoomAmountMotion * 100)}%
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={20}
            step={1}
            value={Math.round(settings.zoomAmountMotion * 100)}
            disabled={disabled || zoom === "none" || !hasMotion}
            onChange={(event) =>
              onSettings({ zoomAmountMotion: Number(event.target.value) / 100 })
            }
            className="mt-1 w-full accent-[var(--accent)] disabled:opacity-40"
          />
          <span className="text-[11px] text-muted">
            Kept separate because the shot is already moving — what reads as a
            gentle drift over a still is usually too much on top of footage. 0
            leaves clips alone.
            {!hasMotion && " No motion clips loaded."}
          </span>
        </label>

      </div>

      <div className="panel space-y-3">
        <p className="panel-title">Film look</p>

        <div className="grid grid-cols-4 gap-2">
          {(["off", "subtle", "medium", "heavy"] as FilmLook[]).map((look) => (
            <button
              key={look}
              type="button"
              disabled={disabled}
              onClick={() => onSettings({ film: look })}
              className={`pill capitalize ${settings.film === look ? "pill-active" : ""}`}
            >
              {look}
            </button>
          ))}
        </div>

        <p className="text-[11px] text-muted">
          Grain that moves with the frame, a slight flicker, vignette and faded
          highlights — no frame shake. Heavier settings grow the file: grain is
          noise, and noise is what the encoder spends bits on.
        </p>

        <div className="space-y-1.5 border-t border-line pt-2">
          <p className="text-[11px] text-muted">Apply the look and the zoom to:</p>
          <label className="flex items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={settings.effectsOnStills}
              disabled={disabled}
              onChange={(event) => onSettings({ effectsOnStills: event.target.checked })}
              className="accent-[var(--accent)]"
            />
            Still images
          </label>
          <label className="flex items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={settings.effectsOnMotion}
              disabled={disabled || !hasMotion}
              onChange={(event) => onSettings({ effectsOnMotion: event.target.checked })}
              className="accent-[var(--accent)] disabled:opacity-40"
            />
            Motion clips
            {!hasMotion && <span className="text-muted">— none loaded</span>}
          </label>
          <p className="text-[11px] text-muted">
            Talking clips never take either.{" "}
            {hasAvatars
              ? "A zoom on a speaking face reads as a mistake, and grain fights the one thing the viewer is trying to read."
              : ""}
          </p>
        </div>
      </div>

      <div className="panel space-y-3">
        <p className="panel-title">Output</p>

        <label className="block">
          <span className="text-xs text-muted">Resolution — 16:9</span>
          <select
            className="field mt-1"
            disabled={disabled}
            value={`${settings.width}x${settings.height}`}
            onChange={(event) => {
              const [width, height] = event.target.value.split("x").map(Number);
              onSettings({ width, height });
            }}
          >
            {RESOLUTIONS.map((resolution) => (
              <option
                key={resolution.label}
                value={`${resolution.width}x${resolution.height}`}
              >
                {resolution.label} — {resolution.width}×{resolution.height}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs text-muted">Frame rate</span>
          <select
            className="field mt-1"
            disabled={disabled}
            value={settings.fps}
            onChange={(event) => onSettings({ fps: Number(event.target.value) })}
          >
            {FPS_CHOICES.map((fps) => (
              <option key={fps} value={fps}>
                {fps} fps
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs text-muted">Encoder</span>
          <select
            className="field mt-1"
            disabled={disabled}
            value={settings.encoder}
            onChange={(event) => onSettings({ encoder: event.target.value as Encoder })}
          >
            <option value="libx264">x264 — best quality, smallest file</option>
            <option value="h264_videotoolbox">Hardware — frees the CPU, larger file</option>
          </select>
          <span className="text-[11px] text-muted">
            Clips encode several at a time, so x264 already spreads across every
            core and is usually the faster of the two as well. Hardware is worth
            trying if the machine has few cores or you need them for something
            else while it renders.
          </span>
        </label>

        {hasLeadIn && (
          <label className="block">
            <span className="text-xs text-muted">Before the first image</span>
            <select
              className="field mt-1"
              disabled={disabled}
              value={leadIn}
              onChange={(event) => onLeadIn(event.target.value as LeadIn)}
            >
              <option value="hold">Hold the first image</option>
              <option value="black">Black</option>
            </select>
          </label>
        )}

        <label className="block">
          <span className="flex items-baseline justify-between text-xs text-muted">
            <span>Shortest visual</span>
            <span className="font-mono text-foreground">
              {settings.minVisualSeconds.toFixed(1)}s
            </span>
          </span>
          <input
            type="range"
            min={0.5}
            max={5}
            step={0.5}
            value={settings.minVisualSeconds}
            disabled={disabled}
            onChange={(event) =>
              onSettings({ minVisualSeconds: Number(event.target.value) })
            }
            className="mt-1 w-full accent-[var(--accent)] disabled:opacity-40"
          />
          <span className="text-[11px] text-muted">
            A talking clip runs to its full length and pushes what follows. An
            image left with less room than this is skipped rather than flashed,
            and the next one takes its slot.
          </span>
        </label>

        {hasMotion && (
          <label className="block">
            <span className="flex items-baseline justify-between text-xs text-muted">
              <span>Slow motion limit</span>
              <span className="font-mono text-foreground">
                {settings.maxStretch.toFixed(1)}×
              </span>
            </span>
            <input
              type="range"
              min={1}
              max={4}
              step={0.5}
              value={settings.maxStretch}
              disabled={disabled}
              onChange={(event) => onSettings({ maxStretch: Number(event.target.value) })}
              className="mt-1 w-full accent-[var(--accent)] disabled:opacity-40"
            />
            <span className="text-[11px] text-muted">
              How far a clip may be slowed to fill its gap, with frames invented
              in between rather than repeated. Past about 2.5× the invention
              starts to show around fast movement. Roughly 70s of render per
              stretched clip.
            </span>
          </label>
        )}

        {hasAudio ? (
          <label className="block">
            <span className="flex items-baseline justify-between text-xs text-muted">
              <span>Audio fade out</span>
              <span className="font-mono text-foreground">
                {settings.audioFadeOut.toFixed(1)}s
              </span>
            </span>
            <input
              type="range"
              min={0}
              max={5}
              step={0.5}
              value={settings.audioFadeOut}
              disabled={disabled}
              onChange={(event) =>
                onSettings({ audioFadeOut: Number(event.target.value) })
              }
              className="mt-1 w-full accent-[var(--accent)] disabled:opacity-40"
            />
          </label>
        ) : (
          <label className="block">
            <span className="text-xs text-muted">Last image holds for</span>
            <input
              type="number"
              min={0.5}
              max={60}
              step={0.5}
              className="field mt-1"
              disabled={disabled}
              value={tailSeconds}
              onChange={(event) => onTailSeconds(Number(event.target.value) || 1)}
            />
            <span className="text-[11px] text-muted">
              With no audio there&rsquo;s nothing to run out, so the last image needs
              a length of its own.
            </span>
          </label>
        )}
      </div>
    </div>
  );
}
