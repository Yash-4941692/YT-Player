import { useCallback, useEffect, useRef, useState } from 'react';
import { Cloud, HardDrive, Info, X } from 'lucide-react';
import { PdfViewer, type PdfAnnotationBridge } from './PdfViewer';
import { pdfTitle } from '../lib/pdfLibrary';
import { useDialog } from '../lib/useDialog';
import {
  DEFAULT_HIGHLIGHT, DEFAULT_PEN, normalizeDocument, useAnnotationHistory, useAnnotationShortcuts,
  type AnnotationColor, type AnnotationDocument, type AnnotationTool,
} from '../lib/annotations';
import { fetchPdfAnnotations, savePdfAnnotations } from '../lib/supabase';
import type { LibraryPdf } from '../types';

/**
 * Annotations made while browsing as a guest live here for the current tab only, keyed by
 * PDF id. Signing in is what makes them follow the account across devices.
 */
const guestAnnotationMemory = new Map<string, AnnotationDocument>();

interface Props {
  item: LibraryPdf;
  url: string;
  loading: boolean;
  busy: boolean;
  error: string;
  status: string;
  signedIn: boolean;
  /** The signed-in user id, or null for guests. */
  userId?: string | null;
  onClose: () => void;
  onDownload: () => void;
  onDelete: () => void;
  /** Reports the page count of a PDF once it has been opened, so cards can show it. */
  onPageCount?: (pdfId: string, pageCount: number) => void;
}

export function PdfLibraryViewer({
  item, url, loading, busy, error, status, signedIn, userId = null, onClose, onDownload, onDelete, onPageCount,
}: Props) {
  // Focus trap, Escape-to-close, body scroll lock and focus restore are shared with
  // the sign-in modal through this hook.
  const dialogRef = useDialog({ open: true, onClose: requestClose });

  const [tool, setTool] = useState<AnnotationTool>('select');
  const [color, setColor] = useState<AnnotationColor>(DEFAULT_HIGHLIGHT);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [annotateStatus, setAnnotateStatus] = useState('');
  const [wordHighlights, setWordHighlights] = useState(false);
  const history = useAnnotationHistory();
  const dirtyRef = useRef(history.dirty);
  dirtyRef.current = history.dirty;

  useAnnotationShortcuts({ undo: history.undo, redo: history.redo, enabled: true });

  const isGuest = Boolean(!signedIn || !userId || item.sessionOnly);

  // Load this PDF's saved annotations (or the guest copy from earlier in this tab).
  useEffect(() => {
    let cancelled = false;
    setAnnotateStatus('');
    setSavedAt(null);
    if (isGuest) {
      const remembered = guestAnnotationMemory.get(item.id);
      history.replaceAll(remembered ? remembered.annotations : []);
      return;
    }
    (async () => {
      try {
        const record = await fetchPdfAnnotations(userId as string, item.id);
        if (cancelled) return;
        const document = normalizeDocument(record);
        history.replaceAll(document.annotations);
      } catch (problem) {
        if (cancelled) return;
        setAnnotateStatus(problem instanceof Error
          ? `Could not load saved annotations. ${problem.message}`
          : 'Could not load saved annotations.');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, isGuest]);

  // Guests: keep every change in memory so closing and reopening keeps the drawing.
  useEffect(() => {
    if (!isGuest) return;
    guestAnnotationMemory.set(item.id, { version: 1, annotations: history.annotations });
  }, [isGuest, item.id, history.annotations]);

  // Warn on a real page reload/close while annotations are unsaved.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  function requestClose() {
    if (dirtyRef.current && !window.confirm('You have unsaved annotations. Close without saving them?')) return;
    onClose();
  }

  const save = useCallback(async () => {
    const document: AnnotationDocument = { version: 1, annotations: history.annotations };
    if (isGuest) {
      guestAnnotationMemory.set(item.id, document);
      history.markSaved();
      setAnnotateStatus('Saved for this tab. Sign in to keep annotations across devices.');
      return;
    }
    setSaving(true);
    setAnnotateStatus('');
    try {
      const timestamp = await savePdfAnnotations(userId as string, item.id, document);
      history.markSaved();
      setSavedAt(timestamp);
      setAnnotateStatus('');
    } catch (problem) {
      setAnnotateStatus(problem instanceof Error
        ? `Could not save your annotations. ${problem.message}`
        : 'Could not save your annotations.');
    } finally {
      setSaving(false);
    }
  }, [history, isGuest, item.id, userId]);

  function clearAll() {
    if (history.annotations.length === 0) return;
    if (!window.confirm('Clear every highlight, drawing and note on this PDF? You can undo this with Ctrl/Cmd+Z until you save.')) return;
    history.clearAll();
  }

  // Pen colours are remembered separately from highlight colours.
  const lastPenRef = useRef<AnnotationColor>(DEFAULT_PEN);
  const lastHighlightRef = useRef<AnnotationColor>(DEFAULT_HIGHLIGHT);
  if (color === DEFAULT_PEN || color === 'black' || color === 'red' || color === 'blue') lastPenRef.current = color;
  if (color === DEFAULT_HIGHLIGHT || color === 'green' || color === 'pink') lastHighlightRef.current = color;

  function changeTool(next: AnnotationTool) {
    setTool(next);
    setColor(next === 'pen' ? lastPenRef.current : lastHighlightRef.current);
  }

  const bridge: PdfAnnotationBridge = {
    annotations: history.annotations,
    tool,
    color,
    dirty: history.dirty,
    saving,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    guest: isGuest,
    savedAt,
    canSave: true,
    onToolChange: changeTool,
    onColorChange: setColor,
    onAdd: history.add,
    onErase: history.erase,
    onUpdateNote: history.updateNote,
    onUndo: history.undo,
    onRedo: history.redo,
    onSave: () => { void save(); },
    onClearAll: clearAll,
    onTextLayerChange: setWordHighlights,
  };

  return (
    <div
      className="modal-backdrop pdf-library-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && requestClose()}
    >
      <section
        ref={dialogRef}
        className="pdf-library-modal glass-card"
        role="dialog"
        aria-modal="true"
        aria-label={`${pdfTitle(item.name)} — PDF reader`}
        tabIndex={-1}
      >
        <header className="pdf-library-modal-head">
          <span className={`subject-tag ${item.subject.toLowerCase().replace(/\s+/g, '-')}`}>{item.subject}</span>
          <h2 title={item.name}>{pdfTitle(item.name)}</h2>
          <button className="icon-button pdf-library-modal-close" onClick={requestClose} aria-label="Close PDF">
            <X size={18} />
          </button>
        </header>

        <PdfViewer
          url={url}
          name={item.name}
          size={item.size}
          cloud={!item.sessionOnly}
          uploading={busy || loading}
          error={error}
          status={status}
          locked={false}
          allowReplace={false}
          expanded
          annotations={bridge}
          onPageCount={(count) => onPageCount?.(item.id, count)}
          onPickFile={() => undefined}
          onFile={() => undefined}
          onRemove={onDelete}
          onDownload={onDownload}
          onSignIn={() => undefined}
          onToggleExpand={requestClose}
        />

        <p className="pdf-library-modal-foot">
          {isGuest
            ? <><HardDrive size={13} /> Annotations stay in this tab until you sign in.</>
            : <><Cloud size={13} /> Annotations are saved to your account and appear on every device.</>}
          {!wordHighlights && <span><Info size={13} /> Text highlighting falls back to a dragged box for this PDF.</span>}
          {annotateStatus && <span className="pdf-library-modal-foot-note">{annotateStatus}</span>}
        </p>
      </section>
    </div>
  );
}
