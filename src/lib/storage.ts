import type { PersistedState, Subject, VideoRecord } from '../types';

const STORAGE_KEY = 'focusframe.jee.v1';
const PDF_TRASH_KEY = 'focusframe.pdfTrash.v1';
const PDF_ACTIVITY_KEY = 'focusframe.pdfActivity.v1';
const PDF_ANNOTATIONS_PREFIX = 'focusframe.pdfAnnotations.v1.';

const initialState: PersistedState = { videos: [] };

export interface StoredPdfActivity {
  lastOpenedAt: number | null;
  pageCount: number | null;
}

function isSubject(value: unknown): value is Subject {
  return value === 'Physics' || value === 'Chemistry' || value === 'Mathematics' || value === 'Other';
}

function normalizeVideo(value: unknown): VideoRecord | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<VideoRecord>;
  if (typeof item.videoId !== 'string' || !item.videoId) return null;
  return {
    videoId: item.videoId,
    title: typeof item.title === 'string' ? item.title : 'YouTube study session',
    channel: typeof item.channel === 'string' ? item.channel : '',
    thumbnail: typeof item.thumbnail === 'string' ? item.thumbnail : `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
    playlistId: typeof item.playlistId === 'string' ? item.playlistId : undefined,
    playlistIndex: Number.isInteger(item.playlistIndex) && Number(item.playlistIndex) >= 0 ? Number(item.playlistIndex) : undefined,
    chaptersRaw: typeof item.chaptersRaw === 'string' ? item.chaptersRaw : '',
    currentTime: Number.isFinite(item.currentTime) ? Number(item.currentTime) : 0,
    duration: Number.isFinite(item.duration) ? Number(item.duration) : 0,
    subject: isSubject(item.subject) ? item.subject : 'Other',
    archived: Boolean(item.archived),
    pdfPath: typeof item.pdfPath === 'string' ? item.pdfPath : undefined,
    pdfName: typeof item.pdfName === 'string' ? item.pdfName : undefined,
    pdfSize: Number.isFinite(item.pdfSize) ? Number(item.pdfSize) : undefined,
    updatedAt: Number.isFinite(item.updatedAt) ? Number(item.updatedAt) : Date.now(),
  };
}

export function loadLocalState(): PersistedState {
  try {
    const serialized = window.localStorage.getItem(STORAGE_KEY);
    if (!serialized) return initialState;
    const parsed = JSON.parse(serialized) as Partial<PersistedState>;
    const videos = Array.isArray(parsed.videos)
      ? parsed.videos.map(normalizeVideo).filter((item): item is VideoRecord => item !== null)
      : [];
    return { videos };
  } catch {
    return initialState;
  }
}

export function saveLocalState(state: PersistedState): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    // Browser storage can be blocked or full. Keep the current session usable regardless.
    return false;
  }
}

export function upsertVideo(list: VideoRecord[], record: VideoRecord): VideoRecord[] {
  const index = list.findIndex((video) => video.videoId === record.videoId);
  if (index === -1) return [record, ...list].sort((a, b) => b.updatedAt - a.updatedAt);
  const next = [...list];
  next[index] = record;
  return next.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadLocalPdfTrash(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(PDF_TRASH_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const ts = Number(value);
      if (key && Number.isFinite(ts) && ts > 0) out[key] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveLocalPdfTrash(trash: Record<string, number>): void {
  try {
    window.localStorage.setItem(PDF_TRASH_KEY, JSON.stringify(trash));
  } catch {
    // Ignore storage quota errors.
  }
}

export function loadLocalPdfActivity(): Record<string, StoredPdfActivity> {
  try {
    const raw = window.localStorage.getItem(PDF_ACTIVITY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, StoredPdfActivity> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key || !value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      const lastOpenedAt = Number.isFinite(Number(entry.lastOpenedAt)) && Number(entry.lastOpenedAt) > 0
        ? Number(entry.lastOpenedAt)
        : null;
      const pageCount = Number.isFinite(Number(entry.pageCount)) && Number(entry.pageCount) > 0
        ? Number(entry.pageCount)
        : null;
      out[key] = { lastOpenedAt, pageCount };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveLocalPdfActivity(activity: Record<string, StoredPdfActivity>): void {
  try {
    window.localStorage.setItem(PDF_ACTIVITY_KEY, JSON.stringify(activity));
  } catch {
    // Ignore storage quota errors.
  }
}

export function loadLocalAnnotations(pdfId: string): unknown | null {
  try {
    const raw = window.localStorage.getItem(`${PDF_ANNOTATIONS_PREFIX}${pdfId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveLocalAnnotations(pdfId: string, data: unknown): void {
  try {
    window.localStorage.setItem(`${PDF_ANNOTATIONS_PREFIX}${pdfId}`, JSON.stringify(data));
  } catch {
    // Ignore storage quota errors.
  }
}

export function deleteLocalAnnotations(pdfId: string): void {
  try {
    window.localStorage.removeItem(`${PDF_ANNOTATIONS_PREFIX}${pdfId}`);
  } catch {
    // Ignore storage errors.
  }
}
