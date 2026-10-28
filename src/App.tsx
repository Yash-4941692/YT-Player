import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { User } from '@supabase/supabase-js';
import {
  Archive, ArchiveRestore, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleHelp, Cloud, CloudOff,
  FileText, Film, HardDrive, Info, ListMusic, Pencil, Play, ShieldCheck, Trash2, X, Zap,
} from 'lucide-react';
import { AuthModal } from './components/AuthModal';
import { ChaptersPanel } from './components/ChaptersPanel';
import { PdfLibraryPanel } from './components/PdfLibraryPanel';
import { PdfLibraryViewer, usePdfAnnotationController } from './components/PdfLibraryViewer';
import { PdfViewer } from './components/PdfViewer';
import { FilePlayer } from './components/FilePlayer';
import { LessonThumb } from './components/LessonThumb';
import { YouTubePlayer, type PlayerControls } from './components/YouTubePlayer';
import {
  clearCloudVideoDeletion, cloudConfigured, createLibraryPdf, createPdfSignedUrl, deleteCloudLessonAnnotations, deleteCloudPdf,
  deleteCloudVideo, deleteLibraryPdf, fetchCloudSyncLedger, fetchCloudVideos, fetchLibraryPdfs, fetchPdfActivity,
  fetchPdfTrashMap, isLibraryPath, probeAnnotationTables, pushCloudSyncLedger, restoreLibraryPdf, saveCloudVideo,
  savePdfActivity, subscribeCloudSyncLedger, supabase, trashLibraryPdf, updateLibraryPdf, uploadCloudPdf,
  watchItemCapabilities,
} from './lib/supabase';
import {
  deleteLocalAnnotations, loadLocalDeletions, loadLocalPdfActivity, loadLocalPdfSync, loadLocalPdfTrash, loadLocalState,
  moveAnnotationCache, saveLocalDeletions, saveLocalPdfActivity, saveLocalPdfSync, saveLocalPdfTrash, saveLocalState,
  upsertVideo,
} from './lib/storage';
import {
  deletionKey, isDeleted, mergeLessonCopies, nextLessonStamp, reconcilePdfState, withDeletion, withoutDeletion,
  type DeletedMap, type LessonTombstoneEntry, type LocalPdfSyncEntry, type PdfSyncEntry, type PdfSyncMap,
} from './lib/lessonSync';
import { sessionLibraryItem, sortLibrary, validateLibraryFile } from './lib/pdfLibrary';
import { captureVideoPoster, hostBlocksFrameCapture } from './lib/thumbnails';
import {
  emptyVideoRecord, fileLessonId, fileVideoRecord, formatTime, isFileLesson, isYouTubeLink, lessonUrlFor,
  parseChapters, parseLessonInput,
} from './lib/youtube';
import type { LibraryPdf, PersistedState, PlayerSource, PlayerVideoInfo, SessionPdf, StudyPanelView, Subject, VideoRecord } from './types';
import { Analytics } from '@vercel/analytics/react';
import './styles.css';
import './readability.css';

type SyncStatus = 'local' | 'syncing' | 'synced' | 'error';

interface PdfPreview {
  url: string;
  /** Whether this URL is a cloud URL (local object URLs can also have a cloud copy). */
  cloud: boolean;
}

const subjects: Subject[] = ['Physics', 'Chemistry', 'Mathematics', 'Other'];

/** The SQL file that creates a missing annotation table, named in the sync warning. */
function annotationMigrationHint(tables: string[]): string {
  const files = new Set<string>();
  if (tables.includes('pdf_annotations')) files.add('supabase/migrations/003_pdf_annotations.sql');
  if (tables.includes('lesson_annotations')) files.add('supabase/migrations/006_lesson_annotations.sql');
  return [...files].join(' and ');
}

const MAX_PDF_SIZE = 100 * 1024 * 1024;

function downloadFromUrl(url: string, name: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function subjectClass(subject: Subject): string {
  return subject.toLowerCase().replace(/\s+/g, '-');
}

function progressPercent(record: VideoRecord): number {
  if (!record.duration) return 0;
  return Math.min(100, Math.max(0, (record.currentTime / record.duration) * 100));
}

export default function App() {
  const [initialState] = useState(loadLocalState);
  const [videos, setVideos] = useState<VideoRecord[]>(initialState.videos);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('local');
  const [syncMessage, setSyncMessage] = useState('');
  const [syncedUserId, setSyncedUserId] = useState<string | null>(null);

  const [urlInput, setUrlInput] = useState('');
  const [selectedSubject, setSelectedSubject] = useState<Subject>('Physics');
  const [urlError, setUrlError] = useState('');
  const [source, setSource] = useState<PlayerSource | null>(null);
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);
  const [isPlaylist, setIsPlaylist] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const [playerState, setPlayerState] = useState(-1);
  const [playerError, setPlayerError] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);
  const [chaptersRaw, setChaptersRaw] = useState('');
  const [panelView, setPanelView] = useState<StudyPanelView>('notes');
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [toast, setToast] = useState('');
  const [pdfError, setPdfError] = useState('');
  const [pdfStatus, setPdfStatus] = useState('');
  const [pdfUpload, setPdfUpload] = useState<{ videoId: string; session: SessionPdf } | null>(null);
  const [pdfPreview, setPdfPreview] = useState<PdfPreview | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  // Session files live in a ref, so bump this when one is added or removed.
  const [, setNotesRevision] = useState(0);
  const [libraryFilter, setLibraryFilter] = useState<'all' | Subject | 'removed'>('all');

  const [libraryPdfs, setLibraryPdfs] = useState<LibraryPdf[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  const [libraryStatus, setLibraryStatus] = useState('');
  const [openLibraryPdf, setOpenLibraryPdf] = useState<LibraryPdf | null>(null);
  const [libraryUrl, setLibraryUrl] = useState('');
  const [libraryUrlLoading, setLibraryUrlLoading] = useState(false);
  const [libraryLoadedFor, setLibraryLoadedFor] = useState<string | null>(null);
  // "Recently deleted" PDFs (pdf id -> when it was deleted), per-PDF sync bookkeeping and activity, backed by localStorage.
  const [pdfTrash, setPdfTrash] = useState<Record<string, number>>(loadLocalPdfTrash);
  const [pdfSync, setPdfSync] = useState<PdfSyncMap>(loadLocalPdfSync);
  const [pdfActivity, setPdfActivity] = useState<Record<string, { lastOpenedAt: number | null; pageCount: number | null }>>(loadLocalPdfActivity);
  const [trashUnavailable, setTrashUnavailable] = useState(false);
  // Names of the annotation tables this project is missing, checked once per sign-in so the
  // app can say which SQL file to run instead of only failing when a drawing is saved.
  const [annotationTablesMissing, setAnnotationTablesMissing] = useState<string[]>([]);
  // Deletions made here (lesson or PDF id → when). They are the reason a deleted lesson does
  // not come back from another device's cached copy. See src/lib/lessonSync.ts.
  const [deletions, setDeletions] = useState<DeletedMap>(loadLocalDeletions);
  // False until the project has the migration that carries `deleted_at` — the app then says
  // deletions stay on this device instead of pretending they sync.
  const [deleteSyncMissing, setDeleteSyncMissing] = useState(false);

  const playerControlsRef = useRef<PlayerControls | null>(null);
  const authUserIdRef = useRef<string | null>(null);
  authUserIdRef.current = authUser?.id ?? null;
  const deletionsRef = useRef(deletions);
  deletionsRef.current = deletions;
  const pdfTrashRef = useRef(pdfTrash);
  pdfTrashRef.current = pdfTrash;
  const pdfSyncRef = useRef(pdfSync);
  pdfSyncRef.current = pdfSync;
  const libraryPdfsRef = useRef<LibraryPdf[]>([]);
  const activeVideoIdRef = useRef<string | null>(null);
  const sourceRef = useRef<PlayerSource | null>(null);
  const libraryMigratedRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  // Lessons whose first frame has already been captured (or attempted) in this tab.
  const posterAttemptsRef = useRef(new Set<string>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timestampsRef = useRef<HTMLDetailsElement>(null);
  const notesSessionRef = useRef<Record<string, SessionPdf>>({});
  const playlistIdRef = useRef<string | undefined>(undefined);
  const loadTokenRef = useRef(0);
  const lastProgressSaveRef = useRef(-1);
  // Cloud sync bookkeeping: the updatedAt we last pushed for each lesson, so a progress
  // tick only re-uploads the one lesson that changed instead of the whole library.
  const lastSyncedRef = useRef(new Map<string, number>());
  // Set right after the cloud library loads so the first push after a merge is a full one.
  const fullReconcileRef = useRef(false);
  const videosRef = useRef(videos);
  videosRef.current = videos;

  const activeRecord = useMemo(
    () => activeVideoId ? videos.find((video) => video.videoId === activeVideoId) ?? null : null,
    [videos, activeVideoId],
  );
  activeVideoIdRef.current = activeVideoId;
  sourceRef.current = source;
  libraryPdfsRef.current = libraryPdfs;
  const parsedChapters = useMemo(() => parseChapters(chaptersRaw), [chaptersRaw]);
  const activeChapterIndex = useMemo(() => {
    let index = -1;
    for (let chapterIndex = 0; chapterIndex < parsedChapters.length; chapterIndex += 1) {
      if (currentTime >= parsedChapters[chapterIndex].seconds) index = chapterIndex;
      else break;
    }
    return index;
  }, [parsedChapters, currentTime]);
  const activeSubject = activeRecord?.subject ?? selectedSubject;
  const activeTitle = activeRecord?.title || (playerReady ? (source?.kind === 'file' ? 'Direct video lesson' : 'YouTube lesson') : 'Your lesson is loading…');

  const trashedLibraryPaths = useMemo(
    () => new Set(
      libraryPdfs
        .filter((item) => Boolean(item.storagePath && pdfTrash[item.id]))
        .map((item) => item.storagePath),
    ),
    [libraryPdfs, pdfTrash],
  );
  const activePdfTrashed = Boolean(activeRecord?.pdfPath && trashedLibraryPaths.has(activeRecord.pdfPath));
  const cachedSessionPdf = activeVideoId ? notesSessionRef.current[activeVideoId] : undefined;
  // A successfully uploaded file can keep its local preview, but only while the account and
  // stored path still match. A replacement, removal, trash or sign-out must win over the cache.
  const sessionPdf = cachedSessionPdf && (!cachedSessionPdf.cloudPath || (
    cachedSessionPdf.cloudPath === activeRecord?.pdfPath
    && cachedSessionPdf.ownerId === authUser?.id
    && !activePdfTrashed
  )) ? cachedSessionPdf : undefined;
  const previewFile = sessionPdf?.file;
  const previewCloudPath = !previewFile && !activePdfTrashed && authUser && supabase ? activeRecord?.pdfPath : undefined;
  const previewOwnerId = previewCloudPath ? authUser?.id : undefined;
  const pdfBusy = Boolean(pdfUpload && pdfUpload.videoId === activeVideoId);
  const pdfName = (sessionPdf?.cloudPath ? activeRecord?.pdfName : sessionPdf?.name) || activeRecord?.pdfName || '';
  const pdfSize = (sessionPdf?.cloudPath ? activeRecord?.pdfSize : sessionPdf?.size) ?? activeRecord?.pdfSize ?? 0;

  const linkedLibraryPdf = useMemo(
    () => (activeRecord?.pdfPath && (!sessionPdf || sessionPdf.cloudPath === activeRecord.pdfPath)
      ? libraryPdfs.find((item) => item.storagePath && item.storagePath === activeRecord.pdfPath && !pdfTrash[item.id]) ?? null
      : null),
    [activeRecord?.pdfPath, libraryPdfs, pdfTrash, sessionPdf],
  );
  const lessonPdfId = linkedLibraryPdf?.id ?? (activeVideoId && pdfPreview?.url ? `lesson:${activeVideoId}` : null);
  // A lesson's own PDF notes sync through the lesson row, a PDF attached from the library
  // syncs through its library row — either way the drawings follow the account.
  const lessonAnnotations = usePdfAnnotationController({
    cacheKey: lessonPdfId,
    libraryPdfId: linkedLibraryPdf?.id ?? null,
    lessonVideoId: linkedLibraryPdf ? null : activeVideoId,
    isGuest: Boolean(!authUser || linkedLibraryPdf?.sessionOnly),
    userId: authUser?.id ?? null,
    shortcutsEnabled: !openLibraryPdf && panelView === 'notes',
  });

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3200);
  }, []);

  /**
   * Update a lesson using a monotonic revision stamp (`nextLessonStamp`) so edits, removals,
   * restores and PDF detachments win even when another device's clock sits ahead of this one.
   */
  const updateVideo = useCallback((videoId: string, patch: Partial<VideoRecord>): VideoRecord => {
    const current = videosRef.current;
    const existing = current.find((item) => item.videoId === videoId) ?? emptyVideoRecord(videoId);
    const prevTombstone = deletionsRef.current[deletionKey('lesson', videoId)] ?? 0;
    const stamp = patch.updatedAt ?? nextLessonStamp(existing.updatedAt, prevTombstone);
    const updated: VideoRecord = { ...existing, ...patch, updatedAt: stamp };
    const nextList = upsertVideo(current, updated);
    videosRef.current = nextList;
    setVideos(nextList);
    return updated;
  }, []);

  /**
   * Push an explicit user change (archive/remove, restore, rename, PDF attach/detach) straight
   * to the account instead of waiting on the progress-tick debounce, and ping open tabs on
   * other devices through the sync ledger so they refresh right away.
   */
  const pushVideoNow = useCallback((record: VideoRecord, signalOtherDevices = false) => {
    if (!supabase || !authUser) return;
    const userId = authUser.id;
    if (isDeleted(deletionsRef.current, 'lesson', record.videoId)) return;
    void saveCloudVideo(userId, record)
      .then(() => {
        if (!isDeleted(deletionsRef.current, 'lesson', record.videoId)) {
          lastSyncedRef.current.set(record.videoId, record.updatedAt);
        }
        if (signalOtherDevices) {
          void pushCloudSyncLedger(userId, { signalAt: record.updatedAt }).catch(() => undefined);
        }
      })
      .catch(() => {
        // Leave `lastSyncedRef` untouched so the periodic sync / reconnect flush retries it.
      });
  }, [authUser]);

  const closeActiveStudyRoom = useCallback(() => {
    setSource(null);
    setActiveVideoId(null);
    setPdfPreview(null);
    setNotesExpanded(false);
    setNotesRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    const state: PersistedState = { videos };
    setStorageAvailable(saveLocalState(state));
  }, [videos]);

  useEffect(() => {
    saveLocalDeletions(deletions);
  }, [deletions]);

  useEffect(() => {
    saveLocalPdfTrash(pdfTrash);
  }, [pdfTrash]);

  useEffect(() => {
    saveLocalPdfSync(pdfSync);
  }, [pdfSync]);

  useEffect(() => {
    saveLocalPdfActivity(pdfActivity);
  }, [pdfActivity]);

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true);
      return;
    }
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setAuthUser(data.session?.user ?? null);
      setAuthReady(true);
    }).catch(() => setAuthReady(true));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUser(session?.user ?? null);
      setAuthReady(true);
    });
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  /**
   * Push the tombstones this browser made but the account does not have yet (offline deletes,
   * or a delete the account rejected at the time). Failures are silent: the local tombstone
   * keeps the lesson deleted here, and the next refresh simply tries again.
   */
  const pushPendingLessonDeletes = useCallback((userId: string, pending: { videoId: string; deletedAt: number }[]) => {
    if (!supabase || pending.length === 0) return;
    void Promise.allSettled(pending.map((entry) => deleteCloudVideo(userId, entry.videoId, entry.deletedAt)));
    const lessonsPatch: Record<string, LessonTombstoneEntry> = {};
    let maxAt = 0;
    for (const entry of pending) {
      lessonsPatch[entry.videoId] = { status: 'deleted', at: entry.deletedAt };
      if (entry.deletedAt > maxAt) maxAt = entry.deletedAt;
    }
    void pushCloudSyncLedger(userId, { lessons: lessonsPatch, signalAt: maxAt }).catch(() => undefined);
  }, []);

  /**
   * Reconcile this browser with the account: the single place where copies are merged, both
   * when the account loads and every time the app checks for changes another device made.
   */
  const reconcileLessons = useCallback((
    userId: string,
    remoteVideos: VideoRecord[],
    remoteLedgerLessons: Record<string, LessonTombstoneEntry> = {},
  ) => {
    const result = mergeLessonCopies(videosRef.current, remoteVideos, deletionsRef.current, remoteLedgerLessons);
    videosRef.current = result.videos;
    deletionsRef.current = result.deletions;
    setVideos(result.videos);
    setDeletions(result.deletions);
    // Anything the account already holds (and this device has not changed) needs no upload.
    for (const [videoId, updatedAt] of Object.entries(result.confirmed)) {
      if (lastSyncedRef.current.get(videoId) !== updatedAt) lastSyncedRef.current.set(videoId, updatedAt);
    }
    pushPendingLessonDeletes(userId, result.pendingDeletes);

    // If another device removed a lesson's PDF notes, clear any in-memory session copy too.
    for (const videoId of result.clearedPdfIds) {
      delete notesSessionRef.current[videoId];
      deleteLocalAnnotations(`lesson:${videoId}`);
      if (activeVideoIdRef.current === videoId) {
        setPdfPreview(null);
        setNotesRevision((value) => value + 1);
      }
    }

    const openId = activeVideoIdRef.current;
    if (openId && result.removedIds.includes(openId)) {
      // Stop the study room when the lesson on screen was deleted elsewhere, so playback
      // ticks cannot re-create the record that was just removed.
      closeActiveStudyRoom();
      showToast('This lesson was deleted on another device.');
    } else if (openId && result.newlyArchivedIds.includes(openId)) {
      // Also stop playback if the open lesson was moved to "Removed" on another device, so
      // progress ticks here cannot silently un-remove it.
      closeActiveStudyRoom();
      showToast('This lesson was removed on another device.');
    }
    return result;
  }, [closeActiveStudyRoom, pushPendingLessonDeletes, showToast]);

  /**
   * Reconcile the PDF library, "Recently deleted" (`pdf_trash`), and permanent PDF deletions
   * across devices — whether or not the optional `pdf_trash` migration was run.
   */
  const reconcilePdfLibrary = useCallback((
    userId: string,
    remotePdfs: LibraryPdf[],
    remoteTrash: Record<string, number> | null,
    remoteLedgerPdfs: Record<string, PdfSyncEntry> = {},
    ledgerAvailable = true,
  ) => {
    const sessionPdfs = libraryPdfsRef.current.filter((item) => item.sessionOnly);
    const result = reconcilePdfState({
      remotePdfs,
      localSessionPdfs: sessionPdfs,
      localSync: pdfSyncRef.current,
      localTrashFallback: pdfTrashRef.current,
      localDeletionsFallback: deletionsRef.current,
      remoteTrash,
      remoteLedgerPdfs,
    });

    libraryPdfsRef.current = result.items;
    pdfTrashRef.current = result.trash;
    pdfSyncRef.current = result.syncMap;
    setLibraryPdfs(result.items);
    setPdfTrash(result.trash);
    setPdfSync(result.syncMap);
    setTrashUnavailable(remoteTrash === null && !ledgerAvailable);

    if (result.deletedIds.length > 0) {
      let nextDel = deletionsRef.current;
      for (const id of result.deletedIds) {
        const at = result.syncMap[id]?.at ?? Date.now();
        nextDel = withDeletion(nextDel, 'pdf', id, at);
        deleteLocalAnnotations(id);
      }
      if (nextDel !== deletionsRef.current) {
        deletionsRef.current = nextDel;
        setDeletions(nextDel);
      }
    }

    // Close the full-screen PDF reader if the PDF it displays was deleted or trashed elsewhere.
    const survivingIds = new Set(result.items.map((item) => item.id));
    setOpenLibraryPdf((current) => {
      if (!current || current.sessionOnly) return current;
      if (!survivingIds.has(current.id)) {
        showToast('This PDF was deleted on another device.');
        return null;
      }
      if (result.newlyTrashedIds.includes(current.id)) {
        showToast('This PDF was moved to Recently deleted on another device.');
        return null;
      }
      return current;
    });

    // Unlink any lesson whose attached library PDF was deleted forever on another device.
    const liveLibraryPaths = new Set(
      result.items.map((item) => item.storagePath).filter((path): path is string => Boolean(path)),
    );
    const unlinkedLessons: VideoRecord[] = [];
    const currentVideos = videosRef.current;
    let videosChanged = false;
    const cleanedVideos = currentVideos.map((video) => {
      if (video.pdfPath && isLibraryPath(video.pdfPath) && !liveLibraryPaths.has(video.pdfPath)) {
        videosChanged = true;
        const cleaned: VideoRecord = {
          ...video,
          pdfPath: undefined,
          pdfName: undefined,
          pdfSize: undefined,
          updatedAt: nextLessonStamp(video.updatedAt),
        };
        unlinkedLessons.push(cleaned);
        return cleaned;
      }
      return video;
    });
    if (videosChanged) {
      videosRef.current = cleanedVideos;
      setVideos(cleanedVideos);
      for (const cleaned of unlinkedLessons) {
        if (!isDeleted(deletionsRef.current, 'lesson', cleaned.videoId)) {
          void saveCloudVideo(userId, cleaned)
            .then(() => lastSyncedRef.current.set(cleaned.videoId, cleaned.updatedAt))
            .catch(() => undefined);
        }
      }
    }

    // Retry / complete any pending account writes for PDF deletions, trashes, or restores.
    for (const item of result.pendingHardDeletes) {
      void deleteLibraryPdf(userId, item).catch(() => undefined);
    }
    for (const entry of result.pendingTrashWrites) {
      void trashLibraryPdf(userId, entry.pdfId, entry.deletedAt).catch(() => undefined);
    }
    for (const pdfId of result.pendingRestores) {
      void restoreLibraryPdf(userId, pdfId).catch(() => undefined);
    }
    if (Object.keys(result.ledgerPatch).length > 0) {
      const patch = result.ledgerPatch;
      const maxAt = Math.max(...Object.values(patch).map((entry) => entry.at), Date.now());
      void pushCloudSyncLedger(userId, { pdfs: patch, signalAt: maxAt })
        .then(({ available }) => {
          if (!available) return;
          setPdfSync((current) => {
            let changed = false;
            const next = { ...current };
            for (const [id, sent] of Object.entries(patch)) {
              const cur = next[id];
              if (cur?.pending && cur.status === sent.status && cur.at === sent.at) {
                next[id] = { status: cur.status, at: cur.at, ...(cur.deletedAt ? { deletedAt: cur.deletedAt } : {}) };
                changed = true;
              }
            }
            if (changed) pdfSyncRef.current = next;
            return changed ? next : current;
          });
        })
        .catch(() => undefined);
    }
  }, [showToast]);

  /**
   * Read the full account state (lessons, PDF library, `pdf_trash` and the sync ledger) and
   * reconcile both shelves together. Concurrent refresh requests coalesce cleanly.
   */
  const refreshAccountState = useCallback(async (userId: string) => {
    if (!supabase) return;
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    try {
      const [videosRes, pdfsRes, trashRes, ledgerRes] = await Promise.allSettled([
        fetchCloudVideos(userId),
        fetchLibraryPdfs(userId),
        fetchPdfTrashMap(userId),
        fetchCloudSyncLedger(userId),
      ]);
      const ledgerRecord = ledgerRes.status === 'fulfilled' ? ledgerRes.value : null;
      const ledgerAvailable = Boolean(ledgerRecord?.available);
      if (videosRes.status === 'fulfilled') {
        reconcileLessons(userId, videosRes.value, ledgerRecord?.ledger.lessons ?? {});
      }
      if (pdfsRes.status === 'fulfilled') {
        const remoteTrash = trashRes.status === 'fulfilled' ? trashRes.value : null;
        reconcilePdfLibrary(
          userId,
          pdfsRes.value,
          remoteTrash,
          ledgerRecord?.ledger.pdfs ?? {},
          ledgerAvailable,
        );
      }
    } finally {
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        void refreshAccountState(userId);
      }
    }
  }, [reconcileLessons, reconcilePdfLibrary]);

  useEffect(() => {
    if (!cloudConfigured || !authReady || !authUser) {
      setSyncedUserId(null);
      setSyncStatus('local');
      lastSyncedRef.current = new Map();
      fullReconcileRef.current = false;
      return;
    }
    let cancelled = false;
    setSyncedUserId(null);
    setSyncStatus('syncing');
    setSyncMessage('Loading your study library…');
    // The merge below is the one place that reconciles local and cloud copies.
    lastSyncedRef.current = new Map();
    fullReconcileRef.current = true;
    (async () => {
      try {
        const [remoteVideos, capabilities, ledgerRecord] = await Promise.all([
          fetchCloudVideos(authUser.id),
          watchItemCapabilities(),
          fetchCloudSyncLedger(authUser.id).catch(() => null),
        ]);
        if (cancelled) return;
        setDeleteSyncMissing(!capabilities.sources && !capabilities.deletions);
        reconcileLessons(authUser.id, remoteVideos, ledgerRecord?.ledger.lessons ?? {});
        setSyncedUserId(authUser.id);
        setSyncStatus('synced');
        setSyncMessage('Your study library is synced.');
      } catch (error) {
        if (cancelled) return;
        setSyncStatus('error');
        setSyncMessage(error instanceof Error ? error.message : 'Cloud sync is unavailable. Your browser copy is still saved.');
      }
    })();
    return () => { cancelled = true; };
  }, [authReady, authUser?.id, reconcileLessons]);

  /**
   * Give a direct video link a real thumbnail: the first frame, read off the video itself.
   * A YouTube lesson already has i.ytimg.com for that; a file link has no picture at all, so
   * its card keeps the link placeholder until this succeeds (it only can when the host serves
   * the file with CORS headers — see src/lib/thumbnails.ts).
   */
  useEffect(() => {
    const record = activeRecord;
    if (!record || !isFileLesson(record) || !record.sourceUrl || record.thumbnail) return;
    if (posterAttemptsRef.current.has(record.videoId)) return;
    // This host already refused to hand over a frame; its cards show the live 00:01 frame.
    if (hostBlocksFrameCapture(record.sourceUrl)) return;
    posterAttemptsRef.current.add(record.videoId);
    let cancelled = false;
    // Let the player have the bandwidth first; the capture reads its own small range.
    const timer = window.setTimeout(() => {
      void captureVideoPoster(record.sourceUrl as string).then((capture) => {
        if (cancelled) return;
        if (capture.dataUrl) {
          updateVideo(record.videoId, { thumbnail: capture.dataUrl });
          showToast('Thumbnail saved from 00:01 of the video.');
          return;
        }
        if (capture.blocked) {
          // The card keeps showing the live 00:01 frame, so nothing looks broken — only the
          // saved copy that would follow the account is missing.
          console.info('This host does not allow its video frame to be read (no CORS headers). The library card shows the live 00:01 frame instead.');
        }
      });
    }, 1800);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeRecord?.videoId, activeRecord?.thumbnail, activeRecord?.sourceUrl, showToast, updateVideo]);

  // Load the account-backed PDF library, "Recently deleted" state, and per-PDF activity.
  // Guest uploads (session-only) are kept alongside it and migrated below.
  useEffect(() => {
    libraryMigratedRef.current = false;
    if (!cloudConfigured || !authReady || !authUser) {
      setLibraryPdfs((current) => current.filter((item) => item.sessionOnly));
      setLibraryLoading(false);
      setLibraryLoadedFor(null);
      return;
    }
    const userId = authUser.id;
    let cancelled = false;
    setLibraryLoading(true);
    (async () => {
      try {
        const [remotePdfs, remoteTrash, ledgerRecord, activityRes] = await Promise.all([
          fetchLibraryPdfs(userId),
          fetchPdfTrashMap(userId),
          fetchCloudSyncLedger(userId).catch(() => null),
          fetchPdfActivity(userId).catch(() => null),
        ]);
        if (cancelled) return;
        reconcilePdfLibrary(
          userId,
          remotePdfs,
          remoteTrash,
          ledgerRecord?.ledger.pdfs ?? {},
          Boolean(ledgerRecord?.available),
        );
        if (activityRes) {
          const remoteActivity = Object.fromEntries(activityRes.map((entry) => [
            entry.pdfId,
            { lastOpenedAt: entry.lastOpenedAt, pageCount: entry.pageCount },
          ]));
          setPdfActivity((current) => {
            const merged = { ...current };
            for (const [pdfId, info] of Object.entries(remoteActivity)) {
              const localInfo = merged[pdfId];
              merged[pdfId] = {
                lastOpenedAt: Math.max(localInfo?.lastOpenedAt ?? 0, info.lastOpenedAt ?? 0) || null,
                pageCount: info.pageCount ?? localInfo?.pageCount ?? null,
              };
            }
            return merged;
          });
        }
        setLibraryError('');
      } catch (error) {
        if (cancelled) return;
        setLibraryError(error instanceof Error ? error.message : 'Could not load your PDF library.');
      } finally {
        if (!cancelled) {
          setLibraryLoading(false);
          // Signals the migration effect below that the account list is in place.
          setLibraryLoadedFor(userId);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [authReady, authUser?.id, reconcilePdfLibrary]);

  // When a guest signs in, move the PDFs uploaded in that tab into their account so they sync.
  useEffect(() => {
    if (!cloudConfigured || !authUser || libraryMigratedRef.current) return;
    if (libraryLoadedFor !== authUser.id) return;
    const pending = libraryPdfs.filter((item) => item.sessionOnly && item.file);
    if (pending.length === 0) return;
    libraryMigratedRef.current = true;
    const userId = authUser.id;
    (async () => {
      setLibraryStatus(`Saving ${pending.length} PDF${pending.length === 1 ? '' : 's'} to your account…`);
      for (const item of pending) {
        try {
          const created = await createLibraryPdf(userId, item.file as File, item.subject);
          // Annotations drawn in guest mode follow the PDF under its new account id.
          moveAnnotationCache(item.id, created.id);
          setLibraryPdfs((current) => sortLibrary([created, ...current.filter((entry) => entry.id !== item.id)]));
        } catch (error) {
          setLibraryError(error instanceof Error
            ? `Could not save “${item.name}” to your account. ${error.message}`
            : `Could not save “${item.name}” to your account.`);
        }
      }
      setLibraryStatus('');
      showToast('Your PDFs are saved to your account now.');
    })();
  }, [authUser?.id, libraryLoadedFor, libraryPdfs, showToast]);

  // PDF drawings reach other devices through two tables. If this project has not had those
  // migrations run, say so as soon as the account loads, rather than only when a drawing
  // fails to save. The reader itself keeps working in this browser either way.
  useEffect(() => {
    if (!cloudConfigured || !authUser || libraryLoadedFor !== authUser.id) {
      setAnnotationTablesMissing([]);
      return;
    }
    let cancelled = false;
    void probeAnnotationTables()
      .then((probes) => {
        if (cancelled) return;
        setAnnotationTablesMissing(probes.filter((probe) => probe.missing).map((probe) => probe.table));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [authUser?.id, libraryLoadedFor]);

  useEffect(() => {
    if (!supabase || !authUser || syncedUserId !== authUser.id) return;
    const fullReconcile = fullReconcileRef.current;
    if (fullReconcile && videos.length === 0) {
      fullReconcileRef.current = false;
      return;
    }
    const pending = videos.filter((video) => (
      !isDeleted(deletionsRef.current, 'lesson', video.videoId)
      && (fullReconcile || lastSyncedRef.current.get(video.videoId) !== video.updatedAt)
    ));
    if (pending.length === 0) return;
    const userId = authUser.id;
    const timeout = window.setTimeout(async () => {
      const stillPending = pending.filter((video) => !isDeleted(deletionsRef.current, 'lesson', video.videoId));
      if (stillPending.length === 0) {
        fullReconcileRef.current = false;
        return;
      }
      setSyncStatus('syncing');
      try {
        // Writes stay independent: one failing lesson must not block the others.
        const results = await Promise.allSettled(stillPending.map(async (video) => {
          await saveCloudVideo(userId, video);
          return video;
        }));
        const failed: VideoRecord[] = [];
        results.forEach((result, index) => {
          const video = stillPending[index];
          if (result.status === 'fulfilled') {
            if (!isDeleted(deletionsRef.current, 'lesson', video.videoId)) {
              lastSyncedRef.current.set(video.videoId, video.updatedAt);
            }
          } else {
            failed.push(video);
          }
        });
        if (failed.length > 0) {
          const reason = results.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined;
          throw reason?.reason instanceof Error ? reason.reason : new Error(`Could not sync ${failed.length} lesson${failed.length === 1 ? '' : 's'}.`);
        }
        fullReconcileRef.current = false;
        setSyncStatus('synced');
        setSyncMessage('Your study library is synced.');
      } catch (error) {
        setSyncStatus('error');
        setSyncMessage(error instanceof Error ? error.message : 'Could not sync your library.');
      }
    }, 1100);
    return () => window.clearTimeout(timeout);
  }, [videos, authUser?.id, syncedUserId]);

  /**
   * Live + background cross-device sync for deletions, removals, restores and uploads:
   *   1. Subscribes to the account sync ledger over Supabase Realtime so an open tab on a
   *      second device reacts in milliseconds when anything is deleted or restored.
   *   2. Flushes pending lesson updates on tab hide / pagehide so closing a tab never drops
   *      a removal or progress update still waiting on the debounce.
   *   3. Re-reads the full account state on focus, visibility, reconnect, and every 15 s.
   */
  useEffect(() => {
    if (!supabase || !authUser || syncedUserId !== authUser.id) return;
    const userId = authUser.id;
    let stopped = false;

    const flushPendingVideos = () => {
      const unsent = videosRef.current.filter((video) => (
        !isDeleted(deletionsRef.current, 'lesson', video.videoId)
        && lastSyncedRef.current.get(video.videoId) !== video.updatedAt
      ));
      for (const video of unsent) {
        void saveCloudVideo(userId, video)
          .then(() => {
            if (!isDeleted(deletionsRef.current, 'lesson', video.videoId)) {
              lastSyncedRef.current.set(video.videoId, video.updatedAt);
            }
          })
          .catch(() => undefined);
      }
    };

    const refresh = () => {
      if (stopped || (typeof document !== 'undefined' && document.visibilityState !== 'visible')) return;
      void refreshAccountState(userId);
    };

    const unsubscribe = subscribeCloudSyncLedger(userId, () => {
      if (!stopped) void refreshAccountState(userId);
    });

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushPendingVideos();
      else refresh();
    };
    const onOnline = () => {
      flushPendingVideos();
      void refreshAccountState(userId);
    };

    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', flushPendingVideos);
    const timer = window.setInterval(refresh, 15000);
    return () => {
      stopped = true;
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', flushPendingVideos);
    };
  }, [authUser?.id, syncedUserId, refreshAccountState]);

  useEffect(() => {
    if (!activeVideoId) return;
    setVideos((current) => {
      const existing = current.find((video) => video.videoId === activeVideoId);
      if (!existing || existing.chaptersRaw === chaptersRaw) return current;
      const next = upsertVideo(current, {
        ...existing,
        chaptersRaw,
        updatedAt: nextLessonStamp(existing.updatedAt),
      });
      videosRef.current = next;
      return next;
    });
  }, [chaptersRaw, activeVideoId]);

  // Once a cloud-backed lesson is left, release its local File. Guest/failed uploads must
  // stay available for this tab, but opening many saved lessons should not retain every file.
  useEffect(() => {
    const videoId = activeVideoId;
    if (!videoId) return;
    return () => {
      if (notesSessionRef.current[videoId]?.cloudPath) delete notesSessionRef.current[videoId];
    };
  }, [activeVideoId]);

  // Resolve only when the actual source changes. Library refreshes create new arrays/sets
  // every 15 seconds; depending on those objects would repeatedly tear down the PDF reader.
  useEffect(() => {
    if (!activeVideoId) {
      setPdfPreview(null);
      setPdfLoading(false);
      return;
    }
    let cancelled = false;
    let objectUrl = '';
    setPdfPreview(null);
    if (previewFile) {
      try {
        // File/Blob URLs are immediate and avoid encoding and decoding PDFs up to 100 MB.
        objectUrl = URL.createObjectURL(previewFile);
        setPdfPreview({ url: objectUrl, cloud: false });
      } catch {
        setPdfError('This PDF could not be opened in the preview. Try uploading it again.');
      }
      setPdfLoading(false);
      return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }
    if (previewCloudPath) {
      setPdfLoading(true);
      setPdfError('');
      createPdfSignedUrl(previewCloudPath).then((url) => {
        if (!cancelled) setPdfPreview({ url, cloud: true });
      }).catch((error: unknown) => {
        if (!cancelled) setPdfError(error instanceof Error ? error.message : 'Could not load your saved PDF.');
      }).finally(() => { if (!cancelled) setPdfLoading(false); });
    } else {
      setPdfLoading(false);
    }
    return () => { cancelled = true; };
  }, [activeVideoId, previewFile, previewCloudPath, previewOwnerId]);

  // Resolve the URL for the PDF opened from the library (object URL for guests, signed link for accounts).
  useEffect(() => {
    const item = openLibraryPdf;
    if (!item) {
      setLibraryUrl('');
      setLibraryUrlLoading(false);
      return;
    }
    let cancelled = false;
    let objectUrl = '';
    setLibraryUrl('');
    if (item.sessionOnly && item.file) {
      objectUrl = URL.createObjectURL(item.file);
      setLibraryUrl(objectUrl);
      setLibraryUrlLoading(false);
      return () => {
        cancelled = true;
        URL.revokeObjectURL(objectUrl);
      };
    }
    if (!item.storagePath || !supabase) {
      setLibraryUrlLoading(false);
      return;
    }
    setLibraryUrlLoading(true);
    createPdfSignedUrl(item.storagePath).then((url) => {
      if (!cancelled) setLibraryUrl(url);
    }).catch((error: unknown) => {
      if (!cancelled) setLibraryError(error instanceof Error ? error.message : 'Could not open this PDF.');
    }).finally(() => {
      if (!cancelled) setLibraryUrlLoading(false);
    });
    return () => { cancelled = true; };
  }, [openLibraryPdf]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!notesExpanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setNotesExpanded(false); };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [notesExpanded]);

  const openTimestamps = useCallback(() => {
    const element = timestampsRef.current;
    if (!element) return;
    element.open = true;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const textarea = element.querySelector('textarea');
    window.setTimeout(() => textarea?.focus(), 350);
  }, []);

  const handlePlayerVideoChange = useCallback((info: PlayerVideoInfo) => {
    const existing = videosRef.current.find((video) => video.videoId === info.videoId);
    const kind = sourceRef.current?.kind === 'file' ? 'file' : existing?.sourceKind === 'file' ? 'file' : 'youtube';
    const record = existing ?? emptyVideoRecord(info.videoId, selectedSubject, kind);
    const prevTombstone = deletionsRef.current[deletionKey('lesson', info.videoId)] ?? 0;
    const updated: VideoRecord = {
      ...record,
      sourceKind: kind,
      sourceUrl: kind === 'file' ? (record.sourceUrl || sourceRef.current?.fileUrl) : undefined,
      title: info.title || record.title,
      channel: info.channel || record.channel,
      // Only a YouTube lesson has a thumbnail that can be derived from its id.
      thumbnail: kind === 'file' ? record.thumbnail : `https://i.ytimg.com/vi/${info.videoId}/hqdefault.jpg`,
      playlistId: playlistIdRef.current || record.playlistId,
      playlistIndex: info.playlistIndex ?? record.playlistIndex,
      archived: false,
      updatedAt: nextLessonStamp(record.updatedAt, prevTombstone),
    };
    const nextList = upsertVideo(videosRef.current, updated);
    videosRef.current = nextList;
    setVideos(nextList);
    setActiveVideoId(info.videoId);
    setPlayerReady(true);
    lastProgressSaveRef.current = -1;
    setChaptersRaw(record.chaptersRaw || '');
    setCurrentTime(record.currentTime || 0);
    setPlayerDuration(record.duration || 0);
    setPanelView(record.pdfPath || notesSessionRef.current[info.videoId] ? 'notes' : parseChapters(record.chaptersRaw || '').length > 0 ? 'timestamps' : 'notes');
    setPdfError('');
    setPdfStatus('');
    setNotesRevision((value) => value + 1);
    if (record.currentTime > 3) playerControlsRef.current?.seekTo(record.currentTime);
  }, [selectedSubject]);

  const handlePlayerTick = useCallback((seconds: number, duration: number) => {
    setCurrentTime((current) => Math.floor(current) === Math.floor(seconds) ? current : seconds);
    setPlayerDuration((current) => Math.abs(current - duration) > 0.5 ? duration : current);
    const elapsedBucket = Math.floor(seconds / 8);
    if (activeVideoId && elapsedBucket !== lastProgressSaveRef.current) {
      lastProgressSaveRef.current = elapsedBucket;
      const currentRecord = videosRef.current.find((video) => video.videoId === activeVideoId);
      if (currentRecord && Math.abs(currentRecord.currentTime - seconds) >= 4) {
        updateVideo(activeVideoId, { currentTime: seconds, duration: duration || currentRecord.duration });
      }
    }
  }, [activeVideoId, updateVideo]);

  /**
   * Open a lesson from whatever was pasted: a YouTube video/playlist link or a direct video
   * link (`.mp4`, an HLS playlist, a file-host download link…). Both kinds are saved in the
   * same library, keep their own progress, timestamps and notes, and follow the account.
   */
  function loadYouTubeVideo(event?: FormEvent<HTMLFormElement>, urlOverride?: string, subjectOverride?: Subject) {
    event?.preventDefault();
    setUrlError('');
    setPlayerError('');
    const value = urlOverride ?? urlInput;
    try {
      const parsed = parseLessonInput(value);
      const isFile = parsed.kind === 'file' && Boolean(parsed.fileUrl);
      const videoId = isFile ? fileLessonId(parsed.fileUrl as string) : parsed.videoId;
      playlistIdRef.current = parsed.playlistId;
      setIsPlaylist(Boolean(parsed.playlistId));
      setPlayerReady(Boolean(playerControlsRef.current));
      setPlayerState(-1);
      lastProgressSaveRef.current = -1;
      setCurrentTime(0);
      setPlayerDuration(0);
      setPdfStatus('');
      setPdfError('');
      setNotesExpanded(false);
      setUrlInput(value);

      let startPlaylistIndex: number | undefined;
      let startSeconds: number | undefined;
      if (videoId) {
        const existing = videosRef.current.find((video) => video.videoId === videoId);
        // Opening a lesson that was deleted — here or on another device — is the one thing
        // that lifts its tombstone. A cached copy alone never does (see lessonSync.ts).
        const prevTombstone = deletionsRef.current[deletionKey('lesson', videoId)] ?? 0;
        const wasDeleted = prevTombstone > 0;
        const revivedAt = nextLessonStamp(existing?.updatedAt ?? 0, prevTombstone);
        if (wasDeleted) {
          const cleared = withoutDeletion(deletionsRef.current, 'lesson', videoId);
          deletionsRef.current = cleared;
          setDeletions(cleared);
          lastSyncedRef.current.delete(videoId);
        }
        const baseRecord: VideoRecord = existing ?? (isFile
          ? fileVideoRecord(parsed.fileUrl as string, subjectOverride ?? selectedSubject)
          : emptyVideoRecord(videoId, subjectOverride ?? selectedSubject));
        const record: VideoRecord = {
          ...baseRecord,
          archived: false,
          updatedAt: revivedAt,
        };
        startPlaylistIndex = record.playlistIndex;
        startSeconds = record.currentTime > 3 ? record.currentTime : undefined;
        if (!existing) {
          const nextList = upsertVideo(videosRef.current, record);
          videosRef.current = nextList;
          setVideos(nextList);
        } else if (existing.archived || wasDeleted) {
          const unarchived = updateVideo(record.videoId, { archived: false, updatedAt: revivedAt });
          if (!wasDeleted) pushVideoNow(unarchived, true);
        }
        if (wasDeleted && authUser && supabase) {
          // Clear the account tombstone straight away (with a monotonic revival timestamp),
          // so a refresh cannot hide it again even if another device's clock was ahead.
          const userId = authUser.id;
          void clearCloudVideoDeletion(userId, videoId, revivedAt)
            .then(() => saveCloudVideo(userId, record))
            .then(() => {
              if (!isDeleted(deletionsRef.current, 'lesson', videoId)) {
                lastSyncedRef.current.set(videoId, record.updatedAt);
              }
              return pushCloudSyncLedger(userId, {
                lessons: { [videoId]: { status: 'active', at: revivedAt } },
                signalAt: revivedAt,
              });
            })
            .catch(() => undefined);
        }
        setActiveVideoId(videoId);
        setChaptersRaw(record.chaptersRaw || '');
        setPanelView(record.pdfPath || notesSessionRef.current[videoId] ? 'notes' : parseChapters(record.chaptersRaw || '').length > 0 ? 'timestamps' : 'notes');
        if (record.currentTime > 3) window.setTimeout(() => playerControlsRef.current?.seekTo(record.currentTime), 500);
      } else {
        setActiveVideoId(null);
        setChaptersRaw('');
        setPanelView('notes');
      }
      loadTokenRef.current += 1;
      const token = loadTokenRef.current;
      if (isFile) {
        setSource({
          kind: 'file',
          videoId,
          fileUrl: parsed.fileUrl,
          startSeconds,
          token,
        });
      } else {
        setSource({
          kind: 'youtube',
          videoId: parsed.videoId,
          playlistId: parsed.playlistId,
          ...(startPlaylistIndex !== undefined ? { playlistIndex: startPlaylistIndex } : {}),
          token,
        });
      }
    } catch (error) {
      setUrlError(error instanceof Error ? error.message : 'Please paste a YouTube link or a direct video link.');
    }
  }

  function resumeVideo(record: VideoRecord) {
    setSelectedSubject(record.subject);
    if (isFileLesson(record) && !record.sourceUrl) {
      // Only possible on a project without the newest migration: the link itself was never
      // stored, so the lesson cannot be reopened from its hash alone.
      showToast('This lesson has no saved link. Paste the video link again to reopen it.');
      return;
    }
    const url = lessonUrlFor(record);
    setUrlInput(url);
    loadYouTubeVideo(undefined, url, record.subject);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function onPlayerReady() {
    setPlayerReady(true);
    setPlayerError('');
  }

  function onPlayerError(message: string) {
    setPlayerError(message);
    setPlayerReady(true);
  }

  function onPlayerStateChange(state: number) {
    setPlayerState(state);
    if (state === 0 && activeVideoId) {
      updateVideo(activeVideoId, { currentTime: playerDuration || activeRecord?.duration || 0 });
    }
  }

  /** Rename a lesson (and move it to another subject). Saves to the browser and the account. */
  function renameVideo(record: VideoRecord, title: string, subject: Subject) {
    const nextTitle = title.trim().slice(0, 160);
    if (!nextTitle) return;
    const updated = updateVideo(record.videoId, { title: nextTitle, subject });
    pushVideoNow(updated, true);
    showToast('Lesson renamed.');
  }

  function archiveVideo(record: VideoRecord) {
    // Stop playback first when the active lesson is removed so player callbacks cannot
    // overwrite `archived: true` back to `false` a moment later.
    if (activeVideoId === record.videoId) {
      closeActiveStudyRoom();
    }
    const updated = updateVideo(record.videoId, { archived: true });
    pushVideoNow(updated, true);
    showToast('Removed from your library. You can restore it from Removed.');
  }

  async function downloadPdf(pdf: PdfPreview, name: string) {
    if (!pdf.cloud) {
      downloadFromUrl(pdf.url, name);
      return;
    }
    let url = pdf.url;
    try {
      // The reader can stay open longer than a signed URL's lifetime. Get a fresh link for
      // downloads without interrupting or reopening the document the user is reading.
      if (previewCloudPath) url = await createPdfSignedUrl(previewCloudPath);
      const response = await fetch(url);
      if (!response.ok) throw new Error('The download link expired.');
      const objectUrl = URL.createObjectURL(await response.blob());
      downloadFromUrl(objectUrl, name);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    } catch {
      // If the browser blocks a cross-origin download, let the PDF viewer open its signed URL.
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  /* ---------------------------- PDF library ---------------------------- */

  async function handleLibraryUpload(file: File, subject: Subject) {
    const problem = validateLibraryFile(file);
    if (problem) {
      setLibraryError(problem);
      return;
    }
    setLibraryError('');
    if (authUser && supabase && cloudConfigured) {
      const userId = authUser.id;
      setLibraryBusy(true);
      setLibraryStatus(`Uploading “${file.name}”…`);
      try {
        const created = await createLibraryPdf(userId, file, subject);
        const nextList = sortLibrary([created, ...libraryPdfsRef.current]);
        libraryPdfsRef.current = nextList;
        setLibraryPdfs(nextList);
        const syncEntry: PdfSyncEntry = { status: 'active', at: created.updatedAt };
        setPdfSync((current) => {
          const next = { ...current, [created.id]: syncEntry };
          pdfSyncRef.current = next;
          return next;
        });
        void pushCloudSyncLedger(userId, {
          pdfs: { [created.id]: syncEntry },
          signalAt: created.updatedAt,
        }).catch(() => undefined);
        setLibraryStatus('Saved to your private library.');
        showToast('PDF added to your library.');
      } catch (error) {
        setLibraryStatus('');
        setLibraryError(error instanceof Error ? error.message : 'The upload failed. Please try again.');
      } finally {
        setLibraryBusy(false);
        window.setTimeout(() => setLibraryStatus((value) => (value === 'Saved to your private library.' ? '' : value)), 3500);
      }
      return;
    }
    // Guest: keep the file in this tab so nothing is lost mid-session; sign-in moves it to the cloud.
    setLibraryPdfs((current) => sortLibrary([sessionLibraryItem(file, subject), ...current]));
    setLibraryStatus('Saved for this tab. Sign in to keep it across devices.');
    showToast('PDF added — sign in to keep it across devices.');
    window.setTimeout(() => setLibraryStatus(''), 6000);
  }

  async function downloadLibraryItem(item: LibraryPdf) {
    try {
      if (item.sessionOnly && item.file) {
        const objectUrl = URL.createObjectURL(item.file);
        downloadFromUrl(objectUrl, item.name);
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
        return;
      }
      const signedUrl = await createPdfSignedUrl(item.storagePath);
      const response = await fetch(signedUrl);
      if (!response.ok) throw new Error('The download link expired.');
      const objectUrl = URL.createObjectURL(await response.blob());
      downloadFromUrl(objectUrl, item.name);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    } catch {
      try {
        window.open(await createPdfSignedUrl(item.storagePath), '_blank', 'noopener,noreferrer');
      } catch {
        setLibraryError('This PDF could not be downloaded right now.');
      }
    }
  }

  /** Deleting from the library moves the PDF to "Recently deleted" so it can be restored or deleted forever. */
  async function deleteLibraryItem(item: LibraryPdf) {
    setLibraryError('');
    const prevAt = pdfSyncRef.current[item.id]?.at ?? pdfTrashRef.current[item.id] ?? 0;
    const deletedAt = nextLessonStamp(prevAt, item.updatedAt);

    setPdfTrash((current) => {
      const next = { ...current, [item.id]: deletedAt };
      pdfTrashRef.current = next;
      return next;
    });
    if (!item.sessionOnly) {
      const syncEntry: LocalPdfSyncEntry = { status: 'trashed', at: deletedAt, deletedAt, pending: true };
      setPdfSync((current) => {
        const next = { ...current, [item.id]: syncEntry };
        pdfSyncRef.current = next;
        return next;
      });
    }
    if (openLibraryPdf?.id === item.id) setOpenLibraryPdf(null);
    showToast('PDF moved to Recently deleted.');

    if (!item.sessionOnly && authUser && supabase) {
      const userId = authUser.id;
      const [trashRes, ledgerRes] = await Promise.allSettled([
        trashLibraryPdf(userId, item.id, deletedAt),
        pushCloudSyncLedger(userId, {
          pdfs: { [item.id]: { status: 'trashed', at: deletedAt, deletedAt } },
          signalAt: deletedAt,
        }),
      ]);
      const trashTableOk = trashRes.status === 'fulfilled';
      const ledgerOk = ledgerRes.status === 'fulfilled' && ledgerRes.value.available;
      if (trashTableOk || ledgerOk) {
        setTrashUnavailable(false);
        setPdfSync((current) => {
          const cur = current[item.id];
          if (!cur || cur.status !== 'trashed' || cur.at !== deletedAt) return current;
          const next = { ...current, [item.id]: { status: 'trashed' as const, at: deletedAt, deletedAt } };
          pdfSyncRef.current = next;
          return next;
        });
      } else if (ledgerRes.status === 'fulfilled' && !ledgerRes.value.available) {
        setTrashUnavailable(true);
      }
    }
  }

  /** Bring a PDF back from "Recently deleted". Nothing was removed from storage. */
  async function restoreTrashedPdf(item: LibraryPdf) {
    setLibraryError('');
    const prevAt = pdfSyncRef.current[item.id]?.at ?? pdfTrashRef.current[item.id] ?? 0;
    const restoredAt = nextLessonStamp(prevAt, item.updatedAt);

    setPdfTrash((current) => {
      const next = { ...current };
      delete next[item.id];
      pdfTrashRef.current = next;
      return next;
    });
    if (!item.sessionOnly) {
      const syncEntry: LocalPdfSyncEntry = { status: 'active', at: restoredAt, pending: true };
      setPdfSync((current) => {
        const next = { ...current, [item.id]: syncEntry };
        pdfSyncRef.current = next;
        return next;
      });
    }
    showToast('PDF restored to your library.');

    if (!item.sessionOnly && authUser && supabase) {
      const userId = authUser.id;
      const [restoreRes, ledgerRes] = await Promise.allSettled([
        restoreLibraryPdf(userId, item.id),
        pushCloudSyncLedger(userId, {
          pdfs: { [item.id]: { status: 'active', at: restoredAt } },
          signalAt: restoredAt,
        }),
      ]);
      const restoreTableOk = restoreRes.status === 'fulfilled';
      const ledgerOk = ledgerRes.status === 'fulfilled' && ledgerRes.value.available;
      if (restoreTableOk || ledgerOk) {
        setTrashUnavailable(false);
        setPdfSync((current) => {
          const cur = current[item.id];
          if (!cur || cur.status !== 'active' || cur.at !== restoredAt) return current;
          const next = { ...current, [item.id]: { status: 'active' as const, at: restoredAt } };
          pdfSyncRef.current = next;
          return next;
        });
      } else if (ledgerRes.status === 'fulfilled' && !ledgerRes.value.available) {
        setTrashUnavailable(true);
      }
    }
  }

  /** "Delete forever": removes the file from storage and the row from the library. */
  async function deleteLibraryItemForever(item: LibraryPdf) {
    setLibraryError('');
    const prevDel = deletionsRef.current[deletionKey('pdf', item.id)] ?? 0;
    const prevSync = pdfSyncRef.current[item.id]?.at ?? pdfTrashRef.current[item.id] ?? 0;
    const deletedAt = nextLessonStamp(Math.max(prevSync, item.updatedAt), prevDel);

    // Record the tombstone locally first so even if the network drops mid-delete, this PDF
    // stays gone here and `reconcilePdfLibrary` finishes removing it on reconnect.
    const nextDel = withDeletion(deletionsRef.current, 'pdf', item.id, deletedAt);
    deletionsRef.current = nextDel;
    setDeletions(nextDel);
    if (!item.sessionOnly) {
      const syncEntry: LocalPdfSyncEntry = { status: 'deleted', at: deletedAt, pending: true };
      setPdfSync((current) => {
        const next = { ...current, [item.id]: syncEntry };
        pdfSyncRef.current = next;
        return next;
      });
    }

    // Any lesson still pointing at this PDF keeps its timestamps — only the notes link clears.
    if (item.storagePath) {
      const affected = videosRef.current.filter((video) => video.pdfPath && video.pdfPath === item.storagePath);
      for (const video of affected) {
        const updated = updateVideo(video.videoId, {
          pdfPath: undefined,
          pdfName: undefined,
          pdfSize: undefined,
        });
        pushVideoNow(updated, false);
      }
    }

    const nextItems = libraryPdfsRef.current.filter((entry) => entry.id !== item.id);
    libraryPdfsRef.current = nextItems;
    setLibraryPdfs(nextItems);
    setPdfTrash((current) => {
      const next = { ...current };
      delete next[item.id];
      pdfTrashRef.current = next;
      return next;
    });
    setPdfActivity((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    deleteLocalAnnotations(item.id);
    if (openLibraryPdf?.id === item.id) setOpenLibraryPdf(null);

    let syncedToCloud = true;
    if (!item.sessionOnly && authUser && supabase) {
      const userId = authUser.id;
      setLibraryBusy(true);
      const [delRes, ledgerRes] = await Promise.allSettled([
        deleteLibraryPdf(userId, item),
        pushCloudSyncLedger(userId, {
          pdfs: { [item.id]: { status: 'deleted', at: deletedAt } },
          signalAt: deletedAt,
        }),
      ]);
      setLibraryBusy(false);
      if (delRes.status === 'rejected') {
        syncedToCloud = false;
        console.warn('Could not delete this PDF from the account yet:', delRes.reason);
      } else if (ledgerRes.status === 'fulfilled') {
        setPdfSync((current) => {
          const cur = current[item.id];
          if (!cur || cur.status !== 'deleted' || cur.at !== deletedAt) return current;
          const next = { ...current, [item.id]: { status: 'deleted' as const, at: deletedAt } };
          pdfSyncRef.current = next;
          return next;
        });
      }
    }

    showToast(syncedToCloud
      ? 'PDF deleted forever.'
      : 'Deleted here. Your account was unreachable, so it will retry automatically.');
  }

  async function renameLibraryItem(item: LibraryPdf, name: string, subject: Subject) {
    const nextName = name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
    const updated: LibraryPdf = { ...item, name: nextName, subject, updatedAt: nextLessonStamp(item.updatedAt) };
    setLibraryPdfs((current) => sortLibrary(current.map((entry) => (entry.id === item.id ? updated : entry))));
    setOpenLibraryPdf((current) => (current && current.id === item.id ? updated : current));
    if (item.sessionOnly || !authUser || !supabase) return;
    setLibraryError('');
    try {
      await updateLibraryPdf(authUser.id, item.id, { name: nextName, subject });
      const affected = videosRef.current.filter((video) => video.pdfPath && video.pdfPath === item.storagePath);
      for (const video of affected) {
        const renamedLesson = updateVideo(video.videoId, { pdfName: nextName });
        pushVideoNow(renamedLesson, false);
      }
      void pushCloudSyncLedger(authUser.id, { signalAt: updated.updatedAt }).catch(() => undefined);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : 'Could not rename this PDF.');
    }
  }

  /** Remember when a PDF was last opened, so "Recently opened" can be shown in the panel. */
  function notePdfOpened(item: LibraryPdf) {
    const openedAt = Date.now();
    setPdfActivity((current) => ({
      ...current,
      [item.id]: { lastOpenedAt: openedAt, pageCount: current[item.id]?.pageCount ?? null },
    }));
    if (authUser && !item.sessionOnly) {
      // Fail soft: an older project without the activity table must not break the reader.
      void savePdfActivity(authUser.id, item.id, { lastOpenedAt: openedAt }).catch(() => undefined);
    }
  }

  /** Called by the reader once a PDF's page count is known. */
  function handlePdfPageCount(pdfId: string, pageCount: number) {
    setPdfActivity((current) => ({
      ...current,
      [pdfId]: { lastOpenedAt: current[pdfId]?.lastOpenedAt ?? Date.now(), pageCount },
    }));
    if (authUser && !pdfId.startsWith('lesson:')) {
      void savePdfActivity(authUser.id, pdfId, { lastOpenedAt: Date.now(), pageCount }).catch(() => undefined);
    }
  }

  function attachLibraryPdf(item: LibraryPdf) {
    if (!activeVideoId) {
      setLibraryError('Load a lesson first, then attach a PDF to it.');
      return;
    }
    if (item.sessionOnly) {
      if (!item.file) {
        setLibraryError('Sign in to attach library PDFs to a lesson.');
        return;
      }
      notesSessionRef.current[activeVideoId] = { file: item.file, name: item.name, size: item.size };
      updateVideo(activeVideoId, { pdfName: item.name, pdfSize: item.size });
      setNotesRevision((value) => value + 1);
      setPdfError('');
      setPdfStatus('Attached for this session.');
      setPanelView('notes');
      notePdfOpened(item);
      showToast('PDF attached to this lesson.');
      return;
    }
    setLibraryError('');
    // A lesson-level PDF would shadow the library copy, so clear it before linking.
    delete notesSessionRef.current[activeVideoId];
    const updated = updateVideo(activeVideoId, { pdfPath: item.storagePath, pdfName: item.name, pdfSize: item.size });
    pushVideoNow(updated, true);
    setNotesRevision((value) => value + 1);
    setPdfError('');
    setPdfStatus('');
    setPanelView('notes');
    notePdfOpened(item);
    showToast('PDF attached to this lesson.');
  }

  async function handleSignOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setAuthUser(null);
    setSyncedUserId(null);
    setSyncStatus('local');
    setOpenLibraryPdf(null);
    showToast('Signed out. Your local browser copy is still here.');
  }

  function handlePdfSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void handlePdfUpload(file);
  }

  async function handlePdfUpload(file: File) {
    setPanelView('notes');
    const videoId = activeVideoId;
    if (!videoId) {
      setPdfError('Load a video before adding its notes.');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      setPdfError('Only PDF files are supported.');
      return;
    }
    if (file.size > MAX_PDF_SIZE) {
      setPdfError('This PDF is larger than 100 MB. Choose a smaller file.');
      return;
    }

    // Open the original File immediately, while the cloud upload runs in parallel.
    const session: SessionPdf = { file, name: file.name, size: file.size };
    const record = videosRef.current.find((video) => video.videoId === videoId);
    notesSessionRef.current[videoId] = session;
    setNotesRevision((value) => value + 1);
    setPdfError('');

    if (!authUser || !supabase || !cloudConfigured) {
      setPdfStatus('Session storage — notes are kept while the page is open.');
      return;
    }

    const userId = authUser.id;
    // A PDF linked from the library is never deleted when a lesson replaces its notes.
    const previousPath = isLibraryPath(record?.pdfPath) ? undefined : record?.pdfPath;
    setPdfUpload({ videoId, session });
    setPdfStatus('Saving notes to your private cloud library…');
    try {
      const path = await uploadCloudPdf(userId, videoId, file);
      // A later replacement, removal, account change, or remote deletion must not be
      // overwritten by this slower upload completing out of order.
      if (notesSessionRef.current[videoId] !== session || authUserIdRef.current !== userId
        || !videosRef.current.some((video) => video.videoId === videoId)
        || isDeleted(deletionsRef.current, 'lesson', videoId)) {
        void deleteCloudPdf(path).catch(() => undefined);
        return;
      }
      // Keep showing the same local File after upload instead of downloading and parsing it
      // again. If the lesson is no longer open, release it and use the cloud copy next time.
      if (activeVideoIdRef.current === videoId) {
        notesSessionRef.current[videoId] = { ...session, cloudPath: path, ownerId: userId };
      } else {
        delete notesSessionRef.current[videoId];
      }
      const updated = updateVideo(videoId, { pdfPath: path, pdfName: file.name, pdfSize: file.size });
      pushVideoNow(updated, true);
      setNotesRevision((value) => value + 1);
      if (previousPath && previousPath !== path) void deleteCloudPdf(previousPath).catch(() => undefined);
      if (activeVideoIdRef.current === videoId) {
        setPdfStatus('Saved to your private cloud library.');
        showToast('PDF notes synced to your account.');
      }
    } catch (error) {
      if (notesSessionRef.current[videoId] === session && activeVideoIdRef.current === videoId) {
        setPdfStatus('Session storage — notes are kept while the page is open.');
        setPdfError(error instanceof Error ? `Cloud upload failed; this PDF is available for this session. ${error.message}` : 'Cloud upload failed; this PDF is available for this session.');
      }
    } finally {
      setPdfUpload((current) => current?.session === session ? null : current);
    }
  }

  function deletePdf() {
    if (!activeVideoId) return;
    const videoId = activeVideoId;
    // Invalidate an in-flight upload before doing any network work, so it cannot restore a
    // PDF that was just removed. A library file is only unlinked, never deleted here.
    delete notesSessionRef.current[videoId];
    setPdfUpload((current) => current?.videoId === videoId ? null : current);
    deleteLocalAnnotations(`lesson:${videoId}`);
    if (activeRecord?.pdfPath && authUser && supabase && !isLibraryPath(activeRecord.pdfPath)) {
      void deleteCloudPdf(activeRecord.pdfPath).catch(() => undefined);
    }
    // The note's synced drawings go with it, so a later PDF on this lesson starts clean.
    if (authUser && supabase && !linkedLibraryPdf) {
      void deleteCloudLessonAnnotations(authUser.id, videoId).catch(() => undefined);
    }
    const updated = updateVideo(videoId, { pdfPath: undefined, pdfName: undefined, pdfSize: undefined });
    pushVideoNow(updated, true);
    setPdfPreview(null);
    setNotesRevision((value) => value + 1);
    setPdfStatus('');
    setPdfError('');
    showToast('PDF notes removed.');
  }

  const libraryVideos = videos.filter((video) => !video.archived);
  const removedVideos = videos.filter((video) => video.archived);
  const showingRemoved = libraryFilter === 'removed';
  const filteredLibrary = showingRemoved ? [] : libraryVideos.filter((video) => libraryFilter === 'all' || video.subject === libraryFilter);
  const availableSubjects = subjects.filter((subject) => libraryVideos.some((video) => video.subject === subject));
  const libraryVisible = libraryVideos.length > 0 || removedVideos.length > 0 || showingRemoved;

  const activeLibraryPdfs = libraryPdfs.filter((item) => !pdfTrash[item.id]);
  const deletedLibraryPdfs = libraryPdfs
    .filter((item) => pdfTrash[item.id])
    .sort((a, b) => (pdfTrash[b.id] ?? 0) - (pdfTrash[a.id] ?? 0));
  /** Storage meter: the sum of the sizes already stored for each library PDF. */
  const libraryUsedBytes = activeLibraryPdfs.reduce((total, item) => total + (Number(item.size) || 0), 0);

  /** A PDF is "linked from the library" when it lives under the library prefix or a library row points at it. */
  function pdfLinkedFromLibrary(path?: string): boolean {
    if (!path) return false;
    if (isLibraryPath(path)) return true;
    return libraryPdfs.some((item) => Boolean(item.storagePath) && item.storagePath === path);
  }

  function restoreVideo(record: VideoRecord) {
    const updated = updateVideo(record.videoId, { archived: false });
    pushVideoNow(updated, true);
    if (removedVideos.length <= 1) setLibraryFilter('all');
    showToast('Lesson restored to your library.');
  }

  /**
   * Remove a lesson and its data for good. The lesson PDF is deleted from storage too —
   * except when that same file is linked from the PDF library, which is never touched.
   */
  async function deleteVideoForever(record: VideoRecord) {
    const keepLibraryPdf = pdfLinkedFromLibrary(record.pdfPath);
    const removesLessonPdf = Boolean(record.pdfPath) && !keepLibraryPdf;
    const prevDel = deletionsRef.current[deletionKey('lesson', record.videoId)] ?? 0;
    const deletedAt = nextLessonStamp(record.updatedAt, prevDel);

    // The tombstone is written here first, on purpose: even if the account write below fails
    // (offline, or an older project), this device must never merge the lesson back. The
    // sign-in / focus refresh retries the account write for every pending tombstone.
    const nextDel = withDeletion(deletionsRef.current, 'lesson', record.videoId, deletedAt);
    deletionsRef.current = nextDel;
    setDeletions(nextDel);
    lastSyncedRef.current.delete(record.videoId);

    delete notesSessionRef.current[record.videoId];
    deleteLocalAnnotations(`lesson:${record.videoId}`);
    const nextVideos = videosRef.current.filter((video) => video.videoId !== record.videoId);
    videosRef.current = nextVideos;
    setVideos(nextVideos);
    // Stop the study room when the lesson on screen is the one being deleted, so playback
    // ticks cannot re-create the record that was just removed.
    if (activeVideoId === record.videoId) {
      closeActiveStudyRoom();
    }
    if (removedVideos.length <= 1) setLibraryFilter('all');

    let syncedToCloud = true;
    setLibraryError('');
    if (authUser && supabase) {
      const userId = authUser.id;
      if (removesLessonPdf) {
        try {
          await deleteCloudPdf(record.pdfPath as string);
        } catch {
          // Proceed even if the storage object was already removed.
        }
      }
      void deleteCloudLessonAnnotations(userId, record.videoId).catch(() => undefined);
      setLibraryBusy(true);
      const [videoDelRes, ledgerRes] = await Promise.allSettled([
        deleteCloudVideo(userId, record.videoId, deletedAt),
        pushCloudSyncLedger(userId, {
          lessons: { [record.videoId]: { status: 'deleted', at: deletedAt } },
          signalAt: deletedAt,
        }),
      ]);
      setLibraryBusy(false);
      const ledgerOk = ledgerRes.status === 'fulfilled' && ledgerRes.value.available;
      if (videoDelRes.status === 'rejected' && !ledgerOk) {
        syncedToCloud = false;
        console.warn('Could not remove this lesson from the account yet:', videoDelRes.reason);
      }
    }

    showToast(syncedToCloud
      ? 'Lesson deleted forever.'
      : 'Deleted here. Your account was unreachable, so it will retry automatically.');
  }

  useEffect(() => {
    function handleShortcuts(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      // Never while typing.
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      // A button, link or disclosure that is not part of the player keeps its own keys
      // (Space activates it). Inside the player card the shortcuts always win, so clicking a
      // control and then pressing Space still plays and pauses instead of doing nothing.
      if (!target?.closest('.player-card') && target?.closest('button, a, summary, [role="button"]')) return;
      const controls = playerControlsRef.current;
      if (!controls || !activeVideoId) return;
      const key = event.key.toLowerCase();
      if (event.code === 'Space' || key === 'k') { event.preventDefault(); controls.togglePlayback(); }
      else if (key === 'arrowleft') { event.preventDefault(); controls.seekBy(-10); }
      else if (key === 'arrowright') { event.preventDefault(); controls.seekBy(10); }
      else if (key === 'j') { event.preventDefault(); controls.seekBy(-10); }
      else if (key === 'l') { event.preventDefault(); controls.seekBy(10); }
      else if (key === 'arrowup') { event.preventDefault(); controls.adjustVolume(5); }
      else if (key === 'arrowdown') { event.preventDefault(); controls.adjustVolume(-5); }
      else if (key === 'f') { event.preventDefault(); controls.toggleFullscreen(); }
      else if (key === 'm') { event.preventDefault(); controls.toggleMute(); }
      else if (key === 'c') { event.preventDefault(); controls.toggleCaptions(); }
    }
    document.addEventListener('keydown', handleShortcuts);
    return () => document.removeEventListener('keydown', handleShortcuts);
  }, [activeVideoId]);

  const progress = activeRecord ? progressPercent({ ...activeRecord, currentTime, duration: playerDuration || activeRecord.duration }) : 0;
  const watched = formatTime(currentTime);

  const urlHelperLabel = useMemo(() => {
    const value = urlInput.trim();
    if (!value) return 'YOUTUBE';
    if (isYouTubeLink(value)) return 'YOUTUBE';
    return /^https?:\/\//i.test(value) ? 'VIDEO LINK' : 'LINK';
  }, [urlInput]);

  const loadForm = (
    <form className="video-load-form" onSubmit={(event) => loadYouTubeVideo(event)}>
      <div className="url-input-wrap">
        <span className="url-play-icon"><Play size={15} fill="currentColor" /></span>
        <input
          aria-label="YouTube video, playlist or direct video link"
          value={urlInput}
          onChange={(event) => { setUrlInput(event.target.value); setUrlError(''); }}
          placeholder="Paste a YouTube link, or any direct video link…"
        />
        <span className="url-helper">{urlHelperLabel}</span>
      </div>
      <label className="subject-select-label">
        <span className="sr-only">Subject</span>
        <select value={selectedSubject} onChange={(event) => setSelectedSubject(event.target.value as Subject)} aria-label="Choose a JEE subject">
          {subjects.map((subject) => <option key={subject}>{subject}</option>)}
        </select>
        <ChevronDown size={13} />
      </label>
      <button className="button-primary load-button" type="submit"><span>{source ? 'Load video' : 'Start studying'}</span><ArrowRight size={17} /></button>
    </form>
  );

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="grid-overlay" />
      <div className="page-content">
        <header className="topbar">
          <a className="brand" href="#top" aria-label="Focusframe home">
            <span className="brand-mark"><Play size={15} fill="currentColor" /></span>
            <span className="brand-name">focusframe<span>.</span></span>
            <span className="brand-divider" />
            <span className="brand-subtitle">JEE STUDY PLAYER</span>
          </a>
          <div className="topbar-actions">
            <div className={`sync-pill ${syncStatus}`} title={syncMessage || (storageAvailable ? 'Saved locally in this browser' : 'Browser storage is unavailable; current tab remains usable')}>
              {syncStatus === 'syncing' ? <span className="mini-spinner" /> : syncStatus === 'synced' ? <Cloud size={14} /> : syncStatus === 'error' ? <CloudOff size={14} /> : <HardDrive size={14} />}
              <span>{syncStatus === 'syncing' ? 'Syncing' : syncStatus === 'synced' ? 'Synced' : syncStatus === 'error' ? 'Sync issue' : storageAvailable ? 'Saved on this device' : 'Session only'}</span>
              {syncStatus === 'error' && <Info size={13} />}
            </div>
            {authUser ? (
              <div className="account-controls">
                <button className="account-chip" onClick={() => showToast(syncMessage || 'Your library is synced to this account.')} title={authUser.email || 'Account settings'}><span className="account-avatar">{(authUser.email || 'S').slice(0, 1).toUpperCase()}</span><span className="account-email">{authUser.email}</span><ChevronDown size={13} /></button>
                <button className="sign-out-button" onClick={() => void handleSignOut()}>Sign out</button>
              </div>
            ) : (
              <button className="button-quiet sign-in-button" onClick={() => setAuthOpen(true)}><Cloud size={15} /> Sync across devices</button>
            )}
          </div>
        </header>

        {deleteSyncMissing && (
          <p className="cloud-warning annotation-sync-warning" role="status">
            <CloudOff size={14} />
            <span className="annotation-sync-warning-text">
              Deleted lessons and direct video links are only kept in this browser: this Supabase project is missing the
              newest lesson columns. Run <code>supabase/migrations/008_source_links_and_deletes.sql</code> in Supabase →
              SQL Editor, then reload this page so deletions and video links follow your account.
            </span>
          </p>
        )}

        {annotationTablesMissing.length > 0 && (
          <p className="cloud-warning annotation-sync-warning" role="status">
            <CloudOff size={14} />
            <span className="annotation-sync-warning-text">
              PDF drawings are saved in this browser only: this Supabase project has no {annotationTablesMissing.join(' or ')} table yet.
              Run <code>{annotationMigrationHint(annotationTablesMissing)}</code> in Supabase → SQL Editor, then reload this page to sync them across devices.
            </span>
          </p>
        )}

        <main id="top">
          {!source ? (
            <section className="hero">
              <div className="hero-copy">
                <p className="eyebrow hero-eyebrow"><span className="live-dot" /> TIMESTAMPS AND NOTES, SIDE BY SIDE</p>
                <h1>Your JEE one-shots,<br className="desktop-break" /> with your <em>notes open.</em></h1>
                <p className="hero-description">Watch the lesson, follow the timestamps, and read your PDF notes right beside the video — on any device. YouTube links and direct video links both work.</p>
              </div>
              {loadForm}
              {urlError && <p className="url-error" role="alert"><CircleHelp size={14} /> {urlError}</p>}
              {syncStatus === 'error' && <p className="cloud-warning"><CloudOff size={14} /> Cloud sync paused. Your local browser copy is still available. <span title={syncMessage}>Details</span></p>}
            </section>
          ) : (
            <section className="load-bar">
              {loadForm}
              {urlError && <p className="url-error" role="alert"><CircleHelp size={14} /> {urlError}</p>}
            </section>
          )}

          {!source && (
            <section className="welcome-section">
              <div className="welcome-heading"><span className="welcome-kicker">THREE STEPS, THEN JUST FOCUS</span><span className="welcome-line" /></div>
              <div className="welcome-cards">
                <article className="welcome-card">
                  <div className="welcome-icon mint"><Film size={20} /></div>
                  <span className="welcome-number">01</span>
                  <h3>Paste a lesson</h3>
                  <p>A YouTube one-shot, a playlist, or any direct video link starts the room.</p>
                </article>
                <article className="welcome-card">
                  <div className="welcome-icon lavender"><ListMusic size={20} /></div>
                  <span className="welcome-number">02</span>
                  <h3>Add the timestamps</h3>
                  <p>Paste the chapter list once and jump to any topic instantly.</p>
                </article>
                <article className="welcome-card">
                  <div className="welcome-icon amber"><FileText size={20} /></div>
                  <span className="welcome-number">03</span>
                  <h3>Keep notes beside the video</h3>
                  <p>Attach a PDF and read it side by side, on desktop and mobile.</p>
                </article>
              </div>
              <div className="welcome-footnote"><ShieldCheck size={16} /> No demo videos. Your space is yours to fill.</div>
            </section>
          )}

          {source && (
            <section className={`workspace ${notesExpanded ? 'notes-expanded' : ''}`} aria-label="Study room">
              <article className="player-card glass-card workspace-player">
                <div className="player-topline"><div className="player-live-label"><span className="live-dot" /> STUDY ROOM <span className="topline-slash">/</span> <span>{source?.kind === 'file' ? 'DIRECT VIDEO' : isPlaylist ? 'PLAYLIST' : 'NOW PLAYING'}</span></div><div className={`player-state ${playerError ? 'error' : playerState === 1 ? 'playing' : ''}`}><span />{playerError ? 'Check video details' : playerState === 1 ? 'In session' : playerReady ? 'Ready when you are' : 'Connecting'}</div></div>
                {source.kind === 'file' ? (
                  <FilePlayer
                    source={source}
                    poster={activeRecord?.thumbnail || undefined}
                    controlsRef={playerControlsRef}
                    onReady={onPlayerReady}
                    onStateChange={onPlayerStateChange}
                    onVideoChange={handlePlayerVideoChange}
                    onTick={handlePlayerTick}
                    onError={onPlayerError}
                  />
                ) : (
                  <YouTubePlayer
                    source={source}
                    controlsRef={playerControlsRef}
                    onReady={onPlayerReady}
                    onStateChange={onPlayerStateChange}
                    onVideoChange={handlePlayerVideoChange}
                    onTick={handlePlayerTick}
                    onError={onPlayerError}
                  />
                )}
                <div className="player-meta">
                  <div className="player-title-wrap">
                    <span className={`subject-tag ${subjectClass(activeSubject)}`}>{activeSubject}</span>
                    <h2>{activeTitle}</h2>
                    <p>{activeRecord?.channel || (isFileLesson(activeRecord) ? 'Direct video link' : 'YouTube study session')} <span>·</span> {playerDuration ? formatTime(playerDuration) : 'Duration appears when the video is ready'}</p>
                  </div>
                  <div className="player-meta-actions">
                    <span className="watch-time"><span>WATCHED</span><strong>{watched}{playerDuration ? ` / ${formatTime(playerDuration)}` : ''}</strong></span>
                    <button className="notes-jump" onClick={() => { setPanelView('notes'); document.querySelector('.study-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}><FileText size={15} /> Notes</button>
                  </div>
                </div>
                <div className="player-progress"><span style={{ width: `${progress}%` }} /></div>
                <details className="shortcut-disclosure">
                  <summary><span><Zap size={15} /> Keyboard shortcuts</span><span className="shortcut-summary-action">Show <ChevronDown size={15} /></span></summary>
                  <div className="shortcut-strip"><span><Zap size={14} /> QUICK KEYS</span><kbd>Space</kbd><small>play</small><kbd>←</kbd><kbd>→</kbd><small>seek</small><kbd>J</kbd><kbd>L</kbd><small>±10s</small><kbd>F</kbd><small>fullscreen</small><kbd>M</kbd><small>mute</small><kbd>C</kbd><small>captions</small></div>
                </details>
              </article>

              <aside className="study-panel glass-card">
                <div className="panel-tabs" role="tablist" aria-label="Notes and timestamps">
                  <button role="tab" aria-selected={panelView === 'notes'} className={panelView === 'notes' ? 'active' : ''} onClick={() => setPanelView('notes')}><FileText size={16} /> Notes{pdfPreview && <span className="tab-dot" />}</button>
                  <button role="tab" aria-selected={panelView === 'timestamps'} className={panelView === 'timestamps' ? 'active' : ''} onClick={() => { setPanelView('timestamps'); setNotesExpanded(false); }}><ListMusic size={16} /> Timestamps{parsedChapters.length > 0 && <span className="tab-count">{parsedChapters.length}</span>}</button>
                </div>
                <div className="panel-body" role="tabpanel">
                  <PdfViewer
                    url={pdfPreview?.url ?? ''}
                    name={pdfName}
                    size={pdfSize}
                    cloud={Boolean(pdfPreview?.cloud || sessionPdf?.cloudPath)}
                    uploading={pdfBusy || pdfLoading}
                    error={pdfError}
                    status={lessonAnnotations.annotateStatus || pdfStatus}
                    locked={Boolean(activeRecord?.pdfPath && !authUser && !sessionPdf)}
                    expanded={notesExpanded}
                    hidden={panelView !== 'notes'}
                    annotations={pdfPreview?.url ? lessonAnnotations.bridge : null}
                    onPageCount={(count) => linkedLibraryPdf && handlePdfPageCount(linkedLibraryPdf.id, count)}
                    onPickFile={() => fileInputRef.current?.click()}
                    onFile={(file) => void handlePdfUpload(file)}
                    onRemove={deletePdf}
                    onDownload={() => pdfPreview && void downloadPdf(pdfPreview, pdfName || 'video-notes.pdf')}
                    onSignIn={() => setAuthOpen(true)}
                    onToggleExpand={() => setNotesExpanded((value) => !value)}
                  />
                  {panelView === 'timestamps' && (
                    <ChaptersPanel
                      chapters={parsedChapters}
                      activeIndex={activeChapterIndex}
                      currentTime={currentTime}
                      onSeek={(seconds) => playerControlsRef.current?.seekTo(seconds)}
                      onAddTimestamps={openTimestamps}
                      compact
                    />
                  )}
                </div>
                {notesExpanded && <button className="panel-close" onClick={() => setNotesExpanded(false)} aria-label="Exit full screen notes"><X size={16} /> Close</button>}
              </aside>

              <details ref={timestampsRef} className="timestamps-editor disclosure-card glass-card workspace-editor">
                <summary className="disclosure-summary">
                  <span className="section-title-lockup">
                    <span className="section-icon violet"><ListMusic size={20} /></span>
                    <span className="disclosure-copy"><span className="eyebrow">TIMESTAMPS</span><span className="disclosure-title">Chapter map</span><span className="disclosure-subtitle">{parsedChapters.length ? 'Saved — tap any timestamp to jump' : 'Paste timestamps to jump to a topic'}</span></span>
                  </span>
                  <span className="disclosure-summary-end"><span className="chapter-count">{parsedChapters.length} {parsedChapters.length === 1 ? 'CHAPTER' : 'CHAPTERS'}</span><span className="disclosure-chevron"><ChevronDown size={18} /></span></span>
                </summary>
                <div className="disclosure-body">
                  <div className="chapter-editor-toolbar"><p className="section-description">Paste the timestamps from your video description. They save automatically for this lesson.</p><a className="description-link" href="https://www.toolsoverflow.com/youtube/youtube-title-description-extractor" target="_blank" rel="noreferrer">Find timestamps <ArrowUpRight size={14} /></a></div>
                  <textarea className="chapters-textarea" value={chaptersRaw} onChange={(event) => setChaptersRaw(event.target.value)} placeholder={'00:00 Introduction\n08:00 - Kinematics\n01:19:42 Work, energy and power'} spellCheck={false} aria-label="Paste video timestamps and chapter titles" />
                  <div className="chapter-editor-footer"><span><Info size={14} /> One timestamp per line · MM:SS or HH:MM:SS</span><span className={parsedChapters.length ? 'parse-success' : ''}>{parsedChapters.length ? <><Check size={14} /> Saved for this video</> : 'Private to this video'}</span></div>
                </div>
              </details>
            </section>
          )}

          <PdfLibraryPanel
            items={activeLibraryPdfs}
            deletedItems={deletedLibraryPdfs}
            deletedAt={pdfTrash}
            activity={pdfActivity}
            usedBytes={libraryUsedBytes}
            trashUnavailable={trashUnavailable}
            loading={libraryLoading}
            busy={libraryBusy}
            error={libraryError}
            status={libraryStatus}
            signedIn={Boolean(authUser)}
            cloudConfigured={cloudConfigured}
            canAttach={Boolean(activeVideoId)}
            attachedPath={activeRecord?.pdfPath}
            onUpload={(file, subject) => handleLibraryUpload(file, subject)}
            onOpen={(item) => { notePdfOpened(item); setOpenLibraryPdf(item); }}
            onDownload={(item) => void downloadLibraryItem(item)}
            onDelete={(item) => void deleteLibraryItem(item)}
            onRestore={(item) => void restoreTrashedPdf(item)}
            onDeleteForever={(item) => void deleteLibraryItemForever(item)}
            onRename={(item, name, subject) => void renameLibraryItem(item, name, subject)}
            onAttach={attachLibraryPdf}
            onSignIn={() => setAuthOpen(true)}
          />

          {libraryVisible && (
            <section className="library-section">
              <div className="library-heading">
                <div>
                  <p className="eyebrow">{showingRemoved ? 'REMOVED LESSONS' : 'YOUR LIBRARY'}</p>
                  <h2>{showingRemoved ? 'Removed, not gone' : 'Pick up where you left off'}</h2>
                  <p>{showingRemoved
                    ? 'Removed lessons stay out of your library until you restore them or delete them forever.'
                    : 'Timestamps, notes and progress stay with every lesson.'}</p>
                </div>
                <span className="library-count"><span>{(showingRemoved ? removedVideos.length : libraryVideos.length).toString().padStart(2, '0')}</span> {showingRemoved ? 'REMOVED' : 'SAVED'}</span>
              </div>
              <div className="library-filters">
                <button className={libraryFilter === 'all' ? 'selected' : ''} onClick={() => setLibraryFilter('all')}>All lessons <span>{libraryVideos.length}</span></button>
                {availableSubjects.map((subject) => <button key={subject} className={libraryFilter === subject ? 'selected' : ''} onClick={() => setLibraryFilter(subject)}>{subject} <span>{libraryVideos.filter((video) => video.subject === subject).length}</span></button>)}
                {removedVideos.length > 0 && (
                  <button className={`library-filter-removed ${showingRemoved ? 'selected' : ''}`} onClick={() => setLibraryFilter(showingRemoved ? 'all' : 'removed')}>
                    <Archive size={13} /> Removed <span>{removedVideos.length}</span>
                  </button>
                )}
              </div>
              {showingRemoved && (
                <p className="library-removed-note">
                  <Info size={13} /> “Delete forever” also erases that lesson’s saved PDF from storage. A PDF that lives in your PDF library above is never deleted.
                </p>
              )}
              <div className="library-grid">
                {showingRemoved
                  ? removedVideos.map((video) => (
                      <LibraryCard
                        key={video.videoId}
                        video={video}
                        removed
                        active={video.videoId === activeVideoId}
                        pdfHidden={Boolean(video.pdfPath && trashedLibraryPaths.has(video.pdfPath))}
                        onResume={() => resumeVideo(video)}
                        onRestore={() => restoreVideo(video)}
                        onDeleteForever={() => void deleteVideoForever(video)}
                        onRename={(title, subject) => renameVideo(video, title, subject)}
                      />
                    ))
                  : filteredLibrary.map((video) => (
                      <LibraryCard
                        key={video.videoId}
                        video={video}
                        active={video.videoId === activeVideoId}
                        pdfHidden={Boolean(video.pdfPath && trashedLibraryPaths.has(video.pdfPath))}
                        onResume={() => resumeVideo(video)}
                        onRemove={() => archiveVideo(video)}
                        onRename={(title, subject) => renameVideo(video, title, subject)}
                      />
                    ))}
                {!showingRemoved && filteredLibrary.length === 0 && <div className="library-empty">Nothing in this subject yet.</div>}
                {showingRemoved && removedVideos.length === 0 && <div className="library-empty">Nothing has been removed.</div>}
              </div>
            </section>
          )}

          <footer className="footer"><a className="footer-brand" href="#top"><span className="brand-mark"><Play size={11} fill="currentColor" /></span> focusframe<span>.</span></a><p>Made for your next breakthrough. Videos are streamed by YouTube or by the link you paste.</p><a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube terms <ArrowUpRight size={11} /></a></footer>
        </main>
      </div>
      <input ref={fileInputRef} className="sr-only" type="file" accept=".pdf,application/pdf" onChange={handlePdfSelection} />
      {toast && <div className="toast-message"><span><Check size={14} /></span>{toast}</div>}
      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
      {openLibraryPdf && (
        <PdfLibraryViewer
          item={openLibraryPdf}
          url={libraryUrl}
          loading={libraryUrlLoading}
          busy={libraryBusy}
          error={libraryError}
          status={libraryStatus}
          signedIn={Boolean(authUser)}
          userId={authUser?.id ?? null}
          onClose={() => setOpenLibraryPdf(null)}
          onDownload={() => void downloadLibraryItem(openLibraryPdf)}
          onDelete={() => void deleteLibraryItem(openLibraryPdf)}
          onPageCount={handlePdfPageCount}
        />
      )}
      <Analytics />
    </div>
  );
}

interface LibraryCardProps {
  video: VideoRecord;
  active: boolean;
  /** Removed (archived) lessons show Restore + Delete forever instead of Remove. */
  removed?: boolean;
  /** Hide the PDF badge while the linked library PDF sits in "Recently deleted". */
  pdfHidden?: boolean;
  onResume: () => void;
  onRemove?: () => void;
  onRestore?: () => void;
  onDeleteForever?: () => void;
  /** Rename a lesson and/or move it to another subject. */
  onRename?: (title: string, subject: Subject) => void;
}

function LibraryCard({
  video, active, removed = false, pdfHidden = false, onResume, onRemove, onRestore, onDeleteForever, onRename,
}: LibraryCardProps) {
  const percent = Math.round(progressPercent(video));
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(video.title);
  const [draftSubject, setDraftSubject] = useState<Subject>(video.subject);

  function startEditing() {
    setDraftTitle(video.title);
    setDraftSubject(video.subject);
    setEditing(true);
  }

  function save() {
    const title = draftTitle.trim();
    if (!title) return;
    onRename?.(title, draftSubject);
    setEditing(false);
  }

  return (
    <article className={`library-card glass-card ${active ? 'library-card-active' : ''} ${removed ? 'library-card-removed' : ''} ${editing ? 'library-card-editing' : ''}`}>
      <button className="library-thumb" onClick={onResume} aria-label={`Open ${video.title}`} tabIndex={editing ? -1 : 0}>
        {/* A saved picture, or the clip's own 00:01 frame, or the link placeholder. */}
        <LessonThumb video={video} still={removed} />
        <span className="library-play"><Play size={14} fill="currentColor" /></span>
        <span className="library-duration">{video.duration ? formatTime(video.duration) : video.subject}</span>
        {active && <span className="library-live">OPEN NOW</span>}
      </button>
      <div className="library-card-body">
        <div className="library-card-overline">
          <span className={`subject-tag ${subjectClass(editing ? draftSubject : video.subject)}`}>{editing ? draftSubject : video.subject}</span>
          <span className="library-card-tools">
            {!editing && video.sourceKind === 'file' && <span className="library-source-badge" title={video.sourceUrl || 'Direct video link'}>LINK</span>}
            {!editing && video.pdfName && !pdfHidden && <span className="library-notes-badge" title={video.pdfName}><FileText size={13} /> PDF</span>}
            {!editing && onRename && (
              <button className="library-rename-button" onClick={startEditing} aria-label={`Rename ${video.title}`} title="Rename lesson"><Pencil size={13} /></button>
            )}
            {!editing && !removed && (
              <button className="library-remove" onClick={onRemove} aria-label={`Remove ${video.title} from your library`} title="Remove from library"><Trash2 size={14} /></button>
            )}
          </span>
        </div>

        {editing ? (
          <form
            className="library-rename"
            onSubmit={(event) => { event.preventDefault(); save(); }}
          >
            <label className="library-rename-field">
              <span className="sr-only">Lesson title</span>
              <input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); save(); }
                  if (event.key === 'Escape') { event.preventDefault(); setEditing(false); }
                }}
                // Focused on open so typing a new name works straight away.
                autoFocus
                maxLength={160}
                placeholder="Lesson title"
              />
            </label>
            <div className="library-rename-row">
              <select
                value={draftSubject}
                onChange={(event) => setDraftSubject(event.target.value as Subject)}
                aria-label="Subject"
              >
                {subjects.map((subject) => <option key={subject}>{subject}</option>)}
              </select>
              <button type="submit" className="library-rename-save"><Check size={13} /> Save</button>
              <button type="button" className="library-rename-cancel" onClick={() => setEditing(false)} aria-label="Cancel rename"><X size={13} /></button>
            </div>
          </form>
        ) : (
          <>
            <button className="library-video-title" onClick={onResume} title={video.title}>{video.title}</button>
            <p>{video.channel || (video.sourceKind === 'file' ? 'Direct video link' : 'YouTube lesson')}</p>
            <div className="library-card-progress"><div className="progress-track"><span style={{ width: `${percent}%` }} /></div><span>{percent}%</span></div>
            {removed ? (
              <div className="library-removed-actions">
                <button className="library-restore-button" onClick={onRestore}><ArchiveRestore size={13} /> Restore</button>
                <button className="library-delete-forever" onClick={onDeleteForever} title="Delete this lesson and its saved PDF for good"><Trash2 size={13} /> Delete forever</button>
              </div>
            ) : (
              <button className="library-resume-button" onClick={onResume}>{video.currentTime > 5 ? `Resume at ${formatTime(video.currentTime)}` : 'Start lesson'} <ArrowRight size={13} /></button>
            )}
          </>
        )}
      </div>
    </article>
  );
}
