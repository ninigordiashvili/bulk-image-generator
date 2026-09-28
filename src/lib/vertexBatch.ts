/** Only this model/resolution has been enabled for discounted image batches. */
export const VERTEX_BATCH_MODEL = "gemini-3.1-flash-lite-image";
export const VERTEX_BATCH_IMAGE_USD = 0.0168;
export const VERTEX_BATCH_INPUT_PER_TOKEN = 0.125 / 1_000_000;
export const VERTEX_BATCH_TEXT_PER_TOKEN = 0.75 / 1_000_000;
export const VERTEX_BATCH_IMAGE_PER_TOKEN = 15 / 1_000_000;
export const VERTEX_BATCH_REFERENCE_TOKENS = 1120;

export function batchInputEstimate(prompt: string, referenceCount: number) {
  // Text tokenization varies. This is an estimate, not a Google billing total.
  return (Math.ceil(prompt.length / 3) + referenceCount * VERTEX_BATCH_REFERENCE_TOKENS) * VERTEX_BATCH_INPUT_PER_TOKEN;
}
