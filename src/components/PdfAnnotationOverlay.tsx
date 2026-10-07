import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Trash2, X } from 'lucide-react';
import {
  newAnnotationId, penPath, rectFromPoints, simplifyPoints, VIEW_BOX, colorHex, PEN_COLORS, DEFAULT_PEN,
  type Annotation, type AnnotationColor, type AnnotationTool, type NormRect, type PenColor,
} from '../lib/annotations';

/** Pens only accept pen colours; anything else falls back to the default ink. */
function penColorFor(color: AnnotationColor): PenColor {
  return PEN_COLORS.some((entry) => entry.id === color) ? color as PenColor : DEFAULT_PEN;
}

interface Props {
  /** 1-based page number this overlay belongs to. */
  page: number;
  annotations: Annotation[];
  tool: AnnotationTool;
  color: AnnotationColor;
  /** Annotation mode is on and this page accepts new drawings. */
  drawingEnabled: boolean;
  onAdd: (annotation: Annotation) => void;
  onErase: (id: string) => void;
  onUpdateNote: (id: string, text: string) => void;
}

function localPoint(event: ReactPointerEvent, element: Element): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}

/**
 * One page's annotation layer. Geometry is normalised (0–1 of the page box) and the SVG
 * viewBox maps that to 0–1000 with preserveAspectRatio="none", so nothing is stored in
 * pixels and every stroke keeps its width via vector-effect="non-scaling-stroke".
 */
export function PdfAnnotationOverlay({
  page, annotations, tool, color, drawingEnabled, onAdd, onErase, onUpdateNote,
}: Props) {
  const layerRef = useRef<SVGSVGElement>(null);
  const draftRef = useRef<{ type: 'pen' | 'rect' | 'ellipse'; points: number[]; start: { x: number; y: number } } | null>(null);
  const [draft, setDraft] = useState<{ type: 'pen' | 'rect' | 'ellipse'; points: number[]; start: { x: number; y: number } } | null>(null);
  const [editingNote, setEditingNote] = useState<{ id: string; x: number; y: number; draft: string } | null>(null);

  const pageAnnotations = useMemo(() => annotations.filter((annotation) => annotation.page === page), [annotations, page]);
  const notes = pageAnnotations.filter((annotation) => annotation.type === 'note');

  const drawingTool = tool === 'pen' || tool === 'rect' || tool === 'ellipse';
  const interactive = drawingEnabled && (drawingTool || tool === 'eraser');
  const strokeWidth = tool === 'pen' ? 2.4 : 2;

  // Any tool change cancels a half-drawn shape so it cannot be committed by accident.
  useEffect(() => {
    draftRef.current = null;
    setDraft(null);
  }, [tool]);

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!drawingEnabled || !drawingTool || event.button !== 0) return;
    const element = layerRef.current;
    if (!element) return;
    const point = localPoint(event, element);
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = {
      type: tool === 'pen' ? 'pen' as const : tool === 'rect' ? 'rect' as const : 'ellipse' as const,
      points: [point.x, point.y],
      start: point,
    };
    draftRef.current = next;
    setDraft(next);
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const current = draftRef.current;
    const element = layerRef.current;
    if (!current || !element) return;
    const point = localPoint(event, element);
    if (current.type === 'pen') {
      current.points.push(point.x, point.y);
    } else {
      current.points[2] = point.x;
      current.points[3] = point.y;
    }
    setDraft({ ...current, points: [...current.points] });
  }

  function finishStroke(event: ReactPointerEvent<SVGSVGElement>) {
    const current = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (!current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (current.type === 'pen') {
      const points = simplifyPoints(current.points);
      if (points.length >= 4) {
        onAdd({
          id: newAnnotationId(),
          type: 'pen',
          page,
          // A pen stroke always uses a pen colour; if a highlight colour is selected
          // (for example right after switching tools) fall back to the default ink.
          color: penColorFor(color),
          points,
          width: 2.4,
        });
      }
      return;
    }
    const rect = rectFromPoints(current.start.x, current.start.y, current.points[2], current.points[3]);
    if (!rect) return;
    onAdd({
      id: newAnnotationId(),
      type: current.type,
      page,
      color,
      rect,
      width: strokeWidth,
    });
  }

  function placeNote(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drawingEnabled || tool !== 'note') return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    const annotation = { id: newAnnotationId(), type: 'note' as const, page, color, x, y, text: '' };
    onAdd(annotation);
    setEditingNote({ id: annotation.id, x, y, draft: '' });
  }

  function closeNoteEditor(save: boolean) {
    const editing = editingNote;
    setEditingNote(null);
    if (!editing) return;
    const text = editing.draft.trim();
    if (!text) {
      // An empty sticky note is not worth keeping.
      onErase(editing.id);
      return;
    }
    if (save) onUpdateNote(editing.id, text);
  }

  return (
    <>
      <svg
        ref={layerRef}
        className="pdf-annotation-layer"
        viewBox={`0 0 ${VIEW_BOX} ${VIEW_BOX}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        style={{
          touchAction: interactive ? 'none' : 'auto',
          cursor: drawingTool ? 'crosshair' : tool === 'eraser' ? 'cell' : 'default',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={() => { draftRef.current = null; setDraft(null); }}
      >
        {pageAnnotations.map((annotation) => {
          const eraseProps = tool === 'eraser'
            ? { onPointerDown: (event: ReactPointerEvent) => { event.stopPropagation(); onErase(annotation.id); } }
            : {};
          if (annotation.type === 'highlight') {
            return (
              <g key={annotation.id} {...eraseProps}>
                {annotation.rects.map((rect, index) => (
                  <rect
                    key={index}
                    x={rect.x * VIEW_BOX}
                    y={rect.y * VIEW_BOX}
                    width={rect.w * VIEW_BOX}
                    height={rect.h * VIEW_BOX}
                    fill={colorHex(annotation.color)}
                    fillOpacity={0.34}
                    style={{ pointerEvents: tool === 'eraser' ? 'auto' : 'none' }}
                  />
                ))}
              </g>
            );
          }
          if (annotation.type === 'pen') {
            return (
              <path
                key={annotation.id}
                d={penPath(annotation.points)}
                fill="none"
                stroke={colorHex(annotation.color)}
                strokeWidth={annotation.width}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: tool === 'eraser' ? 'stroke' : 'none' }}
                {...eraseProps}
              />
            );
          }
          if (annotation.type === 'rect') {
            return (
              <rect
                key={annotation.id}
                x={annotation.rect.x * VIEW_BOX}
                y={annotation.rect.y * VIEW_BOX}
                width={annotation.rect.w * VIEW_BOX}
                height={annotation.rect.h * VIEW_BOX}
                fill="none"
                stroke={colorHex(annotation.color)}
                strokeWidth={annotation.width}
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: tool === 'eraser' ? 'auto' : 'none' }}
                {...eraseProps}
              />
            );
          }
          if (annotation.type === 'ellipse') {
            return (
              <ellipse
                key={annotation.id}
                cx={(annotation.rect.x + annotation.rect.w / 2) * VIEW_BOX}
                cy={(annotation.rect.y + annotation.rect.h / 2) * VIEW_BOX}
                rx={(annotation.rect.w / 2) * VIEW_BOX}
                ry={(annotation.rect.h / 2) * VIEW_BOX}
                fill="none"
                stroke={colorHex(annotation.color)}
                strokeWidth={annotation.width}
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: tool === 'eraser' ? 'auto' : 'none' }}
                {...eraseProps}
              />
            );
          }
          return null;
        })}

        {draft && draft.type === 'pen' && (
          <path
            d={penPath(draft.points)}
            fill="none"
            stroke={colorHex(color)}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: 'none' }}
          />
        )}
        {draft && draft.type !== 'pen' && (() => {
          const rect: NormRect | null = rectFromPoints(draft.start.x, draft.start.y, draft.points[2], draft.points[3]);
          if (!rect) return null;
          const common = {
            fill: 'none',
            stroke: colorHex(color),
            strokeWidth: strokeWidth,
            strokeDasharray: '7 5',
            vectorEffect: 'non-scaling-stroke' as const,
            style: { pointerEvents: 'none' as const },
          };
          return draft.type === 'rect' ? (
            <rect x={rect.x * VIEW_BOX} y={rect.y * VIEW_BOX} width={rect.w * VIEW_BOX} height={rect.h * VIEW_BOX} {...common} />
          ) : (
            <ellipse
              cx={(rect.x + rect.w / 2) * VIEW_BOX}
              cy={(rect.y + rect.h / 2) * VIEW_BOX}
              rx={(rect.w / 2) * VIEW_BOX}
              ry={(rect.h / 2) * VIEW_BOX}
              {...common}
            />
          );
        })()}
      </svg>

      {/* Sticky-note markers live in a plain HTML layer so they stay round at any page size. */}
      {drawingEnabled && tool === 'note' && (
        <div className="pdf-note-catcher" style={{ touchAction: 'none' }} onPointerDown={placeNote} />
      )}

      {notes.map((note) => {
        if (note.type !== 'note') return null;
        const editing = editingNote?.id === note.id;
        return (
          <div key={note.id} className="pdf-note-anchor" style={{ left: `${note.x * 100}%`, top: `${note.y * 100}%` }}>
            <button
              type="button"
              className={`pdf-note-marker ${editing ? 'is-editing' : ''}`}
              style={{ background: colorHex(note.color) }}
              title={note.text || 'Empty note'}
              aria-label={note.text ? `Sticky note: ${note.text}` : 'Empty sticky note'}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                if (tool === 'eraser') { onErase(note.id); return; }
                if (!drawingEnabled) return;
                setEditingNote({ id: note.id, x: note.x, y: note.y, draft: note.text });
              }}
            />
            {editing && (
              <div className="pdf-note-editor" data-escape-stop onPointerDown={(event) => event.stopPropagation()}>
                <textarea
                  autoFocus
                  value={editingNote.draft}
                  placeholder="Type your note…"
                  onChange={(event) => setEditingNote({ ...editingNote, draft: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') { event.preventDefault(); closeNoteEditor(false); }
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); closeNoteEditor(true); }
                  }}
                />
                <div className="pdf-note-editor-actions">
                  <button type="button" className="pdf-note-save" onClick={() => closeNoteEditor(true)}>Save note</button>
                  <button type="button" className="pdf-note-remove" onClick={() => closeNoteEditor(false)} title="Discard"><Trash2 size={13} /></button>
                  <button type="button" className="pdf-note-close" onClick={() => closeNoteEditor(false)} aria-label="Close note"><X size={13} /></button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
