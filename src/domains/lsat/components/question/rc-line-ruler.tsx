import { useCallback, useEffect, useRef, useState } from "react";
import { Ruler } from "lucide-react";
import { cn } from "@/lib/utils";

/** R4-C4 — horizontal drag guide for RC passages. */
export function RcLineRuler({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
  const [active, setActive] = useState(false);
  const [y, setY] = useState(120);
  const dragging = useRef(false);

  const onMove = useCallback(
    (clientY: number) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const next = Math.min(rect.height - 4, Math.max(4, clientY - rect.top));
      setY(next);
    },
    [containerRef],
  );

  useEffect(() => {
    if (!dragging.current) return;
    function onPointerMove(e: PointerEvent) {
      onMove(e.clientY);
    }
    function onPointerUp() {
      dragging.current = false;
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [onMove]);

  if (!active) {
    return (
      <button
        type="button"
        title="Line ruler"
        aria-label="Show line ruler"
        onClick={() => setActive(true)}
        className="rounded-md border bg-card px-2 py-1 text-xs hover:bg-accent"
      >
        <Ruler className="inline h-3.5 w-3.5" />
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        title="Hide line ruler"
        aria-label="Hide line ruler"
        onClick={() => setActive(false)}
        className="rounded-md border border-primary bg-primary/10 px-2 py-1 text-xs text-primary"
      >
        <Ruler className="inline h-3.5 w-3.5" />
      </button>
      <div
        className="pointer-events-none absolute inset-0 z-20"
        aria-hidden={!active}
      >
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-valuenow={Math.round(y)}
          className="pointer-events-auto absolute left-0 right-0 cursor-ns-resize"
          style={{ top: y - 6, height: 12 }}
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            onMove(e.clientY);
          }}
        >
          <div
            className={cn(
              "h-0.5 w-full bg-primary shadow-sm",
              "before:absolute before:left-0 before:top-1/2 before:h-3 before:w-3 before:-translate-y-1/2 before:rounded-full before:bg-primary",
            )}
          />
        </div>
      </div>
    </>
  );
}
