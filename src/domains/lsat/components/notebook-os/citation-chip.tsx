import { Link2, ShieldCheck } from "lucide-react";
import { Badge } from "@lsat/components/ui/badge";
import { cn } from "@lsat/lib/utils";

export function CitationChip({
  target,
  label,
  official,
  onOpen,
  className,
}: {
  target: string;
  label?: string;
  official?: boolean;
  onOpen?: (target: string) => void;
  className?: string;
}) {
  const contents = (
    <>
      {official ? (
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Link2 className="h-3.5 w-3.5" aria-hidden />
      )}
      <span className="truncate">{label || target}</span>
    </>
  );

  if (!onOpen) {
    return (
      <Badge
        variant={official ? "secondary" : "outline"}
        className={cn("max-w-full gap-1.5 rounded-md", className)}
      >
        {contents}
      </Badge>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(target)}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium",
        "text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        official && "border-primary/30 bg-primary/10 text-primary",
        className,
      )}
      title={target}
    >
      {contents}
    </button>
  );
}
