import { Component, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /**
   * "page" (default) renders the full ErrorState. "widget" renders a compact,
   * isolated inline fallback so a crash in one panel does not blank the page
   * (5.7). `label` names the widget in the fallback copy.
   */
  variant?: "page" | "widget";
  label?: string;
  /**
   * Optional reset key: when it changes, the boundary clears its error so the
   * subtree can re-mount (e.g. after navigating to a different question).
   */
  resetKey?: unknown;
  /**
   * Custom fallback renderer. When provided, replaces the default ErrorState.
   * Receives `reset` so the caller can add a retry action.
   */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * J9 / 5.7 — catch unhandled render errors. As a "page" boundary it stops one
 * bad page from blanking the whole app; as a "widget" boundary it isolates a
 * single heavy, independent panel (analytics chart, coach, similar questions)
 * so the rest of the page keeps working and the user can retry just that panel.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // Clear the captured error when the caller's resetKey changes.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.reset();
    }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Local-only: surface in console (and Tauri file logs in a packaged build).
    const where = this.props.label ? ` in ${this.props.label}` : "";
    console.error(`Unhandled render error${where}:`, error);

    // G6 — persist the last crash locally so the Diagnostics panel can surface
    // it. Wrapped in try/catch so a localStorage write failure never masks the
    // original error. Stack is truncated to ~4000 chars to stay well under the
    // typical 5 MB per-key quota.
    try {
      const route =
        typeof window !== "undefined" ? window.location.pathname : "";
      const entry = {
        message: error.message,
        stack: (error.stack ?? "").slice(0, 4000),
        componentStack: (errorInfo.componentStack ?? "").slice(0, 4000),
        route,
        ts: Date.now(),
      };
      localStorage.setItem("lsatlab.lastCrash", JSON.stringify(entry));
    } catch {
      /* ignore write errors */
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      if (this.props.variant === "widget") {
        return (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="flex-1">
                <p className="font-medium">
                  {this.props.label ?? "This panel"} hit an error.
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  The rest of the page is unaffected.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={this.reset}
              >
                <RotateCcw className="h-3.5 w-3.5" /> Retry
              </Button>
            </div>
          </div>
        );
      }
      return (
        <div className="p-8">
          <ErrorState error={this.state.error} onRetry={this.reset} />
        </div>
      );
    }
    return this.props.children;
  }
}

/** Convenience wrapper for isolating one heavy widget (5.7). */
export function WidgetBoundary({
  label,
  resetKey,
  children,
}: {
  label: string;
  resetKey?: unknown;
  children: ReactNode;
}) {
  return (
    <ErrorBoundary variant="widget" label={label} resetKey={resetKey}>
      {children}
    </ErrorBoundary>
  );
}
