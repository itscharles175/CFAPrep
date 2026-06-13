// R10 A1.2 — html-to-image (~20KB min) is dynamically imported inside the
// export fns so it stays out of the eager bundle; it only runs on a Share click.

/** Export a DOM node as PNG. */
export async function exportNodeAsPng(
  node: HTMLElement,
  filename: string,
): Promise<void> {
  const { toPng } = await import("html-to-image");
  const dataUrl = await toPng(node, {
    pixelRatio: 2,
    cacheBust: true,
    // R11 1.1 — match the share-card's graphite gradient base (was slate
    // #0f172a) so there's no seam at the card's rounded corners.
    backgroundColor: "#0d0f17",
  });
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

/** Export a DOM node as SVG file. */
export async function exportNodeAsSvg(
  node: HTMLElement,
  filename: string,
): Promise<void> {
  const { toSvg } = await import("html-to-image");
  const dataUrl = await toSvg(node, { cacheBust: true });
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

/** @deprecated Use RecapShareCard + exportNodeAsPng */
export function downloadRecapPng(opts: {
  title: string;
  score: string;
  accuracy: string;
  time: string;
  bestType?: string;
  worstType?: string;
}): void {
  const w = 640;
  const h = 360;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#f8fafc";
  ctx.font = "bold 28px system-ui, sans-serif";
  ctx.fillText(opts.title, 32, 56);
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillStyle = "#94a3b8";
  ctx.fillText("LSAT Lab session recap", 32, 84);

  const lines = [
    `Score: ${opts.score}`,
    `Accuracy: ${opts.accuracy}`,
    `Time: ${opts.time}`,
    opts.bestType ? `Strongest: ${opts.bestType}` : "",
    opts.worstType ? `Weakest: ${opts.worstType}` : "",
  ].filter(Boolean);

  ctx.fillStyle = "#e2e8f0";
  ctx.font = "20px system-ui, sans-serif";
  lines.forEach((line, i) => ctx.fillText(line, 32, 140 + i * 36));

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lsatlab-recap-${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
    URL.revokeObjectURL(url);
  });
}
