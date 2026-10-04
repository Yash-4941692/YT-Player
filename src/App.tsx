import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import type { User } from '@supabase/supabase-js';
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Bookmark, Check, ChevronDown,
  ChevronRight, CircleHelp, Cloud, CloudOff, FileText, Film, HardDrive, Headphones,
  Info, ListMusic, LockKeyhole, Maximize2, MessageSquarePlus, Play, Plus, RotateCcw,
  ShieldCheck, Sparkles, Trash2, Upload, X, Zap,
} from 'lucide-react';
import { AuthModal } from './components/AuthModal';
import { ChaptersPanel } from './components/ChaptersPanel';
import { FocusTools } from './components/FocusTools';
import { YouTubePlayer, type PlayerControls } from './components/YouTubePlayer';
import { cloudConfigured, createPdfSignedUrl, deleteCloudPdf, fetchCloudStudyState, fetchCloudVideos, saveCloudStudyState, saveCloudVideo, supabase, uploadCloudPdf } from './lib/supabase';
import { loadLocalState, saveLocalState, upsertVideo } from './lib/storage';
import { formatBytes } from './lib/utils';
import { emptyVideoRecord, formatTime, parseChapters, parseYouTubeInput, youtubeUrlFor } from './lib/youtube';
import type { Bookmark as VideoBookmark, FocusSession, PersistedState, PlayerSource, PlayerVideoInfo, StudyTask, Subject, VideoRecord } from './types';
import './styles.css';

type SidebarView = 'info' | 'chapters' | 'notes';
type SyncStatus = 'local' | 'syncing' | 'synced' | 'error';

interface PdfPreview {
  url: string;
  name: string;
  size: number;
  cloud: boolean;
}

const subjects: Subject[] = ['Physics', 'Chemistry', 'Mathematics', 'Other'];
const MAX_PDF_SIZE = 100 * 1024 * 1024;

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  // Let the browser decode large data URLs natively rather than duplicating a 100 MB PDF in JS strings.
  const response = await fetch(dataUrl);
  return response.blob();
}

function relativeDate(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} hr ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function subjectClass(subject: Subject): string {
  return subject.toLowerCase().replace(/\s+/g, '-');
}

function progressPercent(record: VideoRecord): number {
  if (!record.duration) return 0;
  return Math.min(100, Math.max(0, (record.currentTime / record.duration) * 100));
}

function makeBookmark(seconds: number, label: string): VideoBookmark {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, seconds, label, createdAt: Date.now() };
}

export default function App() {
  const [initialState] = useState(loadLocalState);
  const [videos, setVideos] = useState<VideoRecord[]>(initialState.videos);
  const [focusSessions, setFocusSessions] = useState<FocusSession[]>(initialState.focusSessions);
  const [dailyGoalMinutes, setDailyGoalMinutes] = useState(initialState.dailyGoalMinutes);
  const [tasks, setTasks] = useState<StudyTask[]>(initialState.tasks);
  const [studyStateUpdatedAt, setStudyStateUpdatedAt] = useState(initialState.stateUpdatedAt);
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
  const [sidebarView, setSidebarView] = useState<SidebarView>('info');
  const [toast, setToast] = useState('');
  const [pdfError, setPdfError] = useState('');
  const [pdfStatus, setPdfStatus] = useState('');
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfPreview, setPdfPreview] = useState<PdfPreview | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfZoom, setPdfZoom] = useState(100);
  const [notesRevision, setNotesRevision] = useState(0);
  const [libraryFilter, setLibraryFilter] = useState<'all' | Subject | 'revision'>('all');

  const playerControlsRef = useRef<PlayerControls | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const notesSessionRef = useRef<Record<string, { data: string; name: string; size: number }>>({});
  const playlistIdRef = useRef<string | undefined>(undefined);
  const loadTokenRef = useRef(0);
  const lastProgressSaveRef = useRef(-1);
  const videosRef = useRef(videos);
  const studyStateRef = useRef({ focusSessions, dailyGoalMinutes, tasks, stateUpdatedAt: studyStateUpdatedAt });
  videosRef.current = videos;
  studyStateRef.current = { focusSessions, dailyGoalMinutes, tasks, stateUpdatedAt: studyStateUpdatedAt };

  const activeRecord = useMemo(
    () => activeVideoId ? videos.find((video) => video.videoId === activeVideoId) ?? null : null,
    [videos, activeVideoId],
  );
  const parsedChapters = useMemo(() => parseChapters(chaptersRaw), [chaptersRaw]);
  const activeChapterIndex = (() => {
    let index = -1;
    for (let chapterIndex = 0; chapterIndex < parsedChapters.length; chapterIndex += 1) {
      if (currentTime >= parsedChapters[chapterIndex].seconds) index = chapterIndex;
      else break;
    }
    return index;
  })();
  const sessionPdf = activeVideoId ? notesSessionRef.current[activeVideoId] : undefined;

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3200);
  }, []);

  const markStudyChanged = useCallback(() => setStudyStateUpdatedAt(Date.now()), []);

  const updateVideo = useCallback((videoId: string, patch: Partial<VideoRecord>) => {
    setVideos((current) => {
      const existing = current.find((item) => item.videoId === videoId) ?? emptyVideoRecord(videoId);
      const updated: VideoRecord = { ...existing, ...patch, updatedAt: Date.now() };
      return upsertVideo(current, updated);
    });
  }, []);

  useEffect(() => {
    const state: PersistedState = { videos, focusSessions, dailyGoalMinutes, tasks, stateUpdatedAt: studyStateUpdatedAt };
    setStorageAvailable(saveLocalState(state));
  }, [videos, focusSessions, dailyGoalMinutes, tasks, studyStateUpdatedAt]);

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
      return;
    }
    let cancelled = false;
    setSyncedUserId(null);
    setSyncStatus('syncing');
    setSyncMessage('Loading your study library…');
    (async () => {
      try {
        const [remoteVideos, remoteStudy] = await Promise.all([
          fetchCloudVideos(authUser.id),
          fetchCloudStudyState(authUser.id),
        ]);
        if (cancelled) return;
        const merged = new Map<string, VideoRecord>();
        for (const record of remoteVideos) merged.set(record.videoId, record);
        for (const record of videosRef.current) {
          const remote = merged.get(record.videoId);
          if (!remote || record.updatedAt >= remote.updatedAt) merged.set(record.videoId, record);
        }
        setVideos([...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt));

        const localStudy = studyStateRef.current;
        if (remoteStudy && remoteStudy.stateUpdatedAt > localStudy.stateUpdatedAt) {
          setFocusSessions(remoteStudy.focusSessions);
          setDailyGoalMinutes(remoteStudy.dailyGoalMinutes);
          setTasks(remoteStudy.tasks);
          setStudyStateUpdatedAt(remoteStudy.stateUpdatedAt);
        }
        setSyncedUserId(authUser.id);
        setSyncStatus('synced');
        setSyncMessage('Your study space is synced.');
      } catch (error) {
        if (cancelled) return;
        setSyncStatus('error');
        setSyncMessage(error instanceof Error ? error.message : 'Cloud sync is unavailable. Your browser copy is still saved.');
      }
    })();
    return () => { cancelled = true; };
  }, [authReady, authUser?.id]);

  useEffect(() => {
    if (!supabase || !authUser || syncedUserId !== authUser.id) return;
    const timeout = window.setTimeout(async () => {
      setSyncStatus('syncing');
      try {
        await Promise.all(videos.map((video) => saveCloudVideo(authUser.id, video)));
        setSyncStatus('synced');
        setSyncMessage('Your study space is synced.');
      } catch (error) {
        setSyncStatus('error');
        setSyncMessage(error instanceof Error ? error.message : 'Could not sync your watch history.');
      }
    }, 1100);
    return () => window.clearTimeout(timeout);
  }, [videos, authUser?.id, syncedUserId]);

  useEffect(() => {
    if (!supabase || !authUser || syncedUserId !== authUser.id) return;
    const timeout = window.setTimeout(async () => {
      try {
        await saveCloudStudyState(authUser.id, { focusSessions, dailyGoalMinutes, tasks, stateUpdatedAt: studyStateUpdatedAt });
        setSyncStatus((status) => status === 'error' ? status : 'synced');
      } catch (error) {
        setSyncStatus('error');
        setSyncMessage(error instanceof Error ? error.message : 'Could not sync your study plan.');
      }
    }, 1100);
    return () => window.clearTimeout(timeout);
  }, [focusSessions, dailyGoalMinutes, tasks, studyStateUpdatedAt, authUser?.id, syncedUserId]);

  useEffect(() => {
    if (!activeVideoId) return;
    setVideos((current) => {
      const existing = current.find((video) => video.videoId === activeVideoId);
      if (!existing || existing.chaptersRaw === chaptersRaw) return current;
      return upsertVideo(current, { ...existing, chaptersRaw, updatedAt: Date.now() });
    });
  }, [chaptersRaw, activeVideoId]);

  useEffect(() => {
    if (parsedChapters.length > 0 && !isPlaylist) setSidebarView('chapters');
  }, [parsedChapters.length, isPlaylist]);

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
  }, [activeVideoId, activeRecord?.pdfPath, activeRecord?.pdfName, activeRecord?.pdfSize, authUser?.id, notesRevision]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

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
      hiddenFromRecent: false,
      updatedAt: Date.now(),
    };
    setVideos((current) => upsertVideo(current, updated));
    setActiveVideoId(info.videoId);
    setPlayerReady(true);
    lastProgressSaveRef.current = -1;
    setChaptersRaw(record.chaptersRaw || '');
    setCurrentTime(record.currentTime || 0);
    setPlayerDuration(record.duration || 0);
    setSidebarView(parseChapters(record.chaptersRaw || '').length > 0 && !playlistIdRef.current ? 'chapters' : 'info');
    setPdfError('');
    setPdfStatus('');
    setPdfZoom(100);
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
      const chosenSubject = subjectOverride ?? selectedSubject;
      playlistIdRef.current = parsed.playlistId;
      setIsPlaylist(Boolean(parsed.playlistId));
      setPlayerReady(Boolean(playerControlsRef.current));
      setPlayerState(-1);
      lastProgressSaveRef.current = -1;
      setCurrentTime(0);
      setPlayerDuration(0);
      setSidebarView('info');
      setPdfStatus('');
      setPdfError('');
      setUrlInput(value);
      let startPlaylistIndex: number | undefined;
      if (parsed.videoId) {
        const existing = videosRef.current.find((video) => video.videoId === parsed.videoId);
        const record = existing ?? emptyVideoRecord(parsed.videoId, chosenSubject);
        startPlaylistIndex = record.playlistIndex;
        if (!existing) setVideos((current) => upsertVideo(current, record));
        setActiveVideoId(parsed.videoId);
        setChaptersRaw(record.chaptersRaw || '');
        setSidebarView(parseChapters(record.chaptersRaw || '').length > 0 && !parsed.playlistId ? 'chapters' : 'info');
        if (record.currentTime > 3) setTimeout(() => playerControlsRef.current?.seekTo(record.currentTime), 500);
      } else {
        setActiveVideoId(null);
        setChaptersRaw('');
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

  function addDoubtMarker() {
    if (!activeVideoId) return;
    const label = window.prompt('What do you want to revisit at this moment?', 'Revisit this concept');
    if (!label?.trim()) return;
    const bookmark = makeBookmark(currentTime, label.trim());
    updateVideo(activeVideoId, { bookmarks: [...(activeRecord?.bookmarks ?? []), bookmark] });
    setSidebarView('info');
    showToast(`Revision marker added at ${formatTime(currentTime)}.`);
  }

  function removeBookmark(id: string) {
    if (!activeVideoId || !activeRecord) return;
    updateVideo(activeVideoId, { bookmarks: activeRecord.bookmarks.filter((bookmark) => bookmark.id !== id) });
  }

  function addFocusSession(minutes: number) {
    const session: FocusSession = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, minutes, endedAt: Date.now() };
    setFocusSessions((current) => [session, ...current].slice(0, 120));
    markStudyChanged();
    showToast(`${minutes}-minute focus session complete. Nice work.`);
  }

  function addStudyTask(title: string) {
    setTasks((current) => [{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title, done: false, createdAt: Date.now() }, ...current]);
    markStudyChanged();
  }

  function toggleStudyTask(taskId: string) {
    setTasks((current) => current.map((task) => task.id === taskId ? { ...task, done: !task.done } : task));
    markStudyChanged();
  }

  function removeStudyTask(taskId: string) {
    setTasks((current) => current.filter((task) => task.id !== taskId));
    markStudyChanged();
  }

  function changeDailyGoal(value: number) {
    setDailyGoalMinutes(value);
    markStudyChanged();
  }

  async function downloadPdf(pdf: PdfPreview) {
    if (!pdf.cloud) {
      const anchor = document.createElement('a');
      anchor.href = pdf.url;
      anchor.download = pdf.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return;
    }
    try {
      const response = await fetch(pdf.url);
      if (!response.ok) throw new Error('The download link expired.');
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = pdf.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    } catch {
      // If the browser blocks a cross-origin download, let the PDF viewer open its signed URL.
      window.open(pdf.url, '_blank', 'noopener,noreferrer');
    }
  }

  async function handleSignOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setAuthUser(null);
    setSyncedUserId(null);
    setSyncStatus('local');
    showToast('Signed out. Your local browser copy is still here.');
  }

  function handlePdfSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void handlePdfUpload(file);
  }

  function handlePdfDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) void handlePdfUpload(file);
  }

  async function handlePdfUpload(file: File) {
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
          const path = await uploadCloudPdf(authUser.id, activeVideoId, file, record?.pdfPath);
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
    if (activeRecord?.pdfPath && authUser && supabase) {
      try {
        await deleteCloudPdf(activeRecord.pdfPath);
      } catch (error) {
        setPdfError(error instanceof Error ? `Could not remove the cloud copy. ${error.message}` : 'Could not remove the cloud copy.');
        return;
      }
    }
    delete notesSessionRef.current[activeVideoId];
    updateVideo(activeVideoId, { pdfPath: undefined, pdfName: undefined, pdfSize: undefined });
    setNotesRevision((value) => value + 1);
    setPdfStatus('');
    setPdfError('');
    showToast('PDF notes removed.');
  }

  const recentVideos = videos.filter((video) => !video.hiddenFromRecent).slice(0, 12);
  const filteredLibrary = videos.filter((video) => {
    if (libraryFilter === 'revision') return video.isRevision;
    if (libraryFilter !== 'all') return video.subject === libraryFilter;
    return true;
  });
  const activeBookmarkCount = activeRecord?.bookmarks.length ?? 0;

  useEffect(() => {
    function handleShortcuts(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]') || event.altKey || event.ctrlKey || event.metaKey) return;
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

  const currentPdf = pdfPreview;
  const progress = activeRecord ? progressPercent({ ...activeRecord, currentTime, duration: playerDuration || activeRecord.duration }) : 0;

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
                <button className="account-chip" onClick={() => showToast(syncMessage || 'Your study library is synced to this account.')} title={authUser.email || 'Account settings'}><span className="account-avatar">{(authUser.email || 'S').slice(0, 1).toUpperCase()}</span><span className="account-email">{authUser.email}</span><ChevronDown size={13} /></button>
                <button className="sign-out-button" onClick={() => void handleSignOut()}>Sign out</button>
              </div>
            ) : (
              <button className="button-quiet sign-in-button" onClick={() => setAuthOpen(true)}><Cloud size={15} /> Sync across devices</button>
            )}
          </div>
        </header>

        <main id="top">
          <section className={`hero ${activeVideoId ? 'hero-compact' : ''}`}>
            <div className="hero-copy">
              <p className="eyebrow hero-eyebrow"><span className="live-dot" /> A LITTLE MORE FOCUS, A LOT MORE FLOW</p>
              <h1>{activeVideoId ? <>Make this one-shot <em>count.</em></> : <>Your JEE one-shots,<br className="desktop-break" /> with a <em>study plan.</em></>}</h1>
              <p className="hero-description">A calm home for YouTube lessons, timestamp chapters, personal notes, and focused study sessions.</p>
            </div>
            <form className="video-load-form" onSubmit={(event) => loadYouTubeVideo(event)}>
              <div className="url-input-wrap"><span className="url-play-icon"><Play size={15} fill="currentColor" /></span><input aria-label="YouTube video or playlist URL" value={urlInput} onChange={(event) => { setUrlInput(event.target.value); setUrlError(''); }} placeholder="Paste a YouTube one-shot or playlist link…" /><span className="url-helper">YOUTUBE</span></div>
              <label className="subject-select-label"><span className="sr-only">Subject</span><select value={selectedSubject} onChange={(event) => setSelectedSubject(event.target.value as Subject)} aria-label="Choose a JEE subject">{subjects.map((subject) => <option key={subject}>{subject}</option>)}</select><ChevronDown size={13} /></label>
              <button className="button-primary load-button" type="submit"><span>{activeVideoId ? 'Load video' : 'Open study room'}</span><ArrowRight size={16} /></button>
            </form>
            {urlError && <p className="url-error" role="alert"><CircleHelp size={14} /> {urlError}</p>}
            {syncStatus === 'error' && <p className="cloud-warning"><CloudOff size={14} /> Cloud sync paused. Your local browser copy is still available. <span title={syncMessage}>Details</span></p>}
          </section>

          {!source && (
            <section className="welcome-section">
              <div className="welcome-heading"><span className="welcome-kicker">A BETTER WAY TO WATCH</span><span className="welcome-line" /></div>
              <div className="welcome-cards">
                <article className="welcome-card">
                  <div className="welcome-icon mint"><Film size={18} /></div>
                  <span className="welcome-number">01</span>
                  <h3>Bring your lesson</h3>
                  <p>Paste a video or playlist. Your YouTube controls stay exactly where you expect them.</p>
                </article>
                <article className="welcome-card">
                  <div className="welcome-icon lavender"><ListMusic size={18} /></div>
                  <span className="welcome-number">02</span>
                  <h3>Make a chapter map</h3>
                  <p>Drop in description timestamps and jump to the concept you want to master.</p>
                </article>
                <article className="welcome-card">
                  <div className="welcome-icon amber"><FileText size={18} /></div>
                  <span className="welcome-number">03</span>
                  <h3>Keep notes close</h3>
                  <p>Attach your class PDF and start a focused timer without leaving the study room.</p>
                </article>
              </div>
              <div className="welcome-footnote"><ShieldCheck size={15} /> No demo videos. Your space is yours to fill.</div>
            </section>
          )}

          {source && (
            <section className="workspace" aria-label="YouTube study room">
              <div className="workspace-main">
                <article className="player-card glass-card">
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
                      <span className={`subject-tag ${subjectClass(activeRecord?.subject ?? selectedSubject)}`}>{activeRecord?.subject ?? selectedSubject}</span>
                      <h2>{activeRecord?.title || 'Your lesson is loading…'}</h2>
                      <p>{activeRecord?.channel || 'YouTube study session'} <span>·</span> {playerDuration ? formatTime(playerDuration) : 'Duration appears when the video is ready'}</p>
                    </div>
                    <div className="player-meta-actions">
                      <button className={`round-action ${activeRecord?.isRevision ? 'saved' : ''}`} onClick={() => activeVideoId && updateVideo(activeVideoId, { isRevision: !activeRecord?.isRevision })} aria-label={activeRecord?.isRevision ? 'Remove from revision shelf' : 'Save to revision shelf'} title={activeRecord?.isRevision ? 'Saved to revision shelf' : 'Save for revision'}><Bookmark size={16} fill={activeRecord?.isRevision ? 'currentColor' : 'none'} /></button>
                      <button className="bookmark-action" onClick={addDoubtMarker}><MessageSquarePlus size={15} /><span>Mark a doubt</span></button>
                    </div>
                  </div>
                  <div className="player-progress"><span style={{ width: `${progress}%` }} /></div>
                  <div className="shortcut-strip"><span><Zap size={13} /> QUICK KEYS</span><kbd>Space</kbd><small>play</small><kbd>←</kbd><kbd>→</kbd><small>seek</small><kbd>F</kbd><small>fullscreen</small><kbd>M</kbd><small>mute</small><kbd>C</kbd><small>captions</small></div>
                </article>

                <section className="chapters-editor glass-card">
                  <div className="section-heading chapters-editor-heading">
                    <div className="section-title-lockup"><div className="section-icon violet"><ListMusic size={18} /></div><div><p className="eyebrow">MAKE EVERY MINUTE COUNT</p><h3>Video chapters</h3></div></div>
                    <div className="chapter-heading-actions"><span className="chapter-count">{parsedChapters.length} {parsedChapters.length === 1 ? 'CHAPTER' : 'CHAPTERS'}</span><a className="description-link" href="https://www.toolsoverflow.com/youtube/youtube-title-description-extractor" target="_blank" rel="noreferrer">Get description <ArrowUpRight size={13} /></a></div>
                  </div>
                  <p className="section-description">Paste timestamps from the video description. They parse as you type and follow the current video.</p>
                  <textarea className="chapters-textarea" value={chaptersRaw} onChange={(event) => setChaptersRaw(event.target.value)} placeholder={'00:00 Introduction\n08:00 - Kinematics\n01:19:42 Work, energy and power'} spellCheck={false} aria-label="Paste video timestamps and chapter titles" />
                  <div className="chapter-editor-footer"><span><Info size={13} /> One timestamp per line · MM:SS or HH:MM:SS</span><span className={parsedChapters.length ? 'parse-success' : ''}>{parsedChapters.length ? <><Check size={13} /> Auto-saved for this video</> : 'Chapters are private to this video'}</span></div>
                </section>

                <section className="notes-card glass-card">
                  <div className="section-heading notes-heading">
                    <div className="section-title-lockup"><div className="section-icon amber"><FileText size={18} /></div><div><p className="eyebrow">YOUR REVISION COMPANION</p><h3>Video notes <span className="pdf-pill">PDF</span></h3></div></div>
                    {pdfPreview && <button className="text-button remove-pdf" onClick={() => void deletePdf()} disabled={pdfBusy}><Trash2 size={14} /> Remove</button>}
                  </div>
                  {!pdfPreview && activeRecord?.pdfPath && !authUser && !sessionPdf ? (
                    <div className="pdf-file-row locked-pdf-row"><div className="pdf-file-icon"><LockKeyhole size={18} /></div><div className="pdf-file-info"><strong title={activeRecord.pdfName}>{activeRecord.pdfName || 'Private PDF notes'}</strong><span>{formatBytes(activeRecord.pdfSize)} <i /> Saved to a private account</span></div><button className="replace-pdf-button" onClick={() => setAuthOpen(true)}><Cloud size={13} /> Sign in</button></div>
                  ) : !pdfPreview ? (
                    <div className={`pdf-dropzone ${pdfBusy ? 'is-uploading' : ''}`} role="button" tabIndex={0} onClick={() => fileInputRef.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click(); }} onDragOver={(event) => event.preventDefault()} onDrop={handlePdfDrop} aria-label="Upload a PDF for this video">
                      <input ref={fileInputRef} className="sr-only" type="file" accept=".pdf,application/pdf" onChange={handlePdfSelection} />
                      <div className="upload-icon-wrap"><Upload size={18} /></div>
                      <div className="pdf-drop-copy"><strong>{pdfBusy ? 'Reading your notes…' : 'Drop your notes PDF here'}</strong><span>or <b>browse files</b> · PDF only · up to 100 MB</span></div>
                      <span className="upload-arrow"><ChevronRight size={17} /></span>
                    </div>
                  ) : (
                    <div className="pdf-file-row">
                      <div className="pdf-file-icon"><FileText size={19} /></div>
                      <div className="pdf-file-info"><strong title={pdfPreview.name}>{pdfPreview.name}</strong><span>{formatBytes(pdfPreview.size)} <i /> {pdfPreview.cloud ? 'Saved to your private cloud library' : 'Available for this session'}</span></div>
                      <button className="replace-pdf-button" onClick={() => fileInputRef.current?.click()} disabled={pdfBusy}><RotateCcw size={13} /> Replace</button>
                      <input ref={fileInputRef} className="sr-only" type="file" accept=".pdf,application/pdf" onChange={handlePdfSelection} />
                    </div>
                  )}
                  {pdfBusy && <div className="upload-progress"><span /></div>}
                  {pdfError && <p className="pdf-error" role="alert"><Info size={13} /> {pdfError}</p>}
                  <div className="pdf-storage-note"><span className={pdfPreview?.cloud ? 'storage-cloud' : 'storage-session'}>{pdfPreview?.cloud ? <Cloud size={14} /> : <Info size={14} />}</span><span>{pdfStatus || (activeRecord?.pdfPath && !authUser && !sessionPdf ? 'Sign in to access this private cloud PDF.' : authUser ? 'PDFs attached to this video sync privately with your account.' : 'Session storage — notes are kept while the page is open.')}</span></div>
                  {pdfPreview && <button className="open-pdf-inline" onClick={() => setSidebarView('notes')}><BookOpen size={14} /> Open notes beside the video <ArrowRight size={13} /></button>}
                  {pdfLoading && <p className="pdf-loading-message"><span className="mini-spinner" /> Fetching your cloud notes…</p>}
                </section>
              </div>

              <aside className="workspace-aside">
                <section className="sidebar-card glass-card">
                  <div className="sidebar-heading"><div><p className="eyebrow">YOUR STUDY COMPANION</p><h3>Study space</h3></div><span className="sidebar-glow"><Sparkles size={16} /></span></div>
                  <div className="sidebar-tabs" role="tablist" aria-label="Study companion panels">
                    <button className={sidebarView === 'info' ? 'active' : ''} onClick={() => setSidebarView('info')} role="tab" aria-selected={sidebarView === 'info'}><Info size={14} /> Info</button>
                    <button className={sidebarView === 'chapters' ? 'active' : ''} onClick={() => setSidebarView('chapters')} role="tab" aria-selected={sidebarView === 'chapters'}><ListMusic size={14} /> Chapters{parsedChapters.length > 0 && <span className="tab-count">{parsedChapters.length}</span>}</button>
                    <button className={sidebarView === 'notes' ? 'active' : ''} onClick={() => setSidebarView('notes')} role="tab" aria-selected={sidebarView === 'notes'}><FileText size={14} /> Notes{pdfPreview && <span className="tab-dot" />}</button>
                  </div>
                  <div className="sidebar-panel" role="tabpanel">
                    {sidebarView === 'chapters' && <ChaptersPanel chapters={parsedChapters} activeIndex={activeChapterIndex} currentTime={currentTime} onSeek={(seconds) => playerControlsRef.current?.seekTo(seconds)} compact />}
                    {sidebarView === 'info' && (
                      <div className="video-info-panel">
                        <div className="info-video-card"><div className={`info-subject-icon ${subjectClass(activeRecord?.subject ?? selectedSubject)}`}><BookOpen size={16} /></div><div><span>STUDYING</span><strong>{activeRecord?.subject ?? selectedSubject}</strong></div><button className={`revision-toggle ${activeRecord?.isRevision ? 'checked' : ''}`} onClick={() => activeVideoId && updateVideo(activeVideoId, { isRevision: !activeRecord?.isRevision })} title="Toggle revision shelf"><Bookmark size={14} fill={activeRecord?.isRevision ? 'currentColor' : 'none'} /></button></div>
                        <div className="info-stat-row"><div><span>WATCHED</span><strong>{formatTime(currentTime)}</strong></div><div><span>VIDEO LENGTH</span><strong>{playerDuration ? formatTime(playerDuration) : '—'}</strong></div></div>
                        <div className="info-progress-wrap"><div className="info-progress-track"><span style={{ width: `${progress}%` }} /></div><span>{Math.round(progress)}% complete</span></div>
                        <div className="sidebar-divider" />
                        <div className="bookmark-list-heading"><div><p className="eyebrow">CONCEPTS TO REVISIT</p><h4>Revision markers</h4></div><span>{activeBookmarkCount}</span></div>
                        {activeBookmarkCount > 0 ? <div className="bookmark-list">{activeRecord?.bookmarks.map((bookmark) => <div className="bookmark-row" key={bookmark.id}><button onClick={() => playerControlsRef.current?.seekTo(bookmark.seconds)}><span className="bookmark-time">{formatTime(bookmark.seconds)}</span><span className="bookmark-name">{bookmark.label}</span><ChevronRight size={13} /></button><button className="bookmark-delete" aria-label={`Remove ${bookmark.label}`} onClick={() => removeBookmark(bookmark.id)}><X size={13} /></button></div>)}</div> : <div className="no-bookmarks"><MessageSquarePlus size={16} /><span>Mark tricky moments as you watch. They will be saved with this video.</span></div>}
                        <button className="add-marker-button" onClick={addDoubtMarker}><Plus size={14} /> Add a timestamped doubt</button>
                        <a className="description-link info-description-link" href="https://www.toolsoverflow.com/youtube/youtube-title-description-extractor" target="_blank" rel="noreferrer">Find video timestamps <ArrowUpRight size={13} /></a>
                      </div>
                    )}
                    {sidebarView === 'notes' && (
                      <div className="notes-preview-panel">
                        {pdfLoading && <div className="notes-view-empty"><span className="mini-spinner" /><strong>Loading your notes…</strong></div>}
                        {!pdfLoading && currentPdf && <>
                          <div className="pdf-toolbar"><span title={currentPdf.name}><FileText size={13} /> {currentPdf.name}</span><div className="pdf-toolbar-actions"><button onClick={() => setPdfZoom((zoom) => Math.max(50, zoom - 25))} aria-label="Zoom out" disabled={pdfZoom <= 50}>−</button><b>{pdfZoom}%</b><button onClick={() => setPdfZoom((zoom) => Math.min(200, zoom + 25))} aria-label="Zoom in" disabled={pdfZoom >= 200}>+</button><button onClick={() => void downloadPdf(currentPdf)} aria-label="Download notes"><ArrowDownToLine size={14} /></button><a href={currentPdf.url} target="_blank" rel="noreferrer" aria-label="Open notes in a new tab"><Maximize2 size={13} /></a></div></div>
                          <div className="pdf-frame-wrap"><iframe key={`${currentPdf.url}-${pdfZoom}`} src={`${currentPdf.url}#zoom=${pdfZoom}`} title={`${currentPdf.name} PDF notes`} /></div>
                          <p className="pdf-view-status">{currentPdf.cloud ? <Cloud size={12} /> : <Info size={12} />}{currentPdf.cloud ? ' Private cloud copy' : ' Session-only PDF'} · {formatBytes(currentPdf.size)}</p>
                        </>}
                        {!pdfLoading && !currentPdf && <div className="notes-view-empty"><div className="empty-panel-icon"><FileText size={18} /></div><strong>{activeRecord?.pdfPath && !authUser ? 'Private cloud notes' : 'No notes attached yet'}</strong><p>{activeRecord?.pdfPath && !authUser ? 'Sign in to the account that saved this PDF to open it here.' : "Upload this lesson's PDF below the player. You can read it here without leaving the video."}</p>{activeRecord?.pdfPath && !authUser ? <button className="button-outline small-outline" onClick={() => setAuthOpen(true)}><Cloud size={13} /> Sign in to open notes</button> : <button className="button-outline small-outline" onClick={() => fileInputRef.current?.click()}><Upload size={13} /> Upload a PDF</button>}</div>}
                      </div>
                    )}
                  </div>
                </section>
                <FocusTools sessions={focusSessions} goalMinutes={dailyGoalMinutes} tasks={tasks} onComplete={addFocusSession} onGoalChange={changeDailyGoal} onAddTask={addStudyTask} onToggleTask={toggleStudyTask} onRemoveTask={removeStudyTask} />
                <div className="keyboard-note"><Headphones size={14} /><span>Put your phone away. Let the timer do the nudging.</span></div>
              </aside>
            </section>
          )}

          {recentVideos.length > 0 && <ContinueWatching videos={recentVideos} currentVideoId={activeVideoId} onResume={resumeVideo} onDismiss={(videoId) => updateVideo(videoId, { hiddenFromRecent: true })} />}

          {videos.length > 0 && (
            <section className="library-section">
              <div className="library-heading"><div><p className="eyebrow">YOUR PERSONAL STUDY LIBRARY</p><h2>Pick up where you left off</h2><p>Every video keeps its chapters, progress, and revision markers together.</p></div><span className="library-count"><span>{videos.length.toString().padStart(2, '0')}</span> SAVED</span></div>
              <div className="library-filters"><button className={libraryFilter === 'all' ? 'selected' : ''} onClick={() => setLibraryFilter('all')}>All videos <span>{videos.length}</span></button>{subjects.filter((subject) => videos.some((video) => video.subject === subject)).map((subject) => <button key={subject} className={libraryFilter === subject ? 'selected' : ''} onClick={() => setLibraryFilter(subject)}>{subject}</button>)}<button className={libraryFilter === 'revision' ? 'selected revision-filter' : 'revision-filter'} onClick={() => setLibraryFilter('revision')}><Bookmark size={12} /> Revision shelf</button></div>
              <div className="library-grid">
                {filteredLibrary.slice(0, 8).map((video) => <LibraryCard key={video.videoId} video={video} active={video.videoId === activeVideoId} onResume={() => resumeVideo(video)} onToggleRevision={() => updateVideo(video.videoId, { isRevision: !video.isRevision })} />)}
                {filteredLibrary.length === 0 && <div className="library-empty">No videos in this shelf yet. Save a video for revision with the bookmark icon.</div>}
              </div>
              {filteredLibrary.length > 8 && <p className="library-more">Showing your 8 most recent videos · {filteredLibrary.length} total</p>}
            </section>
          )}

          {!source && videos.length === 0 && (
            <section className="focus-promo glass-card"><div className="promo-icon"><Zap size={18} fill="currentColor" /></div><div><p className="eyebrow">BUILT FOR DEEP WORK</p><h3>Small systems. Serious progress.</h3><p>Use the 25-minute focus timer, set a daily target, and collect tricky moments into a personal revision shelf.</p></div><div className="promo-chips"><span>Focus timer</span><span>Revision queue</span><span>Private notes</span></div></section>
          )}

          <footer className="footer"><a className="footer-brand" href="#top"><span className="brand-mark"><Play size={11} fill="currentColor" /></span> focusframe<span>.</span></a><p>Made for your next breakthrough. Videos are streamed by YouTube.</p><a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube terms <ArrowUpRight size={11} /></a></footer>
        </main>
      </div>
      {toast && <div className="toast-message"><span><Check size={14} /></span>{toast}</div>}
      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
    </div>
  );
}

function ContinueWatching({ videos, currentVideoId, onResume, onDismiss }: { videos: VideoRecord[]; currentVideoId: string | null; onResume: (record: VideoRecord) => void; onDismiss: (videoId: string) => void }) {
  return (
    <section className="continue-section">
      <div className="continue-heading"><div><p className="eyebrow">A FEW MINUTES CAN TAKE YOU FAR</p><h2>Continue watching</h2></div><span className="continue-count">{String(videos.length).padStart(2, '0')} <span>RECENT</span></span></div>
      <div className="continue-row">
        {videos.map((video) => <article className={`continue-card ${video.videoId === currentVideoId ? 'currently-open' : ''}`} key={video.videoId}>
          <button className="continue-dismiss" onClick={() => onDismiss(video.videoId)} aria-label={`Dismiss ${video.title} from continue watching`} title="Hide from recent"><X size={13} /></button>
          <button className="continue-thumb" onClick={() => onResume(video)} aria-label={`Resume ${video.title}`}><img src={video.thumbnail} alt="" loading="lazy" /><span className="continue-play"><Play size={15} fill="currentColor" /></span><span className={`subject-mini ${subjectClass(video.subject)}`}>{video.subject}</span><span className="continue-progress"><i style={{ width: `${progressPercent(video)}%` }} /></span></button>
          <div className="continue-card-copy"><span>{video.videoId === currentVideoId ? 'OPEN NOW' : relativeDate(video.updatedAt)}</span><button onClick={() => onResume(video)}>{video.title}</button><div><span>{formatTime(video.currentTime)}{video.duration ? ` / ${formatTime(video.duration)}` : ''}</span><button onClick={() => onResume(video)}><RotateCcw size={12} /> Resume</button></div></div>
        </article>)}
      </div>
      <p className="continue-hint"><ChevronRight size={13} /> Scroll sideways to explore your recent one-shots</p>
    </section>
  );
}

function LibraryCard({ video, active, onResume, onToggleRevision }: { video: VideoRecord; active: boolean; onResume: () => void; onToggleRevision: () => void }) {
  return (
    <article className={`library-card glass-card ${active ? 'library-card-active' : ''}`}>
      <button className="library-thumb" onClick={onResume} aria-label={`Open ${video.title}`}><img src={video.thumbnail} alt="" loading="lazy" /><span className="library-play"><Play size={14} fill="currentColor" /></span><span className="library-duration">{video.duration ? formatTime(video.duration) : video.subject}</span></button>
      <div className="library-card-body"><div className="library-card-overline"><span className={`subject-tag ${subjectClass(video.subject)}`}>{video.subject}</span><button onClick={onToggleRevision} className={video.isRevision ? 'revision-card-button selected' : 'revision-card-button'} aria-label={video.isRevision ? 'Remove from revision shelf' : 'Add to revision shelf'}><Bookmark size={14} fill={video.isRevision ? 'currentColor' : 'none'} /></button></div><button className="library-video-title" onClick={onResume}>{video.title}</button><p>{video.channel || 'YouTube lesson'}</p><div className="library-card-progress"><div className="progress-track"><span style={{ width: `${progressPercent(video)}%` }} /></div><span>{Math.round(progressPercent(video))}%</span></div><button className="library-resume-button" onClick={onResume}>Resume lesson <ArrowRight size={13} /></button></div>
    </article>
  );
}
