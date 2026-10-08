import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { User } from '@supabase/supabase-js';
import {
  Archive, ArchiveRestore, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleHelp, Cloud, CloudOff,
  FileText, Film, HardDrive, Info, ListMusic, Play, ShieldCheck, Trash2, X, Zap,
} from 'lucide-react';
import { AuthModal } from './components/AuthModal';
import { ChaptersPanel } from './components/ChaptersPanel';
import { PdfLibraryPanel } from './components/PdfLibraryPanel';
import { PdfLibraryViewer, usePdfAnnotationController } from './components/PdfLibraryViewer';
import { PdfViewer } from './components/PdfViewer';
import { YouTubePlayer, type PlayerControls } from './components/YouTubePlayer';
import {
  cloudConfigured, createLibraryPdf, createPdfSignedUrl, deleteCloudLessonAnnotations, deleteCloudPdf,
  deleteCloudVideo, deleteLibraryPdf, fetchCloudVideos, fetchLibraryPdfs, fetchPdfActivity, fetchPdfTrash,
  isLibraryPath, probeAnnotationTables, restoreLibraryPdf, saveCloudVideo, savePdfActivity, supabase,
  trashLibraryPdf, updateLibraryPdf, uploadCloudPdf,
} from './lib/supabase';
import {
  deleteLocalAnnotations, loadLocalPdfActivity, loadLocalPdfTrash, loadLocalState, moveAnnotationCache,
  saveLocalPdfActivity, saveLocalPdfTrash, saveLocalState, upsertVideo,
} from './lib/storage';
import { sessionLibraryItem, sortLibrary, validateLibraryFile } from './lib/pdfLibrary';
import { emptyVideoRecord, formatTime, parseChapters, parseYouTubeInput, youtubeUrlFor } from './lib/youtube';
import type { LibraryPdf, PersistedState, PlayerSource, PlayerVideoInfo, StudyPanelView, Subject, VideoRecord } from './types';
import './styles.css';
import './readability.css';

type SyncStatus = 'local' | 'syncing' | 'synced' | 'error';

interface PdfPreview {
  url: string;
  name: string;
  size: number;
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

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  // Let the browser decode large data URLs natively rather than duplicating a 100 MB PDF in JS strings.
  const response = await fetch(dataUrl);
  return response.blob();
}

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
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfPreview, setPdfPreview] = useState<PdfPreview | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [notesVersion, setNotesRevision] = useState(0);
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
  // "Recently deleted" PDFs (pdf id -> when it was deleted) and per-PDF activity, backed by localStorage.
  const [pdfTrash, setPdfTrash] = useState<Record<string, number>>(loadLocalPdfTrash);
  const [pdfActivity, setPdfActivity] = useState<Record<string, { lastOpenedAt: number | null; pageCount: number | null }>>(loadLocalPdfActivity);
  const [trashUnavailable, setTrashUnavailable] = useState(false);
  // Names of the annotation tables this project is missing, checked once per sign-in so the
  // app can say which SQL file to run instead of only failing when a drawing is saved.
  const [annotationTablesMissing, setAnnotationTablesMissing] = useState<string[]>([]);

  const playerControlsRef = useRef<PlayerControls | null>(null);
  const libraryMigratedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timestampsRef = useRef<HTMLDetailsElement>(null);
  const notesSessionRef = useRef<Record<string, { data: string; name: string; size: number }>>({});
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
  const parsedChapters = useMemo(() => parseChapters(chaptersRaw), [chaptersRaw]);
  const activeChapterIndex = useMemo(() => {
    let index = -1;
    for (let chapterIndex = 0; chapterIndex < parsedChapters.length; chapterIndex += 1) {
      if (currentTime >= parsedChapters[chapterIndex].seconds) index = chapterIndex;
      else break;
    }
    return index;
  }, [parsedChapters, currentTime]);
  const sessionPdf = activeVideoId ? notesSessionRef.current[activeVideoId] : undefined;
  const activeSubject = activeRecord?.subject ?? selectedSubject;
  const activeTitle = activeRecord?.title || (playerReady ? 'YouTube lesson' : 'Your lesson is loading…');

  const linkedLibraryPdf = useMemo(
    () => (activeRecord?.pdfPath ? libraryPdfs.find((item) => item.storagePath && item.storagePath === activeRecord.pdfPath) ?? null : null),
    [activeRecord?.pdfPath, libraryPdfs],
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

  const updateVideo = useCallback((videoId: string, patch: Partial<VideoRecord>) => {
    setVideos((current) => {
      const existing = current.find((item) => item.videoId === videoId) ?? emptyVideoRecord(videoId);
      const updated: VideoRecord = { ...existing, ...patch, updatedAt: Date.now() };
      return upsertVideo(current, updated);
    });
  }, []);

  useEffect(() => {
    const state: PersistedState = { videos };
    setStorageAvailable(saveLocalState(state));
  }, [videos]);

  useEffect(() => {
    saveLocalPdfTrash(pdfTrash);
  }, [pdfTrash]);

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
        const remoteVideos = await fetchCloudVideos(authUser.id);
        if (cancelled) return;
        const merged = new Map<string, VideoRecord>();
        for (const record of remoteVideos) merged.set(record.videoId, record);
        for (const record of videosRef.current) {
          const remote = merged.get(record.videoId);
          if (!remote || record.updatedAt >= remote.updatedAt) merged.set(record.videoId, record);
        }
        setVideos([...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt));
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
  }, [authReady, authUser?.id]);

  // Load the account-backed PDF library. Guest uploads (session-only) are kept alongside it.
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
        const remote = await fetchLibraryPdfs(userId);
        if (cancelled) return;
        setLibraryPdfs((current) => sortLibrary([...remote, ...current.filter((item) => item.sessionOnly)]));
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
  }, [authReady, authUser?.id]);

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

  // "Recently deleted" and activity live in two small optional tables. If the owner has not
  // run the newest migration yet, the library keeps working with local storage.
  useEffect(() => {
    if (!cloudConfigured || !authUser || libraryLoadedFor !== authUser.id || !supabase) return;
    let cancelled = false;
    (async () => {
      const [trashResult, activityResult] = await Promise.allSettled([
        fetchPdfTrash(authUser.id),
        fetchPdfActivity(authUser.id),
      ]);
      if (cancelled) return;
      if (trashResult.status === 'fulfilled') {
        const remoteTrash = Object.fromEntries(trashResult.value.map((entry) => [entry.pdfId, entry.deletedAt]));
        setPdfTrash((current) => ({ ...current, ...remoteTrash }));
        setTrashUnavailable(false);
      } else {
        setTrashUnavailable(true);
      }
      if (activityResult.status === 'fulfilled') {
        const remoteActivity = Object.fromEntries(activityResult.value.map((entry) => [
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
    })();
    return () => { cancelled = true; };
  }, [authUser?.id, libraryLoadedFor]);

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
    const pending = videos.filter((video) => fullReconcile || lastSyncedRef.current.get(video.videoId) !== video.updatedAt);
    if (pending.length === 0) return;
    const userId = authUser.id;
    const timeout = window.setTimeout(async () => {
      setSyncStatus('syncing');
      try {
        // Writes stay independent: one failing lesson must not block the others.
        const results = await Promise.allSettled(pending.map(async (video) => {
          await saveCloudVideo(userId, video);
          return video;
        }));
        const failed: VideoRecord[] = [];
        results.forEach((result, index) => {
          const video = pending[index];
          if (result.status === 'fulfilled') lastSyncedRef.current.set(video.videoId, video.updatedAt);
          else failed.push(video);
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

  useEffect(() => {
    if (!activeVideoId) return;
    setVideos((current) => {
      const existing = current.find((video) => video.videoId === activeVideoId);
      if (!existing || existing.chaptersRaw === chaptersRaw) return current;
      return upsertVideo(current, { ...existing, chaptersRaw, updatedAt: Date.now() });
    });
  }, [chaptersRaw, activeVideoId]);

  useEffect(() => {
    const videoId = activeVideoId;
    const record = activeRecord;
    if (!videoId) {
      setPdfPreview(null);
      setPdfLoading(false);
      return;
    }
    let cancelled = false;
    let objectUrl = '';
    setPdfPreview(null);
    if (sessionPdf) {
      setPdfLoading(true);
      dataUrlToBlob(sessionPdf.data).then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPdfPreview({ url: objectUrl, name: sessionPdf.name, size: sessionPdf.size, cloud: false });
      }).catch(() => {
        if (!cancelled) setPdfError('This PDF could not be opened in the preview. Try uploading it again.');
      }).finally(() => { if (!cancelled) setPdfLoading(false); });
      return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }
    if (record?.pdfPath && authUser && supabase) {
      setPdfLoading(true);
      createPdfSignedUrl(record.pdfPath).then((url) => {
        if (!cancelled) setPdfPreview({ url, name: record.pdfName || 'video-notes.pdf', size: record.pdfSize || 0, cloud: true });
      }).catch((error: unknown) => {
        if (!cancelled) setPdfError(error instanceof Error ? error.message : 'Could not load your saved PDF.');
      }).finally(() => { if (!cancelled) setPdfLoading(false); });
    } else {
      setPdfLoading(false);
    }
    return () => { cancelled = true; };
  }, [activeVideoId, activeRecord?.pdfPath, activeRecord?.pdfName, activeRecord?.pdfSize, authUser?.id, notesVersion]);

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
    const record = existing ?? emptyVideoRecord(info.videoId, selectedSubject);
    const updated: VideoRecord = {
      ...record,
      title: info.title || record.title,
      channel: info.channel || record.channel,
      thumbnail: `https://i.ytimg.com/vi/${info.videoId}/hqdefault.jpg`,
      playlistId: playlistIdRef.current || record.playlistId,
      playlistIndex: info.playlistIndex ?? record.playlistIndex,
      archived: false,
      updatedAt: Date.now(),
    };
    setVideos((current) => upsertVideo(current, updated));
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

  function loadYouTubeVideo(event?: FormEvent<HTMLFormElement>, urlOverride?: string, subjectOverride?: Subject) {
    event?.preventDefault();
    setUrlError('');
    setPlayerError('');
    const value = urlOverride ?? urlInput;
    try {
      const parsed = parseYouTubeInput(value);
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
      if (parsed.videoId) {
        const existing = videosRef.current.find((video) => video.videoId === parsed.videoId);
        const record = existing ?? emptyVideoRecord(parsed.videoId, subjectOverride ?? selectedSubject);
        startPlaylistIndex = record.playlistIndex;
        if (!existing) setVideos((current) => upsertVideo(current, record));
        else if (record.archived) updateVideo(record.videoId, { archived: false });
        setActiveVideoId(parsed.videoId);
        setChaptersRaw(record.chaptersRaw || '');
        setPanelView(record.pdfPath || notesSessionRef.current[parsed.videoId] ? 'notes' : parseChapters(record.chaptersRaw || '').length > 0 ? 'timestamps' : 'notes');
        if (record.currentTime > 3) window.setTimeout(() => playerControlsRef.current?.seekTo(record.currentTime), 500);
      } else {
        setActiveVideoId(null);
        setChaptersRaw('');
        setPanelView('notes');
      }
      loadTokenRef.current += 1;
      setSource({ ...parsed, ...(startPlaylistIndex !== undefined ? { playlistIndex: startPlaylistIndex } : {}), token: loadTokenRef.current });
    } catch (error) {
      setUrlError(error instanceof Error ? error.message : 'Please paste a YouTube video or playlist link.');
    }
  }

  function resumeVideo(record: VideoRecord) {
    setSelectedSubject(record.subject);
    const url = youtubeUrlFor(record.videoId, record.playlistId);
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

  function archiveVideo(record: VideoRecord) {
    updateVideo(record.videoId, { archived: true });
    showToast('Removed from your library. You can restore it from Removed.');
  }

  async function downloadPdf(pdf: PdfPreview) {
    if (!pdf.cloud) {
      downloadFromUrl(pdf.url, pdf.name);
      return;
    }
    try {
      const response = await fetch(pdf.url);
      if (!response.ok) throw new Error('The download link expired.');
      const objectUrl = URL.createObjectURL(await response.blob());
      downloadFromUrl(objectUrl, pdf.name);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    } catch {
      // If the browser blocks a cross-origin download, let the PDF viewer open its signed URL.
      window.open(pdf.url, '_blank', 'noopener,noreferrer');
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
      setLibraryBusy(true);
      setLibraryStatus(`Uploading “${file.name}”…`);
      try {
        const created = await createLibraryPdf(authUser.id, file, subject);
        setLibraryPdfs((current) => sortLibrary([created, ...current]));
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
    const deletedAt = Date.now();
    setPdfTrash((current) => ({ ...current, [item.id]: deletedAt }));
    if (openLibraryPdf?.id === item.id) setOpenLibraryPdf(null);
    showToast('PDF moved to Recently deleted.');

    if (!item.sessionOnly && authUser && supabase) {
      try {
        await trashLibraryPdf(authUser.id, item.id);
      } catch {
        // Fail soft if the optional pdf_trash table is not migrated yet; local trash still persists.
        setTrashUnavailable(true);
      }
    }
  }

  /** Bring a PDF back from "Recently deleted". Nothing was removed from storage. */
  async function restoreTrashedPdf(item: LibraryPdf) {
    setLibraryError('');
    setPdfTrash((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    showToast('PDF restored to your library.');

    if (!item.sessionOnly && authUser && supabase) {
      try {
        await restoreLibraryPdf(authUser.id, item.id);
      } catch {
        setTrashUnavailable(true);
      }
    }
  }

  /** "Delete forever": removes the file from storage and the row from the library. */
  async function deleteLibraryItemForever(item: LibraryPdf) {
    setLibraryError('');
    if (!item.sessionOnly && authUser && supabase) {
      setLibraryBusy(true);
      try {
        await deleteLibraryPdf(authUser.id, item);
      } catch (error) {
        setLibraryBusy(false);
        setLibraryError(error instanceof Error
          ? `Could not delete this PDF for good. ${error.message}`
          : 'Could not delete this PDF for good.');
        return;
      }
      setLibraryBusy(false);
    }

    // Any lesson still pointing at this PDF keeps its timestamps — only the notes link clears.
    if (item.storagePath) {
      setVideos((current) => current.map((video) => (
        video.pdfPath && video.pdfPath === item.storagePath
          ? { ...video, pdfPath: undefined, pdfName: undefined, pdfSize: undefined, updatedAt: Date.now() }
          : video
      )));
    }
    setLibraryPdfs((current) => current.filter((entry) => entry.id !== item.id));
    setPdfTrash((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    setPdfActivity((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    deleteLocalAnnotations(item.id);
    if (openLibraryPdf?.id === item.id) setOpenLibraryPdf(null);
    showToast('PDF deleted forever.');
  }

  async function renameLibraryItem(item: LibraryPdf, name: string, subject: Subject) {
    const nextName = name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
    const updated: LibraryPdf = { ...item, name: nextName, subject, updatedAt: Date.now() };
    setLibraryPdfs((current) => sortLibrary(current.map((entry) => (entry.id === item.id ? updated : entry))));
    setOpenLibraryPdf((current) => (current && current.id === item.id ? updated : current));
    if (item.sessionOnly || !authUser || !supabase) return;
    setLibraryError('');
    try {
      await updateLibraryPdf(authUser.id, item.id, { name: nextName, subject });
      setVideos((current) => current.map((video) => (
        video.pdfPath && video.pdfPath === item.storagePath
          ? { ...video, pdfName: nextName, updatedAt: Date.now() }
          : video
      )));
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
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result || '');
        notesSessionRef.current[activeVideoId] = { data, name: item.name, size: item.size };
        updateVideo(activeVideoId, { pdfName: item.name, pdfSize: item.size });
        setNotesRevision((value) => value + 1);
        setPdfError('');
        setPdfStatus('Attached for this session.');
        setPanelView('notes');
        notePdfOpened(item);
        showToast('PDF attached to this lesson.');
      };
      reader.readAsDataURL(item.file);
      return;
    }
    setLibraryError('');
    // A lesson-level PDF would shadow the library copy, so clear it before linking.
    delete notesSessionRef.current[activeVideoId];
    updateVideo(activeVideoId, { pdfPath: item.storagePath, pdfName: item.name, pdfSize: item.size });
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
    if (!activeVideoId) {
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
    setPdfBusy(true);
    setPdfError('');
    setPdfStatus('Reading your PDF…');
    const reader = new FileReader();
    reader.onerror = () => {
      setPdfBusy(false);
      setPdfError('The PDF could not be read. Please try again.');
      setPdfStatus('');
    };
    reader.onload = async () => {
      const data = String(reader.result || '');
      notesSessionRef.current[activeVideoId] = { data, name: file.name, size: file.size };
      setNotesRevision((value) => value + 1);
      const record = videosRef.current.find((video) => video.videoId === activeVideoId);
      if (authUser && supabase && cloudConfigured) {
        setPdfStatus('Saving notes to your private cloud library…');
        try {
          // A PDF linked from the library is never deleted when a lesson replaces its notes.
          const previousPath = isLibraryPath(record?.pdfPath) ? undefined : record?.pdfPath;
          const path = await uploadCloudPdf(authUser.id, activeVideoId, file, previousPath);
          updateVideo(activeVideoId, { pdfPath: path, pdfName: file.name, pdfSize: file.size });
          setPdfStatus('Saved to your private cloud library.');
          showToast('PDF notes synced to your account.');
        } catch (error) {
          setPdfStatus('Session storage — notes are kept while the page is open.');
          setPdfError(error instanceof Error ? `Cloud upload failed; this PDF is available for this session. ${error.message}` : 'Cloud upload failed; this PDF is available for this session.');
        } finally {
          setPdfBusy(false);
        }
      } else {
        setPdfStatus('Session storage — notes are kept while the page is open.');
        setPdfBusy(false);
      }
    };
    reader.readAsDataURL(file);
  }

  async function deletePdf() {
    if (!activeVideoId) return;
    // A library PDF is only unlinked here; the file itself stays in the PDF library.
    if (activeRecord?.pdfPath && authUser && supabase && !isLibraryPath(activeRecord.pdfPath)) {
      try {
        await deleteCloudPdf(activeRecord.pdfPath);
      } catch {
        // Ignore storage removal errors so the lesson's PDF pointer can still be cleared.
      }
    }
    delete notesSessionRef.current[activeVideoId];
    deleteLocalAnnotations(`lesson:${activeVideoId}`);
    // The note's synced drawings go with it, so a later PDF on this lesson starts clean.
    if (authUser && supabase && !linkedLibraryPdf) {
      void deleteCloudLessonAnnotations(authUser.id, activeVideoId).catch(() => undefined);
    }
    updateVideo(activeVideoId, { pdfPath: undefined, pdfName: undefined, pdfSize: undefined });
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
    updateVideo(record.videoId, { archived: false });
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

    setLibraryError('');
    if (authUser && supabase) {
      if (removesLessonPdf) {
        try {
          await deleteCloudPdf(record.pdfPath as string);
        } catch {
          // Proceed even if the storage object was already removed.
        }
      }
      setLibraryBusy(true);
      try {
        await deleteCloudVideo(authUser.id, record.videoId);
      } catch (error) {
        setLibraryBusy(false);
        setLibraryError(error instanceof Error ? error.message : 'Could not delete this lesson from your account.');
        return;
      }
      setLibraryBusy(false);
    }

    delete notesSessionRef.current[record.videoId];
    deleteLocalAnnotations(`lesson:${record.videoId}`);
    // Fail soft: a project that has not run the newest migration simply has no such table.
    if (authUser && supabase) {
      void deleteCloudLessonAnnotations(authUser.id, record.videoId).catch(() => undefined);
    }
    setVideos((current) => current.filter((video) => video.videoId !== record.videoId));
    // Stop the study room when the lesson on screen is the one being deleted, so playback
    // ticks cannot re-create the record that was just removed.
    if (activeVideoId === record.videoId) {
      setSource(null);
      setActiveVideoId(null);
      setPdfPreview(null);
      setNotesRevision((value) => value + 1);
    }
    if (removedVideos.length <= 1) setLibraryFilter('all');
    showToast('Lesson deleted forever.');
  }

  useEffect(() => {
    function handleShortcuts(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, a, summary, [role="button"], [contenteditable="true"]') || event.altKey || event.ctrlKey || event.metaKey) return;
      const controls = playerControlsRef.current;
      if (!controls || !activeVideoId) return;
      const key = event.key.toLowerCase();
      if (event.code === 'Space') { event.preventDefault(); controls.togglePlayback(); }
      else if (key === 'arrowleft') { event.preventDefault(); controls.seekBy(-10); }
      else if (key === 'arrowright') { event.preventDefault(); controls.seekBy(10); }
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

  const loadForm = (
    <form className="video-load-form" onSubmit={(event) => loadYouTubeVideo(event)}>
      <div className="url-input-wrap">
        <span className="url-play-icon"><Play size={15} fill="currentColor" /></span>
        <input
          aria-label="YouTube video or playlist URL"
          value={urlInput}
          onChange={(event) => { setUrlInput(event.target.value); setUrlError(''); }}
          placeholder="Paste a YouTube one-shot or playlist link…"
        />
        <span className="url-helper">YOUTUBE</span>
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
                <p className="hero-description">Watch the lesson, follow the timestamps, and read your PDF notes right beside the video — on any device.</p>
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
                  <p>Any YouTube one-shot or playlist starts the room.</p>
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
            <section className={`workspace ${notesExpanded ? 'notes-expanded' : ''}`} aria-label="YouTube study room">
              <article className="player-card glass-card workspace-player">
                <div className="player-topline"><div className="player-live-label"><span className="live-dot" /> STUDY ROOM <span className="topline-slash">/</span> <span>{isPlaylist ? 'PLAYLIST' : 'NOW PLAYING'}</span></div><div className={`player-state ${playerError ? 'error' : playerState === 1 ? 'playing' : ''}`}><span />{playerError ? 'Check video details' : playerState === 1 ? 'In session' : playerReady ? 'Ready when you are' : 'Connecting'}</div></div>
                <YouTubePlayer
                  source={source}
                  controlsRef={playerControlsRef}
                  onReady={onPlayerReady}
                  onStateChange={onPlayerStateChange}
                  onVideoChange={handlePlayerVideoChange}
                  onTick={handlePlayerTick}
                  onError={onPlayerError}
                />
                <div className="player-meta">
                  <div className="player-title-wrap">
                    <span className={`subject-tag ${subjectClass(activeSubject)}`}>{activeSubject}</span>
                    <h2>{activeTitle}</h2>
                    <p>{activeRecord?.channel || 'YouTube study session'} <span>·</span> {playerDuration ? formatTime(playerDuration) : 'Duration appears when the video is ready'}</p>
                  </div>
                  <div className="player-meta-actions">
                    <span className="watch-time"><span>WATCHED</span><strong>{watched}{playerDuration ? ` / ${formatTime(playerDuration)}` : ''}</strong></span>
                    <button className="notes-jump" onClick={() => { setPanelView('notes'); document.querySelector('.study-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}><FileText size={15} /> Notes</button>
                  </div>
                </div>
                <div className="player-progress"><span style={{ width: `${progress}%` }} /></div>
                <details className="shortcut-disclosure">
                  <summary><span><Zap size={15} /> Keyboard shortcuts</span><span className="shortcut-summary-action">Show <ChevronDown size={15} /></span></summary>
                  <div className="shortcut-strip"><span><Zap size={14} /> QUICK KEYS</span><kbd>Space</kbd><small>play</small><kbd>←</kbd><kbd>→</kbd><small>seek</small><kbd>F</kbd><small>fullscreen</small><kbd>M</kbd><small>mute</small><kbd>C</kbd><small>captions</small></div>
                </details>
              </article>

              <aside className="study-panel glass-card">
                <div className="panel-tabs" role="tablist" aria-label="Notes and timestamps">
                  <button role="tab" aria-selected={panelView === 'notes'} className={panelView === 'notes' ? 'active' : ''} onClick={() => setPanelView('notes')}><FileText size={16} /> Notes{pdfPreview && <span className="tab-dot" />}</button>
                  <button role="tab" aria-selected={panelView === 'timestamps'} className={panelView === 'timestamps' ? 'active' : ''} onClick={() => { setPanelView('timestamps'); setNotesExpanded(false); }}><ListMusic size={16} /> Timestamps{parsedChapters.length > 0 && <span className="tab-count">{parsedChapters.length}</span>}</button>
                </div>
                <div className="panel-body" role="tabpanel">
                  {panelView === 'notes' ? (
                    <PdfViewer
                      url={pdfPreview?.url ?? ''}
                      name={pdfPreview?.name ?? activeRecord?.pdfName ?? ''}
                      size={pdfPreview?.size ?? activeRecord?.pdfSize ?? 0}
                      cloud={pdfPreview?.cloud ?? false}
                      uploading={pdfBusy || pdfLoading}
                      error={pdfError}
                      status={lessonAnnotations.annotateStatus || pdfStatus}
                      locked={Boolean(activeRecord?.pdfPath && !authUser && !sessionPdf)}
                      expanded={notesExpanded}
                      annotations={pdfPreview?.url ? lessonAnnotations.bridge : null}
                      onPageCount={(count) => linkedLibraryPdf && handlePdfPageCount(linkedLibraryPdf.id, count)}
                      onPickFile={() => fileInputRef.current?.click()}
                      onFile={(file) => void handlePdfUpload(file)}
                      onRemove={() => void deletePdf()}
                      onDownload={() => pdfPreview && void downloadPdf(pdfPreview)}
                      onSignIn={() => setAuthOpen(true)}
                      onToggleExpand={() => setNotesExpanded((value) => !value)}
                    />
                  ) : (
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
                        onResume={() => resumeVideo(video)}
                        onRestore={() => restoreVideo(video)}
                        onDeleteForever={() => void deleteVideoForever(video)}
                      />
                    ))
                  : filteredLibrary.map((video) => (
                      <LibraryCard key={video.videoId} video={video} active={video.videoId === activeVideoId} onResume={() => resumeVideo(video)} onRemove={() => archiveVideo(video)} />
                    ))}
                {!showingRemoved && filteredLibrary.length === 0 && <div className="library-empty">Nothing in this subject yet.</div>}
                {showingRemoved && removedVideos.length === 0 && <div className="library-empty">Nothing has been removed.</div>}
              </div>
            </section>
          )}

          <footer className="footer"><a className="footer-brand" href="#top"><span className="brand-mark"><Play size={11} fill="currentColor" /></span> focusframe<span>.</span></a><p>Made for your next breakthrough. Videos are streamed by YouTube.</p><a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube terms <ArrowUpRight size={11} /></a></footer>
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
    </div>
  );
}

interface LibraryCardProps {
  video: VideoRecord;
  active: boolean;
  /** Removed (archived) lessons show Restore + Delete forever instead of Remove. */
  removed?: boolean;
  onResume: () => void;
  onRemove?: () => void;
  onRestore?: () => void;
  onDeleteForever?: () => void;
}

function LibraryCard({ video, active, removed = false, onResume, onRemove, onRestore, onDeleteForever }: LibraryCardProps) {
  const percent = Math.round(progressPercent(video));
  return (
    <article className={`library-card glass-card ${active ? 'library-card-active' : ''} ${removed ? 'library-card-removed' : ''}`}>
      <button className="library-thumb" onClick={onResume} aria-label={`Open ${video.title}`}>
        <img src={video.thumbnail} alt="" loading="lazy" />
        <span className="library-play"><Play size={14} fill="currentColor" /></span>
        <span className="library-duration">{video.duration ? formatTime(video.duration) : video.subject}</span>
        {active && <span className="library-live">OPEN NOW</span>}
      </button>
      <div className="library-card-body">
        <div className="library-card-overline">
          <span className={`subject-tag ${subjectClass(video.subject)}`}>{video.subject}</span>
          <span className="library-card-tools">
            {video.pdfName && <span className="library-notes-badge" title={video.pdfName}><FileText size={13} /> PDF</span>}
            {!removed && (
              <button className="library-remove" onClick={onRemove} aria-label={`Remove ${video.title} from your library`} title="Remove from library"><Trash2 size={14} /></button>
            )}
          </span>
        </div>
        <button className="library-video-title" onClick={onResume}>{video.title}</button>
        <p>{video.channel || 'YouTube lesson'}</p>
        <div className="library-card-progress"><div className="progress-track"><span style={{ width: `${percent}%` }} /></div><span>{percent}%</span></div>
        {removed ? (
          <div className="library-removed-actions">
            <button className="library-restore-button" onClick={onRestore}><ArchiveRestore size={13} /> Restore</button>
            <button className="library-delete-forever" onClick={onDeleteForever} title="Delete this lesson and its saved PDF for good"><Trash2 size={13} /> Delete forever</button>
          </div>
        ) : (
          <button className="library-resume-button" onClick={onResume}>{video.currentTime > 5 ? `Resume at ${formatTime(video.currentTime)}` : 'Start lesson'} <ArrowRight size={13} /></button>
        )}
      </div>
    </article>
  );
}
