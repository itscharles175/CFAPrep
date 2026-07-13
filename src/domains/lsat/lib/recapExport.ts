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
