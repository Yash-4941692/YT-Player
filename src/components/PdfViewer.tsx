import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import {
  ArrowDownToLine, ChevronLeft, ChevronRight, Cloud, ExternalLink, FileText, Info, Loader,
  LockKeyhole, Maximize2, Minimize2, Trash2, Upload, ZoomIn, ZoomOut,
} from 'lucide-react';
import { formatBytes } from '../lib/utils';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type LoadingTask = ReturnType<PdfJs['getDocument']>;

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

function canvasQuality(width: number, height: number): number {
  const device = Math.min(window.devicePixelRatio || 1, 2);
  const maxArea = 6_500_000;
  if (width * height * device * device <= maxArea) return device;
  return Math.max(1, Math.sqrt(maxArea / (width * height)));
}

const ZOOM_STEPS = [50, 75, 100, 125, 150, 175, 200, 250, 300];

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
  onPickFile: () => void;
  onFile: (file: File) => void;
  onRemove: () => void;
  onDownload: () => void;
  onSignIn: () => void;
  onToggleExpand: () => void;
}

export function PdfViewer({
  url, name, size, cloud, uploading, error, status, locked, expanded, allowReplace = true,
  onPickFile, onFile, onRemove, onDownload, onSignIn, onToggleExpand,
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
      } catch {
        // Rendering is cancelled whenever a page scrolls away or the zoom changes.
      } finally {
        renderingRef.current.delete(pageNumber);
      }
    }
  }, []);

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
    });
  }, [currentPage, pageCount]);

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

  const placeholderHeight = layoutWidth ? Math.round(((layoutWidth * zoom) / 100) / aspect) : 0;
  const pages = Array.from({ length: pageCount }, (_value, index) => index + 1);

  return (
    <div
      className={`pdf-viewer ${expanded ? 'is-expanded' : ''} ${dragging ? 'is-dragging' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
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
