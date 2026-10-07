import { Circle, Eraser, Highlighter, MousePointer2, PenLine, Redo2, Save, Square, StickyNote, Trash2, Undo2 } from 'lucide-react';
import { HIGHLIGHT_COLORS, PEN_COLORS, type AnnotationColor, type AnnotationTool } from '../lib/annotations';

interface Props {
  tool: AnnotationTool;
  color: AnnotationColor;
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
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onClearAll: () => void;
}

const TOOLS: { id: AnnotationTool; label: string; hint: string; Icon: typeof PenLine }[] = [
  { id: 'select', label: 'Select', hint: 'Select and scroll — reading mode', Icon: MousePointer2 },
  { id: 'highlight', label: 'Highlight', hint: 'Select text to highlight the words', Icon: Highlighter },
  { id: 'pen', label: 'Pen', hint: 'Draw freehand', Icon: PenLine },
  { id: 'rect', label: 'Rectangle', hint: 'Drag to draw a box', Icon: Square },
  { id: 'ellipse', label: 'Ellipse', hint: 'Drag to draw an oval', Icon: Circle },
  { id: 'note', label: 'Note', hint: 'Tap to add a text note', Icon: StickyNote },
  { id: 'eraser', label: 'Eraser', hint: 'Tap an annotation to delete it', Icon: Eraser },
];

function timeLabel(timestamp?: number | null): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function PdfAnnotationToolbar({
  tool, color, guest, dirty, saving, canUndo, canRedo, wordHighlights, canSave, savedAt,
  onToolChange, onColorChange, onUndo, onRedo, onSave, onClearAll,
}: Props) {
  const penSelected = tool === 'pen';
  const palette = penSelected ? PEN_COLORS : HIGHLIGHT_COLORS;

  return (
    <div className="pdf-annotate-bar" role="toolbar" aria-label="PDF annotation tools">
      <div className="pdf-annotate-tools">
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

      <div className="pdf-annotate-colors" role="group" aria-label={penSelected ? 'Pen colour' : 'Highlight colour'}>
        {palette.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`pdf-annotate-color ${color === entry.id ? 'is-active' : ''}`}
            style={{ background: entry.hex }}
            onClick={() => onColorChange(entry.id)}
            title={entry.label}
            aria-label={entry.label}
            aria-pressed={color === entry.id}
          />
        ))}
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
          ? 'Guest mode: annotations stay in this tab until you sign in.'
          : wordHighlights
            ? 'Highlight follows the text you select.'
            : 'Drag a box to highlight this PDF (it has no selectable text).'}
        {!canSave && ' Sign in to save annotations across devices.'}
      </p>
    </div>
  );
}
