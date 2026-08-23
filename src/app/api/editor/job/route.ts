import { NextResponse } from "next/server";
import { NO_RENDER_REASON, canRender } from "@/server/editor/host";
import { createJob } from "@/server/editor/jobs";
import type { CreateJobResponse, ErrorResponse } from "@/types/editor";

/**
 * Opens a scratch directory for one export. Everything the editor uploads and
 * everything ffmpeg writes lives under the returned id until the job is
 * discarded or swept.
 */
export async function POST() {
  // Checked before anything is uploaded, not after.
  if (!canRender()) {
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: NO_RENDER_REASON },
      { status: 501 }
    );
  }

  try {
    const job = await createJob();
    return NextResponse.json<CreateJobResponse>({ ok: true, id: job.id });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      {
        ok: false,
        error:
          error instanceof Error
            ? `Could not create a workspace: ${error.message}`
            : "Could not create a workspace.",
      },
      { status: 500 }
    );
  }
}
