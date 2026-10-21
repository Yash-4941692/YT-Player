import type { Chapter, LessonSourceKind, PlayerSource, Subject, VideoRecord } from '../types';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{10,}$/;

/** File extensions a browser can stream from a direct link without extra help. */
const NATIVE_MEDIA_EXTENSIONS = ['mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov', 'mkv', 'm4a', 'mp3', 'aac'];
/** Playlists the browser cannot open on its own everywhere (Chrome/Firefox need hls.js). */
const HLS_EXTENSIONS = ['m3u8', 'm3u'];

export type LessonInputKind = LessonSourceKind;

export interface ParsedLessonInput {
  kind: LessonInputKind;
  videoId?: string;
  playlistId?: string;
  /** Present for `file` lessons: the direct video link to stream. */
  fileUrl?: string;
  /** A readable title guessed from the link (file lessons only). */
  title?: string;
  /** The link's host, shown as the lesson's "channel" (file lessons only). */
  channel?: string;
}

function safeUrl(raw: string): URL | null {
  const value = raw.trim().replace(/&amp;/gi, '&');
  if (!value) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
}

function youtubeHost(host: string): boolean {
  const clean = host.replace(/^www\./, '').toLowerCase();
  return clean === 'youtu.be' || clean === 'youtube.com' || clean.endsWith('.youtube.com') || clean === 'youtube-nocookie.com';
}

/** True when a pasted value is a YouTube video/playlist link (or a bare video id). */
export function isYouTubeLink(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (VIDEO_ID_RE.test(value)) return true;
  const url = safeUrl(value);
  if (!url) return false;
  return youtubeHost(url.hostname);
}

export function parseYouTubeInput(raw: string): Omit<PlayerSource, 'token'> {
  const parsed = parseLessonInput(raw);
  if (parsed.kind !== 'youtube') throw new Error('That does not look like a YouTube video or playlist URL.');
  return { kind: 'youtube', videoId: parsed.videoId, playlistId: parsed.playlistId };
}

/**
 * Read whatever the user pasted.
 *
 * YouTube links keep their existing handling (video, playlist, shorts, live, youtu.be and a
 * bare 11-character id). Every other `http(s)` link is treated as a direct video link and
 * played by the browser's own player — that is what makes links such as
 * `https://filesto.o2zone.space/d/TnYng8W`, `.mp4` files and `.m3u8` playlists work.
 */
export function parseLessonInput(raw: string): ParsedLessonInput {
  // Links copied from HTML or a message can retain escaped query separators. Decode
  // just the HTML ampersand entity before URL parsing so `&amp;list=…` is read normally.
  const value = raw.trim().replace(/&amp;/gi, '&');
  if (!value) throw new Error('Paste a YouTube link or a direct video link to get started.');

  const url = safeUrl(value);
  const protocol = url?.protocol.toLowerCase();
  if (url && protocol !== 'http:' && protocol !== 'https:') {
    throw new Error('Only http and https links can be played here.');
  }

  if (url && youtubeHost(url.hostname)) {
    let videoId: string | undefined;
    let playlistId: string | undefined;
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const pathParts = url.pathname.split('/').filter(Boolean);
    playlistId = url.searchParams.get('list') || undefined;

    if (host === 'youtu.be') {
      videoId = pathParts[0];
    } else {
      videoId = url.searchParams.get('v') || undefined;
      const route = pathParts[0];
      if (!videoId && ['embed', 'shorts', 'live', 'v'].includes(route ?? '')) {
        videoId = pathParts[1];
      }
    }

    if (videoId && !VIDEO_ID_RE.test(videoId)) videoId = undefined;
    if (playlistId && !PLAYLIST_ID_RE.test(playlistId)) playlistId = undefined;
    if (!videoId && !playlistId) {
      throw new Error('That does not look like a YouTube video or playlist URL.');
    }
    return { kind: 'youtube', videoId, playlistId };
  }

  if (!value.includes('/') && !value.includes('?') && VIDEO_ID_RE.test(value)) {
    return { kind: 'youtube', videoId: value };
  }

  if (!url) throw new Error('That does not look like a YouTube link or a direct video link.');

  // A direct video link. Nothing is downloaded or proxied: the browser streams the URL, so
  // the host has to serve the file itself (no landing page with a download button).
  return {
    kind: 'file',
    fileUrl: value.startsWith('http') ? value : `https://${value}`,
    title: fileNameFromUrl(url),
    channel: url.hostname.replace(/^www\./, ''),
  };
}

/** `…/lesson-01.mp4?token=…` → `lesson 01`; falls back to the host when there is no file name. */
export function fileNameFromUrl(input: string | URL): string {
  const url = typeof input === 'string' ? safeUrl(input) : input;
  if (!url) return '';
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // A malformed escape sequence is not worth failing over — use the raw segment.
  }
  const base = decoded.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_-]+/g, ' ').trim();
  if (base && !/^\d+$/.test(base)) return base;
  return url.hostname.replace(/^www\./, '');
}

function fileExtension(url: URL): string {
  const match = url.pathname.match(/\.([a-z0-9]{1,5})$/i);
  return match ? match[1].toLowerCase() : '';
}

/** True when the link ends in a format the browser can stream on its own. */
export function isNativeMediaUrl(url: string): boolean {
  const parsed = safeUrl(url);
  return parsed ? NATIVE_MEDIA_EXTENSIONS.includes(fileExtension(parsed)) : false;
}

/** True for an HLS playlist link (`.m3u8`), which may need hls.js outside Safari. */
export function isHlsUrl(url: string): boolean {
  const parsed = safeUrl(url);
  return parsed ? HLS_EXTENSIONS.includes(fileExtension(parsed)) : /\.m3u8(\?|#|$)/i.test(url);
}

/**
 * A stable, storage-safe id for a direct video link.
 *
 * Lessons are keyed by this id in the account, so it must not change between visits (the same
 * URL must always map to the same lesson) and it must stay inside `[A-Za-z0-9_-]` because it
 * is also used in a Supabase storage path. Two independent 32-bit FNV-1a passes over the
 * normalised URL give 64 bits, which is far more than a personal library can collide on.
 */
export function fileLessonId(url: string): string {
  const normalized = normalizeFileUrl(url);
  const forward = fnv1a(normalized, 0x811c9dc5);
  const backward = fnv1a([...normalized].reverse().join(''), 0x01000193);
  return `file-${forward.toString(16).padStart(8, '0')}${backward.toString(16).padStart(8, '0')}`;
}

/** The same file linked with a different fragment or host casing is still the same lesson. */
export function normalizeFileUrl(url: string): string {
  const parsed = safeUrl(url);
  if (!parsed) return url.trim();
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${host}${port}${parsed.pathname}${parsed.search}`;
}

function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
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

export function emptyVideoRecord(videoId: string, subject: Subject = 'Physics', kind: LessonSourceKind = 'youtube'): VideoRecord {
  return {
    videoId,
    sourceKind: kind,
    title: kind === 'file' ? 'Direct video lesson' : 'YouTube study session',
    channel: '',
    // A YouTube id always has a thumbnail; a direct link usually has none, and asking
    // i.ytimg.com for an 11-character id that is not a video only returns a grey placeholder.
    thumbnail: kind === 'file' ? '' : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    chaptersRaw: '',
    currentTime: 0,
    duration: 0,
    subject,
    updatedAt: Date.now(),
  };
}

/** A record for a direct video link, with the readable title/host read from the URL. */
export function fileVideoRecord(url: string, subject: Subject = 'Physics'): VideoRecord {
  const parsed = parseLessonInput(url);
  if (parsed.kind !== 'file' || !parsed.fileUrl) throw new Error('That does not look like a direct video link.');
  return {
    ...emptyVideoRecord(fileLessonId(parsed.fileUrl), subject, 'file'),
    sourceUrl: parsed.fileUrl,
    title: parsed.title || 'Direct video lesson',
    channel: parsed.channel || '',
  };
}

export function youtubeUrlFor(videoId: string, playlistId?: string): string {
  const url = new URL('https://www.youtube.com/watch');
  url.searchParams.set('v', videoId);
  if (playlistId) url.searchParams.set('list', playlistId);
  return url.toString();
}

export function isFileLesson(record: VideoRecord | null | undefined): boolean {
  return record?.sourceKind === 'file';
}

/**
 * The link that re-opens a saved lesson. A direct video lesson must be reopened from its own
 * URL — its id is a hash, so there is no YouTube URL to rebuild.
 */
export function lessonUrlFor(record: VideoRecord): string {
  if (isFileLesson(record) && record.sourceUrl) return record.sourceUrl;
  return youtubeUrlFor(record.videoId, record.playlistId);
}
