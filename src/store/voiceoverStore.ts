"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { inScriptOrder } from "@/lib/editor/order";
import { uploadFile } from "@/lib/editor/upload";
import type { CreateJobResponse, ErrorResponse, PaceReport } from "@/types/editor";

/**
 * The voiceover joiner's own state.
 *
 * Deliberately separate from the editor: joining takes is a job you do once
 * when the narration comes back from wherever it was recorded, and the editor
 * is a job you do afterwards with the result. Sharing a store would have tied
 * two unrelated pieces of work together.
 */
export interface VoiceoverState {
  files: File[];
  busy: boolean;
  error: string | null;
  report: PaceReport | null;
  /** Object URL of the joined track, once there is one. */
  url: string | null;
  /** A pause longer than this is too long. */
  maxGap: number;
  /** What a too-long pause becomes. */
  keepGap: number;

  addFiles: (files: File[]) => void;
  remove: (name: string) => void;
  clear: () => void;
  setPacing: (patch: { maxGap?: number; keepGap?: number }) => void;
  join: () => Promise<void>;
}

const AUDIO = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;

export const useVoiceoverStore = create<VoiceoverState>()(
  persist(
    (set, get) => ({
      files: [],
      busy: false,
      error: null,
      report: null,
      url: null,
      // A second of quiet between sentences reads as a breath; much more and it
      // reads as a mistake.
      maxGap: 1,
      keepGap: 0.8,

      addFiles: (files) =>
        set((state) => {
          const seen = new Set(state.files.map((file) => file.name));
          const added = files.filter(
            (file) =>
              !seen.has(file.name) &&
              (file.type.startsWith("audio/") || AUDIO.test(file.name))
          );
          return {
            // Sorted by the names the user gave them, so 2 comes before 10.
            files: inScriptOrder([...state.files, ...added], (file) => file.name),
            // A new take invalidates whatever was joined before it.
            report: null,
            url: null,
            error: null,
          };
        }),

      remove: (name) =>
        set((state) => ({
          files: state.files.filter((file) => file.name !== name),
          report: null,
          url: null,
        })),

      clear: () => set({ files: [], report: null, url: null, error: null }),

      setPacing: (patch) =>
        set((state) => {
          const maxGap = patch.maxGap ?? state.maxGap;
          return {
            maxGap,
            // A pause can't be shortened to longer than the cap that caught it.
            keepGap: Math.min(patch.keepGap ?? state.keepGap, maxGap),
            report: null,
            url: null,
          };
        }),

      join: async () => {
        const { files, busy, maxGap, keepGap } = get();
        if (files.length === 0 || busy) return;
        set({ busy: true, error: null });

        let jobId: string | null = null;
        try {
          const created = (await post("/api/editor/job", null)) as
            | CreateJobResponse
            | ErrorResponse;
          if (!created.ok) throw new Error(created.error);
          jobId = created.id;

          // Uploaded in script order, and the server joins in the order given —
          // the stored names only record what arrived first.
          const stored: string[] = [];
          for (const file of files) {
            stored.push(await uploadFile({ jobId, kind: "voice", file }));
          }

          const joined = (await post(`/api/editor/job/${jobId}/voiceover`, {
            files: stored,
            maxGap,
            keepGap,
            thresholdDb: -35,
          })) as { ok: true; report: PaceReport } | ErrorResponse;
          if (!joined.ok) throw new Error(joined.error);

          // Fetched back so the result is a local file the browser owns, rather
          // than a link into a scratch directory that gets swept.
          const response = await fetch(`/api/editor/job/${jobId}/voiceover/download`);
          if (!response.ok) throw new Error("The joined track could not be read back.");
          const blob = await response.blob();

          const previous = get().url;
          if (previous) URL.revokeObjectURL(previous);
          set({
            busy: false,
            report: joined.report,
            url: URL.createObjectURL(blob),
          });
        } catch (error) {
          set({
            busy: false,
            error: error instanceof Error ? error.message : "Could not join those takes.",
          });
        } finally {
          // The track is in hand; the scratch copies are not needed.
          if (jobId) {
            void fetch(`/api/editor/job/${jobId}`, { method: "DELETE" }).catch(() => {});
          }
        }
      },
    }),
    {
      name: "bulk-generator-voiceover",
      storage: createJSONStorage(() => localStorage),
      // Files and object URLs mean nothing after a reload; the two numbers do.
      partialize: (state) => ({ maxGap: state.maxGap, keepGap: state.keepGap }),
      merge: (persisted, current) => ({
        ...current,
        ...((persisted ?? {}) as Partial<VoiceoverState>),
      }),
    }
  )
);

async function post(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    ...(body === null
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (payload) return payload;
  throw new Error(`Request to ${url} failed (${response.status}).`);
}
