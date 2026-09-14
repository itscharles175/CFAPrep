import type { ResultItem } from "./types";

/** R4-D11 — print-friendly HTML: stems without answers. */
export function buildBrWorksheetHtml(
  sessionLabel: string,
  items: ResultItem[],
): string {
  const blocks = items
    .map((it, i) => {
      const q = it.question;
      const stem = q.stem
        ? `<div class="stem">${escapeHtml(q.stem)}</div>`
        : "";
      const choices = q.choices
        .map(
          (c) =>
            `<div class="choice"><span class="letter">${c.label}.</span> ${escapeHtml(c.text)}</div>`,
        )
        .join("");
      return `<section class="q">
<h2>Question ${i + 1}</h2>
${stem}
<p class="prompt"><strong>${escapeHtml(q.prompt)}</strong></p>
<div class="choices">${choices}</div>
<div class="br-lines">
<p><strong>Blind review answer:</strong> _____</p>
<p><strong>Confidence:</strong> ☐ Sure &nbsp; ☐ Pretty sure &nbsp; ☐ Guessing</p>
<p><strong>Notes:</strong></p>
<div class="notes-box"></div>
</div>
</section>`;
    })
    .join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>BR Worksheet — ${escapeHtml(sessionLabel)}</title>
<style>
@page { margin: 0.75in; }
body { font-family: Georgia, serif; font-size: 11pt; line-height: 1.45; color: #111; max-width: 7in; margin: 0 auto; }
h1 { font-size: 16pt; font-family: system-ui, sans-serif; }
h2 { font-size: 12pt; margin-top: 1.5rem; border-bottom: 1px solid #ccc; padding-bottom: 0.25rem; }
.q { break-inside: avoid; margin-bottom: 2rem; }
.stem { margin-bottom: 0.75rem; white-space: pre-wrap; }
.prompt { margin: 0.5rem 0; }
.choice { margin: 0.35rem 0 0.35rem 1rem; }
.letter { font-weight: 700; }
.br-lines { margin-top: 1rem; font-family: system-ui, sans-serif; font-size: 10pt; }
.notes-box { border: 1px solid #999; min-height: 3rem; margin-top: 0.25rem; }
.muted { color: #555; font-size: 9pt; font-family: system-ui, sans-serif; }
</style></head><body>
<h1>Blind review worksheet</h1>
<p class="muted">${escapeHtml(sessionLabel)} · ${items.length} questions · no answers</p>
${blocks}
<p class="muted">StudyVault · LSAT · print and work offline, then enter answers in the app.</p>
</body></html>`;
}

export function downloadBrWorksheet(html: string, filename: string): void {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
