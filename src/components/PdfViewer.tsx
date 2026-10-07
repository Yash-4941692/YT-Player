import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import {
  ArrowDownToLine, ChevronLeft, ChevronRight, Cloud, ExternalLink, FileText, Info, Loader,
  LockKeyhole, Maximize2, Minimize2, Trash2, Upload, ZoomIn, ZoomOut,
} from 'lucide-react';
import { formatBytes } from '../lib/utils';
import { PdfAnnotationOverlay } from './PdfAnnotationOverlay';
import { PdfAnnotationToolbar } from './PdfAnnotationToolbar';
import { highlightColorFor, newAnnotationId, type Annotation, type AnnotationColor, type AnnotationTool, type NormRect } from '../lib/annotations';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type LoadingTask = ReturnType<PdfJs['getDocument']>;
type PdfTextLayer = InstanceType<PdfJs['TextLayer']>;

let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfjs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ]).then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/** Merge selection rectangles that sit on the same text line into one box. */
function mergeLineRects(rects: NormRect[]): NormRect[] {
  const sorted = [...rects].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const merged: NormRect[] = [];
  for (const rect of sorted) {
    const previous = merged[merged.length - 1];
    const sameLine = previous
      && Math.abs((previous.y + previous.h / 2) - (rect.y + rect.h / 2)) < Math.max(previous.h, rect.h) * 0.6;
    const touching = previous && rect.x <= previous.x + previous.w + 0.02;
    if (previous && sameLine && touching) {
      const right = Math.max(previous.x + previous.w, rect.x + rect.w);
      const top = Math.min(previous.y, rect.y);
      const bottom = Math.max(previous.y + previous.h, rect.y + rect.h);
      previous.x = Math.min(previous.x, rect.x);
      previous.w = right - previous.x;
      previous.y = top;
      previous.h = bottom - top;
    } else {
      merged.push({ ...rect });
    }
  }
  return merged.filter((rect) => rect.w > 0.001 && rect.h > 0.001);
}

function canvasQuality(width: number, height: number): number {
  const device = Math.min(window.devicePixelRatio || 1, 2);
  const maxArea = 6_500_000;
  if (width * height * device * device <= maxArea) return device;
  return Math.max(1, Math.sqrt(maxArea / (width * height)));
}

const ZOOM_STEPS = [50, 75, 100, 125, 150, 175, 200, 250, 300];

/**
 * Everything the opt-in PDF annotation editor needs. When this prop is omitted the viewer
 * behaves EXACTLY as before: no text layer, no overlay, no annotation toolbar.
 * The lesson-notes viewer in the study room never passes it.
 */
export interface PdfAnnotationBridge {
  annotations: Annotation[];
  tool: AnnotationTool;
  color: AnnotationColor;
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  guest: boolean;
  savedAt?: number | null;
  canSave: boolean;
  onToolChange: (tool: AnnotationTool) => void;
  onColorChange: (color: AnnotationColor) => void;
  onAdd: (annotation: Annotation) => void;
  onErase: (id: string) => void;
  onUpdateNote: (id: string, text: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onClearAll: () => void;
  /** Reports whether this PDF has a real text layer (word-following highlights available). */
  onTextLayerChange?: (available: boolean) => void;
}

export interface PdfViewerProps {
  url: string;
  name: string;
  size: number;
  cloud: boolean;
  uploading: boolean;
  error: string;
  status: string;
  locked: boolean;
  expanded: boolean;
  /** Hide the "replace file" action (used when the PDF belongs to the library). */
  allowReplace?: boolean;
  /** Opt-in annotation editor. Omit it (the default) to keep the plain reader. */
  annotations?: PdfAnnotationBridge | null;
  /** Optional: called once per loaded document with its page count. */
  onPageCount?: (count: number) => void;
  onPickFile: () => void;
  onFile: (file: File) => void;
  onRemove: () => void;
  onDownload: () => void;
  onSignIn: () => void;
  onToggleExpand: () => void;
}

export function PdfViewer({
  url, name, size, cloud, uploading, error, status, locked, expanded, allowReplace = true, annotations = null,
  onPageCount, onPickFile, onFile, onRemove, onDownload, onSignIn, onToggleExpand,
}: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesWrapRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef(new Map<number, HTMLDivElement>());
  const canvasesRef = useRef(new Map<number, HTMLCanvasElement>());
  const tasksRef = useRef(new Map<number, RenderTask>());
  const renderedRef = useRef(new Map<number, string>());
  const renderingRef = useRef(new Set<number>());
  const visibleRef = useRef(new Set<number>());
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const textLayerDivsRef = useRef(new Map<number, HTMLDivElement>());
  const textLayersRef = useRef(new Map<number, PdfTextLayer>());
  const textLayerPagesRef = useRef(new Set<number>());
  const [textLayerAvailable, setTextLayerAvailable] = useState(false);
  const zoomRef = useRef(100);
  const widthRef = useRef(600);
  const currentPageRef = useRef(1);

  const [viewerStatus, setViewerStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [loadError, setLoadError] = useState('');
  const [pageCount, setPageCount] = useState(0);
  const [aspect, setAspect] = useState(1.414);
  const [zoom, setZoom] = useState(100);
  const [layoutWidth, setLayoutWidth] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageDraft, setPageDraft] = useState('1');
  const [dragging, setDragging] = useState(false);

  zoomRef.current = zoom;
  if (layoutWidth) widthRef.current = layoutWidth;
  currentPageRef.current = currentPage;

  const annotationMode = Boolean(annotations);
  const pageCountCallbackRef = useRef(onPageCount);
  pageCountCallbackRef.current = onPageCount;
  const annotationBridgeRef = useRef(annotations);
  annotationBridgeRef.current = annotations;

  const resetView = useCallback(() => {
    tasksRef.current.forEach((task) => task.cancel());
    tasksRef.current.clear();
    canvasesRef.current.forEach((canvas) => {
      canvas.width = 0;
      canvas.height = 0;
    });
    renderedRef.current.clear();
    renderingRef.current.clear();
    visibleRef.current.clear();
    setPageCount(0);
    setCurrentPage(1);
    setPageDraft('1');
  }, []);

  // Load the document whenever the source URL changes.
  useEffect(() => {
    resetView();
    if (!url) {
      docRef.current = null;
      setViewerStatus('idle');
      setLoadError('');
      return;
    }
    let cancelled = false;
    let loadingTask: LoadingTask | null = null;
    setViewerStatus('loading');
    setLoadError('');
    (async () => {
      const pdfjs = await loadPdfjs();
      if (cancelled) return;
      loadingTask = pdfjs.getDocument({ url, isEvalSupported: false });
      const doc = await loadingTask.promise;
      if (cancelled) return;
      docRef.current = doc;
      const firstPage = await doc.getPage(1);
      const viewport = firstPage.getViewport({ scale: 1 });
      if (cancelled) return;
      setAspect(viewport.width / viewport.height);
      setPageCount(doc.numPages);
      pageCountCallbackRef.current?.(doc.numPages);
      setViewerStatus('ready');
    })().catch((problem: unknown) => {
      if (cancelled) return;
      setLoadError(problem instanceof Error ? problem.message : 'This PDF could not be opened.');
      setViewerStatus('error');
    });
    return () => {
      cancelled = true;
      docRef.current = null;
      void loadingTask?.destroy();
    };
  }, [url, resetView]);

  // Track the width available for a page so pages always fit the panel.
  useEffect(() => {
    const element = pagesWrapRef.current;
    if (!element) return;
    const update = () => setLayoutWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [url, viewerStatus]);

  /**
   * Build the invisible text layer for a page so (a) text can be selected and copied and
   * (b) highlighting can follow the words. Only used when annotation mode is on.
   */
  const renderTextLayer = useCallback(async (pageNumber: number, doc: PDFDocumentProxy) => {
    const container = textLayerDivsRef.current.get(pageNumber);
    if (!container || textLayersRef.current.has(pageNumber)) return;
    textLayerPagesRef.current.add(pageNumber);
    try {
      const pdfjs = await loadPdfjs();
      // The installed pdfjs-dist exports TextLayer; if a future version stops exporting it
      // this check keeps the viewer working with drag-a-rectangle highlighting instead.
      if (typeof pdfjs.TextLayer !== 'function') {
        setTextLayerAvailable(false);
        return;
      }
      if (docRef.current !== doc || !textLayerDivsRef.current.has(pageNumber)) return;
      const page = await doc.getPage(pageNumber);
      if (docRef.current !== doc) return;
      const base = page.getViewport({ scale: 1 });
      const cssWidth = container.parentElement?.clientWidth || widthRef.current || base.width;
      const viewport = page.getViewport({ scale: cssWidth / base.width });
      // --scale-factor is what pdf.js uses to place every glyph; it must match the CSS width.
      container.style.setProperty('--scale-factor', String(viewport.scale));
      const layer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container,
        viewport,
      });
      textLayersRef.current.set(pageNumber, layer);
      await layer.render();
      setTextLayerAvailable(true);
    } catch {
      // A PDF without a text layer (a scan, for example) simply falls back to box highlights.
      textLayersRef.current.delete(pageNumber);
      textLayerPagesRef.current.delete(pageNumber);
    }
  }, []);

  const dropTextLayer = useCallback((pageNumber: number) => {
    const layer = textLayersRef.current.get(pageNumber);
    if (layer) {
      try { layer.cancel(); } catch { /* already finished */ }
      textLayersRef.current.delete(pageNumber);
    }
    textLayerPagesRef.current.delete(pageNumber);
    const container = textLayerDivsRef.current.get(pageNumber);
    if (container) container.replaceChildren();
  }, []);

  // Render only the pages near the viewport (large PDFs stay smooth on phones).
  const renderVisiblePages = useCallback(async () => {
    const doc = docRef.current;
    if (!doc) return;
    const key = `${zoomRef.current}:${Math.round(widthRef.current)}`;
    const queue = [...visibleRef.current].sort((a, b) => a - b);
    for (const pageNumber of queue) {
      if (renderingRef.current.has(pageNumber) || docRef.current !== doc) continue;
      if (renderedRef.current.get(pageNumber) === key) continue;
      const canvas = canvasesRef.current.get(pageNumber);
      if (!canvas) continue;
      renderingRef.current.add(pageNumber);
      try {
        const page = await doc.getPage(pageNumber);
        if (docRef.current !== doc) return;
        const base = page.getViewport({ scale: 1 });
        const displayWidth = Math.max(140, widthRef.current * (zoomRef.current / 100));
        const viewport = page.getViewport({ scale: displayWidth / base.width });
        const quality = canvasQuality(viewport.width, viewport.height);
        canvas.width = Math.max(1, Math.floor(viewport.width * quality));
        canvas.height = Math.max(1, Math.floor(viewport.height * quality));
        const context = canvas.getContext('2d');
        if (!context) continue;
        tasksRef.current.get(pageNumber)?.cancel();
        const task = page.render({
          canvasContext: context,
          viewport,
          transform: quality !== 1 ? [quality, 0, 0, quality, 0, 0] : undefined,
        });
        tasksRef.current.set(pageNumber, task);
        await task.promise;
        if (docRef.current !== doc) return;
        renderedRef.current.set(pageNumber, key);
        if (annotationBridgeRef.current) void renderTextLayer(pageNumber, doc);
      } catch {
        // Rendering is cancelled whenever a page scrolls away or the zoom changes.
      } finally {
        renderingRef.current.delete(pageNumber);
      }
    }
  }, [renderTextLayer]);

  // Watch which pages are on screen.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || pageCount === 0) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const pageNumber = Number((entry.target as HTMLElement).dataset.page);
        if (!Number.isFinite(pageNumber)) continue;
        if (entry.isIntersecting) visibleRef.current.add(pageNumber);
        else visibleRef.current.delete(pageNumber);
      }
      void renderVisiblePages();
    }, { root, rootMargin: '900px 0px' });
    pagesRef.current.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [pageCount, renderVisiblePages, url]);

  // Re-render visible pages when the zoom level or available width changes.
  useEffect(() => {
    if (viewerStatus !== 'ready') return;
    const frame = window.requestAnimationFrame(() => { void renderVisiblePages(); });
    return () => window.cancelAnimationFrame(frame);
  }, [zoom, layoutWidth, viewerStatus, renderVisiblePages]);

  // The text layer's glyph positions depend on the page width, so rebuild them on resize.
  useEffect(() => {
    if (!annotationMode || viewerStatus !== 'ready') return;
    textLayerPagesRef.current.forEach((pageNumber) => dropTextLayer(pageNumber));
    const frame = window.requestAnimationFrame(() => { void renderVisiblePages(); });
    return () => window.cancelAnimationFrame(frame);
  }, [annotationMode, zoom, layoutWidth, viewerStatus, dropTextLayer, renderVisiblePages]);

  // Leaving annotation mode (or opening another PDF) removes every text layer again.
  useEffect(() => {
    if (annotationMode) return;
    textLayerPagesRef.current.forEach((pageNumber) => dropTextLayer(pageNumber));
    setTextLayerAvailable(false);
  }, [annotationMode, url, dropTextLayer]);

  useEffect(() => () => {
    textLayersRef.current.forEach((layer) => { try { layer.cancel(); } catch { /* done */ } });
    textLayersRef.current.clear();
    textLayerPagesRef.current.clear();
  }, []);

  // Keep the page indicator in sync with the scroll position.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || pageCount === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rootTop = root.getBoundingClientRect().top;
      const from = Math.max(1, currentPageRef.current - 30);
      const to = Math.min(pageCount, currentPageRef.current + 30);
      let best = currentPageRef.current;
      for (let pageNumber = from; pageNumber <= to; pageNumber += 1) {
        const element = pagesRef.current.get(pageNumber);
        if (element && element.getBoundingClientRect().top - rootTop <= 90) best = pageNumber;
      }
      setCurrentPage((value) => (value === best ? value : best));
    };
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      root.removeEventListener('scroll', onScroll);
    };
  }, [pageCount]);

  useEffect(() => { setPageDraft(String(currentPage)); }, [currentPage]);

  // Free canvases that are far behind/ahead so long PDFs stay light on phones.
  useEffect(() => {
    if (!pageCount) return;
    renderedRef.current.forEach((_key, pageNumber) => {
      if (Math.abs(pageNumber - currentPage) <= 8) return;
      tasksRef.current.get(pageNumber)?.cancel();
      tasksRef.current.delete(pageNumber);
      const canvas = canvasesRef.current.get(pageNumber);
      if (canvas && canvas.width) {
        canvas.width = 0;
        canvas.height = 0;
      }
      renderedRef.current.delete(pageNumber);
      if (pageNumber !== currentPage) dropTextLayer(pageNumber);
    });
  }, [currentPage, pageCount, dropTextLayer]);

  const jumpToPage = useCallback((pageNumber: number) => {
    const target = Math.min(Math.max(1, pageNumber), pageCount || 1);
    const element = pagesRef.current.get(target);
    const root = scrollRef.current;
    if (element && root) root.scrollTo({ top: element.offsetTop - 12, behavior: 'smooth' });
    setCurrentPage(target);
  }, [pageCount]);

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) onFile(file);
  }

  function stepZoom(direction: 1 | -1) {
    setZoom((value) => direction === 1
      ? ZOOM_STEPS.find((step) => step > value) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
      : [...ZOOM_STEPS].reverse().find((step) => step < value) ?? ZOOM_STEPS[0]);
  }

  useEffect(() => {
    annotations?.onTextLayerChange?.(textLayerAvailable);
  }, [textLayerAvailable, annotations]);

  /**
   * Turn the current text selection into highlight boxes: each selection rectangle is
   * clipped to the page it sits on and stored as a normalised rect, so the highlight
   * follows the words at every zoom level. Rectangles on the same line are merged so a
   * sentence does not become dozens of tiny boxes.
   */
  const commitSelectionHighlight = useCallback(() => {
    const bridge = annotationBridgeRef.current;
    if (!bridge || bridge.tool !== 'highlight') return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const perPage = new Map<number, NormRect[]>();
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const clientRects = Array.from(selection.getRangeAt(index).getClientRects());
      for (const clientRect of clientRects) {
        if (clientRect.width < 2 || clientRect.height < 2) continue;
        pagesRef.current.forEach((element, pageNumber) => {
          const pageRect = element.getBoundingClientRect();
          if (pageRect.width === 0 || pageRect.height === 0) return;
          const left = Math.max(clientRect.left, pageRect.left);
          const top = Math.max(clientRect.top, pageRect.top);
          const right = Math.min(clientRect.right, pageRect.right);
          const bottom = Math.min(clientRect.bottom, pageRect.bottom);
          if (right - left < 2 || bottom - top < 2) return;
          const rect: NormRect = {
            x: (left - pageRect.left) / pageRect.width,
            y: (top - pageRect.top) / pageRect.height,
            w: (right - left) / pageRect.width,
            h: (bottom - top) / pageRect.height,
          };
          perPage.set(pageNumber, [...(perPage.get(pageNumber) ?? []), rect]);
        });
      }
    }
    if (perPage.size === 0) return;
    perPage.forEach((rects, pageNumber) => {
      const merged = mergeLineRects(rects);
      if (merged.length === 0) return;
      bridge.onAdd({
        id: newAnnotationId(),
        type: 'highlight',
        page: pageNumber,
        color: highlightColorFor(bridge.color),
        rects: merged,
        source: 'words',
      });
    });
    selection.removeAllRanges();
  }, []);

  // A selection anywhere in the reader becomes a highlight while the highlight tool is on.
  useEffect(() => {
    if (!annotations || annotations.tool !== 'highlight' || !textLayerAvailable) return;
    const onPointerUp = () => window.setTimeout(commitSelectionHighlight, 0);
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === 'Shift') window.setTimeout(commitSelectionHighlight, 0); };
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('keyup', onKeyUp);
    return () => {
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('keyup', onKeyUp);
    };
  }, [annotations, textLayerAvailable, commitSelectionHighlight]);

  const placeholderHeight = layoutWidth ? Math.round(((layoutWidth * zoom) / 100) / aspect) : 0;
  const pages = Array.from({ length: pageCount }, (_value, index) => index + 1);

  return (
    <div
      className={`pdf-viewer ${expanded ? 'is-expanded' : ''} ${dragging ? 'is-dragging' : ''} ${annotationMode ? 'is-annotating' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      {annotations && (
        <PdfAnnotationToolbar
          tool={annotations.tool}
          color={annotations.color}
          guest={annotations.guest}
          dirty={annotations.dirty}
          saving={annotations.saving}
          canUndo={annotations.canUndo}
          canRedo={annotations.canRedo}
          canSave={annotations.canSave}
          savedAt={annotations.savedAt}
          wordHighlights={textLayerAvailable}
          onToolChange={annotations.onToolChange}
          onColorChange={annotations.onColorChange}
          onUndo={annotations.onUndo}
          onRedo={annotations.onRedo}
          onSave={annotations.onSave}
          onClearAll={annotations.onClearAll}
        />
      )}

      <div className="pdf-toolbar">
        <span className="pdf-toolbar-name" title={name || 'Video notes'}>
          <FileText size={15} />
          <span>{name || 'Video notes'}</span>
        </span>
        <div className="pdf-toolbar-actions">
          {viewerStatus === 'ready' && pageCount > 0 && (
            <>
              <div className="pdf-control-group">
                <button type="button" onClick={() => jumpToPage(currentPage - 1)} disabled={currentPage <= 1} aria-label="Previous page"><ChevronLeft size={16} /></button>
                <input
                  className="pdf-page-input"
                  value={pageDraft}
                  inputMode="numeric"
                  aria-label="Page number"
                  onChange={(event) => setPageDraft(event.target.value.replace(/[^0-9]/g, ''))}
                  onBlur={() => jumpToPage(Number(pageDraft) || currentPage)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    jumpToPage(Number(pageDraft) || currentPage);
                    (event.target as HTMLInputElement).blur();
                  }}
                />
                <span className="pdf-page-total">/ {pageCount}</span>
                <button type="button" onClick={() => jumpToPage(currentPage + 1)} disabled={currentPage >= pageCount} aria-label="Next page"><ChevronRight size={16} /></button>
              </div>
              <div className="pdf-control-group">
                <button type="button" onClick={() => stepZoom(-1)} disabled={zoom <= ZOOM_STEPS[0]} aria-label="Zoom out"><ZoomOut size={16} /></button>
                <button type="button" className="pdf-zoom-value" onClick={() => setZoom(100)} title="Reset zoom">{zoom}%</button>
                <button type="button" onClick={() => stepZoom(1)} disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} aria-label="Zoom in"><ZoomIn size={16} /></button>
              </div>
            </>
          )}
          <div className="pdf-control-group">
            {url && <button type="button" onClick={onDownload} aria-label="Download notes" title="Download"><ArrowDownToLine size={16} /></button>}
            {url && <a href={url} target="_blank" rel="noreferrer" aria-label="Open notes in a new tab" title="Open in a new tab"><ExternalLink size={16} /></a>}
            {url && allowReplace && <button type="button" onClick={onPickFile} aria-label="Replace notes" title="Replace PDF"><Upload size={16} /></button>}
            {url && <button type="button" className="pdf-remove" onClick={onRemove} aria-label="Remove notes" title="Remove"><Trash2 size={16} /></button>}
            <button type="button" onClick={onToggleExpand} aria-label={expanded ? 'Exit full screen notes' : 'Expand notes'} title={expanded ? 'Exit full screen' : 'Full screen notes'}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
          </div>
        </div>
      </div>

      {locked ? (
        <div className="pdf-empty-state">
          <div className="pdf-empty-icon"><LockKeyhole size={22} /></div>
          <strong>Private cloud notes</strong>
          <p>Sign in to the account that saved this PDF to read it beside the video.</p>
          <button className="button-outline" onClick={onSignIn}><Cloud size={15} /> Sign in to open notes</button>
        </div>
      ) : !url ? (
        <div className={`pdf-empty-state dropzone ${uploading ? 'is-uploading' : ''}`}>
          <div className="pdf-empty-icon"><Upload size={22} /></div>
          <strong>{uploading ? 'Reading your notes…' : 'Drop your notes PDF here'}</strong>
          <p>Read it beside the video on any device · PDF only · up to 100 MB</p>
          <button className="button-primary" onClick={onPickFile} disabled={uploading}><Upload size={15} /> {uploading ? 'Uploading…' : 'Choose a PDF'}</button>
        </div>
      ) : (
        <div className="pdf-scroll" ref={scrollRef}>
          {viewerStatus === 'loading' && (
            <div className="pdf-loading-state"><Loader size={18} /><span>Opening your notes…</span></div>
          )}
          {viewerStatus === 'error' && (
            <div className="pdf-empty-state">
              <div className="pdf-empty-icon"><Info size={22} /></div>
              <strong>This PDF could not be opened</strong>
              <p>{loadError || 'Try replacing the file with a fresh copy.'}</p>
              {allowReplace && <button className="button-outline" onClick={onPickFile}><Upload size={15} /> Replace PDF</button>}
              <a className="pdf-fallback-link" href={url} target="_blank" rel="noreferrer">Open in a new tab <ExternalLink size={13} /></a>
            </div>
          )}
          {viewerStatus === 'ready' && (
            <div className="pdf-pages" ref={pagesWrapRef}>
              {pages.map((pageNumber) => (
                <div
                  key={pageNumber}
                  className="pdf-page"
                  data-page={pageNumber}
                  ref={(element) => {
                    if (element) pagesRef.current.set(pageNumber, element);
                    else pagesRef.current.delete(pageNumber);
                  }}
                  style={placeholderHeight ? { minHeight: `${placeholderHeight}px` } : undefined}
                >
                  <canvas
                    ref={(element) => {
                      if (element) canvasesRef.current.set(pageNumber, element);
                      else canvasesRef.current.delete(pageNumber);
                    }}
                    aria-label={`Page ${pageNumber} of ${pageCount}`}
                  />
                  {annotationMode && (
                    <div
                      className="pdf-text-layer"
                      data-text-layer={pageNumber}
                      ref={(element) => {
                        if (element) textLayerDivsRef.current.set(pageNumber, element);
                        else {
                          textLayerDivsRef.current.delete(pageNumber);
                          textLayersRef.current.delete(pageNumber);
                          textLayerPagesRef.current.delete(pageNumber);
                        }
                      }}
                    />
                  )}
                  {annotations && (
                    <PdfAnnotationOverlay
                      page={pageNumber}
                      annotations={annotations.annotations}
                      tool={annotations.tool}
                      color={annotations.color}
                      drawingEnabled={viewerStatus === 'ready' && annotations.tool !== 'select'}
                      onAdd={annotations.onAdd}
                      onErase={annotations.onErase}
                      onUpdateNote={annotations.onUpdateNote}
                    />
                  )}
                  <span className="pdf-page-tag">{pageNumber}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="pdf-statusbar">
        <span className="pdf-statusbar-source">
          {cloud ? <Cloud size={13} /> : <Info size={13} />}
          {viewerStatus === 'ready' ? `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}` : cloud ? 'Private cloud copy' : 'Session-only PDF'}
          {size ? ` · ${formatBytes(size)}` : ''}
        </span>
        {status && <span className="pdf-statusbar-note">{status}</span>}
      </div>

      {error && <p className="pdf-error" role="alert"><Info size={14} /> {error}</p>}
    </div>
  );
}
