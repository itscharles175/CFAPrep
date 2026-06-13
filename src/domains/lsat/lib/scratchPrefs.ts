import { getJSON, getRaw, setJSON, setRaw } from "./storage";

const PREFIX = "lsatlab.scratch.";
const DRAW_PREFIX = "lsatlab.scratch.draw.";

export interface StrokePoint {
  x: number;
  y: number;
}

export interface Stroke {
  points: StrokePoint[];
}

export function getScratch(sectionId: number): string {
  return getRaw(PREFIX + sectionId) ?? "";
}

export function setScratch(sectionId: number, text: string): void {
  setRaw(PREFIX + sectionId, text);
}

export function getScratchDrawing(sectionId: number): Stroke[] {
  const arr = getJSON<Stroke[]>(DRAW_PREFIX + sectionId, []);
  return Array.isArray(arr) ? arr : [];
}

export function setScratchDrawing(sectionId: number, strokes: Stroke[]): void {
  setJSON(DRAW_PREFIX + sectionId, strokes);
}
