import { describe, expect, it } from "vitest";
import { offlineCoachProviderHint } from "./Explanation";

describe("Explanation provider-aware offline copy", () => {
  it("names LMStudio when the active local provider is LMStudio", () => {
    expect(offlineCoachProviderHint("lmstudio")).toBe(
      "your LMStudio server (localhost:1234)",
    );
  });

  it("falls back to Ollama copy for older or unknown provider payloads", () => {
    expect(offlineCoachProviderHint(undefined)).toBe("Ollama (localhost:11434)");
    expect(offlineCoachProviderHint("unknown")).toBe("Ollama (localhost:11434)");
  });
});
