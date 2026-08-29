"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { inScriptOrder } from "@/lib/editor/order";
import { clampPacing } from "@/lib/editor/pacing";
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
      // These are measured in *room*, not in what a listener calls silence, and
      // the two are not the same length. A word doesn't stop dead, it decays,
      // and the next one swells in — both are heard as part of the gap but
      // neither is room, and neither may be cut. On a normal read that is about
      // half a second of ramp per gap, so a pause that sounds like 1.2s has
      // nearer 0.7s of room in it.
      //
      // `keepGap` sits on its floor of two guards, which is where it has always
      // been; the floor moved from 0.5 to 0.3 when SPEECH_GUARD did. Measured
      // against the real detector on a 2.26s gap, that takes the leftover from
      // 1.22s to 1.02s. A browser holding the old 0.5 keeps it — the value is
      // persisted and still legal, so it has to be dragged down by hand.
      maxGap: 0.7,
      keepGap: 0.3,
      // Enough of the run-up that the first consonant of the next word is
      // whole. It is never allowed below SPEECH_GUARD, which is where the
      // clipped attack starts to be audible.
      leadIn: 0.15,

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
        set((state) => ({
          // Held to the same floors the cutter applies, so a slider can't be
          // left showing a pause shorter than one it will actually produce.
          ...clampPacing({
            maxGap: patch.maxGap ?? state.maxGap,
            keepGap: patch.keepGap ?? state.keepGap,
            leadIn: patch.leadIn ?? state.leadIn,
          }),
          ...cleared(state),
        })),

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
      merge: (persisted, current) => {
        const saved = { ...current, ...((persisted ?? {}) as Partial<VoiceoverState>) };
        // Settings saved before the guard existed can be below its floors, and
        // a slider showing 0.1s when nothing under 0.5s is possible reads as a
        // broken setting rather than a raised floor.
        return { ...saved, ...clampPacing(saved) };
      },
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
