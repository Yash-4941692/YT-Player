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

/* ---------------------------------------------------------------------------
 * Annotations — the local half of the cross-device sync.
 *
 * Every PDF's drawings are kept in this browser next to the bookkeeping the sync
 * layer needs to decide which copy is newer:
 *
 *   pending          this browser holds changes the account has not confirmed yet
 *   localUpdatedAt   when this browser last changed them
 *   cloudUpdatedAt   the `updated_at` of the account copy this browser last saw
 *
 * Without those, an older browser copy could silently win over a newer account
 * copy (and the other way round), which is exactly how drawings went missing on
 * a second device. Values written by older versions are read as "never confirmed
 * by the account", so they are only used when the account has nothing at all.
 * ------------------------------------------------------------------------- */

const ANNOTATION_CACHE_VERSION = 2;

export interface AnnotationCacheEntry {
  /** The annotation document ({ version: 1, annotations: [...] }). */
  data: unknown;
  /** When this browser last changed the document. */
  localUpdatedAt: number;
  /** The account copy's `updated_at` that this browser last saw (0 = never synced). */
  cloudUpdatedAt: number;
  /** True when this browser holds changes the account has not confirmed yet. */
  pending: boolean;
}

/**
 * Same-tab cache in front of localStorage: the lesson notes panel and the full-screen
 * reader can show the same PDF at once, and they must never disagree.
 */
const annotationMemory = new Map<string, AnnotationCacheEntry>();

function annotationKey(pdfId: string): string {
  return `${PDF_ANNOTATIONS_PREFIX}${pdfId}`;
}

export function loadAnnotationCache(pdfId: string): AnnotationCacheEntry | null {
  const key = annotationKey(pdfId);
  const inMemory = annotationMemory.get(key);
  if (inMemory) return inMemory;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const stored = parsed as Partial<AnnotationCacheEntry> & { v?: number; data?: unknown };
    if (stored.v === ANNOTATION_CACHE_VERSION) {
      const entry: AnnotationCacheEntry = {
        data: stored.data ?? null,
        localUpdatedAt: Number(stored.localUpdatedAt) || 0,
        cloudUpdatedAt: Number(stored.cloudUpdatedAt) || 0,
        pending: Boolean(stored.pending),
      };
      annotationMemory.set(key, entry);
      return entry;
    }
    // A copy written before sync bookkeeping existed: keep it as unconfirmed local work.
    const legacy: AnnotationCacheEntry = {
      data: parsed,
      localUpdatedAt: 0,
      cloudUpdatedAt: 0,
      pending: true,
    };
    annotationMemory.set(key, legacy);
    return legacy;
  } catch {
    return null;
  }
}

export function saveAnnotationCache(pdfId: string, entry: AnnotationCacheEntry): void {
  const key = annotationKey(pdfId);
  annotationMemory.set(key, entry);
  try {
    window.localStorage.setItem(key, JSON.stringify({ v: ANNOTATION_CACHE_VERSION, ...entry }));
  } catch {
    // Ignore storage quota errors: the in-memory copy keeps this tab working.
  }
}

/**
 * Re-key a browser copy: used when a guest's PDF is saved into the account and gets a new
 * library id, so the drawings made before signing in follow it instead of being orphaned
 * under the old session id. The copy is marked pending, so it is pushed on the next open.
 */
export function moveAnnotationCache(fromId: string, toId: string): void {
  if (!fromId || !toId || fromId === toId) return;
  const entry = loadAnnotationCache(fromId);
  if (!entry) return;
  saveAnnotationCache(toId, { ...entry, pending: true });
  deleteLocalAnnotations(fromId);
}

export function deleteLocalAnnotations(pdfId: string): void {
  annotationMemory.delete(annotationKey(pdfId));
  try {
    window.localStorage.removeItem(annotationKey(pdfId));
  } catch {
    // Ignore storage errors.
  }
}
