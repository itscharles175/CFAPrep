/**
 * K4-4 — host-styled `Table` family at the LSAT primitive's module name + prop
 * surface.
 *
 * Drop-in for `@lsat/components/ui/table`: same exports (`Table`,
 * `TableHeader`, `TableBody`, `TableFooter`, `TableHead`, `TableRow`,
 * `TableCell`, `TableCaption`) and the same `React.forwardRef` + native-element
 * prop surfaces. It is a thin facade over the SEMANTIC HTML table elements
 * (`<table>`/`<thead>`/`<tbody>`/`<tfoot>`/`<tr>`/`<th>`/`<td>`/`<caption>`),
 * so screen-reader table semantics, column/row association, and the
 * `data-[state=selected]` row hook are all preserved exactly as in the LSAT
 * primitive — only the emitted class names move to the HOST `.qv-table*`
 * vocabulary (defined in `src/index.css`, built on the host `--border` /
 * `--bg-hover` / `--surface-*` tokens) instead of the LSAT Tailwind utilities.
 *
 * NET-NEW: nothing imports this yet — it is the target vocabulary a later
 * reskin swaps in over the LSAT table.
 */
import * as React from "react";
import { cn } from "./cn";

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement>
>(({ className, ...props }, ref) => (
  // The scroll wrapper preserves the LSAT primitive's overflow behaviour so a
  // wide table scrolls horizontally inside its column instead of blowing out
  // the layout.
  <div className="qv-table-wrapper">
    <table ref={ref} className={cn("qv-table", className)} {...props} />
  </div>
));
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("qv-table-header", className)} {...props} />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("qv-table-body", className)} {...props} />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot ref={ref} className={cn("qv-table-footer", className)} {...props} />
));
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  // `data-[state=selected]` styling is handled in CSS; consumers still set
  // `data-state="selected"` exactly as with the LSAT primitive.
  <tr ref={ref} className={cn("qv-table-row", className)} {...props} />
));
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th ref={ref} className={cn("qv-table-head", className)} {...props} />
));
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td ref={ref} className={cn("qv-table-cell", className)} {...props} />
));
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn("qv-table-caption", className)} {...props} />
));
TableCaption.displayName = "TableCaption";

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
