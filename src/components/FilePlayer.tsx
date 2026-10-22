import {
  useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent,
} from 'react';
import type Hls from 'hls.js';
import {
  AlertTriangle, ExternalLink, Gauge, Maximize, Minimize, Pause, PictureInPicture2, Play, RotateCcw,
  Volume1, Volume2, VolumeX,
} from 'lucide-react';
import type { PlayerSource, PlayerVideoInfo } from '../types';
import { formatTime, isHlsUrl, isNativeMediaUrl } from '../lib/youtube';
import type { PlayerControls } from './YouTubePlayer';

/**
 * Direct video links, played by the browser's own media element behind a full custom control
 * bar — play/pause, a scrubber with a live frame preview, volume, speed, picture-in-picture
 * and fullscreen.
 *
 * Two reasons the controls are custom instead of `controls` on the <video>:
 *   • the native control bar swallows Space and the arrow keys while it has focus, so every
 *     keyboard shortcut looked broken for exactly these lessons;
 *   • the native bar cannot show a frame preview while you scrub.
 *
 * Anything that is not a YouTube link is streamed straight from the URL the user pasted —
 * nothing is downloaded, proxied or re-hosted. `.mp4`/`.webm` play natively; an HLS playlist
 * (`.m3u8`) loads hls.js on demand in Chrome, Firefox and Edge.
 */

interface Props {
  source: PlayerSource;
  controlsRef: MutableRefObject<PlayerControls | null>;
  onReady: () => void;
  onStateChange: (state: number) => void;
  onVideoChange: (info: PlayerVideoInfo) => void;
  onTick: (seconds: number, duration: number) => void;
  onError: (message: string) => void;
  /** The lesson's saved picture — the first frame, once it has been captured. */
  poster?: string;
}

type Engine = 'native' | 'hls';
type Status = 'loading' | 'ready' | 'error';

const LINK_FAILED = 'This link did not play as a video file. If it opens a page with a download button, copy the direct .mp4 or .m3u8 link instead of the page link.';
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const MIN_RATE = 0.1;
const MAX_RATE = 16;
/** The speed the listener picked last — a preference, so it is kept between lessons. */
const RATE_KEY = 'focusframe.playbackRate.v1';

export function sanitizeRate(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value < MIN_RATE || value > MAX_RATE) return null;
  return Math.round(value * 100) / 100;
}

function storedRate(): number {
  try {
    const parsed = sanitizeRate(Number(window.localStorage.getItem(RATE_KEY)));
    return parsed ?? 1;
  } catch {
    return 1;
  }
}

function rememberRate(rate: number): void {
  try {
    window.localStorage.setItem(RATE_KEY, String(rate));
  } catch {
    // A blocked storage area only costs the preference, never playback.
  }
}
const HIDE_CONTROLS_AFTER = 2800;
const UNLOAD_PREVIEW_AFTER = 20000;

/** Safari (and iOS) can play HLS natively; every other browser needs hls.js. */
function canPlayHlsNatively(): boolean {
  if (typeof document === 'undefined') return false;
  const probe = document.createElement('video');
  return Boolean(probe.canPlayType('application/vnd.apple.mpegurl'));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function FilePlayer({
  source, controlsRef, onReady, onStateChange, onVideoChange, onTick, onError, poster,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const callbacksRef = useRef({ onReady, onStateChange, onVideoChange, onTick, onError });
  const sourceRef = useRef(source);
  const pendingSeekRef = useRef<number | null>(null);
  const triedFallbackRef = useRef(false);
  const announcedRef = useRef('');
  const previewLoadedRef = useRef(false);
  const previewPendingRef = useRef(0);
  const previewSeekedAtRef = useRef(0);
  const unloadPreviewTimerRef = useRef(0);
  const hideControlsTimerRef = useRef(0);
  const clickTimerRef = useRef(0);
  const scrubbingRef = useRef(false);
  const barHoveredRef = useRef(false);
  const currentRef = useRef(0);
  const volumeRef = useRef(1);
  const durationRef = useRef(0);

  /** Bumped to force a fresh <video> element after "Try again". */
  const [attempt, setAttempt] = useState(0);
  const [engine, setEngine] = useState<Engine>('native');
  const [status, setStatus] = useState<Status>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [playing, setPlaying] = useState(false);
  const [stalled, setStalled] = useState(false);

  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(storedRate);
  const [customRate, setCustomRate] = useState(() => String(storedRate()));
  const [fullscreen, setFullscreen] = useState(false);
  const [canPip, setCanPip] = useState(false);

  const [controlsVisible, setControlsVisible] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  const [preview, setPreview] = useState<{ time: number; x: number; width: number } | null>(null);
  const [rateMenuOpen, setRateMenuOpen] = useState(false);
  const [rateError, setRateError] = useState('');

  const fileUrl = source.fileUrl ?? '';
  callbacksRef.current = { onReady, onStateChange, onVideoChange, onTick, onError };
  currentRef.current = current;
  volumeRef.current = volume;
  durationRef.current = duration;

  const fail = useCallback((message: string) => {
    setErrorMessage(message);
    setStatus('error');
    callbacksRef.current.onError(message);
  }, []);

  /* ------------------------------------------------------------------ source lifecycle */

  useEffect(() => {
    const element = videoRef.current;
    const sameMedia = sourceRef.current.fileUrl === source.fileUrl;
    sourceRef.current = source;
    triedFallbackRef.current = false;
    announcedRef.current = '';
    pendingSeekRef.current = source.startSeconds && source.startSeconds > 3 ? source.startSeconds : null;
    scrubbingRef.current = false;
    setScrubbing(false);
    setErrorMessage('');
    setStatus('loading');
    setStalled(false);
    setPlaying(false);
    setPreview(null);
    setRateMenuOpen(false);
    setEngine(isHlsUrl(fileUrl) && !canPlayHlsNatively() ? 'hls' : 'native');

    // Resuming the lesson that is already loaded (picked from the library): the metadata is
    // there, so no load event will arrive to apply the saved position — seek right away.
    if (sameMedia && element && element.readyState >= 1 && pendingSeekRef.current !== null) {
      element.currentTime = pendingSeekRef.current;
      pendingSeekRef.current = null;
      setStatus('ready');
      setDuration(Number.isFinite(element.duration) ? element.duration : 0);
    }
  }, [source.token, source.fileUrl, fileUrl]);

  useEffect(() => {
    setCanPip(typeof document !== 'undefined' && Boolean((document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled));
  }, []);

  /* The browser's own player handles every ordinary file link. */
  useEffect(() => {
    const element = videoRef.current;
    if (!element || !fileUrl || engine !== 'native') return;
    setStatus('loading');
    element.src = fileUrl;
    element.load();
    return () => {
      // Detaching stops the network request when the lesson is closed or another link opened.
      element.removeAttribute('src');
      element.load();
    };
  }, [engine, fileUrl, attempt]);

  /* HLS playlists in browsers without native support (Chrome, Firefox, Edge). */
  useEffect(() => {
    if (engine !== 'hls' || !fileUrl) return;
    const element = videoRef.current;
    if (!element) return;
    let cancelled = false;
    let instance: Hls | null = null;

    void (async () => {
      try {
        const { default: HlsPlayer } = await import('hls.js');
        if (cancelled) return;
        if (!HlsPlayer.isSupported()) {
          fail('This browser cannot play HLS playlists. Try the .mp4 link of this video, or open it in Safari.');
          return;
        }
        instance = new HlsPlayer({ enableWorker: true });
        instance.on(HlsPlayer.Events.ERROR, (_event, data) => {
          if (cancelled || !data.fatal) return;
          fail(data.type === 'networkError'
            ? 'This HLS playlist could not be loaded. The link may have expired, or the host may block playback from other websites.'
            : LINK_FAILED);
        });
        instance.loadSource(fileUrl);
        instance.attachMedia(element);
      } catch (error) {
        if (cancelled) return;
        fail(error instanceof Error ? `The HLS player could not be loaded: ${error.message}` : LINK_FAILED);
      }
    })();

    return () => {
      cancelled = true;
      instance?.destroy();
    };
  }, [engine, fileUrl, attempt, fail]);

  /* ------------------------------------------------------------------ controls */

  const seekTo = useCallback((seconds: number) => {
    const element = videoRef.current;
    const target = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    if (!element || element.readyState < 1) {
      // A media element ignores `currentTime` before its metadata exists. Remember the spot
      // and apply it as soon as the video is ready (this is how "resume" works for a link).
      pendingSeekRef.current = target;
      setCurrent(target);
      return;
    }
    const total = Number.isFinite(element.duration) ? element.duration : target;
    element.currentTime = clamp(target, 0, total);
    setCurrent(element.currentTime);
  }, []);

  const togglePlayback = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    if (element.paused || element.ended) {
      const started = element.play();
      if (started && typeof started.catch === 'function') started.catch(() => fail(LINK_FAILED));
    } else {
      element.pause();
    }
  }, [fail]);

  const changeVolume = useCallback((next: number) => {
    const element = videoRef.current;
    const value = clamp(next, 0, 1);
    setVolume(value);
    setMuted(value === 0);
    if (element) {
      element.volume = value;
      element.muted = value === 0;
    }
  }, []);

  const toggleMute = useCallback(() => {
    const element = videoRef.current;
    if (muted && volume === 0) {
      changeVolume(0.6);
      return;
    }
    const next = !muted;
    setMuted(next);
    if (element) element.muted = next;
  }, [muted, volume, changeVolume]);

  const toggleFullscreen = useCallback(() => {
    const stage = stageRef.current;
    const element = videoRef.current;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (stage?.requestFullscreen) {
      void stage.requestFullscreen().catch(() => undefined);
      return;
    }
    // iPhone Safari has no element fullscreen; the video element's own API still works.
    const legacy = element as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    legacy?.webkitEnterFullscreen?.();
  }, []);

  const applyRate = useCallback((next: number) => {
    const element = videoRef.current;
    const value = sanitizeRate(next);
    if (value === null) {
      setRateError(`Use a speed between ${MIN_RATE} and ${MAX_RATE}.`);
      return;
    }
    setRate(value);
    setCustomRate(String(value));
    setRateError('');
    setRateMenuOpen(false);
    rememberRate(value);
    if (element) element.playbackRate = value;
  }, []);

  const toggleCaptions = useCallback(() => {
    // Subtitle tracks only exist when the file itself carries them.
    const tracks = videoRef.current?.textTracks;
    if (!tracks?.length) return;
    const show = tracks[0].mode !== 'showing';
    for (let index = 0; index < tracks.length; index += 1) tracks[index].mode = show ? 'showing' : 'hidden';
  }, []);

  const togglePip = useCallback(() => {
    const element = videoRef.current as (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }) | null;
    if (!element) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
    else void element.requestPictureInPicture?.().catch(() => undefined);
  }, []);

  useEffect(() => {
    const controls: PlayerControls = {
      togglePlayback,
      seekBy: (amount) => seekTo(currentRef.current + amount),
      seekTo,
      adjustVolume: (amount) => changeVolume(volumeRef.current + amount / 100),
      toggleMute,
      toggleFullscreen,
      toggleCaptions,
    };
    controlsRef.current = controls;
    return () => {
      if (controlsRef.current === controls) controlsRef.current = null;
    };
  }, [controlsRef, togglePlayback, seekTo, changeVolume, toggleMute, toggleFullscreen, toggleCaptions]);

  /* ------------------------------------------------------------------ media events */

  const announce = useCallback(() => {
    const videoId = sourceRef.current.videoId ?? sourceRef.current.fileUrl ?? '';
    if (!videoId || announcedRef.current === videoId) return;
    announcedRef.current = videoId;
    // Title and host are left empty on purpose: the record the app saved when the link was
    // pasted already carries the readable name, and this must not overwrite it.
    callbacksRef.current.onVideoChange({ videoId, title: '', channel: '' });
  }, []);

  const readTimeline = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    const total = Number.isFinite(element.duration) ? element.duration : 0;
    setDuration(total);
    setCurrent(element.currentTime);
    try {
      if (element.buffered.length > 0) setBuffered(element.buffered.end(element.buffered.length - 1));
    } catch {
      // `buffered` can throw before anything is loaded; the bar simply stays empty.
    }
    callbacksRef.current.onTick(element.currentTime, total);
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    const element = videoRef.current;
    setStatus('ready');
    setStalled(false);
    callbacksRef.current.onReady();
    announce();
    if (!element) return;
    if (pendingSeekRef.current !== null) {
      element.currentTime = pendingSeekRef.current;
      pendingSeekRef.current = null;
    }
    element.playbackRate = rate;
    element.volume = volume;
    element.muted = muted;
    readTimeline();
  }, [announce, muted, rate, readTimeline, volume]);

  const handleMediaError = useCallback(() => {
    const element = videoRef.current;
    if (!element || !element.error) return;
    // An extension-less link (file hosts usually serve `/d/<id>`) may be an HLS playlist.
    // Try hls.js once before saying the link cannot be played.
    const canFallBack = !triedFallbackRef.current && !canPlayHlsNatively() && !isHlsUrl(fileUrl) && !isNativeMediaUrl(fileUrl);
    if (canFallBack) {
      triedFallbackRef.current = true;
      setEngine('hls');
      return;
    }
    if (element.error.code === 4) {
      fail('This video format is not supported by your browser. A .mp4 file plays everywhere; .mkv does not.');
      return;
    }
    fail(LINK_FAILED);
  }, [fail, fileUrl]);

  const retry = useCallback(() => {
    triedFallbackRef.current = false;
    setErrorMessage('');
    setStatus('loading');
    setEngine(isHlsUrl(fileUrl) && !canPlayHlsNatively() ? 'hls' : 'native');
    setAttempt((value) => value + 1);
  }, [fileUrl]);

  /* A light ticker keeps the scrubber smooth; `timeupdate` alone only fires ~4 times a second. */
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const element = videoRef.current;
      if (!element || element.paused) return;
      setCurrent(element.currentTime);
      try {
        if (element.buffered.length > 0) setBuffered(element.buffered.end(element.buffered.length - 1));
      } catch {
        // ignore
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [playing]);

  /* ------------------------------------------------------------------ controls visibility */

  const showControls = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = window.setTimeout(() => {
      const element = videoRef.current;
      if (!element || element.paused || scrubbingRef.current || barHoveredRef.current) return;
      setControlsVisible(false);
    }, HIDE_CONTROLS_AFTER);
  }, []);

  useEffect(() => {
    showControls();
    return () => window.clearTimeout(hideControlsTimerRef.current);
  }, [showControls, playing, rateMenuOpen]);

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  /* ------------------------------------------------------------------ scrub preview */

  const ensurePreview = useCallback(() => {
    const element = previewVideoRef.current;
    if (!element || previewLoadedRef.current || !fileUrl) return;
    previewLoadedRef.current = true;
    element.src = fileUrl;
    element.load();
    window.clearTimeout(unloadPreviewTimerRef.current);
  }, [fileUrl]);

  const unloadPreview = useCallback(() => {
    const element = previewVideoRef.current;
    if (!element || !previewLoadedRef.current) return;
    previewLoadedRef.current = false;
    previewPendingRef.current = 0;
    element.removeAttribute('src');
    element.load();
  }, []);

  const seekPreview = useCallback((time: number) => {
    const element = previewVideoRef.current;
    if (!element) return;
    if (element.readyState < 1) {
      previewPendingRef.current = time;
      return;
    }
    const now = Date.now();
    // Rapid seeks queue up and stutter, so only move the preview a few times a second.
    if (now - previewSeekedAtRef.current < 110) return;
    if (Math.abs(element.currentTime - time) < 0.3) return;
    previewSeekedAtRef.current = now;
    try {
      element.currentTime = time;
    } catch {
      // A seek before the metadata arrived is ignored; the next move retries.
    }
  }, []);

  const pointerToTime = useCallback((clientX: number): { time: number; x: number; width: number } | null => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return { time: ratio * durationRef.current, x: ratio * rect.width, width: rect.width };
  }, []);

  const onTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!durationRef.current) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a nicety; dragging still works through pointermove.
    }
    scrubbingRef.current = true;
    setScrubbing(true);
    showControls();
    const spot = pointerToTime(event.clientX);
    if (!spot) return;
    setPreview(spot);
    ensurePreview();
    seekPreview(spot.time);
    seekTo(spot.time);
  };

  const onTrackPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!durationRef.current) return;
    const spot = pointerToTime(event.clientX);
    if (!spot) return;
    setPreview(spot);
    ensurePreview();
    seekPreview(spot.time);
    if (scrubbingRef.current) seekTo(spot.time);
  };

  const endScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    setScrubbing(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The capture was already released (pointer left the window).
    }
    window.clearTimeout(unloadPreviewTimerRef.current);
    unloadPreviewTimerRef.current = window.setTimeout(unloadPreview, UNLOAD_PREVIEW_AFTER);
    showControls();
  };

  const hidePreview = () => {
    if (scrubbingRef.current) return;
    setPreview(null);
    window.clearTimeout(unloadPreviewTimerRef.current);
    unloadPreviewTimerRef.current = window.setTimeout(unloadPreview, UNLOAD_PREVIEW_AFTER);
  };

  /* ------------------------------------------------------------------ clicks & keyboard */

  /* A single click toggles playback, a double click goes fullscreen — the same as YouTube. */
  const onStageClick = () => {
    window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => togglePlayback(), 220);
  };

  const onStageDoubleClick = () => {
    window.clearTimeout(clickTimerRef.current);
    toggleFullscreen();
  };

  /**
   * Keys pressed while the player has focus are handled here and stopped from bubbling: the
   * app's global shortcut handler would otherwise act on the same key again — that double
   * handling is why Space looked broken for these lessons.
   */
  const onStageKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    const key = event.key.toLowerCase();
    const handled = (() => {
      if (event.code === 'Space' || key === 'k') { togglePlayback(); return true; }
      if (key === 'arrowleft') { seekTo(currentRef.current - 5); return true; }
      if (key === 'arrowright') { seekTo(currentRef.current + 5); return true; }
      if (key === 'j') { seekTo(currentRef.current - 10); return true; }
      if (key === 'l') { seekTo(currentRef.current + 10); return true; }
      if (key === 'arrowup') { changeVolume(volumeRef.current + 0.05); return true; }
      if (key === 'arrowdown') { changeVolume(volumeRef.current - 0.05); return true; }
      if (key === 'm') { toggleMute(); return true; }
      if (key === 'f') { toggleFullscreen(); return true; }
      if (key === 'c') { toggleCaptions(); return true; }
      if (key === 'home') { seekTo(0); return true; }
      if (key === 'end') { seekTo(durationRef.current); return true; }
      return false;
    })();
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
    showControls();
  };

  /* ------------------------------------------------------------------ render */

  const progress = duration > 0 ? clamp(current / duration, 0, 1) : 0;
  const bufferedRatio = duration > 0 ? clamp(buffered / duration, 0, 1) : 0;
  const previewLeft = useMemo(() => {
    if (!preview) return 0;
    // Keep the preview card inside the player instead of hanging off either edge.
    const half = Math.min(78, preview.width / 2);
    return clamp(preview.x, half, Math.max(half, preview.width - half));
  }, [preview]);

  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div
      className={`youtube-stage fp-stage ${controlsVisible ? 'is-active' : 'is-idle'} ${playing ? 'is-playing' : 'is-paused'}`}
      ref={stageRef}
      tabIndex={0}
      role="region"
      aria-label="Video player"
      onPointerMove={showControls}
      onPointerLeave={showControls}
      onFocus={showControls}
      onKeyDown={onStageKeyDown}
      onClick={onStageClick}
      onDoubleClick={onStageDoubleClick}
    >
      <video
        key={attempt}
        ref={videoRef}
        className="fp-video"
        playsInline
        preload="metadata"
        poster={poster}
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={readTimeline}
        onProgress={readTimeline}
        onDurationChange={readTimeline}
        onPlay={() => { setPlaying(true); setStalled(false); callbacksRef.current.onStateChange(1); showControls(); }}
        onPause={() => { setPlaying(false); callbacksRef.current.onStateChange(2); showControls(); }}
        onWaiting={() => { setStalled(true); callbacksRef.current.onStateChange(3); }}
        onPlaying={() => { setStalled(false); callbacksRef.current.onStateChange(1); }}
        onCanPlay={() => setStalled(false)}
        onEnded={() => { setPlaying(false); callbacksRef.current.onStateChange(0); setControlsVisible(true); }}
        onVolumeChange={(event) => {
          const element = event.currentTarget;
          setMuted(element.muted);
          if (!element.muted) setVolume(element.volume);
        }}
        onRateChange={(event) => setRate(event.currentTarget.playbackRate)}
        onError={handleMediaError}
      />

      {/* A soft gradient keeps the controls readable over a bright frame. */}
      <div className="fp-scrim" aria-hidden="true" />

      {status === 'loading' && (
        <div className="player-loading" aria-live="polite">
          <span className="loading-orbit" />
          <span>Buffering your video…</span>
        </div>
      )}

      {stalled && status === 'ready' && (
        <div className="fp-buffering" aria-live="polite"><span className="loading-orbit" /></div>
      )}

      {!playing && status === 'ready' && !scrubbing && (
        <div className="fp-center" aria-hidden="true">
          <span className="fp-big-play"><Play size={26} fill="currentColor" /></span>
        </div>
      )}

      {status === 'error' && (
        <div className="player-error" role="alert" onClick={(event) => event.stopPropagation()}>
          <span className="error-mark"><AlertTriangle size={17} /></span>
          <div>
            <strong>This link could not be played</strong>
            <p>{errorMessage}</p>
            <div className="file-error-actions">
              <button type="button" className="file-error-retry" onClick={retry}><RotateCcw size={12} /> Try again</button>
              <a className="player-error-link" href={fileUrl} target="_blank" rel="noreferrer">
                Open the link <ExternalLink size={11} />
              </a>
            </div>
          </div>
        </div>
      )}

      <div
        className="fp-controls"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onPointerEnter={() => { barHoveredRef.current = true; showControls(); }}
        onPointerLeave={() => { barHoveredRef.current = false; showControls(); }}
      >
        <div
          className={`fp-progress ${scrubbing ? 'is-scrubbing' : ''}`}
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          aria-valuetext={`${formatTime(current)} of ${formatTime(duration)}`}
          onPointerDown={onTrackPointerDown}
          onPointerMove={onTrackPointerMove}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onPointerLeave={hidePreview}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); seekTo(currentRef.current - 5); }
            else if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); seekTo(currentRef.current + 5); }
          }}
        >
          <span className="fp-progress-track">
            <span className="fp-progress-buffer" style={{ width: `${bufferedRatio * 100}%` }} />
            <span className="fp-progress-played" style={{ width: `${progress * 100}%` }} />
          </span>
          <span className="fp-knob" style={{ left: `${progress * 100}%` }} />

          {/* Always mounted so the frame preview can start loading on the first hover. */}
          <span
            className={`fp-preview ${preview ? 'is-visible' : ''}`}
            style={{ left: `${previewLeft}px` }}
            aria-hidden="true"
          >
            <video
              ref={previewVideoRef}
              muted
              playsInline
              preload="auto"
              tabIndex={-1}
              onLoadedMetadata={(event) => {
                const element = event.currentTarget;
                if (!previewPendingRef.current) return;
                try { element.currentTime = previewPendingRef.current; } catch { /* retried on the next move */ }
              }}
            />
            <span className="fp-preview-time">{formatTime(preview?.time ?? 0)}</span>
          </span>
        </div>

        <div className="fp-row">
          <button
            type="button"
            className="fp-btn fp-btn-play"
            onClick={togglePlayback}
            aria-label={playing ? 'Pause' : 'Play'}
            title={`${playing ? 'Pause' : 'Play'} (Space)`}
          >
            {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
          </button>

          <div className="fp-volume">
            <button type="button" className="fp-btn" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'} title="Mute (M)">
              <VolumeIcon size={16} />
            </button>
            <input
              className="fp-volume-slider"
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={muted ? 0 : volume}
              aria-label="Volume"
              onChange={(event) => changeVolume(Number(event.target.value))}
            />
          </div>

          <span className="fp-time">
            <span className="fp-time-current">{formatTime(current)}</span>
            <span className="fp-time-sep">/</span>
            <span className="fp-time-total">{duration ? formatTime(duration) : '--:--'}</span>
          </span>

          <span className="fp-spacer" />

          <div className="fp-settings">
            <button
              type="button"
              className={`fp-btn fp-btn-rate ${rateMenuOpen ? 'is-open' : ''}`}
              onClick={() => setRateMenuOpen((open) => !open)}
              aria-haspopup="true"
              aria-expanded={rateMenuOpen}
              aria-label={`Playback speed ${rate}x`}
              title="Playback speed"
            >
              <Gauge size={15} />
              <span>{rate}x</span>
            </button>
            {rateMenuOpen && (
              <div className="fp-menu" role="menu">
                {RATES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="menuitemradio"
                    aria-checked={option === rate}
                    className={option === rate ? 'is-selected' : ''}
                    onClick={() => applyRate(option)}
                  >
                    {option}x
                  </button>
                ))}
                <form
                  className="fp-menu-custom"
                  onSubmit={(event) => {
                    event.preventDefault();
                    applyRate(Number(customRate));
                  }}
                >
                  <label>
                    <span className="sr-only">Custom playback speed</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={MIN_RATE}
                      max={MAX_RATE}
                      step={0.05}
                      value={customRate}
                      onChange={(event) => { setCustomRate(event.target.value); setRateError(''); }}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') { event.stopPropagation(); setRateMenuOpen(false); }
                      }}
                      placeholder="1.4"
                      aria-label="Custom playback speed"
                    />
                    <span aria-hidden="true">x</span>
                  </label>
                  <button type="submit" className="fp-menu-set">Set</button>
                </form>
                {rateError
                  ? <p className="fp-menu-hint is-error" role="alert">{rateError}</p>
                  : <p className="fp-menu-hint">{MIN_RATE}–{MAX_RATE}x · saved for your next lesson</p>}
              </div>
            )}
          </div>

          {canPip && (
            <button type="button" className="fp-btn" onClick={togglePip} aria-label="Picture in picture" title="Picture in picture">
              <PictureInPicture2 size={16} />
            </button>
          )}

          <button
            type="button"
            className="fp-btn"
            onClick={toggleFullscreen}
            aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            title="Full screen (F)"
          >
            {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
