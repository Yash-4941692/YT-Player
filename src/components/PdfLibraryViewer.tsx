import { useCallback, useEffect, useRef, useState } from 'react';
import { Cloud, HardDrive, Info, X } from 'lucide-react';
import { PdfViewer, type PdfAnnotationBridge } from './PdfViewer';
import { pdfTitle } from '../lib/pdfLibrary';
import { loadLocalAnnotations, saveLocalAnnotations } from '../lib/storage';
import { useDialog } from '../lib/useDialog';
import {
  DEFAULT_HIGHLIGHT, DEFAULT_HIGHLIGHT_WIDTH, DEFAULT_PEN, DEFAULT_PEN_WIDTH,
  isHighlightColor, normalizeDocument, useAnnotationHistory, useAnnotationShortcuts,
  type AnnotationColor, type AnnotationDocument, type AnnotationTool,
} from '../lib/annotations';
import { fetchPdfAnnotations, savePdfAnnotations } from '../lib/supabase';
import type { LibraryPdf } from '../types';

/**
 * In-memory cache of annotations keyed by PDF id, backed by localStorage so annotations
 * survive page reloads even in guest mode or before cloud sync completes.
 */
const guestAnnotationMemory = new Map<string, AnnotationDocument>();

export interface PdfAnnotationController {
  bridge: PdfAnnotationBridge;
  dirtyRef: React.MutableRefObject<boolean>;
  annotateStatus: string;
  wordHighlights: boolean;
}

export function usePdfAnnotationController({
  pdfId,
  isGuest,
  userId,
  shortcutsEnabled = true,
}: {
  pdfId: string | null;
  isGuest: boolean;
  userId: string | null;
  shortcutsEnabled?: boolean;
}): PdfAnnotationController {
  const [tool, setTool] = useState<AnnotationTool>('select');
  const [color, setColor] = useState<AnnotationColor>(DEFAULT_HIGHLIGHT);
  const [strokeWidth, setStrokeWidth] = useState<number>(DEFAULT_PEN_WIDTH);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [annotateStatus, setAnnotateStatus] = useState('');
  const [wordHighlights, setWordHighlights] = useState(false);
  const history = useAnnotationHistory();
  const dirtyRef = useRef(history.dirty);
  dirtyRef.current = history.dirty;

  const lastPenColorRef = useRef<AnnotationColor>(DEFAULT_PEN);
  const lastHighlightColorRef = useRef<AnnotationColor>(DEFAULT_HIGHLIGHT);
  const lastPenWidthRef = useRef<number>(DEFAULT_PEN_WIDTH);
  const lastHighlightWidthRef = useRef<number>(DEFAULT_HIGHLIGHT_WIDTH);

  useAnnotationShortcuts({ undo: history.undo, redo: history.redo, enabled: shortcutsEnabled && Boolean(pdfId) });

  // Load saved annotations for this PDF (from localStorage/memory and cloud when signed in).
  useEffect(() => {
    if (!pdfId) {
      history.replaceAll([]);
      return;
    }
    let cancelled = false;
    setAnnotateStatus('');
    setSavedAt(null);

    const localRaw = guestAnnotationMemory.get(pdfId) ?? loadLocalAnnotations(pdfId);
    const localDoc = normalizeDocument(localRaw);
    history.replaceAll(localDoc.annotations);

    if (isGuest || !userId || pdfId.startsWith('lesson:')) {
      return;
    }

    (async () => {
      try {
        const record = await fetchPdfAnnotations(userId, pdfId);
        if (cancelled) return;
        if (record) {
          const cloudDoc = normalizeDocument(record.annotations ?? record);
          if (cloudDoc.annotations.length > 0 || localDoc.annotations.length === 0) {
            history.replaceAll(cloudDoc.annotations);
            saveLocalAnnotations(pdfId, cloudDoc);
            guestAnnotationMemory.set(pdfId, cloudDoc);
          }
          setSavedAt(record.updatedAt);
        }
      } catch {
        // If the optional pdf_annotations table is not set up yet, local storage keeps working.
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfId, isGuest, userId]);

  // Keep every change in memory and localStorage so closing/reloading never loses drawings.
  useEffect(() => {
    if (!pdfId) return;
    const doc: AnnotationDocument = { version: 1, annotations: history.annotations };
    guestAnnotationMemory.set(pdfId, doc);
    saveLocalAnnotations(pdfId, doc);
  }, [pdfId, history.annotations]);

  const save = useCallback(async () => {
    if (!pdfId) return;
    const document: AnnotationDocument = { version: 1, annotations: history.annotations };
    guestAnnotationMemory.set(pdfId, document);
    saveLocalAnnotations(pdfId, document);

    if (isGuest || !userId || pdfId.startsWith('lesson:')) {
      history.markSaved();
      setSavedAt(Date.now());
      setAnnotateStatus(isGuest
        ? 'Saved in this browser. Sign in to sync annotations across devices.'
        : 'Saved for this lesson.');
      return;
    }
    setSaving(true);
    setAnnotateStatus('');
    try {
      const timestamp = await savePdfAnnotations(userId, pdfId, document);
      history.markSaved();
      setSavedAt(timestamp);
      setAnnotateStatus('');
    } catch {
      // Even if the cloud table is missing, the local copy is already saved.
      history.markSaved();
      setSavedAt(Date.now());
      setAnnotateStatus('Saved in this browser.');
    } finally {
      setSaving(false);
    }
  }, [history, isGuest, pdfId, userId]);

  function clearAll() {
    if (history.annotations.length === 0) return;
    history.clearAll();
    setAnnotateStatus('Cleared all annotations — press Undo (Ctrl/Cmd+Z) to bring them back.');
  }

  function changeTool(next: AnnotationTool) {
    setTool(next);
    if (next === 'pen') {
      setColor(lastPenColorRef.current);
      setStrokeWidth(lastPenWidthRef.current);
    } else if (next === 'highlight') {
      setColor(lastHighlightColorRef.current);
      setStrokeWidth(lastHighlightWidthRef.current);
    } else if (next === 'rect' || next === 'ellipse') {
      setStrokeWidth(lastPenWidthRef.current);
    }
  }

  function changeColor(nextColor: AnnotationColor) {
    setColor(nextColor);
    if (tool === 'pen') {
      lastPenColorRef.current = nextColor;
    } else if (tool === 'highlight') {
      lastHighlightColorRef.current = nextColor;
    } else if (tool === 'select' || tool === 'eraser') {
      const nextTool: AnnotationTool = nextColor === 'black' || nextColor === 'red' ? 'pen' : 'highlight';
      setTool(nextTool);
      if (nextTool === 'pen') {
        lastPenColorRef.current = nextColor;
        setStrokeWidth(lastPenWidthRef.current);
      } else {
        lastHighlightColorRef.current = nextColor;
        setStrokeWidth(lastHighlightWidthRef.current);
      }
    }
  }

  function changeStrokeWidth(nextWidth: number) {
    const clamped = Math.max(1, Math.min(40, Math.round(nextWidth)));
    setStrokeWidth(clamped);
    if (tool === 'highlight') {
      lastHighlightWidthRef.current = clamped;
    } else if (tool === 'pen' || tool === 'rect' || tool === 'ellipse') {
      lastPenWidthRef.current = clamped;
    } else {
      // If the user adjusts marker width while on Select/Eraser/Note, switch to an active drawing tool immediately.
      const nextTool: AnnotationTool = clamped >= 10 && isHighlightColor(color) ? 'highlight' : 'pen';
      setTool(nextTool);
      if (nextTool === 'highlight') lastHighlightWidthRef.current = clamped;
      else lastPenWidthRef.current = clamped;
    }
  }

  const bridge: PdfAnnotationBridge = {
    annotations: history.annotations,
    tool,
    color,
    strokeWidth,
    dirty: history.dirty,
    saving,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    guest: isGuest,
    savedAt,
    canSave: true,
    onToolChange: changeTool,
    onColorChange: changeColor,
    onStrokeWidthChange: changeStrokeWidth,
    onAdd: history.add,
    onErase: history.erase,
    onUpdateNote: history.updateNote,
    onUndo: history.undo,
    onRedo: history.redo,
    onSave: () => { void save(); },
    onClearAll: clearAll,
    onTextLayerChange: setWordHighlights,
  };

  return { bridge, dirtyRef, annotateStatus, wordHighlights };
}

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
  const isGuest = Boolean(!signedIn || !userId || item.sessionOnly);
  const { bridge, dirtyRef, annotateStatus, wordHighlights } = usePdfAnnotationController({
    pdfId: item.id,
    isGuest,
    userId,
    shortcutsEnabled: true,
  });

  function requestClose() {
    if (dirtyRef.current) {
      bridge.onSave();
    }
    onClose();
  }

  const dialogRef = useDialog({ open: true, onClose: requestClose });

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
            ? <><HardDrive size={13} /> Annotations are saved in this browser. Sign in to sync across devices.</>
            : <><Cloud size={13} /> Annotations are saved to your account and appear on every device.</>}
          {!wordHighlights && <span><Info size={13} /> Drag with the Highlight / Marker tool to highlight anywhere on this PDF.</span>}
          {annotateStatus && <span className="pdf-library-modal-foot-note">{annotateStatus}</span>}
        </p>
      </section>
    </div>
  );
}
