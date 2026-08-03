"use client";

import {
  fieldLabel,
  findModel,
  groupedModels,
  parseCustomInput,
  referenceLimit,
  type KieFieldSpec,
} from "@/lib/kieModels";
import { useGenerationStore } from "@/store/generationStore";
import { CUSTOM_MODEL, type InputValue } from "@/types";

function NumberField({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      <input
        type="number"
        className="field"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isNaN(next)) return;
          onChange(Math.min(max, Math.max(min, Math.round(next))));
        }}
      />
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

/**
 * One control for one field of the selected model's schema. Every model on
 * kie.ai declares a different input shape, so the panel is rendered from the
 * catalog rather than hard-coded — adding a model needs no UI change.
 */
function ModelField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: KieFieldSpec;
  value: InputValue | undefined;
  disabled: boolean;
  onChange: (value: InputValue) => void;
}) {
  if (field.enum?.length) {
    return (
      <div>
        <span className="mb-1.5 block text-xs text-muted">
          {fieldLabel(field)}
          {field.required && <span className="ml-1 text-muted/60">required</span>}
        </span>
        <div className="flex flex-wrap gap-2">
          {field.enum.map((option) => (
            <button
              key={option}
              type="button"
              disabled={disabled}
              onClick={() => onChange(option)}
              className={`pill ${value === option ? "pill-active" : ""}`}
            >
              {option}
            </button>
          ))}
        </div>
        {field.description && (
          <p className="mt-1.5 text-[11px] text-muted">{field.description}</p>
        )}
      </div>
    );
  }

  if (field.type === "boolean") {
    return (
      <label className="flex cursor-pointer items-start gap-2 text-xs text-muted">
        <input
          type="checkbox"
          className="mt-0.5 accent-[var(--accent)]"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          <span className="text-foreground">{fieldLabel(field)}</span>
          {field.description && (
            <span className="mt-0.5 block text-[11px]">{field.description}</span>
          )}
        </span>
      </label>
    );
  }

  if (field.type === "number" || field.type === "integer") {
    return (
      <NumberField
        label={fieldLabel(field)}
        value={typeof value === "number" ? value : 1}
        min={1}
        max={10}
        disabled={disabled}
        onChange={onChange}
        hint={field.description}
      />
    );
  }

  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{fieldLabel(field)}</span>
      <input
        className="field"
        value={typeof value === "string" ? value : ""}
        maxLength={field.maxLength}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {field.description && (
        <span className="mt-1 block text-[11px] text-muted">{field.description}</span>
      )}
    </label>
  );
}

export function GenerationSettingsPanel({ disabled }: { disabled: boolean }) {
  const settings = useGenerationStore((state) => state.settings);
  const queueConfig = useGenerationStore((state) => state.queueConfig);
  const setSettings = useGenerationStore((state) => state.setSettings);
  const setModelInput = useGenerationStore((state) => state.setModelInput);
  const setQueueConfig = useGenerationStore((state) => state.setQueueConfig);

  const isCustom = settings.model === CUSTOM_MODEL;
  const spec = isCustom ? undefined : findModel(settings.model);
  const input = settings.modelInputs?.[settings.model] ?? {};
  const refLimit = referenceLimit(spec);
  const customParse = parseCustomInput(settings.customInputJson);

  return (
    <section className="panel space-y-4">
      <h2 className="panel-title mb-0">Generation settings</h2>

      <div>
        <span className="mb-1.5 block text-xs text-muted">Model</span>
        <select
          className="field"
          value={settings.model}
          disabled={disabled}
          onChange={(event) => setSettings({ model: event.target.value })}
        >
          {groupedModels().map(({ group, models }) => (
            <optgroup key={group} label={group}>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </optgroup>
          ))}
          <optgroup label="Other">
            <option value={CUSTOM_MODEL}>Custom model id…</option>
          </optgroup>
        </select>

        {spec && (
          <p className="mt-1.5 text-[11px] text-muted">
            <code className="text-foreground">{spec.id}</code> · prompts up to{" "}
            {spec.promptMax.toLocaleString()} chars ·{" "}
            {refLimit > 0
              ? `up to ${refLimit} reference image${refLimit === 1 ? "" : "s"}`
              : "text-to-image only"}{" "}
            ·{" "}
            <a
              className="underline hover:text-foreground"
              href={spec.docUrl}
              target="_blank"
              rel="noreferrer"
            >
              docs
            </a>
          </p>
        )}
      </div>

      {isCustom ? (
        // Escape hatch: kie adds models faster than this catalog is regenerated,
        // so anything missing can still be run by naming it and passing raw input.
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted">kie.ai model id</span>
            <input
              className="field font-mono text-xs"
              placeholder="e.g. seedream/5-pro-text-to-image"
              value={settings.customModelId}
              disabled={disabled}
              onChange={(event) => setSettings({ customModelId: event.target.value })}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-muted">Extra input (JSON)</span>
            <textarea
              className="field h-28 resize-y font-mono text-xs"
              placeholder={'{ "aspect_ratio": "16:9", "resolution": "2K" }'}
              value={settings.customInputJson}
              disabled={disabled}
              onChange={(event) =>
                setSettings({ customInputJson: event.target.value })
              }
            />
          </label>

          {!customParse.ok ? (
            <p className="text-[11px] text-red-400">{customParse.error}</p>
          ) : (
            <p className="text-[11px] text-muted">
              Merged into the task&apos;s <code>input</code> alongside{" "}
              <code>prompt</code>. Reference images are not attached — a custom
              model&apos;s image field name isn&apos;t known here.
            </p>
          )}
        </div>
      ) : (
        spec && (
          <div className="space-y-4">
            {spec.options.map((field) => (
              <ModelField
                key={field.name}
                field={field}
                value={input[field.name]}
                disabled={disabled}
                onChange={(value) => setModelInput(field.name, value)}
              />
            ))}
            {spec.options.length === 0 && (
              <p className="text-[11px] text-muted">
                This model takes a prompt and nothing else.
              </p>
            )}
          </div>
        )
      )}

      <div className="grid grid-cols-3 gap-3">
        <NumberField
          label="Images / prompt"
          value={settings.imagesPerPrompt}
          min={1}
          max={10}
          disabled={disabled}
          onChange={(imagesPerPrompt) => setSettings({ imagesPerPrompt })}
        />
        <NumberField
          label="Concurrency"
          value={queueConfig.concurrency}
          min={1}
          max={10}
          disabled={false}
          onChange={(concurrency) => setQueueConfig({ concurrency })}
        />
        <NumberField
          label="Retries"
          value={queueConfig.retries}
          min={0}
          max={5}
          disabled={false}
          onChange={(retries) => setQueueConfig({ retries })}
        />
      </div>

      <p className="text-[11px] text-muted">
        Concurrency and retries apply live, mid-run. Model settings and
        images-per-prompt are locked while a batch is running. Every image spends
        real kie.ai credits.
      </p>
    </section>
  );
}
