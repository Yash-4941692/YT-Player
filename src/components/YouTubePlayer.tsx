import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { PlayerSource, PlayerVideoInfo } from '../types';

interface VideoData {
  video_id?: string;
  title?: string;
  author?: string;
}

interface YTPlayerInstance {
  destroy(): void;
  getCurrentTime(): number;
  getDuration(): number;
  getVideoData(): VideoData;
  getPlayerState(): number;
  getPlaylistIndex(): number;
  getVolume(): number;
  getIframe(): HTMLIFrameElement;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  loadVideoById(videoId: string | { videoId: string; startSeconds?: number }): void;
  loadPlaylist(options: { list: string; listType: 'playlist'; index?: number }): void;
  loadModule(module: string): void;
  unloadModule(module: string): void;
  setOption(module: string, option: string, value: unknown): void;
}

interface YTEvent<T = undefined> {
  target: YTPlayerInstance;
  data: T;
}

interface YTNamespace {
  Player: new (element: HTMLElement, options: Record<string, unknown>) => YTPlayerInstance;
  PlayerState: { ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number };
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export interface PlayerControls {
  togglePlayback(): void;
  seekBy(seconds: number): void;
  seekTo(seconds: number): void;
  adjustVolume(amount: number): void;
  toggleMute(): void;
  toggleFullscreen(): void;
  toggleCaptions(): void;
}

interface Props {
  source: PlayerSource;
  controlsRef: MutableRefObject<PlayerControls | null>;
  onReady: () => void;
  onStateChange: (state: number) => void;
  onVideoChange: (info: PlayerVideoInfo) => void;
  onTick: (seconds: number, duration: number) => void;
  onError: (message: string) => void;
}

// Load the IFrame API from YouTube's documented API endpoint. The API itself then
// creates privacy-enhanced embeds using the `host` option below.
const YOUTUBE_IFRAME_API_URL = 'https://www.youtube.com/iframe_api';
const YOUTUBE_EMBED_HOST = 'https://www.youtube-nocookie.com';

let apiPromise: Promise<void> | null = null;

function loadIframeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;

  const pendingApi = new Promise<void>((resolve, reject) => {
    let timeout = 0;
    let script: HTMLScriptElement | null = null;
    let settled = false;
    const previousReady = window.onYouTubeIframeAPIReady;
    const restoreReadyCallback = () => {
      if (window.onYouTubeIframeAPIReady === onApiReady) {
        window.onYouTubeIframeAPIReady = previousReady;
      }
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      restoreReadyCallback();
      script?.remove();
      reject(new Error(message));
    };
    const onApiReady = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      restoreReadyCallback();
      try {
        previousReady?.();
      } catch {
        // A previously registered callback should not prevent this player from initializing.
      }
      resolve();
    };

    window.onYouTubeIframeAPIReady = onApiReady;
    timeout = window.setTimeout(
      () => fail('YouTube player took too long to load. Check your connection and try again.'),
      18000,
    );
    script = document.querySelector<HTMLScriptElement>(`script[src="${YOUTUBE_IFRAME_API_URL}"]`);
    if (!script) {
      script = document.createElement('script');
      script.src = YOUTUBE_IFRAME_API_URL;
      script.async = true;
      document.head.appendChild(script);
    }
    script.onerror = () => fail('Could not load YouTube. Please check your network connection.');
  });

  apiPromise = pendingApi;
  // A failed request should not poison every future attempt in this tab.
  void pendingApi.catch(() => {
    if (apiPromise === pendingApi) apiPromise = null;
  });
  return pendingApi;
}

function mediaInfo(player: YTPlayerInstance): PlayerVideoInfo | null {
  const data = player.getVideoData();
  if (!data?.video_id) return null;
  const playlistIndex = player.getPlaylistIndex?.() ?? -1;
  return { videoId: data.video_id, title: data.title || '', channel: data.author || '', ...(playlistIndex >= 0 ? { playlistIndex } : {}) };
}

function friendlyPlayerError(code: number): string {
  if (code === 2) return 'This YouTube link is not valid.';
  if (code === 5) return 'This video could not be played in the browser. Try opening it on YouTube.';
  if (code === 100) return 'This video is unavailable or has been removed.';
  if (code === 101 || code === 150) return 'The owner does not allow this video to be embedded. Open it on YouTube instead.';
  if (code === 153) return 'YouTube could not verify this embed. Check your browser privacy or referrer settings.';
  return 'YouTube could not play this video. Try another link.';
}

export function YouTubePlayer({ source, controlsRef, onReady, onStateChange, onVideoChange, onTick, onError }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayerInstance | null>(null);
  const sourceRef = useRef(source);
  const callbacksRef = useRef({ onReady, onStateChange, onVideoChange, onTick, onError });
  const lastInfoRef = useRef('');
  const lastPlaylistIndexRef = useRef(-1);
  const [apiReady, setApiReady] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const [playerError, setPlayerError] = useState('');

  callbacksRef.current = { onReady, onStateChange, onVideoChange, onTick, onError };
  const openOnYouTubeUrl = source.videoId
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(source.videoId)}`
    : source.playlistId ? `https://www.youtube.com/playlist?list=${encodeURIComponent(source.playlistId)}` : 'https://www.youtube.com';

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const initialSource = sourceRef.current;

    loadIframeApi().then(() => {
      if (cancelled || !mountRef.current || !window.YT) return;
      setApiReady(true);
      const playerVars: Record<string, number | string> = {
        controls: 1,
        rel: 0,
        modestbranding: 1,
        fs: 1,
        iv_load_policy: 3,
        playsinline: 1,
        showinfo: 0,
        origin: window.location.origin,
      };
      if (initialSource.playlistId) {
        playerVars.list = initialSource.playlistId;
        playerVars.listType = 'playlist';
      }

      // The IFrame API is more reliable with a concrete initial embed path. For a
      // playlist-only URL, `videoseries` is YouTube's special playlist embed endpoint;
      // the playlist ID itself is then loaded in onReady below.
      const initialVideoId = initialSource.videoId ?? (initialSource.playlistId ? 'videoseries' : undefined);
      const player = new window.YT.Player(mountRef.current, {
        width: '100%',
        height: '100%',
        host: YOUTUBE_EMBED_HOST,
        ...(initialVideoId ? { videoId: initialVideoId } : {}),
        playerVars,
        events: {
          onReady: (event: YTEvent) => {
            if (cancelled) return;
            playerRef.current = event.target;
            setPlayerReady(true);
            setPlayerError('');
            controlsRef.current = makeControls(event.target);
            callbacksRef.current.onReady();
            const info = mediaInfo(event.target);
            if (info) {
              lastInfoRef.current = info.videoId;
              callbacksRef.current.onVideoChange(info);
            }
            // Supplying `list` in playerVars is not consistently enough when there is no
            // videoId (a plain /playlist URL). Explicitly load it once the API is ready;
            // keep a provided videoId intact when a watch URL points into a playlist.
            if (initialSource.playlistId && (!initialSource.videoId || (initialSource.playlistIndex ?? 0) > 0)) {
              event.target.loadPlaylist({
                list: initialSource.playlistId,
                listType: 'playlist',
                index: initialSource.playlistIndex ?? 0,
              });
            }
            timer = window.setInterval(() => {
              const currentPlayer = playerRef.current;
              if (!currentPlayer) return;
              const currentInfo = mediaInfo(currentPlayer);
              const index = currentPlayer.getPlaylistIndex?.() ?? -1;
              if (currentInfo && (currentInfo.videoId !== lastInfoRef.current || index !== lastPlaylistIndexRef.current)) {
                lastInfoRef.current = currentInfo.videoId;
                lastPlaylistIndexRef.current = index;
                callbacksRef.current.onVideoChange(currentInfo);
              }
              const currentTime = currentPlayer.getCurrentTime();
              const duration = currentPlayer.getDuration();
              if (Number.isFinite(currentTime)) callbacksRef.current.onTick(currentTime, Number.isFinite(duration) ? duration : 0);
            }, 250);
          },
          onStateChange: (event: YTEvent<number>) => {
            callbacksRef.current.onStateChange(event.data);
            const info = mediaInfo(event.target);
            if (info && info.videoId !== lastInfoRef.current) {
              lastInfoRef.current = info.videoId;
              callbacksRef.current.onVideoChange(info);
            }
          },
          onError: (event: YTEvent<number>) => {
            const message = friendlyPlayerError(event.data);
            setPlayerError(message);
            callbacksRef.current.onError(message);
          },
          // YouTube's public IFrame API primarily reports playlist transitions through state changes.
          // These named listeners are harmless where supported and improve compatibility with playlist embeds.
          onPlaylistData: (event: YTEvent) => {
            const info = mediaInfo(event.target);
            if (info) callbacksRef.current.onVideoChange(info);
          },
          onPlaylistIndexChange: (event: YTEvent) => {
            const info = mediaInfo(event.target);
            if (info) callbacksRef.current.onVideoChange(info);
          },
        },
      });
      playerRef.current = player;
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'YouTube could not be loaded.';
      setPlayerError(message);
      callbacksRef.current.onError(message);
    });

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      controlsRef.current = null;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [controlsRef]);

  useEffect(() => {
    const player = playerRef.current;
    if (!playerReady || !player || source.token === sourceRef.current.token) return;
    sourceRef.current = source;
    setPlayerError('');
    lastInfoRef.current = '';
    lastPlaylistIndexRef.current = -1;
    if (source.playlistId) {
      player.loadPlaylist({ list: source.playlistId, listType: 'playlist', index: source.playlistIndex ?? 0 });
    } else if (source.videoId) {
      player.loadVideoById(source.videoId);
    }
  }, [playerReady, source]);

  return (
    <div className="youtube-stage">
      <div className="youtube-crop">
        <div className="youtube-inner"><div ref={mountRef} className="youtube-mount" /></div>
      </div>
      {!playerReady && !playerError && (
        <div className="player-loading" aria-live="polite">
          <span className="loading-orbit" />
          <span>{apiReady ? 'Preparing your study room…' : 'Connecting to YouTube…'}</span>
        </div>
      )}
      {playerError && (
        <div className="player-error" role="alert">
          <span className="error-mark">!</span>
          <div><strong>Video unavailable</strong><p>{playerError}</p><a className="player-error-link" href={openOnYouTubeUrl} target="_blank" rel="noreferrer">Open on YouTube <span>↗</span></a></div>
        </div>
      )}
    </div>
  );
}

function makeControls(player: YTPlayerInstance): PlayerControls {
  let captionsEnabled = false;
  return {
    togglePlayback: () => {
      if (player.getPlayerState() === 1) player.pauseVideo();
      else player.playVideo();
    },
    seekBy: (amount) => player.seekTo(Math.max(0, player.getCurrentTime() + amount), true),
    seekTo: (seconds) => player.seekTo(Math.max(0, seconds), true),
    adjustVolume: (amount) => player.setVolume(Math.min(100, Math.max(0, player.getVolume() + amount))),
    toggleMute: () => player.isMuted() ? player.unMute() : player.mute(),
    toggleFullscreen: () => {
      const frame = player.getIframe();
      const target = frame.parentElement ?? frame;
      if (document.fullscreenElement) void document.exitFullscreen();
      else if (target.requestFullscreen) void target.requestFullscreen();
    },
    toggleCaptions: () => {
      try {
        if (captionsEnabled) player.unloadModule('captions');
        else {
          player.loadModule('captions');
          player.setOption('captions', 'track', {});
        }
        captionsEnabled = !captionsEnabled;
      } catch {
        // Some videos do not provide captions; YouTube's native CC button remains available.
      }
    },
  };
}
