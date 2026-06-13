import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Pencil, StickyNote } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  getScratch,
  getScratchDrawing,
  setScratch,
  setScratchDrawing,
  type Stroke,
  type StrokePoint,
} from "@/lib/scratchPrefs";
import { cn } from "@/lib/utils";

type Tab = "text" | "draw";

/** R4-C2 — typed scratch + optional canvas drawing (per section). */
export function ScratchPad({ sectionId }: { sectionId: number }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("text");
  const [text, setText] = useState(() => getScratch(sectionId));
  const [strokes, setStrokes] = useState<Stroke[]>(() => getScratchDrawing(sectionId));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const currentStroke = useRef<StrokePoint[]>([]);

  useEffect(() => {
    setText(getScratch(sectionId));
    setStrokes(getScratchDrawing(sectionId));
  }, [sectionId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !open || tab !== "draw") return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "hsl(var(--foreground))";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokes) {
      if (stroke.points.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      ctx.stroke();
    }
  }, [strokes, open, tab]);

  function saveText(next: string) {
    setText(next);
    setScratch(sectionId, next);
  }

  const persistStrokes = useCallback(
    (next: Stroke[]) => {
      setStrokes(next);
      setScratchDrawing(sectionId, next);
    },
    [sectionId],
  );

  function pointerPos(e: React.PointerEvent<HTMLCanvasElement>): StrokePoint {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    currentStroke.current = [pointerPos(e)];
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    currentStroke.current.push(pointerPos(e));
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "hsl(var(--foreground))";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    for (const stroke of strokes) {
      if (stroke.points.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      ctx.stroke();
    }
    const pts = currentStroke.current;
    if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
  }

  function onPointerUp() {
    if (!drawing.current) return;
    drawing.current = false;
    if (currentStroke.current.length > 0) {
      persistStrokes([...strokes, { points: [...currentStroke.current] }]);
    }
    currentStroke.current = [];
  }

  const hasContent = text.trim().length > 0 || strokes.length > 0;

  return (
    <div className="border-t bg-muted/30">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        aria-controls={`scratch-panel-${sectionId}`}
        onClick={() => setOpen((o) => !o)}
      >
        <StickyNote className="h-3.5 w-3.5" />
        Scratch pad
        {hasContent && !open && (
          <span className="rounded-full bg-primary/15 px-1.5 text-[10px] text-primary">
            saved
          </span>
        )}
      </button>
      {open && (
        <div id={`scratch-panel-${sectionId}`} className="space-y-2 px-4 pb-3">
          <div className="flex gap-1">
            <button
              type="button"
              aria-pressed={tab === "text"}
              onClick={() => setTab("text")}
              className={cn(
                "rounded px-2 py-0.5 text-xs",
                tab === "text" ? "bg-primary text-primary-foreground" : "hover:bg-accent",
              )}
            >
              Notes
            </button>
            <button
              type="button"
              aria-pressed={tab === "draw"}
              onClick={() => setTab("draw")}
              className={cn(
                "flex items-center gap-1 rounded px-2 py-0.5 text-xs",
                tab === "draw" ? "bg-primary text-primary-foreground" : "hover:bg-accent",
              )}
            >
              <Pencil className="h-3 w-3" />
              Draw
            </button>
          </div>
          {tab === "text" ? (
            <Textarea
              value={text}
              onChange={(e) => saveText(e.target.value)}
              placeholder="Rough work, passage map, rule sketches…"
              rows={4}
              className="text-sm font-mono"
            />
          ) : (
            <div className="space-y-2">
              <canvas
                ref={canvasRef}
                aria-label="Scratch drawing canvas"
                className="h-32 w-full cursor-crosshair rounded-md border bg-card touch-none"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={() => persistStrokes([])}
              >
                <Eraser className="h-3 w-3" />
                Clear drawing
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
