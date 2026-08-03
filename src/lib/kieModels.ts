import { KIE_MODELS, type KieFieldSpec, type KieModelSpec } from "@/lib/kieCatalog";
import { CUSTOM_MODEL, type InputValue, type ModelInput } from "@/types";

export type { KieFieldSpec, KieModelSpec };
export { KIE_MODELS };

const BY_ID = new Map(KIE_MODELS.map((model) => [model.id, model]));

/** First entry in the catalog — Nano Banana 2, which the ordering puts first. */
export const DEFAULT_MODEL = KIE_MODELS[0].id;

export function findModel(id: string): KieModelSpec | undefined {
  return BY_ID.get(id);
}

/** Catalog models grouped for the picker, preserving the catalog's ordering. */
export function groupedModels(): { group: string; models: KieModelSpec[] }[] {
  const groups: { group: string; models: KieModelSpec[] }[] = [];
  for (const model of KIE_MODELS) {
    const existing = groups.find((entry) => entry.group === model.group);
    if (existing) existing.models.push(model);
    else groups.push({ group: model.group, models: [model] });
  }
  return groups;
}

/**
 * The `input` a model starts with: every field that declares a default, plus a
 * first-enum-value stand-in for required fields that don't. Optional fields with
 * no default are left out entirely so kie applies its own.
 */
export function defaultInput(model: KieModelSpec): ModelInput {
  const input: ModelInput = {};
  for (const field of model.options) {
    if (field.default !== undefined) input[field.name] = field.default;
    else if (field.required && field.enum?.length) input[field.name] = field.enum[0];
  }
  return input;
}

/**
 * Drops values that the model doesn't declare, or that aren't in its enum. A
 * persisted setting can outlive the model it was chosen for — this is what stops
 * `resolution: "4K"` leaking into a model that only knows `quality`.
 */
export function reconcileInput(
  model: KieModelSpec,
  stored: ModelInput | undefined
): ModelInput {
  const input = defaultInput(model);
  if (!stored) return input;
  for (const field of model.options) {
    const value = stored[field.name];
    if (value === undefined) continue;
    if (field.enum && !field.enum.includes(String(value))) continue;
    if (field.type === "boolean" && typeof value !== "boolean") continue;
    input[field.name] = value;
  }
  return input;
}

/** Falls back to the default model if a persisted setting names one we dropped. */
export function normalizeModel(model: unknown): string {
  if (model === CUSTOM_MODEL) return CUSTOM_MODEL;
  return typeof model === "string" && BY_ID.has(model) ? model : DEFAULT_MODEL;
}

/**
 * How many reference images this model can take. Zero means text-to-image only,
 * and the character library is ignored for it.
 */
export function referenceLimit(model: KieModelSpec | undefined): number {
  return model?.imageField ? (model.imageMax ?? 1) : 0;
}

/** Human-readable field name for the settings UI: `aspect_ratio` → `Aspect ratio`. */
export function fieldLabel(field: KieFieldSpec): string {
  return field.name
    .replace(/_/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

/**
 * Parses the custom-model JSON box. Returns the error rather than throwing so
 * the settings panel can show it inline while the user is still typing.
 */
export function parseCustomInput(
  json: string
): { ok: true; input: ModelInput } | { ok: false; error: string } {
  const text = json.trim();
  if (!text) return { ok: true, input: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid JSON.",
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Expected a JSON object, e.g. {\"resolution\":\"2K\"}." };
  }
  const input: ModelInput = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      input[key] = value as InputValue;
    } else {
      return {
        ok: false,
        error: `"${key}" must be a string, number or boolean — nested values aren't supported here.`,
      };
    }
  }
  return { ok: true, input };
}
