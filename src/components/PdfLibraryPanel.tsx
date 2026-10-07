import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  Check, Clock, Cloud, CloudOff, Download, FileText, HardDrive, Link2, Pencil, RotateCcw,
  Search, Trash2, Upload, X,
} from 'lucide-react';
import { formatLibraryDate, pdfTitle, sortLibrary } from '../lib/pdfLibrary';
import { formatBytes } from '../lib/utils';
import type { LibraryPdf, Subject } from '../types';

const subjects: Subject[] = ['Physics', 'Chemistry', 'Mathematics', 'Other'];

/** How long a deleted PDF waits in "Recently deleted" before the owner can purge it. */
const TRASH_RETENTION_DAYS = 30;
/** Supabase's free storage allowance, used only for the "of Y GB" part of the meter. */
const STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024;

export interface PdfActivity {
  lastOpenedAt: number | null;
  pageCount: number | null;
}

function usedLabel(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  const gb = bytes / (1024 * 1024 * 1024);
  if (bytes === 0) return '0 MB';
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function daysLeft(deletedAt: number): number {
  const elapsed = Math.floor((Date.now() - deletedAt) / 86_400_000);
  return Math.max(0, TRASH_RETENTION_DAYS - elapsed);
}

function subjectClass(subject: Subject): string {
  return subject.toLowerCase().replace(/\s+/g, '-');
}

function formatSize(bytes: number): string {
  return bytes ? formatBytes(bytes) : 'Unknown size';
}

interface Props {
  items: LibraryPdf[];
  deletedItems: LibraryPdf[];
  deletedAt: Record<string, number>;
  activity: Record<string, PdfActivity>;
  usedBytes: number;
  trashUnavailable: boolean;
  loading: boolean;
  busy: boolean;
  error: string;
  status: string;
  signedIn: boolean;
  cloudConfigured: boolean;
  canAttach: boolean;
  attachedPath?: string;
  onUpload: (file: File, subject: Subject) => void | Promise<void>;
  onOpen: (item: LibraryPdf) => void;
  onDownload: (item: LibraryPdf) => void;
  onDelete: (item: LibraryPdf) => void;
  onRestore: (item: LibraryPdf) => void;
  onDeleteForever: (item: LibraryPdf) => void;
  onRename: (item: LibraryPdf, name: string, subject: Subject) => void;
  onAttach: (item: LibraryPdf) => void;
  onSignIn: () => void;
}

export function PdfLibraryPanel({
  items, deletedItems, deletedAt, activity, usedBytes, trashUnavailable, loading, busy, error, status,
  signedIn, cloudConfigured, canAttach, attachedPath,
  onUpload, onOpen, onDownload, onDelete, onRestore, onDeleteForever, onRename, onAttach, onSignIn,
}: Props) {
  const [filter, setFilter] = useState<'all' | Subject>('all');
  const [query, setQuery] = useState('');
  const [uploadSubject, setUploadSubject] = useState<Subject>('Other');
  const [dragging, setDragging] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [byRecent, setByRecent] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // "Recently opened" is a sort of the same shelf, newest first, using the activity table.
  const ordered = useMemo(() => {
    const sorted = sortLibrary(items);
    if (!byRecent) return sorted;
    return [...sorted].sort((a, b) => {
      const aOpened = activity[a.id]?.lastOpenedAt ?? 0;
      const bOpened = activity[b.id]?.lastOpenedAt ?? 0;
      if (bOpened !== aOpened) return bOpened - aOpened;
      return b.updatedAt - a.updatedAt;
    });
  }, [items, byRecent, activity]);

  const recentlyOpened = useMemo(
    () => [...items]
      .filter((item) => activity[item.id]?.lastOpenedAt)
      .sort((a, b) => (activity[b.id]?.lastOpenedAt ?? 0) - (activity[a.id]?.lastOpenedAt ?? 0))
      .slice(0, 5),
    [items, activity],
  );

  const counts = useMemo(() => {
    const map = new Map<Subject, number>();
    for (const item of ordered) map.set(item.subject, (map.get(item.subject) ?? 0) + 1);
    return map;
  }, [ordered]);

  const trimmedQuery = query.trim().toLowerCase();
  const visible = ordered.filter((item) => {
    if (filter !== 'all' && item.subject !== filter) return false;
    if (!trimmedQuery) return true;
    return item.name.toLowerCase().includes(trimmedQuery);
  });

  function selectSubjectFilter(nextFilter: 'all' | Subject) {
    setShowTrash(false);
    setFilter(nextFilter);
    if (nextFilter === 'all' && !showTrash && filter === 'all') {
      setByRecent(false);
    }
  }

  function handleRecentClick() {
    if (showTrash) {
      setShowTrash(false);
      setByRecent(true);
    } else {
      setByRecent((value) => !value);
    }
  }

  function handleTrashClick() {
    setShowTrash((value) => !value);
  }

  async function handleFiles(files: FileList | null) {
    // Uploading one at a time keeps memory and progress messages predictable for large PDFs.
    for (const file of Array.from(files ?? [])) {
      await onUpload(file, uploadSubject);
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    void handleFiles(event.dataTransfer.files);
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>) {
    void handleFiles(event.target.files);
    event.target.value = '';
  }

  return (
    <section
      className={`pdf-library-section ${dragging ? 'is-dragging' : ''}`}
      aria-label="Your PDF library"
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={(event) => {
        // Ignore dragleave fired when moving between children of the section.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <div className="library-heading">
        <div>
          <p className="eyebrow">PDF LIBRARY</p>
          <h2>Notes that follow you</h2>
          <p>
            {signedIn
              ? 'Upload once and open these PDFs from any device you sign in from.'
              : cloudConfigured
                ? 'Sign in to keep your PDFs across devices. Guest uploads stay in this tab.'
                : 'Guest uploads stay in this tab until cloud sync is switched on.'}
          </p>
        </div>
        <div className="pdf-library-heading-end">
          <span className="library-count"><span>{ordered.length.toString().padStart(2, '0')}</span> PDFS</span>
          <span className="pdf-storage-meter" title="Total size of the PDFs in your library">
            <span className="pdf-storage-bar">
              <span
                className="pdf-storage-bar-fill"
                style={{ width: `${Math.min(100, (usedBytes / STORAGE_QUOTA_BYTES) * 100).toFixed(2)}%` }}
              />
            </span>
            You’ve used {usedLabel(usedBytes)} of {Math.round(STORAGE_QUOTA_BYTES / (1024 * 1024 * 1024))} GB
          </span>
        </div>
      </div>

      {!signedIn && cloudConfigured && (
        <div className="pdf-library-notice">
          <span className="pdf-library-notice-icon"><CloudOff size={15} /></span>
          <p>You are browsing as a guest. Uploaded PDFs stay in this tab until you sign in.</p>
          <button className="button-outline small-outline" onClick={onSignIn}><Cloud size={14} /> Sign in to sync</button>
        </div>
      )}

      {recentlyOpened.length > 0 && !showTrash && (
        <div className="pdf-recent-strip">
          <span className="pdf-recent-label"><Clock size={13} /> Recently opened</span>
          <div className="pdf-recent-items">
            {recentlyOpened.map((item) => (
              <button key={item.id} type="button" className="pdf-recent-chip" onClick={() => onOpen(item)} title={`Open ${item.name}`}>
                <FileText size={12} /> {pdfTitle(item.name)}
                {activity[item.id]?.pageCount ? <span>{activity[item.id].pageCount}p</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="pdf-library-toolbar">
        <div className="pdf-library-filters" role="group" aria-label="Filter PDFs by subject">
          <button
            type="button"
            className={!showTrash && filter === 'all' && !byRecent ? 'selected' : ''}
            onClick={() => { setShowTrash(false); setFilter('all'); setByRecent(false); }}
          >
            All <span>{ordered.length}</span>
          </button>
          {subjects.map((subject) => (
            <button
              key={subject}
              type="button"
              className={!showTrash && filter === subject ? 'selected' : ''}
              onClick={() => selectSubjectFilter(subject)}
            >
              {subject} <span>{counts.get(subject) ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="pdf-library-tools">
          {ordered.length > 1 && !showTrash && (
            <label className="pdf-library-search">
              <Search size={14} />
              <span className="sr-only">Search your PDFs</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search PDFs" />
            </label>
          )}
          <button
            type="button"
            className={`pdf-library-sort ${!showTrash && byRecent ? 'selected' : ''}`}
            onClick={handleRecentClick}
            title="View PDFs sorted by most recently opened"
            aria-pressed={!showTrash && byRecent}
          >
            <Clock size={13} /> Recently opened {recentlyOpened.length > 0 && <span>{recentlyOpened.length}</span>}
          </button>
          <button
            type="button"
            className={`pdf-library-sort pdf-library-trash-toggle ${showTrash ? 'selected' : ''}`}
            onClick={handleTrashClick}
            title="PDFs you deleted in the last 30 days"
            aria-pressed={showTrash}
          >
            <Trash2 size={13} /> Recently deleted {deletedItems.length > 0 && <span>{deletedItems.length}</span>}
          </button>

          <label className="pdf-library-subject">
            <span className="sr-only">Subject for new uploads</span>
            <select value={uploadSubject} onChange={(event) => setUploadSubject(event.target.value as Subject)} aria-label="Subject for new uploads">
              {subjects.map((subject) => <option key={subject}>{subject}</option>)}
            </select>
          </label>
          <button className="button-primary pdf-library-upload" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            <Upload size={14} /> {busy ? 'Uploading…' : 'Upload PDF'}
          </button>
        </div>
      </div>

      <input ref={fileInputRef} className="sr-only" type="file" accept=".pdf,application/pdf" multiple onChange={handleInput} />

      {loading && ordered.length === 0 ? (
        <div className="pdf-library-placeholder"><span className="mini-spinner" /> Loading your PDF library…</div>
      ) : (
        <>
          <div className={`pdf-library-dropzone ${ordered.length === 0 ? 'is-empty' : ''} ${busy ? 'is-uploading' : ''}`}>
            <span className="pdf-library-dropzone-icon"><Upload size={18} /></span>
            <p>
              <strong>{busy ? 'Uploading your PDF…' : 'Drop a PDF here'}</strong>
              {' '}or{' '}
              <button type="button" className="pdf-library-inline-button" onClick={() => fileInputRef.current?.click()} disabled={busy}>browse files</button>
            </p>
            <span className="pdf-library-dropzone-hint">PDF only · up to 100 MB each · private to your account</span>
          </div>

          {showTrash ? (
            deletedItems.length === 0 ? (
              <div className="pdf-library-empty">
                <span className="pdf-library-empty-icon"><Trash2 size={20} /></span>
                <strong>Nothing in Recently deleted</strong>
                <p>PDFs you delete from the library wait here for {TRASH_RETENTION_DAYS} days, so one tap brings them back.</p>
                <button
                  type="button"
                  className="button-outline small-outline"
                  onClick={() => setShowTrash(false)}
                >
                  Back to PDF library
                </button>
              </div>
            ) : (
              <>
                <p className="pdf-trash-note">
                  <RotateCcw size={13} /> Deleted PDFs stay here for {TRASH_RETENTION_DAYS} days. Restore brings one straight back; “Delete forever” erases its file from storage.
                  {trashUnavailable && ' Saved locally on this device until the optional cloud trash migration is run.'}
                </p>
                <div className="pdf-library-grid">
                  {deletedItems.map((item) => (
                    <article key={item.id} className="pdf-library-card glass-card is-deleted">
                      <div className="pdf-library-open is-static">
                        <span className="pdf-library-file-icon"><FileText size={17} /></span>
                        <span className="pdf-library-name">{pdfTitle(item.name)}</span>
                      </div>
                      <div className="pdf-library-card-meta">
                        <span className={`subject-tag ${subjectClass(item.subject)}`}>{item.subject}</span>
                        <span className="pdf-library-size">{formatSize(item.size)}</span>
                      </div>
                      <p className="pdf-library-trash-meta">
                        Deleted {formatLibraryDate(deletedAt[item.id] ?? Date.now())}
                        {' · '}
                        {daysLeft(deletedAt[item.id] ?? Date.now()) === 0
                          ? 'ready to be deleted for good'
                          : `${daysLeft(deletedAt[item.id] ?? Date.now())} days left`}
                      </p>
                      <div className="pdf-library-card-foot">
                        <span className="pdf-library-trash-actions">
                          <button type="button" className="pdf-library-restore" onClick={() => onRestore(item)}>
                            <RotateCcw size={13} /> Restore
                          </button>
                          <button type="button" className="pdf-library-delete-forever" onClick={() => onDeleteForever(item)}>
                            <Trash2 size={13} /> Delete forever
                          </button>
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              </>
            )
          ) : ordered.length === 0 ? (
            <div className="pdf-library-empty">
              <span className="pdf-library-empty-icon"><FileText size={20} /></span>
              <strong>No PDFs yet</strong>
              <p>Add class notes, formula sheets or DPPs here and read them beside any lesson, on any device.</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="library-empty">No PDFs match this filter.</div>
          ) : (
            <div className="pdf-library-grid">
              {visible.map((item) => (
                <PdfCard
                  key={item.id}
                  item={item}
                  attached={Boolean(attachedPath && item.storagePath && item.storagePath === attachedPath)}
                  canAttach={canAttach && !item.sessionOnly}
                  onOpen={() => onOpen(item)}
                  onDownload={() => onDownload(item)}
                  onDelete={() => onDelete(item)}
                  onRename={(name, subject) => onRename(item, name, subject)}
                  onAttach={() => onAttach(item)}
                  pageCount={activity[item.id]?.pageCount ?? null}
                  lastOpenedAt={activity[item.id]?.lastOpenedAt ?? null}
                />
              ))}
            </div>
          )}
        </>
      )}

      {(status || error) && (
        <p className={`pdf-library-status ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>
          {error ? <CloudOff size={13} /> : signedIn ? <Cloud size={13} /> : <HardDrive size={13} />}
          {error || status}
        </p>
      )}
    </section>
  );
}

interface CardProps {
  item: LibraryPdf;
  attached: boolean;
  canAttach: boolean;
  pageCount: number | null;
  lastOpenedAt: number | null;
  onOpen: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onRename: (name: string, subject: Subject) => void;
  onAttach: () => void;
}

function PdfCard({ item, attached, canAttach, pageCount, lastOpenedAt, onOpen, onDownload, onDelete, onRename, onAttach }: CardProps) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(pdfTitle(item.name));
  const [draftSubject, setDraftSubject] = useState<Subject>(item.subject);

  function startEditing() {
    setDraftName(pdfTitle(item.name));
    setDraftSubject(item.subject);
    setEditing(true);
  }

  function save() {
    const name = draftName.trim();
    if (!name) return;
    onRename(name.slice(0, 120), draftSubject);
    setEditing(false);
  }

  return (
    <article className={`pdf-library-card glass-card ${attached ? 'is-attached' : ''}`}>
      {editing ? (
        <div className="pdf-library-edit">
          <label className="pdf-library-edit-field">
            <span className="sr-only">PDF name</span>
            <input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); save(); }
                if (event.key === 'Escape') { event.preventDefault(); setEditing(false); }
              }}
              autoFocus
              maxLength={120}
            />
          </label>
          <label className="pdf-library-edit-field">
            <span className="sr-only">Subject</span>
            <select value={draftSubject} onChange={(event) => setDraftSubject(event.target.value as Subject)}>
              {subjects.map((subject) => <option key={subject}>{subject}</option>)}
            </select>
          </label>
          <div className="pdf-library-edit-actions">
            <button type="button" className="pdf-library-save" onClick={save}><Check size={13} /> Save</button>
            <button type="button" className="pdf-library-cancel" onClick={() => setEditing(false)}><X size={13} /> Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <button type="button" className="pdf-library-open" onClick={onOpen} title={`Open ${item.name}`}>
            <span className="pdf-library-file-icon"><FileText size={17} /></span>
            <span className="pdf-library-name">{pdfTitle(item.name)}</span>
          </button>

          <div className="pdf-library-card-meta">
            <span className={`subject-tag ${subjectClass(item.subject)}`}>{item.subject}</span>
            <span className="pdf-library-size">
              {formatSize(item.size)}
              {pageCount ? ` · ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}` : ''}
            </span>
          </div>

          <div className="pdf-library-card-foot">
            <span className={`pdf-library-origin ${item.sessionOnly ? 'is-session' : ''}`} title={item.sessionOnly ? 'Only available in this tab' : 'Synced with your account'}>
              {item.sessionOnly ? <HardDrive size={12} /> : <Cloud size={12} />}
              {item.sessionOnly ? 'This tab only' : 'Synced'}
              {lastOpenedAt ? <em className="pdf-library-opened">{formatLibraryDate(lastOpenedAt)}</em> : null}
            </span>
            <span className="pdf-library-card-actions">
              {canAttach && (
                <button
                  type="button"
                  className={`pdf-library-action ${attached ? 'is-attached' : ''}`}
                  onClick={onAttach}
                  title={attached ? 'Already open beside this lesson' : 'Open beside the current lesson'}
                  aria-label={attached ? 'Attached to the current lesson' : 'Attach to the current lesson'}
                >
                  {attached ? <Check size={14} /> : <Link2 size={14} />}
                </button>
              )}
              <button type="button" className="pdf-library-action" onClick={onDownload} title="Download" aria-label={`Download ${item.name}`}><Download size={14} /></button>
              <button type="button" className="pdf-library-action" onClick={startEditing} title="Rename" aria-label={`Rename ${item.name}`}><Pencil size={14} /></button>
              <button type="button" className="pdf-library-action is-danger" onClick={onDelete} title="Delete" aria-label={`Delete ${item.name}`}><Trash2 size={14} /></button>
            </span>
          </div>
        </>
      )}
    </article>
  );
}
