import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type NoticeTone = "info" | "warning" | "success" | "destructive";

const TONE: Record<
  NoticeTone,
  { bg: string; icon: string; ring: string }
> = {
  info: { bg: "bg-info-subtle", icon: "text-info", ring: "border-info/30" },
  warning: {
    bg: "bg-warning-subtle",
    icon: "text-warning",
    ring: "border-warning/30",
  },
  success: {
    bg: "bg-success-subtle",
    icon: "text-success",
    ring: "border-success/30",
  },
  destructive: {
    bg: "bg-destructive-subtle",
    icon: "text-destructive",
    ring: "border-destructive/30",
  },
};

/**
 * R9 (docs/19 F4 / secondary surfaces) — one calm "system status / counsel"
 * language for advisories: offline, AI-prereq, error patterns, recommendations.
 * Replaces ~4 divergent banner idioms (and the deprecated `bg-warning/10`
 * opacity pattern) with a single token-driven primitive: an icon chip + title +
 * body + optional action + optional dismiss. Theme- and contrast-safe.
 */
export function SystemNotice({
  tone = "info",
  icon,
  title,
  children,
  action,
  onDismiss,
  className,
  role = "status",
}: {
  tone?: NoticeTone;
  icon?: LucideIcon;
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  onDismiss?: () => void;
  className?: string;
  role?: "status" | "alert";
}) {
  const t = TONE[tone];
  return (
    <div
      role={role}
      className={cn(
        "flex items-start gap-3 rounded-card border p-3 text-sm",
        t.bg,
        t.ring,
        className,
      )}
    >
      {icon && (
        <span className={cn("mt-0.5 shrink-0", t.icon)}>
          <Icon as={icon} size="sm" />
        </span>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-medium leading-snug">{title}</p>}
        {children && (
          <div className="text-muted-foreground [text-wrap:pretty]">{children}</div>
        )}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
