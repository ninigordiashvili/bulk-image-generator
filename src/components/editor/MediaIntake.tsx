"use client";

import { useEffect, useRef, useState } from "react";
import { formatDuration } from "@/lib/editor/format";
import { analyseBed } from "@/lib/editor/analyse";
import { readAudioDuration } from "@/lib/editor/media";
import type { AudioTrack } from "@/store/editorStore";
import { MAX_IMAGES, VIDEO_EXTENSIONS } from "@/types/editor";

interface Props {
  audio: AudioTrack | null;
  imageCount: number;
  placedCount: number;
  disabled: boolean;
  onAudio: (track: AudioTrack | null) => void;
  onImages: (files: File[]) => void;
  onClearImages: () => void;
}

const IMAGE_PATTERN = /\.(png|jpe?g|webp|bmp|tiff?)$/i;
const VIDEO_PATTERN = new RegExp(`\\.(${VIDEO_EXTENSIONS.join("|")})$`, "i");
const VISUAL = (file: File) =>
  IMAGE_PATTERN.test(file.name) ||
  VIDEO_PATTERN.test(file.name) ||
  file.type.startsWith("image/") ||
  file.type.startsWith("video/");

export function MediaIntake({
  audio,
  imageCount,
  placedCount,
  disabled,
  onAudio,
  onImages,
  onClearImages,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const folderInput = useRef<HTMLInputElement | null>(null);

  // `webkitdirectory` isn't in the DOM typings, and it's the only way to let
  // someone hand over a whole render folder in one go.
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  const takeAudio = async (file: File) => {
    setError(null);
    const url = URL.createObjectURL(file);
    try {
      const duration = await readAudioDuration(url);
      // Decoded up front: every talking clip is located against this, and
      // doing it once here beats doing it per clip.
      const envelope = await analyseBed(file);
      onAudio({ file, name: file.name, duration, url, envelope });
    } catch (problem) {
      URL.revokeObjectURL(url);
      setError(problem instanceof Error ? problem.message : "Could not read that audio.");
    }
  };

  /** One drop can hold the audio and the images together — sort them out here. */
  const takeFiles = async (files: File[]) => {
    const images = files.filter(VISUAL);
    const sound = files.find(
      (file) => file.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(file.name)
    );

    if (images.length > 0) onImages(images);
    if (sound) await takeAudio(sound);
    if (images.length === 0 && !sound) {
      setError("Nothing in that drop looked like an image, a video or an audio file.");
    } else if (images.length > 0) {
      setError(null);
    }
  };

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    await takeFiles([...event.dataTransfer.files]);
  };

  return (
    <div className="panel space-y-3">
      <p className="panel-title">Source material</p>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-lg border border-dashed p-4 text-center transition ${
          dragging ? "border-accent bg-accent/10" : "border-line bg-surface-2"
        } ${disabled ? "opacity-50" : ""}`}
      >
        <p className="text-sm text-foreground">
          Drop your audio, images and clips here
        </p>
        <p className="mt-1 text-xs text-muted">
          Placed by filename — <span className="font-mono">0-00</span>,{" "}
          <span className="font-mono">0-08</span>, <span className="font-mono">1-24</span>.
          Talking clips find their own position from the audio.
        </p>

        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <label className={`pill ${disabled ? "pointer-events-none opacity-50" : "cursor-pointer"}`}>
            Choose audio
            <input
              type="file"
              accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus"
              className="hidden"
              disabled={disabled}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void takeAudio(file);
              }}
            />
          </label>

          <label className={`pill ${disabled ? "pointer-events-none opacity-50" : "cursor-pointer"}`}>
            Choose visuals
            <input
              type="file"
              accept="image/*,video/*"
              multiple
              className="hidden"
              disabled={disabled}
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = "";
                if (files.length) onImages(files);
              }}
            />
          </label>

          <label className={`pill ${disabled ? "pointer-events-none opacity-50" : "cursor-pointer"}`}>
            Choose folder
            <input
              ref={folderInput}
              type="file"
              multiple
              className="hidden"
              disabled={disabled}
              onChange={(event) => {
                const files = [...(event.target.files ?? [])].filter(VISUAL);
                event.target.value = "";
                if (files.length) onImages(files);
                else setError("That folder had no images or clips in it.");
              }}
            />
          </label>
        </div>
      </div>

      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted">Audio</span>
          {audio ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-foreground" title={audio.name}>
                {audio.name}
              </span>
              <span className="shrink-0 font-mono text-xs text-muted">
                {formatDuration(audio.duration)}
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onAudio(null)}
                className="shrink-0 text-xs text-muted hover:text-foreground disabled:opacity-40"
              >
                ✕
              </button>
            </span>
          ) : (
            <span className="text-xs text-muted">none — the video will be silent</span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-muted">Visuals</span>
          <span className="flex items-center gap-2">
            <span className="text-foreground">
              {placedCount} placed
              {imageCount !== placedCount && (
                <span className="text-muted"> of {imageCount}</span>
              )}
            </span>
            {imageCount > 0 && (
              <button
                type="button"
                disabled={disabled}
                onClick={onClearImages}
                className="text-xs text-muted hover:text-foreground disabled:opacity-40"
              >
                clear
              </button>
            )}
          </span>
        </div>

        {imageCount >= MAX_IMAGES && (
          <p className="text-xs text-amber-400">
            Holding the first {MAX_IMAGES} visuals — anything past that was ignored.
          </p>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
}
