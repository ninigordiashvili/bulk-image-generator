/** `0:08`, `1:24`, `1:02:30` — how cues read everywhere in the editor UI. */
export function formatTime(seconds: number, showMillis = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const base =
    hours > 0
      ? `${hours}:${pad(minutes)}:${pad(secs)}`
      : `${minutes}:${pad(secs)}`;
  if (!showMillis) return base;
  const millis = Math.round((seconds - whole) * 1000);
  return millis > 0 ? `${base}.${String(millis).padStart(3, "0")}` : base;
}

/** Durations read better as `4.0s` than as `0:04` when they're this short. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  return seconds < 60 ? `${seconds.toFixed(1)}s` : formatTime(seconds);
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / 1024 ** power;
  return `${value >= 10 || power === 0 ? Math.round(value) : value.toFixed(1)} ${units[power]}`;
}
