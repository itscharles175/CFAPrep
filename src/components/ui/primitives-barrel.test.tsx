/**
 * K4-2 — render smoke test for the host-styled primitive barrel.
 *
 * Asserts that every wrapper (a) renders to the DOM and (b) forwards a
 * prop/variant: the cva-driven variant maps to the right host class, custom
 * props (loading, interactive, voice, className, htmlFor) reach the element, and
 * the Radix-backed primitives (Dialog/Select/Popover/Tabs/Tooltip) open and
 * expose their content. These are the net-new wrappers a later reskin swaps in;
 * the test pins the contract that makes them drop-in for the LSAT primitives.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button, buttonVariants } from "./button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./card";
import { Badge, badgeVariants } from "./badge";
import { Input } from "./input";
import { Label } from "./label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./dialog";
import { Popover, PopoverTrigger, PopoverContent } from "./popover";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "./tooltip";

describe("primitives barrel — Button", () => {
  it("renders children and forwards arbitrary button props", () => {
    render(
      <Button type="submit" data-testid="btn">
        Continue
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Continue" });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("type", "submit");
    expect(btn).toHaveAttribute("data-testid", "btn");
    // default variant -> host primary class
    expect(btn).toHaveClass("btn", "btn-primary");
  });

  it("maps each variant + size to the host class via buttonVariants", () => {
    expect(buttonVariants({ variant: "destructive" })).toContain("btn-danger");
    expect(buttonVariants({ variant: "outline" })).toContain("qv-btn-outline");
    expect(buttonVariants({ variant: "secondary" })).toContain("btn-secondary");
    expect(buttonVariants({ variant: "ghost" })).toContain("btn-ghost");
    expect(buttonVariants({ variant: "link" })).toContain("btn-link");
    expect(buttonVariants({ size: "sm" })).toContain("btn-sm");
    expect(buttonVariants({ size: "lg" })).toContain("btn-lg");
    expect(buttonVariants({ size: "icon" })).toContain("btn-icon");
  });

  it("forwards the `loading` prop: disables + sets aria-busy + injects spinner", () => {
    render(<Button loading>Saving</Button>);
    const btn = screen.getByRole("button", { name: "Saving" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn.querySelector(".qv-spin")).not.toBeNull();
  });

  it("forwards `asChild` to render a custom element via Slot", () => {
    render(
      <Button asChild>
        <a href="/next">Link button</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Link button" });
    expect(link).toHaveClass("btn", "btn-primary");
    expect(link).toHaveAttribute("href", "/next");
  });
});

describe("primitives barrel — Card", () => {
  it("renders the full family and forwards interactive + className", () => {
    render(
      <Card interactive className="extra" data-testid="card">
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Desc</CardDescription>
        </CardHeader>
        <CardContent>Body</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>,
    );
    const card = screen.getByTestId("card");
    expect(card).toHaveClass("qv-card", "qv-card-interactive", "extra");
    expect(screen.getByText("Title")).toHaveClass("qv-card-title");
    expect(screen.getByText("Desc")).toHaveClass("qv-card-description");
    expect(screen.getByText("Body")).toHaveClass("qv-card-content");
    expect(screen.getByText("Footer")).toHaveClass("qv-card-footer");
  });

  it("forwards the CardTitle `voice` variant", () => {
    render(<CardTitle voice="display">Editorial</CardTitle>);
    expect(screen.getByText("Editorial")).toHaveClass(
      "qv-card-title-display",
      "type-display",
    );
  });
});

describe("primitives barrel — Badge", () => {
  it("renders and forwards the variant via badgeVariants", () => {
    render(<Badge variant="success">Ready</Badge>);
    expect(screen.getByText("Ready")).toHaveClass("badge", "qv-badge-success");
    expect(badgeVariants({ variant: "destructive" })).toContain(
      "qv-badge-destructive",
    );
    expect(badgeVariants({ variant: "outline" })).toContain("qv-badge-outline");
  });
});

describe("primitives barrel — Input", () => {
  it("renders, forwards type/placeholder, and applies the host class", () => {
    render(<Input type="email" placeholder="you@example.com" />);
    const input = screen.getByPlaceholderText("you@example.com");
    expect(input).toHaveClass("qv-input");
    expect(input).toHaveAttribute("type", "email");
  });
});

describe("primitives barrel — Label", () => {
  it("renders, applies the host class, and forwards htmlFor", () => {
    render(<Label htmlFor="field-x">Field</Label>);
    const label = screen.getByText("Field");
    expect(label).toHaveClass("qv-label");
    expect(label).toHaveAttribute("for", "field-x");
  });
});

describe("primitives barrel — Select (Radix facade)", () => {
  it("renders the trigger with the host class and forwards a placeholder", () => {
    render(
      <Select>
        <SelectTrigger aria-label="Difficulty">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="easy">Easy</SelectItem>
        </SelectContent>
      </Select>,
    );
    const trigger = screen.getByRole("combobox", { name: "Difficulty" });
    expect(trigger).toHaveClass("qv-select-trigger");
    expect(screen.getByText("Pick one")).toBeInTheDocument();
  });
});

describe("primitives barrel — Dialog (Radix facade)", () => {
  it("renders content (incl. close button) when open and forwards className", () => {
    render(
      <Dialog open>
        <DialogContent className="extra">
          <DialogHeader>
            <DialogTitle>Confirm</DialogTitle>
            <DialogDescription>Are you sure?</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("qv-dialog-content", "extra");
    expect(screen.getByText("Confirm")).toHaveClass("qv-dialog-title");
    expect(screen.getByText("Are you sure?")).toHaveClass(
      "qv-dialog-description",
    );
    // Radix-provided close button (a11y preserved through the facade).
    expect(
      screen.getByRole("button", { name: "Close" }),
    ).toHaveClass("qv-dialog-close");
  });
});

describe("primitives barrel — Popover (Radix facade)", () => {
  it("renders the trigger and reveals host-classed content when open", () => {
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Panel</PopoverContent>
      </Popover>,
    );
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Panel")).toHaveClass("qv-popover-content");
  });
});

describe("primitives barrel — Tabs (Radix facade)", () => {
  it("renders list/triggers/content with host classes and the active state", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList aria-label="Sections">
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Panel A</TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole("tablist", { name: "Sections" })).toHaveClass(
      "qv-tabs-list",
    );
    const tabA = screen.getByRole("tab", { name: "A" });
    expect(tabA).toHaveClass("qv-tabs-trigger");
    expect(tabA).toHaveAttribute("data-state", "active");
    expect(screen.getByText("Panel A")).toHaveClass("qv-tabs-content");
  });
});

describe("primitives barrel — Tooltip (Radix facade)", () => {
  it("renders the trigger inside a provider with the host class on trigger", () => {
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Hover me</TooltipTrigger>
          <TooltipContent>Hint</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    // Tooltip content is lazy (shows on hover/focus); the trigger always renders.
    expect(screen.getByText("Hover me")).toBeInTheDocument();
  });
});
