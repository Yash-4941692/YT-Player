import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Annotations are stored NORMALISED: every coordinate is 0–1 relative to that page's own
 * width and height. Nothing is stored in pixels, so the same drawing looks identical at any
 * zoom level, in the side panel, full screen and on a phone.
 */

export type AnnotationTool = 'select' | 'highlight' | 'pen' | 'rect' | 'ellipse' | 'note' | 'eraser';

export type HighlightColor = 'yellow' | 'green' | 'pink' | 'blue';
export type PenColor = 'black' | 'red' | 'blue';
export type AnnotationColor = HighlightColor | PenColor;

export interface NormRect {
  /** Left edge, 0–1 of the page width. */
  x: number;
  /** Top edge, 0–1 of the page height. */
  y: number;
  w: number;
  h: number;
}

export interface HighlightAnnotation {
  id: string;
  type: 'highlight';
  page: number;
  color: HighlightColor;
  rects: NormRect[];
  /** 'words' when the boxes came from a real text selection, 'box' for a dragged rectangle. */
  source?: 'words' | 'box';
}

export interface PenAnnotation {
  id: string;
  type: 'pen';
  page: number;
  color: PenColor;
  /** Flattened [x0, y0, x1, y1, …] normalised points. */
  points: number[];
  /** Line width in screen pixels, kept constant with non-scaling-stroke. */
  width: number;
}

export interface ShapeAnnotation {
  id: string;
  type: 'rect' | 'ellipse';
  page: number;
  color: AnnotationColor;
  rect: NormRect;
  width: number;
}

export interface NoteAnnotation {
  id: string;
  type: 'note';
  page: number;
  color: AnnotationColor;
  x: number;
  y: number;
  text: string;
}

export type Annotation = HighlightAnnotation | PenAnnotation | ShapeAnnotation | NoteAnnotation;

export interface AnnotationDocument {
  version: 1;
  annotations: Annotation[];
}

export const EMPTY_ANNOTATION_DOCUMENT: AnnotationDocument = { version: 1, annotations: [] };

export const HIGHLIGHT_COLORS: { id: HighlightColor; label: string; hex: string }[] = [
  { id: 'yellow', label: 'Yellow', hex: '#ffd166' },
  { id: 'green', label: 'Green', hex: '#8ce99a' },
  { id: 'pink', label: 'Pink', hex: '#ff9ecb' },
  { id: 'blue', label: 'Blue', hex: '#8ac6ff' },
];

export const PEN_COLORS: { id: PenColor; label: string; hex: string }[] = [
  { id: 'black', label: 'Black', hex: '#111318' },
  { id: 'red', label: 'Red', hex: '#e0483f' },
  { id: 'blue', label: 'Blue', hex: '#2f6fed' },
];

export const DEFAULT_HIGHLIGHT: HighlightColor = 'yellow';
export const DEFAULT_PEN: PenColor = 'red';

/** Colour used by shapes and sticky notes, which share the highlight palette. */
export function colorHex(color: AnnotationColor): string {
  return (
    HIGHLIGHT_COLORS.find((entry) => entry.id === color)?.hex
    ?? PEN_COLORS.find((entry) => entry.id === color)?.hex
    ?? '#ffd166'
  );
}

export function isHighlightColor(color: AnnotationColor): color is HighlightColor {
  return HIGHLIGHT_COLORS.some((entry) => entry.id === color);
}

/** Highlights only accept highlight colours; anything else becomes the default. */
export function highlightColorFor(color: AnnotationColor): HighlightColor {
  return isHighlightColor(color) ? color : DEFAULT_HIGHLIGHT;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function newAnnotationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Build a normalised rect from two corner points, and refuse degenerate boxes. */
export function rectFromPoints(x1: number, y1: number, x2: number, y2: number): NormRect | null {
  const x = clamp01(Math.min(x1, x2));
  const y = clamp01(Math.min(y1, y2));
  const w = clamp01(Math.max(x1, x2)) - x;
  const h = clamp01(Math.max(y1, y2)) - y;
  // A 1.5 mm-ish tap is not a shape.
  if (w < 0.004 || h < 0.004) return null;
  return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
}

/** Absolute-positioned SVG viewBox of 0..1000 gives sub-pixel accuracy for free. */
export const VIEW_BOX = 1000;

export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Pen strokes arrive one point per pointer event, which is far more detail than needed.
 * Points closer than `minDistance` (normalised) are dropped or merged, so a long stroke
 * stays small enough to sync happily and still looks smooth.
 */
export function simplifyPoints(points: number[], minDistance = 0.0025): number[] {
  if (points.length <= 4) return points.map(round4);
  const out: number[] = [round4(points[0]), round4(points[1])];
  for (let i = 2; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    const dx = x - out[out.length - 2];
    const dy = y - out[out.length - 1];
    if (Math.hypot(dx, dy) < minDistance) continue;
    out.push(round4(x), round4(y));
  }
  // Always keep the very last point so the stroke ends where the finger lifted.
  const lastX = round4(points[points.length - 2]);
  const lastY = round4(points[points.length - 1]);
  if (out[out.length - 2] !== lastX || out[out.length - 1] !== lastY) out.push(lastX, lastY);
  return out;
}

export function penPath(points: number[]): string {
  if (points.length < 4) return '';
  const [x0, y0, ...rest] = points;
  let path = `M ${(x0 * VIEW_BOX).toFixed(2)} ${(y0 * VIEW_BOX).toFixed(2)}`;
  for (let i = 0; i < rest.length; i += 2) {
    path += ` L ${(rest[i] * VIEW_BOX).toFixed(2)} ${(rest[i + 1] * VIEW_BOX).toFixed(2)}`;
  }
  return path;
}

/** True when the annotation sits on the given page (1-based). */
export function annotationsForPage(annotations: Annotation[], page: number): Annotation[] {
  return annotations.filter((annotation) => annotation.page === page);
}

/** Eraser hit test: is this normalised point on the annotation? */
export function hitsAnnotation(annotation: Annotation, x: number, y: number, pad = 0.012): boolean {
  if (annotation.type === 'pen') {
    for (let i = 0; i + 3 < annotation.points.length; i += 2) {
      if (segmentDistance(x, y, annotation.points[i], annotation.points[i + 1], annotation.points[i + 2], annotation.points[i + 3]) <= pad) return true;
    }
    return false;
  }
  if (annotation.type === 'note') {
    return Math.hypot(x - annotation.x, y - annotation.y) <= 0.035;
  }
  const rects = annotation.type === 'highlight' ? annotation.rects : [annotation.rect];
  return rects.some((rect) => (
    x >= rect.x - pad && x <= rect.x + rect.w + pad && y >= rect.y - pad && y <= rect.y + rect.h + pad
  ));
}

function segmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Drop malformed shapes that could come from an older or hand-edited document, so one bad
 * entry can never break the whole viewer.
 */
export function normalizeDocument(value: unknown): AnnotationDocument {
  if (!value || typeof value !== 'object') return EMPTY_ANNOTATION_DOCUMENT;
  const raw = value as Partial<AnnotationDocument> & { annotations?: unknown };
  if (!Array.isArray(raw.annotations)) return EMPTY_ANNOTATION_DOCUMENT;
  const annotations: Annotation[] = [];
  for (const entry of raw.annotations) {
    const annotation = normalizeAnnotation(entry);
    if (annotation) annotations.push(annotation);
  }
  return { version: 1, annotations };
}

function normalizeAnnotation(value: unknown): Annotation | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const page = Math.max(1, Math.round(Number(item.page) || 1));
  const id = typeof item.id === 'string' && item.id ? item.id : newAnnotationId();
  const type = item.type;

  if (type === 'highlight') {
    const rects = Array.isArray(item.rects) ? item.rects.map(normalizeRect).filter((rect): rect is NormRect => rect !== null) : [];
    if (rects.length === 0) return null;
    const color = isHighlightColor(item.color as AnnotationColor) ? item.color as HighlightColor : DEFAULT_HIGHLIGHT;
    const source = item.source === 'box' ? 'box' : 'words';
    return { id, type, page, color, rects, source };
  }
  if (type === 'pen') {
    const points = Array.isArray(item.points) ? item.points.map(Number).filter(Number.isFinite) : [];
    if (points.length < 4) return null;
    const color = PEN_COLORS.some((entry) => entry.id === item.color) ? item.color as PenColor : DEFAULT_PEN;
    return { id, type, page, color, points: points.map(clamp01), width: clampNumber(Number(item.width), 1, 12, 3) };
  }
  if (type === 'rect' || type === 'ellipse') {
    const rect = normalizeRect(item.rect);
    if (!rect) return null;
    const color = (colorHex(item.color as AnnotationColor) ? item.color as AnnotationColor : DEFAULT_HIGHLIGHT);
    return { id, type, page, color, rect, width: clampNumber(Number(item.width), 1, 12, 3) };
  }
  if (type === 'note') {
    const text = typeof item.text === 'string' ? item.text.slice(0, 2000) : '';
    const color = (colorHex(item.color as AnnotationColor) ? item.color as AnnotationColor : DEFAULT_HIGHLIGHT);
    return { id, type, page, color, x: clamp01(Number(item.x)), y: clamp01(Number(item.y)), text };
  }
  return null;
}

function normalizeRect(value: unknown): NormRect | null {
  if (!value || typeof value !== 'object') return null;
  const rect = value as Record<string, unknown>;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const w = Number(rect.w);
  const h = Number(rect.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w <= 0 || h <= 0) return null;
  return { x: clamp01(x), y: clamp01(y), w: clamp01(w), h: clamp01(h) };
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/* ---------------------------------------------------------------------------
 * Editor state: annotations + ~50 steps of undo/redo + a dirty marker.
 * ------------------------------------------------------------------------- */

export const HISTORY_LIMIT = 50;

export interface AnnotationEditorState {
  annotations: Annotation[];
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  add(annotation: Annotation): void;
  erase(id: string): void;
  updateNote(id: string, text: string): void;
  clearAll(): void;
  undo(): void;
  redo(): void;
  markSaved(): void;
  replaceAll(annotations: Annotation[]): void;
}

export function useAnnotationHistory(initial: Annotation[] = []): AnnotationEditorState {
  const [present, setPresent] = useState<Annotation[]>(initial);
  const [past, setPast] = useState<Annotation[][]>([]);
  const [future, setFuture] = useState<Annotation[][]>([]);
  const [savedSnapshot, setSavedSnapshot] = useState<string>(() => JSON.stringify(initial));

  const presentRef = useRef(present);
  presentRef.current = present;

  const commit = useCallback((next: Annotation[]) => {
    setPresent((current) => {
      setPast((stack) => [...stack, current].slice(-HISTORY_LIMIT));
      return next;
    });
    setFuture([]);
  }, []);

  const add = useCallback((annotation: Annotation) => {
    commit([...presentRef.current, annotation]);
  }, [commit]);

  const erase = useCallback((id: string) => {
    const next = presentRef.current.filter((annotation) => annotation.id !== id);
    if (next.length === presentRef.current.length) return;
    commit(next);
  }, [commit]);

  const updateNote = useCallback((id: string, text: string) => {
    commit(presentRef.current.map((annotation) => (
      annotation.id === id && annotation.type === 'note' ? { ...annotation, text } : annotation
    )));
  }, [commit]);

  const clearAll = useCallback(() => {
    if (presentRef.current.length === 0) return;
    commit([]);
  }, [commit]);

  const undo = useCallback(() => {
    setPast((stack) => {
      if (stack.length === 0) return stack;
      const previous = stack[stack.length - 1];
      setFuture((redoStack) => [presentRef.current, ...redoStack].slice(0, HISTORY_LIMIT));
      setPresent(previous);
      return stack.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((stack) => {
      if (stack.length === 0) return stack;
      const [next, ...rest] = stack;
      setPast((undoStack) => [...undoStack, presentRef.current].slice(-HISTORY_LIMIT));
      setPresent(next);
      return rest;
    });
  }, []);

  const replaceAll = useCallback((annotations: Annotation[]) => {
    setPresent(annotations);
    setPast([]);
    setFuture([]);
    setSavedSnapshot(JSON.stringify(annotations));
  }, []);

  const markSaved = useCallback(() => {
    setSavedSnapshot(JSON.stringify(presentRef.current));
  }, []);

  const dirty = useMemo(() => JSON.stringify(present) !== savedSnapshot, [present, savedSnapshot]);

  return {
    annotations: present,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    dirty,
    add,
    erase,
    updateNote,
    clearAll,
    undo,
    redo,
    markSaved,
    replaceAll,
  };
}

/**
 * Undo/redo keyboard shortcuts while the reader is open: Ctrl/Cmd+Z, Ctrl+Shift+Z, Ctrl+Y.
 * Ignored while the user is typing in the sticky-note box so text editing keeps working.
 */
export function useAnnotationShortcuts(
  { undo, redo, enabled }: { undo: () => void; redo: () => void; enabled: boolean },
) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      const target = event.target as HTMLElement | null;
      const typing = target?.closest('input, textarea, [contenteditable="true"]');
      if (typing) return;
      event.preventDefault();
      if (key === 'y' || (event.shiftKey && key === 'z')) redo();
      else undo();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [undo, redo, enabled]);
}
