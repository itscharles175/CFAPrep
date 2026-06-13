import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * A1.5 — the streamed-explanation markdown body, split into its OWN module so the
 * `react-markdown` + `remark-gfm` bundle (~47KB) is code-split out of the
 * Explanation route. `Explanation.tsx` `lazy()`-imports this component behind a
 * `Suspense`, so the explanation shell (header, choices, per-choice breakdown)
 * paints first and this heavy renderer arrives without blocking first paint. The
 * body already streams token-by-token, so a one-frame fallback here is invisible.
 *
 * Behaviour is unchanged from the previous inline `AiMarkdown`: choice citations
 * like "(A)" become hoverable spans that drive the breakdown spotlight; the
 * `.reading` substrate + the `aria-live` streaming cursor are preserved by the
 * caller.
 */
export default function AiMarkdown({
  text,
  streaming,
  validLabels,
  onSpotlight,
  readingClassName,
}: {
  text: string;
  streaming: boolean;
  validLabels: string[];
  onSpotlight: (label: string | null) => void;
  /** Tuned `.reading` classes so the stream honors size/serif/measure prefs. */
  readingClassName: string;
}) {
  // Wrap "(A)" style references in a sentinel so a custom renderer can pick
  // them up. Only wrap labels that exist on this question.
  const labelSet = useMemo(() => new Set(validLabels), [validLabels]);
  const prepared = useMemo(
    () =>
      text.replace(/\(([A-E])\)/g, (m, letter: string) =>
        labelSet.has(letter) ? `⁣${letter}⁣` : m,
      ),
    [text, labelSet],
  );

  return (
    // 4.3 — the streamed body now reads on the tuned `.reading` surface (size /
    // serif / measure prefs) instead of `prose-sm`; paragraph rhythm comes from
    // `.reading p + p` rather than per-paragraph margins. C5 — long unbroken
    // tokens (pasted URLs) wrap instead of forcing horizontal scroll.
    <div className={readingClassName} style={{ overflowWrap: "anywhere" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p>{renderCitations(children, onSpotlight)}</p>
          ),
          li: ({ children }) => (
            <li className="ml-4 list-disc">
              {renderCitations(children, onSpotlight)}
            </li>
          ),
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          code: ({ children }) => (
            <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>
          ),
        }}
      >
        {prepared}
      </ReactMarkdown>
      {streaming && (
        <span className="ml-0.5 inline-block animate-pulse motion-reduce:animate-none">
          ▋
        </span>
      )}
    </div>
  );
}

// Convert sentinel-wrapped choice letters in rendered children into hoverable
// spans that drive the spotlight.
function renderCitations(
  children: React.ReactNode,
  onSpotlight: (label: string | null) => void,
): React.ReactNode {
  if (typeof children === "string") {
    return splitCitations(children, onSpotlight);
  }
  if (Array.isArray(children)) {
    return children.map((c, i) =>
      typeof c === "string" ? (
        <span key={i}>{splitCitations(c, onSpotlight)}</span>
      ) : (
        c
      ),
    );
  }
  return children;
}

function splitCitations(
  s: string,
  onSpotlight: (label: string | null) => void,
): React.ReactNode {
  const parts = s.split(/⁣([A-E])⁣/g);
  return parts.map((part, i) => {
    // Odd indices are captured letters.
    if (i % 2 === 1) {
      return (
        <button
          key={i}
          type="button"
          onMouseEnter={() => onSpotlight(part)}
          onMouseLeave={() => onSpotlight(null)}
          onClick={() => onSpotlight(part)}
          className="mx-px rounded bg-info/15 px-1 font-semibold text-info hover:bg-info/30"
        >
          ({part})
        </button>
      );
    }
    return <span key={i}>{part}</span>;
  });
}
