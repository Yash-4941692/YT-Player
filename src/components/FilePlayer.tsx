import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type Hls from 'hls.js';
import { AlertTriangle, ExternalLink, RotateCcw } from 'lucide-react';
import type { PlayerSource, PlayerVideoInfo } from '../types';
import { isHlsUrl, isNativeMediaUrl } from '../lib/youtube';
import type { PlayerControls } from './YouTubePlayer';

/**
 * Direct video links.
 *
 * Anything that is not a YouTube link is streamed by the browser's own media element straight
 * from the URL the user pasted — nothing is downloaded, proxied or re-hosted. That covers
 * `.mp4`/`.webm` files, file-host download links such as
 * `https://filesto.o2zone.space/d/TnYng8W`, and HLS playlists (`.m3u8`), which Chrome and
 * Firefox cannot open on their own: for those, hls.js is loaded on demand.
 *
 * It exposes exactly the same controls and tick/state callbacks as `YouTubePlayer`, so the
 * keyboard shortcuts, the progress that syncs to the account and the timestamp chapters work
 * the same for both kinds of lesson.
 */

interface Props {
  source: PlayerSource;
  controlsRef: MutableRefObject<PlayerControls | null>;
  onReady: () => void;
  onStateChange: (state: number) => void;
  onVideoChange: (info: PlayerVideoInfo) => void;
  onTick: (seconds: number, duration: number) => void;
  onError: (message: string) => void;
}

type Engine = 'native' | 'hls';

const LINK_FAILED = 'This link did not play as a video file. If it opens a page with a download button, copy the direct .mp4 or .m3u8 link instead of the page link.';

/** Safari (and iOS) can play HLS natively; every other browser needs hls.js. */
function canPlayHlsNatively(): boolean {
  if (typeof document === 'undefined') return false;
  const probe = document.createElement('video');
  return Boolean(probe.canPlayType('application/vnd.apple.mpegurl'));
}

export function FilePlayer({ source, controlsRef, onReady, onStateChange, onVideoChange, onTick, onError }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previousUrlRef = useRef('');
  const callbacksRef = useRef({ onReady, onStateChange, onVideoChange, onTick, onError });
  const sourceRef = useRef(source);
  const pendingSeekRef = useRef<number | null>(null);
  const triedFallbackRef = useRef(false);
  const announcedRef = useRef('');
  /** Bumped to force a fresh <video> element after "Try again". */
  const [attempt, setAttempt] = useState(0);
  const [engine, setEngine] = useState<Engine>('native');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');

  const fileUrl = source.fileUrl ?? '';
  callbacksRef.current = { onReady, onStateChange, onVideoChange, onTick, onError };

  const fail = useCallback((message: string) => {
    setErrorMessage(message);
    setStatus('error');
    callbacksRef.current.onError(message);
  }, []);

  /* A new link — or the same one opened again to resume: reset the per-link state. */
  useEffect(() => {
    const element = videoRef.current;
    const sameMedia = previousUrlRef.current === fileUrl;
    previousUrlRef.current = fileUrl;
    sourceRef.current = source;
    triedFallbackRef.current = false;
    announcedRef.current = '';
    pendingSeekRef.current = source.startSeconds && source.startSeconds > 3 ? source.startSeconds : null;
    setErrorMessage('');
    setStatus('loading');
    setEngine(isHlsUrl(fileUrl) && !canPlayHlsNatively() ? 'hls' : 'native');
    // Resuming the lesson that is already loaded (picked from the library): the metadata is
    // there, so no load event will arrive to apply the saved position — seek right away.
    if (sameMedia && element && element.readyState >= 1 && pendingSeekRef.current !== null) {
      element.currentTime = pendingSeekRef.current;
      pendingSeekRef.current = null;
      setStatus('ready');
    }
  }, [source.token, fileUrl]);

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

  const seek = useCallback((seconds: number) => {
    const element = videoRef.current;
    const target = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    if (!element || element.readyState < 1) {
      // A media element ignores `currentTime` before its metadata exists. Remember the spot
      // and apply it as soon as the video is ready (this is how "resume" works for a link).
      pendingSeekRef.current = target;
      return;
    }
    element.currentTime = target;
  }, []);

  const announce = useCallback(() => {
    const videoId = sourceRef.current.videoId ?? sourceRef.current.fileUrl ?? '';
    if (!videoId || announcedRef.current === videoId) return;
    announcedRef.current = videoId;
    // Title and host are left empty on purpose: the record the app saved when the link was
    // pasted already carries the readable name, and this must not overwrite it.
    callbacksRef.current.onVideoChange({ videoId, title: '', channel: '' });
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    const element = videoRef.current;
    setStatus('ready');
    callbacksRef.current.onReady();
    announce();
    if (!element) return;
    if (pendingSeekRef.current !== null) {
      element.currentTime = pendingSeekRef.current;
      pendingSeekRef.current = null;
    }
    if (Number.isFinite(element.duration)) callbacksRef.current.onTick(element.currentTime, element.duration);
  }, [announce]);

  const handleTimeUpdate = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    const duration = Number.isFinite(element.duration) ? element.duration : 0;
    callbacksRef.current.onTick(element.currentTime, duration);
  }, []);

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

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const controls: PlayerControls = {
      togglePlayback: () => {
        if (element.paused) void element.play().catch(() => fail(LINK_FAILED));
        else element.pause();
      },
      seekBy: (amount) => seek(element.currentTime + amount),
      seekTo: (seconds) => seek(seconds),
      adjustVolume: (amount) => {
        element.muted = false;
        element.volume = Math.min(1, Math.max(0, element.volume + amount / 100));
      },
      toggleMute: () => { element.muted = !element.muted; },
      toggleFullscreen: () => {
        const target = stageRef.current ?? element;
        if (document.fullscreenElement) void document.exitFullscreen();
        else if (target.requestFullscreen) void target.requestFullscreen();
      },
      toggleCaptions: () => {
        // Subtitle tracks only exist when the file itself carries them.
        const tracks = element.textTracks;
        if (!tracks?.length) return;
        const show = tracks[0].mode !== 'showing';
        for (let index = 0; index < tracks.length; index += 1) tracks[index].mode = show ? 'showing' : 'hidden';
      },
    };
    controlsRef.current = controls;
    return () => {
      if (controlsRef.current === controls) controlsRef.current = null;
    };
  }, [controlsRef, fail, seek, attempt]);

  return (
    <div className="youtube-stage file-stage" ref={stageRef}>
      <video
        key={attempt}
        ref={videoRef}
        className="file-video"
        controls
        playsInline
        preload="metadata"
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onDurationChange={handleTimeUpdate}
        onPlay={() => callbacksRef.current.onStateChange(1)}
        onPause={() => callbacksRef.current.onStateChange(2)}
        onWaiting={() => callbacksRef.current.onStateChange(3)}
        onEnded={() => callbacksRef.current.onStateChange(0)}
        onError={handleMediaError}
      />

      {status === 'loading' && (
        <div className="player-loading" aria-live="polite">
          <span className="loading-orbit" />
          <span>Buffering your video…</span>
        </div>
      )}

      {status === 'error' && (
        <div className="player-error" role="alert">
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
    </div>
  );
}
