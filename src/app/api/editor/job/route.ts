import { NextResponse } from "next/server";
import { createJob } from "@/server/editor/jobs";
import type { CreateJobResponse, ErrorResponse } from "@/types/editor";

/**
 * Opens a scratch directory for one export. Everything the editor uploads and
 * everything ffmpeg writes lives under the returned id until the job is
 * discarded or swept.
 */
export async function POST() {
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
