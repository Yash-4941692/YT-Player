import { useEffect, useRef, useState } from 'react';
import { Film } from 'lucide-react';
import type { VideoRecord } from '../types';
import { posterTimestamp } from '../lib/thumbnails';

/**
 * The picture on a lesson card.
 *
 *   1. A saved picture — YouTube's i.ytimg.com, or the frame at 00:01 that was captured from a
 *      direct link — is shown as a plain <img>.
 *   2. When a direct link has no saved picture (the host did not allow its frame to be read,
 *      see src/lib/thumbnails.ts) the frame is still *shown*: a paused <video> is pointed at the
 *      clip and held at 00:01. Displaying a cross-origin video is always allowed, so this works
 *      on every host — nothing is being read, only played.
 *   3. Otherwise the link placeholder stays.
 *
 * The live frame only starts loading once the card is on screen, so a big library does not
 * quietly download a slice of every video at once.
 */
interface Props {
  video: VideoRecord;
  /** Falls back to the link placeholder instead of a live frame (used by the "Removed" shelf). */
  still?: boolean;
}

export function LessonThumb({ video, still = false }: Props) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [frameReady, setFrameReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const sourceUrl = video.sourceKind === 'file' ? video.sourceUrl : undefined;
  const usesLiveFrame = !video.thumbnail && Boolean(sourceUrl) && !still;

  useEffect(() => {
    if (!usesLiveFrame) return;
    const host = hostRef.current;
    if (!host) return;
    if (typeof IntersectionObserver !== 'function') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '200px' });
    observer.observe(host);
    return () => observer.disconnect();
  }, [usesLiveFrame]);

  if (video.thumbnail) {
    return <img src={video.thumbnail} alt="" loading="lazy" />;
  }

  if (!usesLiveFrame) {
    return <span className="library-thumb-link"><Film size={22} /></span>;
  }

  return (
    <span className={`library-thumb-frame ${frameReady ? 'is-ready' : ''}`} ref={hostRef}>
      {failed
        ? <span className="library-thumb-link"><Film size={22} /></span>
        : (
          <>
            <video
              ref={videoRef}
              src={visible ? sourceUrl : undefined}
              muted
              playsInline
              preload="metadata"
              tabIndex={-1}
              aria-hidden="true"
              onLoadedMetadata={(event) => {
                const element = event.currentTarget;
                // Hold the clip on its 00:01 frame — the same frame a captured thumbnail uses.
                try {
                  element.currentTime = posterTimestamp(element.duration);
                } catch {
                  setFrameReady(true);
                }
              }}
              onSeeked={() => setFrameReady(true)}
              onError={() => setFailed(true)}
            />
            {!frameReady && <span className="library-thumb-link"><Film size={22} /></span>}
          </>
        )}
    </span>
  );
}
