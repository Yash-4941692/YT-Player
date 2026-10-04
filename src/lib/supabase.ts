import { createClient } from '@supabase/supabase-js';
import type { Bookmark, FocusSession, StudyTask, Subject, VideoRecord } from '../types';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

export const cloudConfigured = Boolean(supabase);

interface WatchRow {
  video_id: string;
  title: string;
  channel: string;
  thumbnail: string;
  playlist_id: string | null;
  playlist_index?: number | null;
  chapters_raw: string;
  current_time: number;
  duration: number;
  subject: Subject;
  is_revision: boolean;
  hidden_from_recent?: boolean;
  bookmarks: Bookmark[];
  pdf_path: string | null;
  pdf_name: string | null;
  pdf_size: number | null;
  updated_at: string;
}

function rowToVideo(row: WatchRow): VideoRecord {
  return {
    videoId: row.video_id,
    title: row.title || 'YouTube study session',
    channel: row.channel || '',
    thumbnail: row.thumbnail || `https://i.ytimg.com/vi/${row.video_id}/hqdefault.jpg`,
    playlistId: row.playlist_id || undefined,
    playlistIndex: Number.isInteger(row.playlist_index) && Number(row.playlist_index) >= 0 ? Number(row.playlist_index) : undefined,
    chaptersRaw: row.chapters_raw || '',
    currentTime: Number(row.current_time) || 0,
    duration: Number(row.duration) || 0,
    subject: row.subject || 'Other',
    isRevision: Boolean(row.is_revision),
    hiddenFromRecent: Boolean(row.hidden_from_recent),
    bookmarks: Array.isArray(row.bookmarks) ? row.bookmarks : [],
    pdfPath: row.pdf_path || undefined,
    pdfName: row.pdf_name || undefined,
    pdfSize: row.pdf_size ? Number(row.pdf_size) : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  };
}

function videoToRow(record: VideoRecord): Omit<WatchRow, 'updated_at'> & { updated_at: string } {
  return {
    video_id: record.videoId,
    title: record.title,
    channel: record.channel,
    thumbnail: record.thumbnail,
    playlist_id: record.playlistId || null,
    playlist_index: record.playlistIndex ?? null,
    chapters_raw: record.chaptersRaw,
    current_time: record.currentTime,
    duration: record.duration,
    subject: record.subject,
    is_revision: record.isRevision,
    hidden_from_recent: Boolean(record.hiddenFromRecent),
    bookmarks: record.bookmarks,
    pdf_path: record.pdfPath || null,
    pdf_name: record.pdfName || null,
    pdf_size: record.pdfSize || null,
    updated_at: new Date(record.updatedAt).toISOString(),
  };
}

export interface RemoteStudyState {
  focusSessions: FocusSession[];
  dailyGoalMinutes: number;
  tasks: StudyTask[];
  stateUpdatedAt: number;
}

export async function fetchCloudVideos(userId: string): Promise<VideoRecord[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('watch_items').select('*').eq('user_id', userId);
  if (error) throw error;
  return (data as WatchRow[]).map(rowToVideo);
}

export async function saveCloudVideo(userId: string, record: VideoRecord): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('watch_items').upsert(
    { ...videoToRow(record), user_id: userId },
    { onConflict: 'user_id,video_id' },
  );
  if (error) throw error;
}

export async function fetchCloudStudyState(userId: string): Promise<RemoteStudyState | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('study_state').select('data').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (!data?.data || typeof data.data !== 'object') return null;
  const state = data.data as Partial<RemoteStudyState>;
  return {
    focusSessions: Array.isArray(state.focusSessions) ? state.focusSessions : [],
    dailyGoalMinutes: Number.isFinite(state.dailyGoalMinutes) ? Number(state.dailyGoalMinutes) : 180,
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    stateUpdatedAt: Number.isFinite(state.stateUpdatedAt) ? Number(state.stateUpdatedAt) : Date.now(),
  };
}

export async function saveCloudStudyState(userId: string, state: RemoteStudyState): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('study_state').upsert(
    { user_id: userId, data: state, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
}

export async function uploadCloudPdf(userId: string, videoId: string, file: File, previousPath?: string): Promise<string> {
  if (!supabase) throw new Error('Cloud sync is not configured.');
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-90) || 'notes.pdf';
  const path = `${userId}/${videoId}/${Date.now()}-${safeName}`;
  const { error } = await supabase.storage.from('video-notes').upload(path, file, {
    contentType: 'application/pdf',
    cacheControl: '3600',
    upsert: false,
  });
  if (error) throw error;
  if (previousPath) await supabase.storage.from('video-notes').remove([previousPath]);
  return path;
}

export async function createPdfSignedUrl(path: string): Promise<string> {
  if (!supabase) throw new Error('Cloud sync is not configured.');
  const { data, error } = await supabase.storage.from('video-notes').createSignedUrl(path, 60 * 60);
  if (error) throw error;
  return data.signedUrl;
}

export async function deleteCloudPdf(path: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.storage.from('video-notes').remove([path]);
  if (error) throw error;
}
