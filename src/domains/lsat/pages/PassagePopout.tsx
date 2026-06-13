import { useEffect, useMemo, useState } from "react";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { POPOUT_PASSAGE_KEY, type PopoutPassage } from "@/lib/tauri";
import { getJSON } from "@/lib/storage";
import { Logo } from "@/components/logo";
import {
  nextReadingSize,
  prevReadingSize,
  readingClasses,
  useReadingPrefs,
} from "@/lib/prefs";

function readPassage(): PopoutPassage | null {
  return getJSON<PopoutPassage | null>(POPOUT_PASSAGE_KEY, null);
}

/** Split passage text into paragraphs on blank-line boundaries (matches the
 * main reading pane), keeping soft single newlines as in-paragraph breaks. */
function toParagraphs(text: string): string[] {
  return text.split(/\r?\n[ \t]*\r?\n[\s]*/);
}

/**
 * C3 — standalone passage window. Reads the popped-out passage from
 * localStorage and live-updates when the main window pops a different one
 * (cross-window `storage` event). Works as a Tauri WebviewWindow or a browser
 * popup.
 */
export default function PassagePopout() {
  const [data, setData] = useState<PopoutPassage | null>(() => readPassage());
  // C3 + R8 §4.4 — reconcile with the main reading pane: same `.reading`
  // typography (size / serif / measure) instead of a bespoke px stepper.
  const [reading, setReading] = useReadingPrefs();
  const rcls = readingClasses(reading);
  const paragraphs = useMemo(() => toParagraphs(data?.text ?? ""), [data?.text]);

  useDocumentTitle("Passage — LSATLab");

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === POPOUT_PASSAGE_KEY) setData(readPassage());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  if (!data) {
    return (
      // R9 (docs/19 F8): the brand mark makes the second window recognizably
      // part of LSAT Lab. The shared desktop Titlebar (native drag region +
      // window controls under Tauri) is supplied by GlobalChrome, which wraps
      // this route and titles its bar "Passage" — so we don't double it here.
      <div className="flex min-h-screen flex-col bg-background">
        <div className="flex items-center gap-2 border-b px-6 py-2 text-xs text-muted-foreground">
          <Logo className="h-4 w-4" />
          <span className="font-semibold uppercase tracking-wide">Passage</span>
        </div>
        <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
          No passage to display. Pop one out from a Reading Comprehension section.
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* R9 (docs/19 F8) — branded sticky header (the shared desktop Titlebar is
          provided by GlobalChrome around this route). The brand mark ties the
          second window to the app; reading controls keep their read-only prefs. */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b bg-background/95 px-6 py-2 text-xs text-muted-foreground backdrop-blur">
        <span className="flex items-center gap-2">
          <Logo className="h-4 w-4" />
          <span className="font-semibold uppercase tracking-wide">
            {data.topic ?? "Passage"}
          </span>
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded px-2 py-0.5 transition-colors hover:bg-surface-2"
            onClick={() => setReading({ size: prevReadingSize(reading.size) })}
            aria-label="Decrease text size"
          >
            A−
          </button>
          <button
            type="button"
            className="rounded px-2 py-0.5 transition-colors hover:bg-surface-2"
            onClick={() => setReading({ size: nextReadingSize(reading.size) })}
            aria-label="Increase text size"
          >
            A+
          </button>
        </div>
      </div>
      <article className={`${rcls} mx-auto px-8 py-8`}>
        {paragraphs.map((p, i) => (
          <p key={i} className="whitespace-pre-wrap">
            {p}
          </p>
        ))}
      </article>
    </div>
  );
}
