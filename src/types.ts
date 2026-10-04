export type Subject = 'Physics' | 'Chemistry' | 'Mathematics' | 'Other';

export interface Chapter {
  seconds: number;
  label: string;
  timeLabel: string;
}

export interface Bookmark {
  id: string;
  seconds: number;
  label: string;
  createdAt: number;
}

export interface VideoRecord {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  playlistId?: string;
  playlistIndex?: number;
  chaptersRaw: string;
  currentTime: number;
  duration: number;
  subject: Subject;
  isRevision: boolean;
  hiddenFromRecent?: boolean;
  bookmarks: Bookmark[];
  pdfPath?: string;
  pdfName?: string;
  pdfSize?: number;
  updatedAt: number;
}

export interface FocusSession {
  id: string;
  minutes: number;
  endedAt: number;
}

export interface StudyTask {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
}

export interface PersistedState {
  videos: VideoRecord[];
  focusSessions: FocusSession[];
  dailyGoalMinutes: number;
  tasks: StudyTask[];
  stateUpdatedAt: number;
}

export interface PlayerSource {
  videoId?: string;
  playlistId?: string;
  playlistIndex?: number;
  token: number;
}

export interface PlayerVideoInfo {
  videoId: string;
  title: string;
  channel: string;
  playlistIndex?: number;
}

export interface SessionPdf {
  data: string;
  name: string;
  size: number;
}
