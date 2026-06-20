import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

/*
 * K4-13a — "doubled chrome" resolution proof.
 *
 * The LSAT <AppShell> is the layout route element that renders the LSAT plane's
 * own outer chrome (its Sidebar + header). When the LSAT App is mounted INSIDE
 * the host <SharedLayout> (the flag-ON unified shell), SharedLayout already
 * supplies the one sidebar/topbar — so AppShell must render CHROMELESS, leaving
 * only the page content. In legacy mode (the default, no unified provider) it
 * must render its FULL chrome exactly as before.
 *
 * These tests render the REAL AppShell + the real ChromelessShell/FullChromeShell
 * structure (so the dispatch + the chrome landmarks are genuinely exercised) and
 * assert on the presence/absence of the LSAT shell's nav surfaces. The data layer
 * (react-query hooks) and the lazy command palette are stubbed to keep the render
 * light + deterministic — none of them are the chrome we assert on, and the real
 * structural landmarks (aside/header/nav/skip-link) still render.
 */

// Data hooks → empty, synchronous. Strips react-query networking from the render.
vi.mock("@lsat/lib/hooks", () => ({
  useDashboard: () => ({ data: undefined }),
  useSrsDue: () => ({ data: undefined }),
}));

// Command palette → trivial passthrough provider + no-op hook, so the full
// shell's ⌘K affordance renders without pulling in the lazy cmdk dialog.
vi.mock("@lsat/components/command-palette", () => ({
  CommandPaletteProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useCommandPalette: () => ({ open: false, setOpen: () => {}, toggle: () => {}, register: () => () => {} }),
}));

import { AppShell } from "@lsat/components/app-shell";
import { CommandPaletteProvider } from "@lsat/components/command-palette";
import { UnifiedShellContext } from "@lsat/lib/unifiedShellContext";

function renderShell(unified: boolean) {
  return render(
    <UnifiedShellContext.Provider value={{ unified }}>
      <MemoryRouter initialEntries={["/srs"]}>
        <CommandPaletteProvider>
          <Routes>
            <Route element={<AppShell />}>
              <Route
                path="/srs"
                element={<div data-testid="page-content">SRS page</div>}
              />
            </Route>
          </Routes>
        </CommandPaletteProvider>
      </MemoryRouter>
    </UnifiedShellContext.Provider>,
  );
}

describe("AppShell doubled-chrome (K4-13a)", () => {
  it("LEGACY (default): renders the full LSAT shell chrome — sidebar, header, nav, skip link", () => {
    renderShell(false);

    // The routed page still renders inside the shell's content region.
    expect(screen.getByTestId("page-content")).toBeInTheDocument();

    // FULL chrome present: the persistent Sidebar + the top header are both here.
    expect(screen.getByRole("complementary", { name: "Sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    // The shell's own primary nav rail + brand lockup + skip link.
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getAllByText("LSAT Lab").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: "Skip to main content" }),
    ).toBeInTheDocument();
  });

  it("UNIFIED: renders chromeless — NO second sidebar/header/nav/skip link, page content only", () => {
    renderShell(true);

    // The routed page content still renders (scroll region preserved).
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    // The scrollable main region (MainScrollArea) is preserved for scroll
    // restoration; SharedLayout's chrome wraps it in the real app.
    expect(screen.getByRole("main")).toBeInTheDocument();

    // NONE of the LSAT shell's own chrome is rendered — SharedLayout supplies it.
    expect(
      screen.queryByRole("complementary", { name: "Sidebar" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Primary" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Skip to main content" }),
    ).not.toBeInTheDocument();
    // No duplicated LSAT brand lockup from a second sidebar.
    expect(screen.queryByText("LSAT Lab")).not.toBeInTheDocument();
  });
});
