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

/**
 * Delete one lesson row from the account. Used by "Delete forever" in the removed
 * section of the library — "Remove" only archives a lesson and never calls this.
 */
export async function deleteCloudVideo(userId: string, videoId: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('watch_items').delete().eq('user_id', userId).eq('video_id', videoId);
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
  if (!supabase || !path) return;
  const { error } = await supabase.storage.from('video-notes').remove([path]);
  if (error && !/not found|404|no such|invalid/i.test(error.message)) {
    console.warn('Could not remove cloud PDF object from storage:', error.message);
  }
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
  if (item.storagePath) {
    const { error: removeError } = await supabase.storage.from('video-notes').remove([item.storagePath]);
    // A missing file or storage policy hiccup should never block clearing the entry from the library.
    if (removeError && !/not found|404|no such|invalid/i.test(removeError.message)) {
      console.warn('Could not remove library PDF object from storage:', removeError.message);
    }
  }
  await Promise.allSettled([
    supabase.from('pdf_trash').delete().eq('pdf_id', item.id).eq('user_id', userId),
    supabase.from('pdf_activity').delete().eq('pdf_id', item.id).eq('user_id', userId),
    supabase.from('pdf_annotations').delete().eq('pdf_id', item.id).eq('user_id', userId),
  ]);
  const { error } = await supabase.from('pdf_library').delete().eq('id', item.id).eq('user_id', userId);
  if (error) throw error;
}

/* ---------------------------------------------------------------------------
 * PDF annotations — drawings, highlights and sticky notes on a library PDF.
 * One row per PDF (`pdf_annotations`), read and written next to the library
 * helpers above. Guests keep annotations in memory for the current tab only.
 * ------------------------------------------------------------------------- */

export interface PdfAnnotationRecord {
  annotations: unknown;
  updatedAt: number;
}

/**
 * Which kind of PDF an annotation document belongs to:
 * - `library` — a PDF on the personal shelf (`pdf_annotations`, keyed by the library row id).
 * - `lesson`  — the PDF attached to one lesson, uploaded beside the video
 *               (`lesson_annotations`, keyed by the YouTube video id).
 * Both are stored and synced the same way, so drawings made anywhere in the app
 * follow the account to every device.
 */
export type AnnotationScope =
  | { kind: 'library'; pdfId: string }
  | { kind: 'lesson'; videoId: string };

function annotationTable(scope: AnnotationScope): string {
  return scope.kind === 'library' ? 'pdf_annotations' : 'lesson_annotations';
}

function annotationFilter(scope: AnnotationScope): string {
  return scope.kind === 'library' ? `pdf_id=eq.${scope.pdfId}` : `video_id=eq.${scope.videoId}`;
}

function annotationRow(scope: AnnotationScope): Record<string, string> {
  return scope.kind === 'library' ? { pdf_id: scope.pdfId } : { video_id: scope.videoId };
}

/**
 * True when PostgREST reports a missing table (the owner has not run the newest
 * migration yet) or a missing column, so callers can fall back to browser storage
 * and explain what to run instead of silently pretending everything synced.
 */
export function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: string } | null | undefined)?.code ?? '';
  if (code === '42P01' || code === '42703' || code === 'PGRST205') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /does not exist|schema cache|could not find the table|relation .* does not exist/i.test(message);
}

/** Read the saved annotation document for one PDF, or null when there is none yet. */
export async function fetchCloudAnnotations(
  userId: string,
  scope: AnnotationScope,
): Promise<PdfAnnotationRecord | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from(annotationTable(scope))
    .select('data, updated_at')
    .eq(scope.kind === 'library' ? 'pdf_id' : 'video_id', scope.kind === 'library' ? scope.pdfId : scope.videoId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { data: unknown; updated_at: string | null };
  return {
    annotations: row.data,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  };
}

/** Upsert the annotation document for one PDF. Returns the account copy's timestamp. */
export async function saveCloudAnnotations(
  userId: string,
  scope: AnnotationScope,
  data: unknown,
): Promise<number> {
  if (!supabase) throw new Error('Cloud sync is not configured.');
  const updatedAt = new Date().toISOString();
  const { error } = await supabase
    .from(annotationTable(scope))
    .upsert(
      { ...annotationRow(scope), user_id: userId, data, updated_at: updatedAt },
      { onConflict: scope.kind === 'library' ? 'pdf_id' : 'user_id,video_id' },
    );
  if (error) throw error;
  return new Date(updatedAt).getTime();
}

/** Remove the account copy of one PDF's annotations (used when notes are taken off a lesson). */
export async function deleteCloudAnnotations(userId: string, scope: AnnotationScope): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase
    .from(annotationTable(scope))
    .delete()
    .eq(scope.kind === 'library' ? 'pdf_id' : 'video_id', scope.kind === 'library' ? scope.pdfId : scope.videoId)
    .eq('user_id', userId);
  if (error && !isMissingTableError(error)) throw error;
}

/** Drop every synced annotation document that belongs to one lesson. */
export async function deleteCloudLessonAnnotations(userId: string, videoId: string): Promise<void> {
  await deleteCloudAnnotations(userId, { kind: 'lesson', videoId });
}

export interface AnnotationChange {
  /** The saved document, or null when the row was deleted and the caller should re-read it. */
  annotations: unknown;
  updatedAt: number;
}

/**
 * Live updates for one PDF, so a drawing saved on another device appears here without a
 * reload. Returns an unsubscribe function. Projects without the realtime migration (or a
 * table that is not published) simply never receive an event — the reader still refetches
 * whenever the tab regains focus, so nothing depends on this working.
 */
export function subscribeCloudAnnotations(
  userId: string,
  scope: AnnotationScope,
  onChange: (change: AnnotationChange | null) => void,
  onUnavailable?: () => void,
): () => void {
  if (!supabase) return () => undefined;
  const table = annotationTable(scope);
  const topic = `annotations:${table}:${annotationFilter(scope)}:${userId}:${Math.random().toString(36).slice(2, 8)}`;
  const channel = supabase
    .channel(topic)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table, filter: annotationFilter(scope) },
      (payload: { eventType?: string; new?: Record<string, unknown> | null }) => {
        if (payload.eventType === 'DELETE') {
          onChange(null);
          return;
        }
        const row = payload.new ?? {};
        const updatedAt = typeof row.updated_at === 'string' ? new Date(row.updated_at).getTime() : Date.now();
        onChange({ annotations: row.data, updatedAt });
      },
    );
  channel.subscribe((status) => {
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      // Usually a table that is not published (or not migrated) yet. Give up quietly instead
      // of retrying forever: the reader also re-reads when the tab regains focus.
      onUnavailable?.();
      if (supabase) void supabase.removeChannel(channel);
    }
  });
  return () => {
    if (!supabase) return;
    void supabase.removeChannel(channel);
  };
}

/* ---------------------------------------------------------------------------
 * Recently deleted PDFs and per-PDF activity (last opened, page count).
 * Both tables are additive; the PDF files themselves never move.
 * ------------------------------------------------------------------------- */

export interface PdfTrashEntry {
  pdfId: string;
  deletedAt: number;
}

export interface PdfActivityEntry {
  pdfId: string;
  lastOpenedAt: number | null;
  pageCount: number | null;
}

export async function fetchPdfTrash(userId: string): Promise<PdfTrashEntry[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('pdf_trash')
    .select('pdf_id, deleted_at')
    .eq('user_id', userId);
  if (error) throw error;
  return (data as { pdf_id: string; deleted_at: string | null }[]).map((row) => ({
    pdfId: row.pdf_id,
    deletedAt: row.deleted_at ? new Date(row.deleted_at).getTime() : Date.now(),
  }));
}

/** Move a PDF to "Recently deleted". The library row and the file stay untouched. */
export async function trashLibraryPdf(userId: string, pdfId: string): Promise<number> {
  if (!supabase) throw new Error('Cloud sync is not configured.');
  const deletedAt = new Date().toISOString();
  const { error } = await supabase
    .from('pdf_trash')
    .upsert({ pdf_id: pdfId, user_id: userId, deleted_at: deletedAt }, { onConflict: 'pdf_id' });
  if (error) throw error;
  return new Date(deletedAt).getTime();
}

/** Take a PDF out of "Recently deleted". */
export async function restoreLibraryPdf(userId: string, pdfId: string): Promise<void> {
  if (!supabase) throw new Error('Cloud sync is not configured.');
  const { error } = await supabase.from('pdf_trash').delete().eq('pdf_id', pdfId).eq('user_id', userId);
  if (error) throw error;
}

export async function fetchPdfActivity(userId: string): Promise<PdfActivityEntry[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('pdf_activity')
    .select('pdf_id, last_opened_at, page_count')
    .eq('user_id', userId);
  if (error) throw error;
  return (data as { pdf_id: string; last_opened_at: string | null; page_count: number | null }[]).map((row) => ({
    pdfId: row.pdf_id,
    lastOpenedAt: row.last_opened_at ? new Date(row.last_opened_at).getTime() : null,
    pageCount: row.page_count === null ? null : Number(row.page_count),
  }));
}

/** Record that a PDF was opened, and how many pages it has. */
export async function savePdfActivity(
  userId: string,
  pdfId: string,
  patch: { lastOpenedAt?: number; pageCount?: number },
): Promise<void> {
  if (!supabase) throw new Error('Cloud sync is not configured.');
  const body: Record<string, unknown> = { pdf_id: pdfId, user_id: userId, updated_at: new Date().toISOString() };
  if (patch.lastOpenedAt) body.last_opened_at = new Date(patch.lastOpenedAt).toISOString();
  if (patch.pageCount) body.page_count = patch.pageCount;
  const { error } = await supabase.from('pdf_activity').upsert(body, { onConflict: 'pdf_id' });
  if (error) throw error;
}
