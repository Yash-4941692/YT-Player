import { createClient } from '@supabase/supabase-js';
import { newLibraryId } from './pdfLibrary';
import type { LibraryPdf, Subject, VideoRecord } from '../types';

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
  hidden_from_recent?: boolean | null;
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
    archived: Boolean(row.hidden_from_recent),
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
    hidden_from_recent: Boolean(record.archived),
    pdf_path: record.pdfPath || null,
    pdf_name: record.pdfName || null,
    pdf_size: record.pdfSize || null,
    updated_at: new Date(record.updatedAt).toISOString(),
  };
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

/* ---------------------------------------------------------------------------
 * PDF library — a personal, cross-device shelf of PDFs that is not tied to a
 * single lesson. Files live in the same private `video-notes` bucket, under a
 * `<user id>/library/` prefix, so no extra bucket setup is required.
 * ------------------------------------------------------------------------- */

export const LIBRARY_PATH_MARKER = '/library/';

/** True when a storage path points at a PDF-library file rather than a lesson attachment. */
export function isLibraryPath(path?: string): boolean {
  return typeof path === 'string' && path.includes(LIBRARY_PATH_MARKER);
}

interface LibraryRow {
  id: string;
  user_id: string;
  name: string;
  subject: Subject;
  size: number | null;
  storage_path: string;
  created_at: string;
  updated_at: string;
}

function rowToLibraryPdf(row: LibraryRow): LibraryPdf {
  return {
    id: row.id,
    name: row.name || 'Untitled PDF',
    subject: row.subject || 'Other',
    size: Number(row.size) || 0,
    storagePath: row.storage_path,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  };
}

export function libraryStoragePath(userId: string, id: string, fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-90) || 'notes.pdf';
  return `${userId}/library/${id}-${safeName}`;
}

export async function fetchLibraryPdfs(userId: string): Promise<LibraryPdf[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('pdf_library')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data as LibraryRow[]).map(rowToLibraryPdf);
}

/**
 * Insert the metadata row first, then upload the file. If the upload fails the row is
 * removed again, so the library never lists a PDF whose file is missing.
 */
export async function createLibraryPdf(
  userId: string,
  file: File,
  subject: Subject,
): Promise<LibraryPdf> {
  if (!supabase) throw new Error('Cloud sync is not configured.');
  const id = newLibraryId();
  const storagePath = libraryStoragePath(userId, id, file.name);
  const { data, error } = await supabase
    .from('pdf_library')
    .insert({
      id,
      user_id: userId,
      name: file.name,
      subject,
      size: file.size,
      storage_path: storagePath,
    })
    .select()
    .single();
  if (error) throw error;

  const { error: uploadError } = await supabase.storage.from('video-notes').upload(storagePath, file, {
    contentType: 'application/pdf',
    cacheControl: '3600',
    upsert: false,
  });
  if (uploadError) {
    await supabase.from('pdf_library').delete().eq('id', id).eq('user_id', userId);
    throw uploadError;
  }
  return rowToLibraryPdf(data as LibraryRow);
}

export async function updateLibraryPdf(
  userId: string,
  id: string,
  patch: { name?: string; subject?: Subject },
): Promise<void> {
  if (!supabase) throw new Error('Cloud sync is not configured.');
  const { error } = await supabase
    .from('pdf_library')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId);
  if (error) throw error;
}

export async function deleteLibraryPdf(userId: string, item: LibraryPdf): Promise<void> {
  if (!supabase) throw new Error('Cloud sync is not configured.');
  const { error: removeError } = await supabase.storage.from('video-notes').remove([item.storagePath]);
  // A missing file should never block clearing the entry from the library.
  if (removeError && !/not found|404/i.test(removeError.message)) throw removeError;
  const { error } = await supabase.from('pdf_library').delete().eq('id', item.id).eq('user_id', userId);
  if (error) throw error;
}
