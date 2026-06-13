import type {
  NotebookCapabilities,
  NotebookCapabilityOption,
  NotebookContextModeCapability,
  NotebookExportBundle,
  NotebookExportFormatCapability,
} from "./types";

type AnyNotebookCapability =
  | NotebookCapabilityOption
  | NotebookContextModeCapability
  | NotebookExportFormatCapability;

const exportFormats = new Set<NotebookExportBundle["format"]>([
  "markdown",
  "html",
  "json",
]);

function humanize(value: string) {
  return value.split("_").join(" ");
}

function option(
  value: string,
  label = humanize(value),
  description?: string,
): NotebookCapabilityOption {
  return { value, label, ...(description ? { description } : {}) };
}

export const DEFAULT_NOTEBOOK_CAPABILITIES: NotebookCapabilities = {
  source_types: [
    option("auto"),
    option("text"),
    option("markdown"),
    option("pdf"),
    option("docx"),
    option("web"),
    option("audio_transcript"),
    option("video_transcript"),
  ],
  note_types: [
    option("manual"),
    option("captured"),
    option("ai_generated"),
    option("transformed"),
    option("daily_journal"),
  ],
  transform_templates: [
    option("summarize"),
    option("extract_rules"),
    option("generate_flaw_patterns"),
    option("make_rc_structure_notes"),
    option("create_srs_cards"),
    option("wrong_answer_packet"),
    option("weekly_study_sheet"),
  ],
  export_formats: [
    { value: "markdown", label: "Markdown" },
    { value: "html", label: "HTML" },
    { value: "json", label: "JSON" },
  ],
  import_formats: [
    option("auto"),
    option("json", "JSON"),
    option("markdown", "Markdown"),
    option("html", "HTML"),
  ],
  context_modes: [
    { value: "off", label: "Off", description: "No retrieval context" },
    {
      value: "summary",
      label: "Summary",
      description: "Use summaries and safe metadata",
    },
    {
      value: "full",
      label: "Full",
      description: "Use full local workspace context",
    },
    {
      value: "answer_key_locked",
      label: "Locked",
      description: "Never reveal answer keys before reveal",
    },
    {
      value: "after_reveal",
      label: "Reveal",
      description: "Use only citations marked as revealed",
    },
    {
      value: "official_firewalled",
      label: "Firewall",
      description: "Deny cloud whenever official content is in scope",
    },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExportFormat(value: string): value is NotebookExportBundle["format"] {
  return exportFormats.has(value as NotebookExportBundle["format"]);
}

function normalizeCapability<T extends AnyNotebookCapability>(
  raw: unknown,
  defaults: readonly T[],
  allowValue?: (value: string) => boolean,
): T | null {
  const value =
    typeof raw === "string"
      ? raw
      : isRecord(raw) && typeof (raw.value ?? raw.key) === "string"
        ? String(raw.value ?? raw.key)
        : "";
  if (!value || (allowValue && !allowValue(value))) return null;

  const base = defaults.find((item) => item.value === value);
  const label =
    isRecord(raw) && typeof raw.label === "string"
      ? raw.label
      : base?.label ?? humanize(value);
  const description =
    isRecord(raw) && typeof (raw.description ?? raw.hint) === "string"
      ? String(raw.description ?? raw.hint)
      : base?.description;
  const enabled =
    isRecord(raw) && typeof raw.enabled === "boolean"
      ? raw.enabled
      : base?.enabled;
  const next: AnyNotebookCapability = {
    ...(base ?? { value, label }),
    value,
    label,
    ...(description ? { description } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };
  if (isRecord(raw) && typeof raw.content_type === "string") {
    (next as NotebookExportFormatCapability).content_type = raw.content_type;
  }
  if (isRecord(raw) && typeof raw.icon === "string") {
    (next as NotebookContextModeCapability).icon = raw.icon;
  }
  return next as T;
}

function normalizeList<T extends AnyNotebookCapability>(
  raw: unknown,
  defaults: readonly T[],
  allowValue?: (value: string) => boolean,
): T[] {
  if (!Array.isArray(raw)) return [...defaults];
  const normalized = raw
    .map((item) => normalizeCapability(item, defaults, allowValue))
    .filter((item): item is T => Boolean(item));
  return normalized.length ? normalized : [...defaults];
}

export function normalizeNotebookCapabilities(raw: unknown): NotebookCapabilities {
  const source = isRecord(raw) ? raw : {};
  return {
    source_types: normalizeList(
      source.source_types,
      DEFAULT_NOTEBOOK_CAPABILITIES.source_types,
    ),
    note_types: normalizeList(
      source.note_types,
      DEFAULT_NOTEBOOK_CAPABILITIES.note_types,
    ),
    transform_templates: normalizeList(
      source.transform_templates ?? source.transformation_templates,
      DEFAULT_NOTEBOOK_CAPABILITIES.transform_templates,
    ),
    export_formats: normalizeList(
      source.export_formats,
      DEFAULT_NOTEBOOK_CAPABILITIES.export_formats,
      isExportFormat,
    ),
    import_formats: normalizeList(
      source.import_formats,
      DEFAULT_NOTEBOOK_CAPABILITIES.import_formats ?? [],
    ),
    context_modes: normalizeList(
      source.context_modes,
      DEFAULT_NOTEBOOK_CAPABILITIES.context_modes,
    ),
  };
}

export function enabledCapabilities<T extends NotebookCapabilityOption>(
  options: readonly T[],
): T[] {
  return options.filter((option) => option.enabled !== false);
}
