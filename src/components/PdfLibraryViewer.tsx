import { useEffect } from 'react';
import { X } from 'lucide-react';
import { PdfViewer } from './PdfViewer';
import { pdfTitle } from '../lib/pdfLibrary';
import type { LibraryPdf } from '../types';

interface Props {
  item: LibraryPdf;
  url: string;
  loading: boolean;
  busy: boolean;
  error: string;
  status: string;
  onClose: () => void;
  onDownload: () => void;
  onDelete: () => void;
}

export function PdfLibraryViewer({
  item, url, loading, busy, error, status, onClose, onDownload, onDelete,
}: Props) {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop pdf-library-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="pdf-library-modal glass-card"
        role="dialog"
        aria-modal="true"
        aria-label={`${pdfTitle(item.name)} — PDF reader`}
      >
        <header className="pdf-library-modal-head">
          <span className={`subject-tag ${item.subject.toLowerCase().replace(/\s+/g, '-')}`}>{item.subject}</span>
          <h2 title={item.name}>{pdfTitle(item.name)}</h2>
          <button className="icon-button pdf-library-modal-close" onClick={onClose} aria-label="Close PDF">
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
          onPickFile={() => undefined}
          onFile={() => undefined}
          onRemove={onDelete}
          onDownload={onDownload}
          onSignIn={() => undefined}
          onToggleExpand={onClose}
        />
      </section>
    </div>
  );
}
