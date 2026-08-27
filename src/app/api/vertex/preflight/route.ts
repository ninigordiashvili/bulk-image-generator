import { NextResponse } from "next/server";
import { preflight, vertexTarget } from "@/server/vertex";
import { VertexAccountError, findVertexAccount } from "@/server/vertexAccounts";
import { VERTEX_IMAGE_MODELS, VERTEX_VIDEO_MODELS } from "@/lib/vertexModels";

/** Each image model is tested with a real call, and they run one at a time. */
export const maxDuration = 300;

/**
 * Reports which Vertex models this project may actually use.
 *
 * Worth having as an endpoint rather than a note in the README because the
 * failure it diagnoses is invisible from the outside: a project can be billing-
 * enabled, have `aiplatform` switched on, answer Gemini text calls perfectly,
 * and still return 404 for every image model — with wording that reads like a
 * typo in the model id. Running this once answers "is it my spelling or my
 * project?" in about a minute.
 *
 * It generates a test image per model, so it costs a few cents and is gated
 * behind `?confirm=1` rather than running on a stray page load.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const { project, location } = vertexTarget();

  if (!project) {
    return NextResponse.json(
      { ok: false, error: "No GOOGLE_CLOUD_PROJECT set in .env.local." },
      { status: 500 }
    );
  }

  if (url.searchParams.get("confirm") !== "1") {
    return NextResponse.json({
      ok: false,
      project,
      location,
      error:
        "This generates one test image per model and bills your project a few " +
        "cents. Re-run with ?confirm=1 to proceed.",
      wouldTest: {
        image: VERTEX_IMAGE_MODELS.map((model) => model.id),
        video: VERTEX_VIDEO_MODELS.map((model) => model.id),
      },
    });
  }

  let account;
  try {
    account = await findVertexAccount(url.searchParams.get("accountId") ?? undefined);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof VertexAccountError ? error.message : "No account." },
      { status: 500 }
    );
  }

  const results = await preflight(account, {
    image: VERTEX_IMAGE_MODELS.map((model) => model.id),
    video: VERTEX_VIDEO_MODELS.map((model) => model.id),
  });

  const usable = results.filter((result) => result.available).map((result) => result.model);

  // The options each model takes, so the UI can build its pickers from the same
  // source the preflight just tested against.
  const options = {
    images: VERTEX_IMAGE_MODELS.map((model) => ({
      model: model.id,
      location: model.location,
      aspectRatios: model.aspectRatios,
      verifiedAspectRatios: model.verifiedAspectRatios,
      imageSizes: model.imageSizes,
      verifiedImageSizes: model.verifiedImageSizes,
    })),
    videos: VERTEX_VIDEO_MODELS.map((model) => ({
      model: model.id,
      location: model.location,
      aspectRatios: model.aspectRatios,
      resolutions: model.resolutions,
      verifiedResolutions: model.verifiedResolutions,
      durations: model.durations,
    })),
  };

  return NextResponse.json({
    ok: true,
    account: { id: account.id, label: account.label },
    project: account.projectId,
    location,
    usableImageModels: usable,
    summary:
      usable.length > 0
        ? `${usable.length} image model(s) available.`
        : "No image model is available to this project. Every one returned an " +
          "error — that is an entitlement or billing problem, not a model id " +
          "problem, and no code change here will fix it.",
    options,
    results,
  });
}
