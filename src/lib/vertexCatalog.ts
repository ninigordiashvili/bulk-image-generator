import type { KieFieldSpec, KieModelSpec } from "./kieCatalog";
import { VERTEX_IMAGE_MODELS, findVertexImageModel } from "./vertexModels";

/**
 * Vertex image models, described in the shape the settings panel already reads.
 *
 * The panel renders its controls from a model's `options` array rather than from
 * hard-coded JSX — that is what lets "pick any model" work without a UI change
 * per model. Vertex is a different provider with a different API, but its
 * *options* are the same idea: a closed set of aspect ratios and a closed set of
 * sizes. Expressing them as `KieFieldSpec` means the aspect-ratio and size pills
 * appear for Vertex models with no new UI at all, and the store's existing
 * per-model input state keeps working unchanged.
 *
 * The ids are the real Vertex model ids, so nothing has to be unmapped before
 * the call — `isVertexModel` is what tells the two providers apart.
 */

/** Ratios and sizes confirmed working are offered first. */
function optionsFor(id: string): readonly KieFieldSpec[] {
  const spec = findVertexImageModel(id);
  if (!spec) return [];

  const ordered = <T>(all: readonly T[], verified: readonly T[]): T[] => [
    ...verified,
    ...all.filter((value) => !verified.includes(value)),
  ];

  return [
    {
      name: "aspect_ratio",
      type: "string",
      enum: ordered(spec.aspectRatios, spec.verifiedAspectRatios),
      default: spec.verifiedAspectRatios[0] ?? spec.aspectRatios[0],
      required: false,
      description: `Confirmed on this project: ${spec.verifiedAspectRatios.join(", ")}.`,
    },
    {
      name: "image_size",
      type: "string",
      enum: ordered(spec.imageSizes, spec.verifiedImageSizes),
      default: spec.verifiedImageSizes[0] ?? spec.imageSizes[0],
      required: false,
      description: `Confirmed on this project: ${spec.verifiedImageSizes.join(", ")}.`,
    },
  ];
}

export const VERTEX_CATALOG_GROUP = "Vertex AI (your GCP credits)";

export const VERTEX_CATALOG_MODELS: readonly KieModelSpec[] = VERTEX_IMAGE_MODELS.map(
  (model) => ({
    id: model.id,
    label: model.label,
    group: VERTEX_CATALOG_GROUP,
    docUrl: "https://cloud.google.com/vertex-ai/generative-ai/pricing",
    // Gemini takes a long prompt; this is well inside it and only guards the UI.
    promptMax: 8000,
    options: optionsFor(model.id),
  })
);

/** True when a model id belongs to Vertex rather than kie.ai. */
export function isVertexModel(id: string): boolean {
  return VERTEX_CATALOG_MODELS.some((model) => model.id === id);
}
