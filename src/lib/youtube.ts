import type { Chapter, PlayerSource, Subject, VideoRecord } from '../types';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{10,}$/;

export function parseYouTubeInput(raw: string): Omit<PlayerSource, 'token'> {
  const value = raw.trim();
  if (!value) throw new Error('Paste a YouTube video or playlist link to get started.');

  let videoId: string | undefined;
  let playlistId: string | undefined;
  try {
    const url = new URL(value.startsWith('http') ? value : `https://${value}`);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const pathParts = url.pathname.split('/').filter(Boolean);
    playlistId = url.searchParams.get('list') || undefined;

    if (host === 'youtu.be' || host === 'www.youtu.be') {
      videoId = pathParts[0];
    } else if (host.endsWith('youtube.com') || host === 'youtube-nocookie.com') {
      videoId = url.searchParams.get('v') || undefined;
      const route = pathParts[0];
      if (!videoId && ['embed', 'shorts', 'live', 'v'].includes(route ?? '')) {
        videoId = pathParts[1];
      }
    } else if (!value.includes('/') && !value.includes('?')) {
      videoId = value;
    }
  } catch {
    if (VIDEO_ID_RE.test(value)) videoId = value;
  }

  if (videoId && !VIDEO_ID_RE.test(videoId)) videoId = undefined;
  if (playlistId && !PLAYLIST_ID_RE.test(playlistId)) playlistId = undefined;
  if (!videoId && !playlistId) {
    throw new Error('That does not look like a YouTube video or playlist URL.');
  }
  return { videoId, playlistId };
}

export function parseChapters(input: string): Chapter[] {
  const result: Chapter[] = [];
  const linePattern = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—.]?\s*(.+)$/;

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(linePattern);
    if (!match) continue;
    const pieces = match[1].split(':').map(Number);
    const seconds = pieces.length === 3
      ? pieces[0] * 3600 + pieces[1] * 60 + pieces[2]
      : pieces[0] * 60 + pieces[1];
    const label = match[2].trim();
    if (!label || !Number.isFinite(seconds)) continue;
    result.push({ seconds, label, timeLabel: formatTime(seconds) });
  }
  return result.sort((a, b) => a.seconds - b.seconds);
}

export function formatTime(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function emptyVideoRecord(videoId: string, subject: Subject = 'Physics'): VideoRecord {
  return {
    videoId,
    title: 'YouTube study session',
    channel: '',
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    chaptersRaw: '',
    currentTime: 0,
    duration: 0,
    subject,
    updatedAt: Date.now(),
  };
}

export function youtubeUrlFor(videoId: string, playlistId?: string): string {
  const url = new URL('https://www.youtube.com/watch');
  url.searchParams.set('v', videoId);
  if (playlistId) url.searchParams.set('list', playlistId);
  return url.toString();
}
