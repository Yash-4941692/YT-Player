import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cloud, HardDrive, Info, X } from 'lucide-react';
import { PdfViewer, type PdfAnnotationBridge } from './PdfViewer';
import { pdfTitle } from '../lib/pdfLibrary';
import { loadAnnotationCache, nextRevisionStamp, saveAnnotationCache, type AnnotationCacheEntry } from '../lib/storage';
import { useDialog } from '../lib/useDialog';
import {
  DEFAULT_HIGHLIGHT, DEFAULT_HIGHLIGHT_WIDTH, DEFAULT_PEN, DEFAULT_PEN_WIDTH,
  isHighlightColor, normalizeDocument, useAnnotationHistory, useAnnotationShortcuts,
  type Annotation, type AnnotationColor, type AnnotationDocument, type AnnotationTool,
} from '../lib/annotations';
import {
  fetchCloudAnnotations, isMissingTableError, saveCloudAnnotations, subscribeCloudAnnotations,
  type AnnotationScope,
} from '../lib/supabase';
import type { LibraryPdf } from '../types';

/**
 * How long the reader waits after the last change before pushing annotations to the account.
 * Long enough that a whole stroke or note is written once, short enough that a change made
 * here is on the other device almost immediately.
 */
const AUTOSAVE_DELAY_MS = 1400;

/**
 * A cloud write that failed still leaves a valid browser copy. The message names the actual
 * fix (the usual cause is a migration the site owner has not run yet) instead of quietly
 * claiming everything synced, and says so when the save is being retried on its own.
 */
function annotationSyncHint(error: unknown, scope: AnnotationScope, retrying = false): string {
  if (isMissingTableError(error)) {
    return scope.kind === 'lesson'
      ? 'Saved in this browser only. Run supabase/migrations/006_lesson_annotations.sql in Supabase to sync lesson notes across devices.'
      : 'Saved in this browser only. Run supabase/migrations/003_pdf_annotations.sql in Supabase to sync annotations across devices.';
  }
  const detail = error instanceof Error ? error.message : '';
  const tail = detail ? ` (${detail})` : '';
  return retrying
    ? `Saved in this browser only — still trying to reach your account${tail}.`
    : `Saved in this browser only — the account copy could not be updated${tail}.`;
}

/**
 * Wait times between automatic retries of a failed account write. Short enough that a minute
 * of flaky connection does not need user action, long enough not to hammer a project that is
 * genuinely not reachable; after the last wait the save waits for the next edit, focus,
 * "online" event or Save press instead.
 */
const SAVE_RETRY_DELAYS_MS = [1500, 4000, 10000, 20000, 30000];

export interface PdfAnnotationController {
  bridge: PdfAnnotationBridge;
  dirtyRef: React.MutableRefObject<boolean>;
  annotateStatus: string;
  wordHighlights: boolean;
  /** Push any pending changes now (used when the reader is closed). */
  flush: () => void;
}

/**
 * Owns one PDF's annotations: the editor state, this browser's copy and the account copy.
 *
 * Sync rules, in order of importance:
 * 1. Every change is written to this browser immediately, so nothing is ever lost.
 * 2. Changes are pushed to the account automatically (a short debounce, plus a flush when
 *    the reader closes, the tab is hidden or the page goes away) — no Save button required.
 * 3. On open, the newest copy wins: local changes the account has not seen are pushed up,
 *    otherwise the account copy is loaded. That makes deletions and clears sync too.
 * 4. A live subscription (plus a refetch when the tab regains focus) brings in changes made
 *    on another device while this PDF is open.
 */
export function usePdfAnnotationController({
  cacheKey,
  libraryPdfId = null,
  lessonVideoId = null,
  isGuest,
  userId,
  shortcutsEnabled = true,
}: {
  /** Local storage key for this PDF (`<library id>` or `lesson:<video id>`). */
  cacheKey: string | null;
  /** Set when the PDF is a row in the account's PDF library. */
  libraryPdfId?: string | null;
  /** Set when the PDF is the notes attachment of one lesson. */
  lessonVideoId?: string | null;
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

  /** Where this PDF's annotations live in the account, or null when there is no account copy. */
  const scope = useMemo<AnnotationScope | null>(() => {
    if (!cacheKey || isGuest || !userId) return null;
    if (libraryPdfId) return { kind: 'library', pdfId: libraryPdfId };
    if (lessonVideoId) return { kind: 'lesson', videoId: lessonVideoId };
    return null;
  }, [cacheKey, isGuest, libraryPdfId, lessonVideoId, userId]);
  const scopeKey = scope ? `${scope.kind}:${scope.kind === 'library' ? scope.pdfId : scope.videoId}` : '';

  // The save path runs from timers and page events, so it reads everything through refs and
  // always writes the newest document.
  const historyRef = useRef(history);
  historyRef.current = history;
  const cacheKeyRef = useRef<string | null>(cacheKey);
  cacheKeyRef.current = cacheKey;
  const scopeRef = useRef<AnnotationScope | null>(scope);
  scopeRef.current = scope;
  const userIdRef = useRef<string | null>(userId);
  userIdRef.current = userId;
  const localOnlyNote = isGuest
    ? 'Saved in this browser. Sign in to sync annotations across devices.'
    : 'Saved in this browser only — this PDF is not in your account yet.';
  const localOnlyNoteRef = useRef(localOnlyNote);
  localOnlyNoteRef.current = localOnlyNote;

  const cacheRef = useRef<AnnotationCacheEntry | null>(null);
  const savingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  /** Changes made in this browser, and the revision already written out. */
  const revisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  /** True when a save was asked for while another one was still running. */
  const queuedSaveRef = useRef(false);
  /** Automatic retries of a write that failed, so a flaky moment heals itself. */
  const retryTimerRef = useRef<number | null>(null);
  const retryAttemptRef = useRef(0);
  /** "Clear all" is the one destructive action that waits for an explicit Save or Undo. */
  const holdAutoSaveRef = useRef(false);
  const persistRef = useRef<(options?: { force?: boolean }) => void>(() => undefined);
  const scheduleRef = useRef<(delay?: number) => void>(() => undefined);
  const retryRef = useRef<() => void>(() => undefined);

  const schedule = useCallback((delay = AUTOSAVE_DELAY_MS) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      persistRef.current();
    }, delay);
  }, []);
  scheduleRef.current = schedule;

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  /**
   * A failed write keeps being retried by itself. Waiting for the next edit is not enough:
   * a tab left open after a dropped connection, a sleep/wake on a phone, or a token being
   * refreshed would otherwise sit on "Unsaved changes" until the user happened to draw again.
   */
  const scheduleRetry = useCallback(() => {
    clearRetry();
    const attempt = retryAttemptRef.current;
    if (attempt >= SAVE_RETRY_DELAYS_MS.length) return;
    retryAttemptRef.current = attempt + 1;
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      persistRef.current();
    }, SAVE_RETRY_DELAYS_MS[attempt]);
  }, [clearRetry]);
  retryRef.current = scheduleRetry;

  /** Write the current document to this browser, and to the account when there is one. */
  const persist = useCallback(async (options?: { force?: boolean }) => {
    const key = cacheKeyRef.current;
    if (!key) return;
    // A save for this PDF is already running: remember that another one was asked for so the
    // newest document (and an explicit Save press) can never be dropped on the floor.
    if (savingRef.current) {
      queuedSaveRef.current = true;
      return;
    }
    const unsaved = revisionRef.current !== savedRevisionRef.current || Boolean(cacheRef.current?.pending);
    if (!unsaved && !options?.force) return;

    const revision = revisionRef.current;
    const document: AnnotationDocument = { version: 1, annotations: historyRef.current.annotations };
    const target = scopeRef.current;
    const owner = userIdRef.current;
    // The revision this write carries: always newer than anything this device has seen, so a
    // device whose clock is off can never make its own drawing look older than the stored one.
    const stamp = nextRevisionStamp(cacheRef.current);
    const entry: AnnotationCacheEntry = {
      data: document,
      localUpdatedAt: stamp,
      cloudUpdatedAt: cacheRef.current?.cloudUpdatedAt ?? 0,
      pending: Boolean(target),
    };
    cacheRef.current = entry;
    saveAnnotationCache(key, entry);

    if (!target || !owner) {
      // No account copy to write: the browser copy above is the whole story.
      savedRevisionRef.current = revision;
      historyRef.current.markSaved(document.annotations);
      setSavedAt(stamp);
      setAnnotateStatus(localOnlyNoteRef.current);
      return;
    }

    savingRef.current = true;
    setSaving(true);
    let succeeded = false;
    try {
      const updatedAt = await saveCloudAnnotations(owner, target, document, stamp);
      succeeded = true;
      if (cacheKeyRef.current === key) {
        // This write landed last, so its stamp is the revision the account now holds. A newer
        // write from another device arrives as a realtime event or on the next re-read.
        const saved: AnnotationCacheEntry = { ...entry, pending: false, cloudUpdatedAt: updatedAt };
        cacheRef.current = saved;
        saveAnnotationCache(key, saved);
        savedRevisionRef.current = revision;
        // Mark only the document that was actually written: edits made while this save was
        // running are still unsaved and must be written next.
        historyRef.current.markSaved(document.annotations);
        setSavedAt(updatedAt);
        setAnnotateStatus('');
        retryAttemptRef.current = 0;
        clearRetry();
      }
    } catch (error) {
      if (cacheKeyRef.current === key) {
        // Say that a retry is coming while there is one left; after that the next edit, focus,
        // "online" event or Save press is what pushes the document again.
        const stillRetrying = retryAttemptRef.current < SAVE_RETRY_DELAYS_MS.length;
        setAnnotateStatus(annotationSyncHint(error, target, stillRetrying));
      }
      // The browser copy above is already saved; the retry below pushes it again.
    } finally {
      savingRef.current = false;
      setSaving(false);
      if (cacheKeyRef.current === key) {
        const stillUnsaved = revisionRef.current !== savedRevisionRef.current;
        const queued = queuedSaveRef.current;
        queuedSaveRef.current = false;
        if (!succeeded) {
          retryRef.current();
        } else if (queued) {
          persistRef.current({ force: true });
        } else if (stillUnsaved) {
          // Edits landed while this save was running: write those too.
          scheduleRef.current(AUTOSAVE_DELAY_MS);
        }
      } else {
        queuedSaveRef.current = false;
      }
    }
  }, [clearRetry]);
  persistRef.current = (options) => { void persist(options); };

  /** Bring in a copy that was saved somewhere else without disturbing unsaved local work. */
  const applyRemote = useCallback((document: AnnotationDocument, updatedAt: number, note = '') => {
    const key = cacheKeyRef.current;
    if (!key) return;
    if (revisionRef.current !== savedRevisionRef.current) return; // local edits win, they are pushed next
    const knownCloudUpdatedAt = cacheRef.current?.cloudUpdatedAt ?? 0;
    if (updatedAt < knownCloudUpdatedAt) return; // an older revision: this browser is ahead
    if (updatedAt === knownCloudUpdatedAt) {
      // Same revision. Two devices can build the same stamp if both of their clocks sit
      // behind the last revision; adopting the account copy then makes both devices agree
      // instead of each keeping its own version of the same revision.
      const known = normalizeDocument(cacheRef.current?.data).annotations;
      if (JSON.stringify(known) === JSON.stringify(document.annotations)) return;
    }
    historyRef.current.replaceAll(document.annotations);
    savedRevisionRef.current = revisionRef.current;
    const entry: AnnotationCacheEntry = {
      data: document,
      localUpdatedAt: updatedAt,
      cloudUpdatedAt: updatedAt,
      pending: false,
    };
    cacheRef.current = entry;
    saveAnnotationCache(key, entry);
    setSavedAt(updatedAt);
    if (note) setAnnotateStatus(note);
  }, []);

  const refreshFromCloud = useCallback(async () => {
    const target = scopeRef.current;
    const owner = userIdRef.current;
    const key = cacheKeyRef.current;
    if (!target || !owner || !key) return;
    if (revisionRef.current !== savedRevisionRef.current || cacheRef.current?.pending) return;
    try {
      const record = await fetchCloudAnnotations(owner, target);
      if (!record || cacheKeyRef.current !== key) return;
      applyRemote(normalizeDocument(record.annotations), record.updatedAt, 'Updated from another device.');
    } catch {
      // Offline, or the migration has not been run: the browser copy keeps working.
    }
  }, [applyRemote]);

  // Load: this browser's copy appears instantly, then the account copy is reconciled in.
  useEffect(() => {
    revisionRef.current = 0;
    savedRevisionRef.current = 0;
    holdAutoSaveRef.current = false;
    queuedSaveRef.current = false;
    retryAttemptRef.current = 0;
    clearRetry();
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setAnnotateStatus('');
    setSavedAt(null);

    if (!cacheKey) {
      cacheRef.current = null;
      historyRef.current.replaceAll([]);
      return;
    }

    const cached = loadAnnotationCache(cacheKey);
    cacheRef.current = cached;
    const localDoc = normalizeDocument(cached?.data);
    historyRef.current.replaceAll(localDoc.annotations);
    if (cached?.cloudUpdatedAt || cached?.localUpdatedAt) {
      setSavedAt(cached.cloudUpdatedAt || cached.localUpdatedAt);
    }

    const target = scope;
    const owner = userId;
    if (!target || !owner) return; // Guest, or a PDF with no account copy: browser copy only.

    let cancelled = false;
    (async () => {
      try {
        const record = await fetchCloudAnnotations(owner, target);
        if (cancelled || cacheKeyRef.current !== cacheKey) return;
        if (!record) {
          // Nothing in the account yet. If this browser has drawings, send them up so they
          // can follow the account to every other device.
          if (localDoc.annotations.length > 0) {
            revisionRef.current += 1;
            persistRef.current();
          }
          return;
        }
        // This browser holds the newest copy when it has changes the account never confirmed
        // (pending), or when it has drawings for a PDF the account has never stored — for
        // example a guest who drew first and signed in afterwards.
        const localIsNewer = Boolean(
          cached
          && (cached.localUpdatedAt ?? 0) > record.updatedAt
          && (cached.pending || cached.cloudUpdatedAt === 0),
        );
        if (localIsNewer) {
          setSavedAt(record.updatedAt);
          setAnnotateStatus('Sending the changes you made on this device…');
          revisionRef.current += 1;
          persistRef.current();
          return;
        }
        if (cached?.cloudUpdatedAt === record.updatedAt) {
          setSavedAt(record.updatedAt); // This browser already holds exactly this version.
          return;
        }
        applyRemote(normalizeDocument(record.annotations), record.updatedAt);
      } catch (error) {
        if (cancelled) return;
        setAnnotateStatus(annotationSyncHint(error, target));
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, scopeKey, userId]);

  // Every change is kept in this browser straight away, so the debounced account save can
  // never be the difference between having a drawing and losing it.
  useEffect(() => {
    if (!cacheKey) return;
    if (revisionRef.current === savedRevisionRef.current) return;
    const entry: AnnotationCacheEntry = {
      data: { version: 1, annotations: history.annotations } as AnnotationDocument,
      // The same monotonic stamp the account write will carry, so a device whose clock is
      // behind can still tell that these unsaved edits are newer than the stored copy.
      localUpdatedAt: nextRevisionStamp(cacheRef.current),
      cloudUpdatedAt: cacheRef.current?.cloudUpdatedAt ?? 0,
      pending: Boolean(scopeRef.current),
    };
    cacheRef.current = entry;
    saveAnnotationCache(cacheKey, entry);
  }, [cacheKey, history.annotations]);

  // Live updates from another device (or another tab) while this PDF stays open.
  useEffect(() => {
    const target = scopeRef.current;
    if (!target || !userId) return;
    const unsubscribe = subscribeCloudAnnotations(userId, target, (change) => {
      if (!change) {
        void refreshFromCloud();
        return;
      }
      applyRemote(normalizeDocument(change.annotations), change.updatedAt, 'Updated from another device.');
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, userId, applyRemote, refreshFromCloud]);

  // Leaving the page, or coming back to it, must never surprise the user: flush what is
  // pending on the way out, and pull in anything that changed elsewhere on the way in.
  useEffect(() => {
    const flush = () => { persistRef.current(); };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
      else void refreshFromCloud();
    };
    const onFocus = () => { void refreshFromCloud(); };
    // Back online after a dropped connection: write the pending document straight away
    // instead of waiting for the retry timer, and pull in anything missed meanwhile.
    const onOnline = () => {
      retryAttemptRef.current = 0;
      flush();
      void refreshFromCloud();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, [refreshFromCloud]);

  // Closing the reader (or switching to another PDF) writes out whatever is still pending.
  useEffect(() => () => { persistRef.current(); }, []);

  const markChanged = useCallback(() => {
    revisionRef.current += 1;
    if (holdAutoSaveRef.current) return;
    scheduleRef.current(AUTOSAVE_DELAY_MS);
  }, []);

  const addAnnotation = useCallback((annotation: Annotation) => {
    holdAutoSaveRef.current = false;
    historyRef.current.add(annotation);
    markChanged();
  }, [markChanged]);

  const eraseAnnotation = useCallback((id: string) => {
    holdAutoSaveRef.current = false;
    historyRef.current.erase(id);
    markChanged();
  }, [markChanged]);

  const updateNote = useCallback((id: string, text: string) => {
    holdAutoSaveRef.current = false;
    historyRef.current.updateNote(id, text);
    markChanged();
  }, [markChanged]);

  const undo = useCallback(() => {
    if (!historyRef.current.canUndo) return;
    holdAutoSaveRef.current = false;
    historyRef.current.undo();
    markChanged();
  }, [markChanged]);

  const redo = useCallback(() => {
    if (!historyRef.current.canRedo) return;
    holdAutoSaveRef.current = false;
    historyRef.current.redo();
    markChanged();
  }, [markChanged]);

  const clearAll = useCallback(() => {
    if (historyRef.current.annotations.length === 0) return;
    holdAutoSaveRef.current = true;
    historyRef.current.clearAll();
    revisionRef.current += 1;
    setAnnotateStatus('Cleared all annotations — press Undo (Ctrl/Cmd+Z) to bring them back, or Save to keep this.');
  }, []);

  /** The Save button: write now, without waiting for the debounce. */
  const saveNow = useCallback(() => {
    holdAutoSaveRef.current = false;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    persistRef.current({ force: true });
  }, []);

  // Undo/redo also changes the document, so it goes through the same sync path.
  useAnnotationShortcuts({ undo, redo, enabled: shortcutsEnabled && Boolean(cacheKey) });

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
    onAdd: addAnnotation,
    onErase: eraseAnnotation,
    onUpdateNote: updateNote,
    onUndo: undo,
    onRedo: redo,
    onSave: saveNow,
    onClearAll: clearAll,
    onTextLayerChange: setWordHighlights,
  };

  return { bridge, dirtyRef, annotateStatus, wordHighlights, flush: saveNow };
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
  const { bridge, dirtyRef, annotateStatus, wordHighlights, flush } = usePdfAnnotationController({
    cacheKey: item.id,
    // A guest upload has no library row until it is moved into the account on sign-in.
    libraryPdfId: item.sessionOnly ? null : item.id,
    lessonVideoId: null,
    isGuest,
    userId,
    shortcutsEnabled: true,
  });
  /** True while the account copy could not be written, so the footer never overclaims. */
  const browserOnly = annotateStatus.startsWith('Saved in this browser');

  function requestClose() {
    if (dirtyRef.current) flush();
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
            : browserOnly
              ? <><HardDrive size={13} /> Saved in this browser for now — this PDF is not reaching your account yet.</>
              : <><Cloud size={13} /> Annotations save themselves to your account and appear on every device.</>}
          {!wordHighlights && <span><Info size={13} /> Drag with the Highlight / Marker tool to highlight anywhere on this PDF.</span>}
          {annotateStatus && <span className="pdf-library-modal-foot-note">{annotateStatus}</span>}
        </p>
      </section>
    </div>
  );
}
