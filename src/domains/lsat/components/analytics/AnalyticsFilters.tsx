import { useId } from "react";
import { Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import type { Source } from "./tabs";

export type AnalyticsRange = "7" | "30" | "all";

export function AnalyticsFilters({
  source,
  range,
  comparePrior,
  usingSample,
  onSourceChange,
  onRangeChange,
  onCompareChange,
  footer,
}: {
  source: Source;
  range: AnalyticsRange;
  comparePrior: boolean;
  usingSample?: boolean;
  onSourceChange: (s: Source) => void;
  onRangeChange: (r: AnalyticsRange) => void;
  onCompareChange: (v: boolean) => void;
  footer?: React.ReactNode;
}) {
  const sourceId = useId();
  const rangeId = useId();
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="print:hidden">
          <Filter className="h-4 w-4" />
          Filters
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-sm">
        <h2 className="text-lg font-semibold">Analytics filters</h2>
        <div className="mt-6 space-y-6">
          {usingSample && (
            <p className="text-sm text-warning">Showing sample data (backend offline).</p>
          )}
          <div className="space-y-2">
            <Label htmlFor={sourceId}>Question source</Label>
            <Select value={source} onValueChange={(v) => onSourceChange(v as Source)}>
              <SelectTrigger id={sourceId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="official">Real questions only</SelectItem>
                <SelectItem value="all">Include AI drills</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={rangeId}>Time range</Label>
            <Select value={range} onValueChange={(v) => onRangeChange(v as AnalyticsRange)}>
              <SelectTrigger id={rangeId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="all">All time</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Filters trend chart client-side; type stats use full history until API adds range.
            </p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="compare-prior-sheet">Compare to prior period</Label>
              <p className="text-xs text-muted-foreground">Overlay earlier scores on the trend.</p>
            </div>
            <Switch
              id="compare-prior-sheet"
              checked={comparePrior}
              onCheckedChange={onCompareChange}
            />
          </div>
          {footer}
        </div>
      </SheetContent>
    </Sheet>
  );
}
