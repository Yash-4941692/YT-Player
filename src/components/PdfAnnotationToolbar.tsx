import { Circle, Eraser, Highlighter, MousePointer2, PenLine, Redo2, Save, Square, StickyNote, Trash2, Undo2 } from 'lucide-react';
import {
  ALL_COLORS, HIGHLIGHT_WIDTH_PRESETS, PEN_WIDTH_PRESETS,
  type AnnotationColor, type AnnotationTool,
} from '../lib/annotations';

interface Props {
  tool: AnnotationTool;
  color: AnnotationColor;
  strokeWidth: number;
  guest: boolean;
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  wordHighlights: boolean;
  canSave: boolean;
  savedAt?: number | null;
  onToolChange: (tool: AnnotationTool) => void;
  onColorChange: (color: AnnotationColor) => void;
  onStrokeWidthChange: (width: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onClearAll: () => void;
}

const TOOLS: { id: AnnotationTool; label: string; hint: string; Icon: typeof PenLine }[] = [
  { id: 'select', label: 'Select', hint: 'Select and scroll — reading mode', Icon: MousePointer2 },
  { id: 'highlight', label: 'Highlight / Marker', hint: 'Drag to draw with the marker or select text to highlight', Icon: Highlighter },
  { id: 'pen', label: 'Pen', hint: 'Draw freehand with adjustable width', Icon: PenLine },
  { id: 'rect', label: 'Rectangle', hint: 'Drag to draw a box', Icon: Square },
  { id: 'ellipse', label: 'Ellipse', hint: 'Drag to draw an oval', Icon: Circle },
  { id: 'note', label: 'Note', hint: 'Tap to add a text note', Icon: StickyNote },
  { id: 'eraser', label: 'Eraser', hint: 'Tap or drag across an annotation to delete it', Icon: Eraser },
];

function timeLabel(timestamp?: number | null): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function PdfAnnotationToolbar({
  tool, color, strokeWidth, guest, dirty, saving, canUndo, canRedo, wordHighlights, canSave, savedAt,
  onToolChange, onColorChange, onStrokeWidthChange, onUndo, onRedo, onSave, onClearAll,
}: Props) {
  const isHighlight = tool === 'highlight';
  const widthPresets = isHighlight ? HIGHLIGHT_WIDTH_PRESETS : PEN_WIDTH_PRESETS;
  const minWidth = isHighlight ? 4 : 1;
  const maxWidth = isHighlight ? 36 : 24;

  return (
    <div className="pdf-annotate-bar" role="toolbar" aria-label="PDF annotation tools">
      <div className="pdf-annotate-tools" role="group" aria-label="Drawing tools">
        {TOOLS.map(({ id, label, hint, Icon }) => (
          <button
            key={id}
            type="button"
            className={`pdf-annotate-tool ${tool === id ? 'is-active' : ''}`}
            onClick={() => onToolChange(id)}
            title={`${label} — ${hint}`}
            aria-label={`${label} — ${hint}`}
            aria-pressed={tool === id}
          >
            <Icon size={15} />
          </button>
        ))}
      </div>

      <div className="pdf-annotate-colors" role="group" aria-label="Marker and pen colour">
        {ALL_COLORS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`pdf-annotate-color ${color === entry.id ? 'is-active' : ''}`}
            style={{ background: entry.hex }}
            onClick={() => onColorChange(entry.id)}
            title={entry.label}
            aria-label={`Colour: ${entry.label}`}
            aria-pressed={color === entry.id}
          />
        ))}
      </div>

      <div className="pdf-annotate-widths" role="group" aria-label="Marker and stroke width">
        {widthPresets.map((preset, index) => {
          const dotSize = 5 + index * 3;
          const active = strokeWidth === preset.width;
          return (
            <button
              key={preset.width}
              type="button"
              className={`pdf-annotate-width-btn ${active ? 'is-active' : ''}`}
              onClick={() => onStrokeWidthChange(preset.width)}
              title={preset.label}
              aria-label={`Marker width ${preset.label}`}
              aria-pressed={active}
            >
              <span
                className="pdf-annotate-width-dot"
                style={{ width: `${dotSize}px`, height: `${dotSize}px` }}
              />
            </button>
          );
        })}
        <label className="pdf-annotate-width-slider-wrap" title={`Marker width: ${strokeWidth}px`}>
          <span className="sr-only">Marker width in pixels</span>
          <input
            type="range"
            className="pdf-annotate-width-slider"
            min={minWidth}
            max={maxWidth}
            step={1}
            value={Math.min(maxWidth, Math.max(minWidth, strokeWidth))}
            onChange={(event) => onStrokeWidthChange(Number(event.target.value))}
            aria-label="Adjust marker width"
          />
          <span className="pdf-annotate-width-value">{strokeWidth}px</span>
        </label>
      </div>

      <div className="pdf-annotate-actions">
        <button type="button" className="pdf-annotate-action" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl/Cmd+Z)" aria-label="Undo">
          <Undo2 size={15} />
        </button>
        <button type="button" className="pdf-annotate-action" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl/Cmd+Shift+Z or Ctrl+Y)" aria-label="Redo">
          <Redo2 size={15} />
        </button>
        <button type="button" className="pdf-annotate-action is-danger" onClick={onClearAll} title="Clear every annotation on this PDF" aria-label="Clear all annotations">
          <Trash2 size={15} />
        </button>
      </div>

      <div className="pdf-annotate-save">
        <span className={`pdf-annotate-status ${dirty ? 'is-dirty' : 'is-saved'}`} role="status">
          <span className="pdf-annotate-dot" style={{ background: dirty ? '#ffb18c' : '#83e4c0' }} />
          {saving ? 'Saving…' : dirty ? 'Unsaved changes' : `Saved${savedAt ? ` ${timeLabel(savedAt)}` : ''}`}
        </span>
        <button
          type="button"
          className="button-primary pdf-annotate-save-button"
          onClick={onSave}
          disabled={saving || !dirty || !canSave}
          title={!canSave ? 'Sign in to save annotations to your account' : 'Save annotations'}
        >
          <Save size={14} /> Save
        </button>
      </div>

      <p className="pdf-annotate-hint">
        {guest
          ? 'Guest mode: annotations are saved in this browser. Sign in to sync them across devices.'
          : isHighlight
            ? `Marker width: ${strokeWidth}px · Drag to highlight with the marker (hold Shift for a box)${wordHighlights ? ', or select text first and tap Highlight.' : '.'}`
            : `Width: ${strokeWidth}px · Pick a preset dot or slide to adjust marker and stroke thickness.`}
        {!canSave && ' Sign in to save annotations across devices.'}
      </p>
    </div>
  );
}
