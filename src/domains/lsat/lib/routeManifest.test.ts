import { describe, expect, it } from "vitest";

import {
  canonicalRoutePath,
  manifestRoutesByGroup,
  primaryRouteManifest,
  routeCommandLabelFromManifest,
  routeManifest,
  routePrefetchImporters,
  visibleRouteManifest,
} from "./routeManifest";

describe("routeManifest", () => {
  it("is the single source for command labels and prefetchable primary routes", () => {
    const paths = new Set<string>();
    for (const entry of routeManifest) {
      expect(paths.has(entry.path)).toBe(false);
      paths.add(entry.path);
      expect(entry.commandLabel).toMatch(/^Go to /);
      expect(routeCommandLabelFromManifest(entry.path)).toBe(entry.label);
      expect(routePrefetchImporters[entry.path]).toBeTypeOf("function");
    }
  });

  it("applies test-mode visibility from the manifest", () => {
    const studyPaths = visibleRouteManifest("study").map((entry) => entry.path);
    const testPaths = visibleRouteManifest("test").map((entry) => entry.path);

    expect(studyPaths).toContain("/");
    expect(studyPaths).toContain("/settings");
    expect(testPaths).not.toContain("/");
    expect(testPaths).toContain("/settings");
    expect(testPaths).toContain("/practice");
  });

  it("builds sidebar sections from visible manifest entries", () => {
    const sections = manifestRoutesByGroup("study");
    const insight = sections.find((section) => section.group === "Insight");

    expect(insight?.items.map((entry) => entry.path)).toContain("/");
    expect(insight?.items.map((entry) => entry.path)).not.toContain("/notebook");
    expect(sections.flatMap((section) => section.items).some((entry) => entry.path === "/settings")).toBe(true);
  });

  it("keeps / as the canonical Notebook OS route and hides the /notebook alias from primary discovery", () => {
    expect(canonicalRoutePath("/notebook")).toBe("/");
    expect(routeCommandLabelFromManifest("/notebook")).toBe("Notebook OS");
    expect(primaryRouteManifest("study").map((entry) => entry.path)).toContain("/");
    expect(primaryRouteManifest("study").map((entry) => entry.path)).not.toContain("/notebook");
  });
});
