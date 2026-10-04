import type { PersistedState, Subject, VideoRecord } from '../types';

const STORAGE_KEY = 'focusframe.jee.v1';

const initialState: PersistedState = {
  videos: [],
  focusSessions: [],
  dailyGoalMinutes: 180,
  tasks: [],
  stateUpdatedAt: Date.now(),
};

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
    isRevision: Boolean(item.isRevision),
    hiddenFromRecent: Boolean(item.hiddenFromRecent),
    bookmarks: Array.isArray(item.bookmarks) ? item.bookmarks : [],
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
    return {
      videos,
      focusSessions: Array.isArray(parsed.focusSessions) ? parsed.focusSessions : [],
      dailyGoalMinutes: Number.isFinite(parsed.dailyGoalMinutes) ? Math.min(1440, Math.max(15, Number(parsed.dailyGoalMinutes))) : 180,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      stateUpdatedAt: Number.isFinite(parsed.stateUpdatedAt) ? Number(parsed.stateUpdatedAt) : Date.now(),
    };
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
