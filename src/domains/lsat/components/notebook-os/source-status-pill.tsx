import { CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { Badge } from "@lsat/components/ui/badge";
import { cn } from "@lsat/lib/utils";

export function SourceStatusPill({
  status,
  official,
  className,
}: {
  status: string;
  official?: boolean;
  className?: string;
}) {
  const Icon =
    status === "ready" || status === "transcript_ready"
      ? CheckCircle2
      : status === "failed" || status === "offline"
        ? XCircle
        : Loader2;
  return (
    <Badge
      variant={official ? "secondary" : "outline"}
      className={cn("gap-1.5 rounded-md", official && "text-primary", className)}
    >
      {official ? (
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Icon
          className={cn(
            "h-3.5 w-3.5",
            ["running", "queued", "pending"].includes(status) && "animate-spin",
          )}
          aria-hidden
        />
      )}
      {official ? "firewalled" : status.split("_").join(" ")}
    </Badge>
  );
}
