import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

/*
 * K4-13 — "doubled chrome" resolution proof (final cutover).
 *
 * The LSAT <AppShell> is the layout route element for the LSAT plane. As of the
 * K4-13 cutover the LSAT App is ALWAYS mounted INSIDE the host <SharedLayout>,
 * which supplies the one sidebar/topbar — so AppShell renders CHROMELESS,
 * leaving only the scrollable page content (+ scroll restoration). The legacy
 * full-chrome shell and the `unified` dispatch were removed.
 *
 * This renders the REAL AppShell structure and asserts the LSAT shell's own nav
 * surfaces are ABSENT (SharedLayout supplies them) while the routed page content
 * + the scroll region survive. The command palette is stubbed only to keep the
 * render light + deterministic.
 */

// Command palette → trivial passthrough provider + no-op hook.
vi.mock("@lsat/components/command-palette", () => ({
  CommandPaletteProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useCommandPalette: () => ({ open: false, setOpen: () => {}, toggle: () => {}, register: () => () => {} }),
}));

import { AppShell } from "@lsat/components/app-shell";
import { CommandPaletteProvider } from "@lsat/components/command-palette";

function renderShell() {
  return render(
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
    </MemoryRouter>,
  );
}

describe("AppShell chromeless (K4-13)", () => {
  it("renders chromeless — NO sidebar/header/nav/skip link, page content only", () => {
    renderShell();

    // The routed page content still renders (scroll region preserved).
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    // The host SharedLayout owns the single main landmark. The LSAT scroll
    // region remains focusable and labelled without creating a nested <main>.
    expect(screen.queryByRole("main")).not.toBeInTheDocument();
    const scrollRegion = screen.getByRole("region", { name: "LSAT content" });
    expect(scrollRegion).toBeInTheDocument();
    expect(scrollRegion).toHaveAttribute("id", "main-content");

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
