import type { VideoRecord } from '../types';

/**
 * Cross-device deletions.
 *
 * A deleted lesson used to simply vanish from this browser's copy — but every other device
 * still had its own cached copy, and the next merge happily sent that copy back to the
 * account. The lesson then "came back" on every device: the exact symptom of content that
 * would not stay deleted.
 *
 * A deletion is therefore recorded as a *tombstone*: a timestamp that says "this lesson was
 * deleted at this moment". Tombstones are kept in two places:
 *
 *   • in the account (the `watch_items` row keeps `deleted_at`), so every device sees it,
 *   • in this browser (`focusframe.deleted.v1`), so a delete made offline — or a delete the
 *     account rejected — still hides the lesson here instead of being re-uploaded.
 *
 * A tombstone is only lifted when the user explicitly opens that lesson again, which is what
 * `clearDeletion` is for. Cached copies never lift one.
 */

export type DeletedKind = 'lesson' | 'pdf';

/** `lesson:<video id>` / `pdf:<library id>` → when it was deleted (ms since epoch). */
export type DeletedMap = Record<string, number>;

export function deletionKey(kind: DeletedKind, id: string): string {
  return `${kind}:${id}`;
}

export function parseDeletionKey(key: string): { kind: DeletedKind; id: string } | null {
  const separator = key.indexOf(':');
  if (separator <= 0) return null;
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if ((kind !== 'lesson' && kind !== 'pdf') || !id) return null;
  return { kind, id };
}

/** Keep only the well-formed, positive entries of a stored tombstone map. */
export function normalizeDeletions(value: unknown): DeletedMap {
  if (!value || typeof value !== 'object') return {};
  const out: DeletedMap = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const parsed = parseDeletionKey(key);
    const stamp = Number(raw);
    if (!parsed || !Number.isFinite(stamp) || stamp <= 0) continue;
    out[key] = stamp;
  }
  return out;
}

export function isDeleted(deletions: DeletedMap, kind: DeletedKind, id: string): boolean {
  return Boolean(deletions[deletionKey(kind, id)]);
}

/** Add (or refresh) one tombstone without mutating the caller's map. */
export function withDeletion(deletions: DeletedMap, kind: DeletedKind, id: string, deletedAt: number): DeletedMap {
  if (!id) return deletions;
  return { ...deletions, [deletionKey(kind, id)]: Math.max(Math.round(deletedAt) || Date.now(), 0) };
}

/** Remove a tombstone: the user deliberately opened that lesson (or restored that PDF) again. */
export function withoutDeletion(deletions: DeletedMap, kind: DeletedKind, id: string): DeletedMap {
  const key = deletionKey(kind, id);
  if (!(key in deletions)) return deletions;
  const next = { ...deletions };
  delete next[key];
  return next;
}

export interface LessonMergeResult {
  /** The lessons this device should show: union of both copies, minus everything deleted. */
  videos: VideoRecord[];
  /** Tombstones still in force here, including the account's. */
  deletions: DeletedMap;
  /**
   * lesson id → `updatedAt` the account already holds. Those copies must not be pushed back,
   * otherwise a merge would re-upload every lesson on every refresh.
   */
  confirmed: Record<string, number>;
  /** Deletions this browser knows about that the account does not have yet. */
  pendingDeletes: { videoId: string; deletedAt: number }[];
  /** Lessons that disappeared because someone deleted them (used to close the open player). */
  removedIds: string[];
}

/**
 * Reconcile this browser's lessons with the account's.
 *
 * `remoteVideos` may contain tombstone rows (`deletedAt` set): they always win over a cached
 * copy, whatever the two clocks say. A lesson the account holds *again* (its `updated_at` is
 * newer than a local tombstone) means it was deliberately re-opened after being deleted, so
 * the stale local tombstone is dropped instead of hiding it forever.
 */
export function mergeLessonCopies(
  localVideos: VideoRecord[],
  remoteVideos: VideoRecord[],
  localDeletions: DeletedMap = {},
): LessonMergeResult {
  const deletions: DeletedMap = {};
  for (const [key, stamp] of Object.entries(normalizeDeletions(localDeletions))) {
    if (parseDeletionKey(key)?.kind === 'lesson') deletions[key] = stamp;
  }

  const merged = new Map<string, VideoRecord>();
  const confirmed: Record<string, number> = {};
  const remoteDeletions = new Set<string>();

  // 1. The account's tombstones.
  for (const record of remoteVideos) {
    if (!record.deletedAt) continue;
    const key = deletionKey('lesson', record.videoId);
    remoteDeletions.add(record.videoId);
    deletions[key] = Math.max(deletions[key] ?? 0, record.deletedAt);
  }

  // 2. The account's live lessons.
  for (const record of remoteVideos) {
    if (record.deletedAt) continue;
    const key = deletionKey('lesson', record.videoId);
    const tombstone = deletions[key];
    if (tombstone && record.updatedAt > tombstone) delete deletions[key];
    merged.set(record.videoId, record);
    confirmed[record.videoId] = record.updatedAt;
  }

  // 3. This browser's copy, kept only when it is at least as new as the account's.
  for (const record of localVideos) {
    if (record.deletedAt) continue;
    // A lesson the account has tombstoned is gone, whatever this browser cached — including a
    // progress tick or a re-upload that raced the delete. Only opening the lesson again
    // (clearCloudVideoDeletion) can lift that, and that is a deliberate user action.
    if (remoteDeletions.has(record.videoId)) continue;
    const tombstone = deletions[deletionKey('lesson', record.videoId)];
    if (tombstone && record.updatedAt <= tombstone) continue;
    const remoteRecord = merged.get(record.videoId);
    if (!remoteRecord || record.updatedAt >= remoteRecord.updatedAt) {
      merged.set(record.videoId, record);
      delete confirmed[record.videoId];
    } else {
      confirmed[record.videoId] = remoteRecord.updatedAt;
    }
  }

  const videos: VideoRecord[] = [];
  for (const [videoId, record] of merged) {
    if (remoteDeletions.has(videoId)) continue;
    const tombstone = deletions[deletionKey('lesson', videoId)];
    if (tombstone && record.updatedAt <= tombstone) continue;
    videos.push(record);
  }
  videos.sort((a, b) => b.updatedAt - a.updatedAt);

  // Every lesson with a tombstone is gone here — including one whose cached copy was already
  // skipped above, which is the case the open player has to react to.
  const removedIds = Object.keys(deletions)
    .map((key) => parseDeletionKey(key))
    .filter((entry): entry is { kind: 'lesson'; id: string } => entry?.kind === 'lesson')
    .map((entry) => entry.id);

  const pendingDeletes: { videoId: string; deletedAt: number }[] = [];
  for (const [key, deletedAt] of Object.entries(deletions)) {
    const parsed = parseDeletionKey(key);
    if (!parsed || parsed.kind !== 'lesson') continue;
    if (!remoteDeletions.has(parsed.id)) pendingDeletes.push({ videoId: parsed.id, deletedAt });
  }

  return { videos, deletions, confirmed, pendingDeletes, removedIds };
}

/** Drop library PDFs this browser has already deleted for good. */
export function withoutDeletedPdfs<T extends { id: string }>(items: T[], deletions: DeletedMap): T[] {
  return items.filter((item) => !isDeleted(deletions, 'pdf', item.id));
}
