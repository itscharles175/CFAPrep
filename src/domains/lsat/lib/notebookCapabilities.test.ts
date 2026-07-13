import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTEBOOK_CAPABILITIES,
  enabledCapabilities,
  normalizeNotebookCapabilities,
} from "./notebookCapabilities";

describe("notebookCapabilities", () => {
  it("falls back to the built-in capability lists when the backend has not advertised them", () => {
    expect(normalizeNotebookCapabilities(null)).toEqual(
      DEFAULT_NOTEBOOK_CAPABILITIES,
    );
    expect(normalizeNotebookCapabilities({ source_types: [] }).source_types).toEqual(
      DEFAULT_NOTEBOOK_CAPABILITIES.source_types,
    );
  });

  it("normalizes string and object options from the advertised endpoint", () => {
    const capabilities = normalizeNotebookCapabilities({
      source_types: ["text", { value: "web", label: "Web link" }],
      note_types: [{ key: "manual", label: "Manual note" }],
      transform_templates: [{ value: "summarize", enabled: false }],
      export_formats: ["markdown", "pdf"],
      import_formats: ["json", { value: "markdown", label: "Markdown bundle" }],
      context_modes: [{ value: "summary", hint: "Summaries only" }],
    });

    expect(capabilities.source_types.map((item) => item.label)).toEqual([
      "text",
      "Web link",
    ]);
    expect(capabilities.note_types[0]).toMatchObject({
      value: "manual",
      label: "Manual note",
    });
    expect(enabledCapabilities(capabilities.transform_templates)).toEqual([]);
    expect(capabilities.export_formats.map((item) => item.value)).toEqual([
      "markdown",
    ]);
    expect(capabilities.import_formats?.map((item) => item.label)).toEqual([
      "JSON",
      "Markdown bundle",
    ]);
    expect(capabilities.context_modes[0].description).toBe("Summaries only");
  });
});
