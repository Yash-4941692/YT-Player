export type Subject = 'Physics' | 'Chemistry' | 'Mathematics' | 'Other';

export interface Chapter {
  seconds: number;
  label: string;
  timeLabel: string;
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
  archived?: boolean;
  pdfPath?: string;
  pdfName?: string;
  pdfSize?: number;
  updatedAt: number;
}

export interface PersistedState {
  videos: VideoRecord[];
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

export type StudyPanelView = 'notes' | 'timestamps';
