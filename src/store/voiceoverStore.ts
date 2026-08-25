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
  /** Object URLs of the joined track, once there is one. */
  url: string | null;
  urlMp3: string | null;
  /** A pause longer than this is too long. */
  maxGap: number;
  /** What a too-long pause becomes. */
  keepGap: number;
  /** How much of the original run-up to the next word is kept. */
  leadIn: number;

  addFiles: (files: File[]) => void;
  remove: (name: string) => void;
  clear: () => void;
  setPacing: (patch: { maxGap?: number; keepGap?: number; leadIn?: number }) => void;
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
      urlMp3: null,
      // A second of quiet between sentences reads as a breath; much more and it
      // reads as a mistake.
      maxGap: 1,
      keepGap: 0.8,
      // Enough of the run-up that the first consonant of the next word is
      // whole. Below about 0.1s the clipped attack starts to be audible again.
      leadIn: 0.2,

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
            ...cleared(state),
            error: null,
          };
        }),

      remove: (name) =>
        set((state) => ({
          files: state.files.filter((file) => file.name !== name),
          ...cleared(state),
        })),

      clear: () =>
        set((state) => ({ files: [], ...cleared(state), error: null })),

      setPacing: (patch) =>
        set((state) => {
          const maxGap = patch.maxGap ?? state.maxGap;
          // A pause can't be shortened to longer than the cap that caught it,
          // and the run-up has to fit inside what's left of the pause.
          const keepGap = Math.min(patch.keepGap ?? state.keepGap, maxGap);
          return {
            maxGap,
            keepGap,
            leadIn: Math.min(patch.leadIn ?? state.leadIn, keepGap),
            ...cleared(state),
          };
        }),

      join: async () => {
        const { files, busy, maxGap, keepGap, leadIn } = get();
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
            leadIn,
          })) as { ok: true; report: PaceReport } | ErrorResponse;
          if (!joined.ok) throw new Error(joined.error);

          // Both fetched back so the result is a pair of local files the
          // browser owns, rather than links into a scratch directory that gets
          // swept out from under them. It also means the job can be dropped
          // immediately instead of being kept alive for a later download.
          const [m4a, mp3] = await Promise.all([
            grab(`/api/editor/job/${jobId}/voiceover/download`),
            grab(`/api/editor/job/${jobId}/voiceover/download?format=mp3`),
          ]);

          const previous = get();
          revoke(previous.url);
          revoke(previous.urlMp3);
          set({
            busy: false,
            report: joined.report,
            url: URL.createObjectURL(m4a),
            urlMp3: URL.createObjectURL(mp3),
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
      partialize: (state) => ({
        maxGap: state.maxGap,
        keepGap: state.keepGap,
        leadIn: state.leadIn,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...((persisted ?? {}) as Partial<VoiceoverState>),
      }),
    }
  )
);

/** Dropping a result means dropping the object URLs behind it, or they leak. */
function cleared(state: VoiceoverState) {
  revoke(state.url);
  revoke(state.urlMp3);
  return { report: null, url: null, urlMp3: null };
}

function revoke(url: string | null) {
  if (url) URL.revokeObjectURL(url);
}

async function grab(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("The joined track could not be read back.");
  return response.blob();
}

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
