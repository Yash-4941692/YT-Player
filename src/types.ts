export type Subject = 'Physics' | 'Chemistry' | 'Mathematics' | 'Other';

/**
 * Where a lesson's video comes from.
 *
 * `youtube` lessons are played by the YouTube IFrame player from an 11-character video id.
 * `file` lessons are played by the browser's own <video> element from any direct video link
 * (for example `https://host.example/d/TnYng8W`, an `.mp4`, or an HLS `.m3u8` playlist).
 * Lessons saved before direct links existed have no `sourceKind` and are YouTube lessons.
 */
export type LessonSourceKind = 'youtube' | 'file';

export interface Chapter {
  seconds: number;
  label: string;
  timeLabel: string;
}

export interface VideoRecord {
  videoId: string;
  /** `undefined` means `youtube` — lessons from before direct links existed. */
  sourceKind?: LessonSourceKind;
  /** The direct video URL of a `file` lesson; empty for YouTube lessons. */
  sourceUrl?: string;
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
  /**
   * Set only on the cloud copy of a deleted lesson (it is the tombstone that makes the delete
   * reach every device). A record with this set is never shown, stored or uploaded.
   */
  deletedAt?: number;
  pdfPath?: string;
  pdfName?: string;
  pdfSize?: number;
  updatedAt: number;
}

export interface PersistedState {
  videos: VideoRecord[];
}

export interface PlayerSource {
  /** Defaults to `youtube` when omitted. */
  kind?: LessonSourceKind;
  videoId?: string;
  /** Direct video URL for `file` lessons. */
  fileUrl?: string;
  playlistId?: string;
  playlistIndex?: number;
  /** Where playback should resume (a file lesson cannot seek before its metadata arrives). */
  startSeconds?: number;
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

/**
 * A PDF in the user's personal library.
 *
 * `storagePath` is the path inside the private Supabase bucket for account-backed
 * PDFs. Items uploaded while browsing as a guest have no cloud copy yet: they are
 * marked `sessionOnly` and keep the raw `file` in memory for the current tab.
 */
export interface LibraryPdf {
  id: string;
  name: string;
  subject: Subject;
  size: number;
  storagePath: string;
  createdAt: number;
  updatedAt: number;
  sessionOnly?: boolean;
  file?: File;
}
