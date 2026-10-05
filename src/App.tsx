import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { User } from '@supabase/supabase-js';
import {
  ArrowRight, ArrowUpRight, Check, ChevronDown, CircleHelp, Cloud, CloudOff, FileText, Film,
  HardDrive, Info, ListMusic, Play, ShieldCheck, Trash2, X, Zap,
} from 'lucide-react';
import { AuthModal } from './components/AuthModal';
import { ChaptersPanel } from './components/ChaptersPanel';
import { PdfViewer } from './components/PdfViewer';
import { YouTubePlayer, type PlayerControls } from './components/YouTubePlayer';
import { cloudConfigured, createPdfSignedUrl, deleteCloudPdf, fetchCloudVideos, saveCloudVideo, supabase, uploadCloudPdf } from './lib/supabase';
import { loadLocalState, saveLocalState, upsertVideo } from './lib/storage';
import { emptyVideoRecord, formatTime, parseChapters, parseYouTubeInput, youtubeUrlFor } from './lib/youtube';
import type { PersistedState, PlayerSource, PlayerVideoInfo, StudyPanelView, Subject, VideoRecord } from './types';
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
const MAX_PDF_SIZE = 100 * 1024 * 1024;

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  // Let the browser decode large data URLs natively rather than duplicating a 100 MB PDF in JS strings.
  const response = await fetch(dataUrl);
  return response.blob();
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
  const [libraryFilter, setLibraryFilter] = useState<'all' | Subject>('all');

  const playerControlsRef = useRef<PlayerControls | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timestampsRef = useRef<HTMLDetailsElement>(null);
  const notesSessionRef = useRef<Record<string, { data: string; name: string; size: number }>>({});
  const playlistIdRef = useRef<string | undefined>(undefined);
  const loadTokenRef = useRef(0);
  const lastProgressSaveRef = useRef(-1);
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

  useEffect(() => {
    if (!supabase || !authUser || syncedUserId !== authUser.id) return;
    const timeout = window.setTimeout(async () => {
      setSyncStatus('syncing');
      try {
        await Promise.all(videos.map((video) => saveCloudVideo(authUser.id, video)));
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
    const confirmed = window.confirm(`Remove “${record.title}” from your library? Your progress stays saved and re-opening the link brings it back.`);
    if (!confirmed) return;
    updateVideo(record.videoId, { archived: true });
    showToast('Removed from your library.');
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

  const libraryVideos = videos.filter((video) => !video.archived);
  const filteredLibrary = libraryVideos.filter((video) => libraryFilter === 'all' || video.subject === libraryFilter);
  const availableSubjects = subjects.filter((subject) => libraryVideos.some((video) => video.subject === subject));

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
                      status={pdfStatus}
                      locked={Boolean(activeRecord?.pdfPath && !authUser && !sessionPdf)}
                      expanded={notesExpanded}
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

          {libraryVideos.length > 0 && (
            <section className="library-section">
              <div className="library-heading">
                <div>
                  <p className="eyebrow">YOUR LIBRARY</p>
                  <h2>Pick up where you left off</h2>
                  <p>Timestamps, notes and progress stay with every lesson.</p>
                </div>
                <span className="library-count"><span>{libraryVideos.length.toString().padStart(2, '0')}</span> SAVED</span>
              </div>
              <div className="library-filters">
                <button className={libraryFilter === 'all' ? 'selected' : ''} onClick={() => setLibraryFilter('all')}>All lessons <span>{libraryVideos.length}</span></button>
                {availableSubjects.map((subject) => <button key={subject} className={libraryFilter === subject ? 'selected' : ''} onClick={() => setLibraryFilter(subject)}>{subject} <span>{libraryVideos.filter((video) => video.subject === subject).length}</span></button>)}
              </div>
              <div className="library-grid">
                {filteredLibrary.map((video) => (
                  <LibraryCard key={video.videoId} video={video} active={video.videoId === activeVideoId} onResume={() => resumeVideo(video)} onRemove={() => archiveVideo(video)} />
                ))}
                {filteredLibrary.length === 0 && <div className="library-empty">Nothing in this subject yet.</div>}
              </div>
            </section>
          )}

          <footer className="footer"><a className="footer-brand" href="#top"><span className="brand-mark"><Play size={11} fill="currentColor" /></span> focusframe<span>.</span></a><p>Made for your next breakthrough. Videos are streamed by YouTube.</p><a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube terms <ArrowUpRight size={11} /></a></footer>
        </main>
      </div>
      <input ref={fileInputRef} className="sr-only" type="file" accept=".pdf,application/pdf" onChange={handlePdfSelection} />
      {toast && <div className="toast-message"><span><Check size={14} /></span>{toast}</div>}
      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
    </div>
  );
}

function LibraryCard({ video, active, onResume, onRemove }: { video: VideoRecord; active: boolean; onResume: () => void; onRemove: () => void }) {
  const percent = Math.round(progressPercent(video));
  return (
    <article className={`library-card glass-card ${active ? 'library-card-active' : ''}`}>
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
            <button className="library-remove" onClick={onRemove} aria-label={`Remove ${video.title} from your library`} title="Remove from library"><Trash2 size={14} /></button>
          </span>
        </div>
        <button className="library-video-title" onClick={onResume}>{video.title}</button>
        <p>{video.channel || 'YouTube lesson'}</p>
        <div className="library-card-progress"><div className="progress-track"><span style={{ width: `${percent}%` }} /></div><span>{percent}%</span></div>
        <button className="library-resume-button" onClick={onResume}>{video.currentTime > 5 ? `Resume at ${formatTime(video.currentTime)}` : 'Start lesson'} <ArrowRight size={13} /></button>
      </div>
    </article>
  );
}
