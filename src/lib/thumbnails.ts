/**
 * The frame at 00:01 of a direct video link, used as the lesson's thumbnail.
 *
 * A YouTube lesson gets its picture from i.ytimg.com; a `.mp4` or a file-host link has no
 * picture at all. This reads one frame off the video with a canvas.
 *
 * Two things are worth knowing about how that works:
 *
 *   1. A browser only lets a page read the pixels of a cross-origin video when the host sends
 *      `Access-Control-Allow-Origin`. So the first attempt asks for that (`crossOrigin`), and a
 *      second attempt loads the video without it — which always plays, but whose pixels the
 *      browser refuses to hand over. The caller then falls back to showing the frame with a
 *      paused <video> instead of a picture (see components/LessonThumb.tsx), which every host
 *      allows because nothing is being read.
 *   2. Frame zero is usually a fade-in from black, so the capture asks for 00:01 exactly, and
 *      steps back only for a clip that is shorter than that.
 */

const TIMEOUT_MS = 15000;
const MAX_WIDTH = 352;
const QUALITY = 0.55;
/** Above this the data URL is not worth storing at all — a card is only a few hundred pixels. */
const MAX_DATA_URL = 60_000;

/**
 * Hosts that are known (in this tab) to refuse pixel readback. Asking again for every lesson
 * from the same host would only waste a request, so the card goes straight to the live frame.
 */
const blockedHosts = new Set<string>();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** True when this host already refused a frame in this tab. */
export function hostBlocksFrameCapture(url: string): boolean {
  return blockedHosts.has(hostOf(url));
}

export interface PosterCapture {
  /** A small JPEG data URL, or null when the host did not allow reading the frame. */
  dataUrl: string | null;
  /** True when the browser refused to read the pixels (the host sends no CORS headers). */
  blocked: boolean;
}

function once(target: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const onDone = () => { cleanup(); resolve(); };
    const onFail = () => { cleanup(); reject(new Error('the video could not be loaded')); };
    function cleanup() {
      window.clearTimeout(timer);
      target.removeEventListener(event, onDone);
      target.removeEventListener('error', onFail);
    }
    target.addEventListener(event, onDone, { once: true });
    target.addEventListener('error', onFail, { once: true });
  });
}

function drawPoster(element: HTMLVideoElement, width: number, quality: number): string | null {
  const sourceWidth = element.videoWidth;
  const sourceHeight = element.videoHeight;
  if (!sourceWidth || !sourceHeight) return null;
  const targetWidth = Math.min(width, sourceWidth);
  const targetHeight = Math.round((targetWidth * sourceHeight) / sourceWidth);
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(element, 0, 0, targetWidth, targetHeight);
  // A host without CORS headers taints the canvas and this throws — that is the answer.
  return canvas.toDataURL('image/jpeg', quality);
}

/** Where in the clip the thumbnail is taken from: 00:01, unless the clip is shorter. */
export function posterTimestamp(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 1;
  return Math.min(1, Math.max(0, duration * 0.5));
}

interface Attempt {
  dataUrl: string | null;
  /** True when the frame was decoded — a null `dataUrl` then means the pixels were blocked. */
  loaded: boolean;
}

async function tryCapture(url: string, anonymous: boolean): Promise<Attempt> {
  const element = document.createElement('video');
  if (anonymous) element.crossOrigin = 'anonymous';
  element.muted = true;
  element.playsInline = true;
  element.preload = 'auto';
  element.setAttribute('aria-hidden', 'true');
  element.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';

  try {
    document.body.appendChild(element);
    element.src = url;
    element.load();
    await once(element, 'loadeddata', TIMEOUT_MS);

    const target = posterTimestamp(element.duration);
    if (target > 0.01) {
      const seeked = once(element, 'seeked', TIMEOUT_MS);
      element.currentTime = target;
      await seeked;
      // One paint after the seek: the decoder needs a beat before the frame is drawable.
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    }

    let poster: string | null = null;
    try {
      poster = drawPoster(element, MAX_WIDTH, QUALITY);
    } catch {
      // SecurityError: the host did not allow its video to be read.
      return { dataUrl: null, loaded: true };
    }
    if (!poster) return { dataUrl: null, loaded: true };
    if (poster.length <= MAX_DATA_URL) return { dataUrl: poster, loaded: true };
    let smaller: string | null = null;
    try {
      smaller = drawPoster(element, Math.round(MAX_WIDTH * 0.7), 0.45);
    } catch {
      return { dataUrl: null, loaded: true };
    }
    return { dataUrl: smaller && smaller.length <= MAX_DATA_URL ? smaller : null, loaded: true };
  } catch {
    // The video itself never loaded (a dead link, an unsupported format, a timeout).
    return { dataUrl: null, loaded: false };
  } finally {
    element.removeAttribute('src');
    try {
      element.load();
    } catch {
      // Nothing to release.
    }
    element.remove();
  }
}

/**
 * Resolve the frame at 00:01 as a small JPEG data URL. `blocked` is true when the video loaded
 * but the host did not allow its pixels to be read, which tells the caller to fall back to a
 * live frame instead of retrying.
 */
export async function captureVideoPoster(url: string): Promise<PosterCapture> {
  if (!url || typeof document === 'undefined') return { dataUrl: null, blocked: false };

  const host = hostOf(url);
  if (host && blockedHosts.has(host)) return { dataUrl: null, blocked: true };

  const withCors = await tryCapture(url, true);
  if (withCors.dataUrl) return { dataUrl: withCors.dataUrl, blocked: false };

  // Without CORS headers the request above fails outright. Load it the way the player does, to
  // tell "the host blocks reading the frame" apart from "this link cannot be played at all".
  const withoutCors = await tryCapture(url, false);
  if (withoutCors.dataUrl) return { dataUrl: withoutCors.dataUrl, blocked: false };
  if (withoutCors.loaded && host) blockedHosts.add(host);
  return { dataUrl: null, blocked: withoutCors.loaded };
}
