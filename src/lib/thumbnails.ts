/**
 * The first frame of a direct video link, used as the lesson's thumbnail.
 *
 * A YouTube lesson gets its picture from i.ytimg.com; a `.mp4` or a file-host link has no
 * picture at all, so the player would otherwise show a grey card forever. The frame is read
 * off the video with a canvas — which the browser only allows when the host serves the file
 * with permissive CORS headers. Every failure here is normal and silent: the card simply keeps
 * the link placeholder it already had.
 */

const TIMEOUT_MS = 14000;
const MAX_WIDTH = 352;
const QUALITY = 0.55;
/** Above this the data URL is not worth storing at all — a card is only a few hundred pixels. */
const MAX_DATA_URL = 60_000;

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

/**
 * Resolve to a small JPEG data URL of the video's first visible frame, or null when the host
 * does not allow it (no CORS headers, an unplayable file, a timeout…).
 */
export async function captureVideoPoster(url: string): Promise<string | null> {
  if (!url || typeof document === 'undefined') return null;
  const element = document.createElement('video');
  element.crossOrigin = 'anonymous';
  element.muted = true;
  element.playsInline = true;
  element.preload = 'auto';
  element.setAttribute('aria-hidden', 'true');
  element.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';

  try {
    element.src = url;
    document.body.appendChild(element);
    await once(element, 'loadeddata', TIMEOUT_MS);

    // Frame zero is often a fade-in from black; a moment later looks like the video.
    const total = Number.isFinite(element.duration) ? element.duration : 0;
    const target = total > 0 ? Math.min(1, Math.max(0.1, total * 0.02)) : 0.1;
    if (target > 0) {
      const seeked = once(element, 'seeked', TIMEOUT_MS);
      element.currentTime = target;
      await seeked;
    }

    const poster = drawPoster(element, MAX_WIDTH, QUALITY);
    if (!poster) return null;
    if (poster.length <= MAX_DATA_URL) return poster;
    const smaller = drawPoster(element, Math.round(MAX_WIDTH * 0.7), 0.45);
    return smaller && smaller.length <= MAX_DATA_URL ? smaller : null;
  } catch {
    return null;
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
