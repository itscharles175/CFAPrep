/**
 * K4-4 — render smoke test for the expanded feedback + table/list-row barrel.
 *
 * Asserts that every net-new wrapper (a) renders to the DOM, (b) preserves the
 * LSAT prop surface / semantics, and (c) emits the host `.qv-*` class the later
 * reskin depends on. These are the drop-in twins a reskin swaps in over the
 * LSAT table / list-row / route skeletons, so the test pins that contract.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  ListRow,
  SkeletonCard,
  SkeletonChart,
  SkeletonListPage,
  SkeletonDetailPage,
  SkeletonDashboard,
} from ".";

describe("feedback barrel — Table (semantic facade)", () => {
  it("renders real table semantics with host classes and forwards props", () => {
    render(
      <Table data-testid="tbl">
        <TableCaption>Recent reviews</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Topic</TableHead>
            <TableHead>Score</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow data-state="selected">
            <TableCell>Ethics</TableCell>
            <TableCell>88</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell>Total</TableCell>
            <TableCell>88</TableCell>
          </TableRow>
        </TableFooter>
      </Table>,
    );

    // Semantics preserved: a real <table> with column headers + rows.
    const table = screen.getByRole("table");
    expect(table).toHaveClass("qv-table");
    expect(table.tagName).toBe("TABLE");
    expect(screen.getByTestId("tbl")).toBe(table);

    expect(
      screen.getByRole("columnheader", { name: "Topic" }),
    ).toHaveClass("qv-table-head");
    expect(screen.getByRole("cell", { name: "Ethics" })).toHaveClass(
      "qv-table-cell",
    );
    // The selected-row data hook is preserved for the CSS facade.
    const selected = screen
      .getByRole("cell", { name: "Ethics" })
      .closest("tr");
    expect(selected).toHaveAttribute("data-state", "selected");
    expect(selected).toHaveClass("qv-table-row");

    // 3 rows total (header + body + footer) — semantics intact end to end.
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("Recent reviews")).toHaveClass("qv-table-caption");
  });
});

describe("feedback barrel — ListRow (LSAT prop surface)", () => {
  it("renders a static <div> with title/meta/leading/trailing slots", () => {
    render(
      <ListRow
        leading={<span data-testid="lead">L</span>}
        title="Logical Reasoning"
        meta="12 cards due"
        trailing={<span data-testid="trail">T</span>}
      />,
    );
    expect(screen.getByText("Logical Reasoning")).toHaveClass(
      "qv-list-row-title",
    );
    expect(screen.getByText("12 cards due")).toHaveClass("qv-list-row-meta");
    expect(screen.getByTestId("lead")).toBeInTheDocument();
    expect(screen.getByTestId("trail")).toBeInTheDocument();
    // No onClick + no interactive => static div, not a button.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders a real <button> + fires onClick when clickable", () => {
    const onClick = vi.fn();
    render(<ListRow title="Open queue" onClick={onClick} />);
    const btn = screen.getByRole("button", { name: "Open queue" });
    expect(btn).toHaveClass("qv-list-row", "qv-list-row-interactive");
    btn.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("honors `interactive` without onClick (affordance only)", () => {
    render(<ListRow title="Wraps a link" interactive className="x" />);
    const row = screen.getByText("Wraps a link").closest(".qv-list-row");
    expect(row).toHaveClass("qv-list-row-interactive", "x");
    // Still a div (no onClick), so no implicit button role.
    expect(row?.tagName).toBe("DIV");
  });
});

describe("feedback barrel — route-shaped skeletons", () => {
  it("SkeletonCard / SkeletonChart render host skeleton blocks", () => {
    const { container: card } = render(<SkeletonCard />);
    expect(card.querySelector(".qv-skeleton-card")).not.toBeNull();
    expect(card.querySelectorAll(".skeleton").length).toBeGreaterThan(0);

    const { container: chart } = render(<SkeletonChart />);
    expect(chart.querySelector(".qv-skeleton-card")).not.toBeNull();
    expect(chart.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("SkeletonListPage announces loading + renders the requested card count", () => {
    render(<SkeletonListPage cards={3} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(within(status).getByText("Loading…")).toBeInTheDocument();
    expect(status.querySelectorAll(".qv-skeleton-card")).toHaveLength(3);
  });

  it("SkeletonDetailPage announces loading and lays out a main + rail", () => {
    render(<SkeletonDetailPage />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status.querySelector(".qv-skeleton-detail-main")).not.toBeNull();
  });

  it("SkeletonDashboard announces loading and renders the hero band", () => {
    render(<SkeletonDashboard />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status.querySelector(".qv-skeleton-hero-band")).not.toBeNull();
  });
});
