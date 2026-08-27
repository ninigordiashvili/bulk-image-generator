import { NextResponse } from "next/server";
import {
  VertexError,
  generateImages,
  generateVideo,
  vertexTarget,
} from "@/server/vertex";
import { findVertexImageModel, findVertexVideoModel } from "@/lib/vertexModels";
import { VertexAccountError, findVertexAccount } from "@/server/vertexAccounts";
import { classifyResolution, readImageDimensions } from "@/lib/imageMeta";

/**
 * Vertex generation, shaped like the kie route so the queue can drive either.
 *
 * Video is a long-running operation that the server waits out, which is why the
 * ceiling here is higher than the kie route's — a Veo clip regularly takes
 * longer than a kie image task.
 */
export const maxDuration = 800;

interface VertexGenerateBody {
  /** Which Google account pays. Omitted uses the first configured. */
  accountId?: string;
  kind?: "image" | "video";
  model?: string;
  prompt?: string;
  styleBible?: string;
  count?: number;
  /** Shape of the output, e.g. "16:9". Valid values differ per model. */
  aspectRatio?: string;
  /** Image resolution tier, e.g. "1K". */
  imageSize?: string;
  /** Video resolution, "720p" or "1080p". */
  resolution?: string;
  negativePrompt?: string;
  seed?: number;
  durationSeconds?: number;
  /** Defaults to false: cheaper, and the editor lays your own narration under. */
  generateAudio?: boolean;
  outputGcsUri?: string;
  /** Base64 still for the image-to-video models, without a data: prefix. */
  image?: { base64?: string; mimeType?: string };
}

function fail(error: string, status = 400, retryable = false) {
  return NextResponse.json({ ok: false, error, retryable }, { status });
}

export async function POST(request: Request) {
  let body: VertexGenerateBody;
  try {
    body = (await request.json()) as VertexGenerateBody;
  } catch {
    return fail("Malformed request body.");
  }

  const kind = body.kind ?? "image";
  const model = body.model?.trim();
  const prompt = [body.styleBible?.trim(), body.prompt?.trim()]
    .filter(Boolean)
    .join("\n");

  if (!model) return fail("No model selected.");
  if (!prompt) return fail("Prompt is empty.");

  const { project } = vertexTarget();
  if (!project) {
    return fail(
      "No Google Cloud project configured. Set GOOGLE_CLOUD_PROJECT in .env.local.",
      500
    );
  }

  // The client can send any id — the catalog is a convenience, not a gate, so an
  // unlisted model still reaches Vertex. What the lookup buys is catching a
  // wrong *kind* before spending a call on it.
  if (kind === "image" && findVertexVideoModel(model)) {
    return fail(`${model} is a video model — send it with kind: "video".`);
  }
  if (kind === "video" && findVertexImageModel(model)) {
    return fail(`${model} is an image model — send it with kind: "image".`);
  }

  const signal = request.signal;

  let account;
  try {
    account = await findVertexAccount(body.accountId);
  } catch (error) {
    return fail(
      error instanceof VertexAccountError ? error.message : "No Vertex account.",
      500
    );
  }

  try {
    if (kind === "video") {
      const still = body.image?.base64
        ? { base64: body.image.base64, mimeType: body.image.mimeType ?? "image/png" }
        : undefined;

      const videos = await generateVideo({
        account,
        model,
        prompt,
        image: still,
        aspectRatio: body.aspectRatio,
        durationSeconds: body.durationSeconds,
        resolution: body.resolution,
        generateAudio: body.generateAudio ?? false,
        outputGcsUri: body.outputGcsUri,
        signal,
      });

      return NextResponse.json({ ok: true, kind: "video", videos });
    }

    const images = await generateImages({
      account,
      model,
      prompt,
      count: body.count,
      aspectRatio: body.aspectRatio,
      imageSize: body.imageSize,
      negativePrompt: body.negativePrompt,
      seed: body.seed,
      signal,
    });

    // Dimensions are measured here rather than assumed from the aspect ratio:
    // the gallery's resolution warning compares against what actually arrived.
    const withSize = images.map((image) => {
      const bytes = Buffer.from(image.base64, "base64");
      const size = readImageDimensions(bytes);
      return {
        ...image,
        width: size?.width ?? 0,
        height: size?.height ?? 0,
        resolution: size ? classifyResolution(size) : "",
        // Vertex returns bytes inline rather than hosting the result, so there
        // is no upstream URL to record — unlike kie, which serves one.
        sourceUrl: "",
      };
    });

    return NextResponse.json({ ok: true, kind: "image", images: withSize });
  } catch (error) {
    if (error instanceof VertexError) {
      // 429 is reported as a 503 so the browser's own fetch retry logic stays out
      // of it; the retry decision belongs to the queue, which reads `retryable`.
      const status = error.status === 429 ? 503 : error.status ?? 500;
      return fail(error.message, status, error.retryable);
    }
    return fail(
      error instanceof Error ? error.message : "Vertex call failed.",
      500,
      true
    );
  }
}
