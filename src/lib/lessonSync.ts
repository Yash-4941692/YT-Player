import type { LibraryPdf, VideoRecord } from '../types';
import { sortLibrary } from './pdfLibrary';

/**
 * Cross-device deletions and soft-delete ("Recently deleted" / "Removed") sync.
 *
 * Deletions fail across devices for three classic reasons:
 *   1. A missing row cannot tell another device's cached copy that something was deleted — so
 *      the other device merges its stale cache back into the account.
 *   2. Device clocks disagree: if Device B's clock sits ahead of Device A's, an archive, PDF
 *      detachment, soft-delete, restore, or reopen written with `Date.now()` on Device A looks
 *      *older* than Device B's cached copy and gets ignored or reverted.
 *   3. Optional auxiliary tables (`pdf_trash`, or `watch_items.deleted_at` before migration
 *      008) may be absent, stranding deletions in one browser's `localStorage`.
 *
 * This module solves all three:
 *   • Every state change uses `nextLessonStamp`, producing a strictly monotonic revision stamp
 *     above anything the device has seen for that item regardless of clock skew.
 *   • Permanent deletions write tombstones (`watch_items.deleted_at` + local tombstones + the
 *     account sync ledger).
 *   • PDF soft-deletes ("Recently deleted"), restores, and permanent deletes — plus fallback
 *     lesson tombstones and live cross-device wakeups — reconcile through a conflict-free
 *     per-item ledger (`SyncLedger`) alongside `pdf_trash` and `watch_items`.
 */

export type DeletedKind = 'lesson' | 'pdf';

/** `lesson:<video id>` / `pdf:<library id>` → when it was deleted (ms since epoch). */
export type DeletedMap = Record<string, number>;

export type PdfSyncStatus = 'active' | 'trashed' | 'deleted';

export interface PdfSyncEntry {
  status: PdfSyncStatus;
  /** Monotonic revision stamp used to order transitions across devices. */
  at: number;
  /** Timestamp displayed in "Recently deleted" (when moved to trash). */
  deletedAt?: number;
}

export interface LocalPdfSyncEntry extends PdfSyncEntry {
  /** True while this browser holds a transition the account has not confirmed yet. */
  pending?: boolean;
}

export type PdfSyncMap = Record<string, LocalPdfSyncEntry>;

export interface LessonTombstoneEntry {
  status: 'active' | 'deleted';
  at: number;
}

export interface SyncLedger {
  version: 1;
  pdfs: Record<string, PdfSyncEntry>;
  lessons: Record<string, LessonTombstoneEntry>;
  /** Monotonic ping stamp so open tabs on other devices refresh immediately via Realtime. */
  signalAt?: number;
}

const MAX_LEDGER_ENTRIES = 500;
const LEDGER_PRUNE_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Build a revision timestamp strictly newer than any revision already known for an item, so a
 * device whose clock sits behind another device still publishes a winning update/delete.
 */
export function nextLessonStamp(
  previousUpdatedAt = 0,
  previousDeletedAt = 0,
  now: number = Date.now(),
): number {
  const seen = Math.max(Math.round(previousUpdatedAt) || 0, Math.round(previousDeletedAt) || 0, 0);
  return Math.max(Math.round(now) || 1, seen + 1);
}

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
  const prev = deletions[deletionKey(kind, id)] ?? 0;
  return { ...deletions, [deletionKey(kind, id)]: Math.max(Math.round(deletedAt) || Date.now(), prev, 1) };
}

/** Remove a tombstone: the user deliberately opened that lesson (or restored that PDF) again. */
export function withoutDeletion(deletions: DeletedMap, kind: DeletedKind, id: string): DeletedMap {
  const key = deletionKey(kind, id);
  if (!(key in deletions)) return deletions;
  const next = { ...deletions };
  delete next[key];
  return next;
}

/* ---------------------------------------------------------------------------
 * Conflict-free Sync Ledger (CRDT merge for PDF trash/delete + lesson deletes)
 * ------------------------------------------------------------------------- */

function isPdfSyncStatus(value: unknown): value is PdfSyncStatus {
  return value === 'active' || value === 'trashed' || value === 'deleted';
}

export function normalizePdfSyncMap(value: unknown): PdfSyncMap {
  if (!value || typeof value !== 'object') return {};
  const out: PdfSyncMap = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!id || !raw || typeof raw !== 'object') continue;
    const entry = raw as Partial<LocalPdfSyncEntry>;
    const at = Number(entry.at);
    if (!isPdfSyncStatus(entry.status) || !Number.isFinite(at) || at <= 0) continue;
    const deletedAt = Number(entry.deletedAt);
    out[id] = {
      status: entry.status,
      at: Math.round(at),
      ...(Number.isFinite(deletedAt) && deletedAt > 0 ? { deletedAt: Math.round(deletedAt) } : {}),
      ...(entry.pending ? { pending: true } : {}),
    };
  }
  return out;
}

export function emptySyncLedger(): SyncLedger {
  return { version: 1, pdfs: {}, lessons: {} };
}

export function normalizeSyncLedger(value: unknown): SyncLedger {
  if (!value || typeof value !== 'object') return emptySyncLedger();
  const raw = value as Partial<SyncLedger>;
  const pdfs: Record<string, PdfSyncEntry> = {};
  if (raw.pdfs && typeof raw.pdfs === 'object') {
    for (const [id, item] of Object.entries(raw.pdfs as Record<string, unknown>)) {
      if (!id || !item || typeof item !== 'object') continue;
      const candidate = item as Partial<PdfSyncEntry>;
      const at = Number(candidate.at);
      if (!isPdfSyncStatus(candidate.status) || !Number.isFinite(at) || at <= 0) continue;
      const deletedAt = Number(candidate.deletedAt);
      pdfs[id] = {
        status: candidate.status,
        at: Math.round(at),
        ...(Number.isFinite(deletedAt) && deletedAt > 0 ? { deletedAt: Math.round(deletedAt) } : {}),
      };
    }
  }
  const lessons: Record<string, LessonTombstoneEntry> = {};
  if (raw.lessons && typeof raw.lessons === 'object') {
    for (const [id, item] of Object.entries(raw.lessons as Record<string, unknown>)) {
      if (!id || !item || typeof item !== 'object') continue;
      const candidate = item as Partial<LessonTombstoneEntry>;
      const at = Number(candidate.at);
      if ((candidate.status !== 'active' && candidate.status !== 'deleted') || !Number.isFinite(at) || at <= 0) continue;
      lessons[id] = { status: candidate.status, at: Math.round(at) };
    }
  }
  const signalAt = Number(raw.signalAt);
  return {
    version: 1,
    pdfs,
    lessons,
    ...(Number.isFinite(signalAt) && signalAt > 0 ? { signalAt: Math.round(signalAt) } : {}),
  };
}

export function mergePdfSyncEntry(left: PdfSyncEntry | undefined, right: PdfSyncEntry | undefined): PdfSyncEntry | undefined {
  if (!left) return right ? { ...right } : undefined;
  if (!right) return { ...left };
  // Permanent deletion of a library PDF UUID is terminal and always wins.
  if (left.status === 'deleted' || right.status === 'deleted') {
    return { status: 'deleted', at: Math.max(left.at, right.at) };
  }
  if (right.at > left.at) return { ...right };
  if (left.at > right.at) return { ...left };
  // Exact timestamp tie: prefer 'trashed' so a delete is never silently dropped.
  if (right.status === 'trashed' && left.status !== 'trashed') return { ...right };
  return { ...left };
}

export function mergeLessonTombstoneEntry(
  left: LessonTombstoneEntry | undefined,
  right: LessonTombstoneEntry | undefined,
): LessonTombstoneEntry | undefined {
  if (!left) return right ? { ...right } : undefined;
  if (!right) return { ...left };
  if (right.at > left.at) return { ...right };
  if (left.at > right.at) return { ...left };
  if (right.status === 'deleted' && left.status !== 'deleted') return { ...right };
  return { ...left };
}

function pruneMapByAge<T extends { at: number }>(map: Record<string, T>, now: number): Record<string, T> {
  const entries = Object.entries(map);
  if (entries.length <= MAX_LEDGER_ENTRIES) return map;
  const cutoff = now - LEDGER_PRUNE_AGE_MS;
  const sorted = entries.sort((a, b) => b[1].at - a[1].at);
  const kept = sorted.filter(([, entry], idx) => idx < MAX_LEDGER_ENTRIES || entry.at >= cutoff).slice(0, MAX_LEDGER_ENTRIES);
  return Object.fromEntries(kept);
}

export function mergeSyncLedgers(
  left: Partial<SyncLedger> | null | undefined,
  right: Partial<SyncLedger> | null | undefined,
  now: number = Date.now(),
): SyncLedger {
  const a = normalizeSyncLedger(left);
  const b = normalizeSyncLedger(right);

  const pdfs: Record<string, PdfSyncEntry> = { ...a.pdfs };
  for (const [id, entry] of Object.entries(b.pdfs)) {
    const merged = mergePdfSyncEntry(pdfs[id], entry);
    if (merged) pdfs[id] = merged;
  }

  const lessons: Record<string, LessonTombstoneEntry> = { ...a.lessons };
  for (const [id, entry] of Object.entries(b.lessons)) {
    const merged = mergeLessonTombstoneEntry(lessons[id], entry);
    if (merged) lessons[id] = merged;
  }

  const signalAt = Math.max(a.signalAt ?? 0, b.signalAt ?? 0);
  return {
    version: 1,
    pdfs: pruneMapByAge(pdfs, now),
    lessons: pruneMapByAge(lessons, now),
    ...(signalAt > 0 ? { signalAt } : {}),
  };
}

/* ---------------------------------------------------------------------------
 * Lesson reconciliation
 * ------------------------------------------------------------------------- */

export interface LessonMergeResult {
  /** The lessons this device should show: union of both copies, minus everything deleted. */
  videos: VideoRecord[];
  /** Tombstones still in force here, including the account's (lesson + preserved PDF ones). */
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
  /** Lessons that were unarchived here and became archived ("Removed") on another device. */
  newlyArchivedIds: string[];
  /** Lessons whose cloud PDF attachment was removed on another device. */
  clearedPdfIds: string[];
}

/**
 * Reconcile this browser's lessons with the account's.
 *
 * `remoteVideos` may contain tombstone rows (`deletedAt` set), and `remoteLedgerLessons` may
 * carry tombstones written through the sync ledger (which works even when `watch_items` lacks
 * `deleted_at`). Account tombstones always win over a cached copy unless a live account row
 * has an `updatedAt` strictly newer than a ledger-only tombstone (meaning the lesson was
 * deliberately reopened).
 */
export function mergeLessonCopies(
  localVideos: VideoRecord[],
  remoteVideos: VideoRecord[],
  localDeletions: DeletedMap = {},
  remoteLedgerLessons: Record<string, LessonTombstoneEntry> = {},
): LessonMergeResult {
  const deletions: DeletedMap = {};
  const preservedPdfDeletions: DeletedMap = {};
  for (const [key, stamp] of Object.entries(normalizeDeletions(localDeletions))) {
    const parsed = parseDeletionKey(key);
    if (parsed?.kind === 'lesson') deletions[key] = stamp;
    else if (parsed?.kind === 'pdf') preservedPdfDeletions[key] = stamp;
  }

  const localById = new Map<string, VideoRecord>();
  for (const record of localVideos) {
    if (!record.deletedAt) localById.set(record.videoId, record);
  }

  const merged = new Map<string, VideoRecord>();
  const confirmed: Record<string, number> = {};
  const remoteRowDeletions = new Set<string>();
  const remoteEffectiveDeletions = new Set<string>();

  // 1a. Tombstones stored directly on `watch_items` rows.
  for (const record of remoteVideos) {
    if (!record.deletedAt) continue;
    const key = deletionKey('lesson', record.videoId);
    const ledger = remoteLedgerLessons[record.videoId];
    // If the ledger explicitly says this lesson was reopened AFTER `record.deletedAt`, let a
    // newer live state win; otherwise the tombstone row rules.
    if (ledger?.status === 'active' && ledger.at > record.deletedAt) continue;
    remoteRowDeletions.add(record.videoId);
    remoteEffectiveDeletions.add(record.videoId);
    deletions[key] = Math.max(deletions[key] ?? 0, record.deletedAt);
  }

  // 1b. Tombstones stored in the account sync ledger (covers pre-008 databases and races).
  for (const [videoId, entry] of Object.entries(remoteLedgerLessons)) {
    const key = deletionKey('lesson', videoId);
    if (entry.status === 'deleted') {
      const liveRemote = remoteVideos.find((v) => v.videoId === videoId && !v.deletedAt);
      if (liveRemote && liveRemote.updatedAt > entry.at) {
        // Deliberately reopened after the ledger tombstone.
        if (deletions[key] && deletions[key] <= liveRemote.updatedAt) delete deletions[key];
        continue;
      }
      remoteEffectiveDeletions.add(videoId);
      deletions[key] = Math.max(deletions[key] ?? 0, entry.at);
    } else if (entry.status === 'active' && !remoteRowDeletions.has(videoId)) {
      if (deletions[key] && entry.at > deletions[key]) {
        delete deletions[key];
      }
    }
  }

  // 2. The account's live lessons.
  for (const record of remoteVideos) {
    if (record.deletedAt) continue;
    if (remoteEffectiveDeletions.has(record.videoId)) continue;
    const key = deletionKey('lesson', record.videoId);
    const tombstone = deletions[key];
    if (tombstone && record.updatedAt > tombstone) delete deletions[key];
    merged.set(record.videoId, record);
    confirmed[record.videoId] = record.updatedAt;
  }

  // 3. This browser's copy, kept only when it is at least as new as the account's.
  for (const record of localVideos) {
    if (record.deletedAt) continue;
    if (remoteEffectiveDeletions.has(record.videoId)) continue;
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
  const newlyArchivedIds: string[] = [];
  const clearedPdfIds: string[] = [];

  for (const [videoId, record] of merged) {
    if (remoteEffectiveDeletions.has(videoId)) continue;
    const tombstone = deletions[deletionKey('lesson', videoId)];
    if (tombstone && record.updatedAt <= tombstone) continue;
    videos.push(record);

    const prevLocal = localById.get(videoId);
    if (prevLocal && !prevLocal.archived && record.archived) {
      newlyArchivedIds.push(videoId);
    }
    if (prevLocal?.pdfPath && !record.pdfPath) {
      clearedPdfIds.push(videoId);
    }
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
    const ledgerConfirmed = remoteLedgerLessons[parsed.id]?.status === 'deleted'
      && remoteLedgerLessons[parsed.id].at >= deletedAt;
    if (!remoteRowDeletions.has(parsed.id) && !ledgerConfirmed) {
      pendingDeletes.push({ videoId: parsed.id, deletedAt });
    } else if (!remoteRowDeletions.has(parsed.id) && remoteVideos.some((v) => v.videoId === parsed.id && !v.deletedAt)) {
      // Ledger knows it's deleted, but `watch_items` still has a live row: clean it up too.
      pendingDeletes.push({ videoId: parsed.id, deletedAt });
    }
  }

  return {
    videos,
    deletions: { ...preservedPdfDeletions, ...deletions },
    confirmed,
    pendingDeletes,
    removedIds,
    newlyArchivedIds,
    clearedPdfIds,
  };
}

/** Drop library PDFs this browser has already deleted for good. */
export function withoutDeletedPdfs<T extends { id: string }>(items: T[], deletions: DeletedMap): T[] {
  return items.filter((item) => !isDeleted(deletions, 'pdf', item.id));
}

/* ---------------------------------------------------------------------------
 * PDF Library & "Recently deleted" cross-device reconciliation
 * ------------------------------------------------------------------------- */

export interface PdfReconcileResult {
  /** Library PDFs to hold in state (active + trashed, excluding permanently deleted). */
  items: LibraryPdf[];
  /** `pdfId` -> `deletedAt` map for PDFs currently in "Recently deleted". */
  trash: Record<string, number>;
  /** Updated local sync bookkeeping to persist in `focusframe.pdfSync.v1`. */
  syncMap: PdfSyncMap;
  /** All permanently deleted PDF IDs known after merging. */
  deletedIds: string[];
  /** PDFs that newly moved into "Recently deleted" from another device. */
  newlyTrashedIds: string[];
  /** Pending soft-deletes to write to `pdf_trash` (when that table exists). */
  pendingTrashWrites: { pdfId: string; deletedAt: number }[];
  /** Pending restores to delete from `pdf_trash` (when that table exists). */
  pendingRestores: string[];
  /** Remote `pdf_library` rows that match a permanent-delete tombstone and must be erased. */
  pendingHardDeletes: LibraryPdf[];
  /** Entries that the account sync ledger does not have (or has an older revision of) yet. */
  ledgerPatch: Record<string, PdfSyncEntry>;
}

export function reconcilePdfState({
  remotePdfs,
  localSessionPdfs = [],
  localSync = {},
  localTrashFallback = {},
  localDeletionsFallback = {},
  remoteTrash = null,
  remoteLedgerPdfs = {},
}: {
  remotePdfs: LibraryPdf[];
  localSessionPdfs?: LibraryPdf[];
  localSync?: PdfSyncMap;
  localTrashFallback?: Record<string, number>;
  localDeletionsFallback?: DeletedMap;
  /** `null` when the optional `pdf_trash` table is missing or unreachable; map otherwise. */
  remoteTrash?: Record<string, number> | null;
  remoteLedgerPdfs?: Record<string, PdfSyncEntry>;
}): PdfReconcileResult {
  const workingLocal: PdfSyncMap = { ...normalizePdfSyncMap(localSync) };
  const remoteById = new Map<string, LibraryPdf>();
  for (const item of remotePdfs) {
    if (!item.sessionOnly) remoteById.set(item.id, item);
  }
  const sessionIds = new Set(localSessionPdfs.filter((item) => item.sessionOnly).map((item) => item.id));

  // Fold any legacy `pdf:<id>` permanent deletions into `workingLocal`.
  for (const [key, stamp] of Object.entries(normalizeDeletions(localDeletionsFallback))) {
    const parsed = parseDeletionKey(key);
    if (parsed?.kind !== 'pdf') continue;
    const prev = workingLocal[parsed.id];
    if (!prev || prev.status !== 'deleted') {
      const confirmedRemotely = !remoteById.has(parsed.id) && remoteLedgerPdfs[parsed.id]?.status === 'deleted';
      workingLocal[parsed.id] = {
        status: 'deleted',
        at: Math.max(stamp, prev?.at ?? 0),
        ...(confirmedRemotely ? {} : { pending: true }),
      };
    }
  }

  // Upgrade path: if `pdf_trash` was missing (`remoteTrash === null`), any soft-deletes made
  // before this version lived ONLY in `focusframe.pdfTrash.v1`. Promote them to pending so
  // they immediately sync to every other device via the account ledger.
  if (remoteTrash === null) {
    for (const [id, deletedAt] of Object.entries(localTrashFallback)) {
      if (sessionIds.has(id) || workingLocal[id] || remoteLedgerPdfs[id]) continue;
      if (remoteById.has(id) && Number.isFinite(deletedAt) && deletedAt > 0) {
        workingLocal[id] = {
          status: 'trashed',
          at: Math.round(deletedAt),
          deletedAt: Math.round(deletedAt),
          pending: true,
        };
      }
    }
  }

  const allIds = new Set<string>([
    ...remoteById.keys(),
    ...Object.keys(workingLocal),
    ...Object.keys(remoteLedgerPdfs),
    ...(remoteTrash ? Object.keys(remoteTrash) : []),
  ]);

  const nextSyncMap: PdfSyncMap = {};
  const nextTrash: Record<string, number> = {};
  const deletedSet = new Set<string>();
  const newlyTrashedIds: string[] = [];
  const pendingTrashWrites: { pdfId: string; deletedAt: number }[] = [];
  const pendingRestores: string[] = [];
  const pendingHardDeletes: LibraryPdf[] = [];
  const ledgerPatch: Record<string, PdfSyncEntry> = {};

  for (const id of allIds) {
    if (sessionIds.has(id)) continue;

    const ledgerEntry = remoteLedgerPdfs[id];
    const trashTs = remoteTrash && Number.isFinite(remoteTrash[id]) && remoteTrash[id] > 0
      ? Math.round(remoteTrash[id])
      : undefined;

    // 1. Determine the unified remote state for this PDF.
    let remoteEntry: PdfSyncEntry | null = null;
    if (ledgerEntry?.status === 'deleted') {
      remoteEntry = ledgerEntry;
    } else if (ledgerEntry && trashTs !== undefined) {
      if (ledgerEntry.status === 'active' && ledgerEntry.at > trashTs) {
        remoteEntry = ledgerEntry;
      } else {
        remoteEntry = {
          status: 'trashed',
          at: Math.max(ledgerEntry.at, trashTs),
          deletedAt: ledgerEntry.deletedAt ?? trashTs,
        };
      }
    } else if (ledgerEntry) {
      remoteEntry = ledgerEntry;
    } else if (trashTs !== undefined) {
      remoteEntry = { status: 'trashed', at: trashTs, deletedAt: trashTs };
    } else if (remoteById.has(id) && remoteTrash !== null) {
      remoteEntry = { status: 'active', at: 0 };
    }

    const localEntry = workingLocal[id];

    // 2. Permanent deletion always wins.
    if (localEntry?.status === 'deleted' || remoteEntry?.status === 'deleted') {
      const at = Math.max(localEntry?.at ?? 0, remoteEntry?.at ?? 0, 1);
      deletedSet.add(id);
      const needsLedger = remoteLedgerPdfs[id]?.status !== 'deleted';
      const remoteItem = remoteById.get(id);
      if (remoteItem) pendingHardDeletes.push(remoteItem);
      if (needsLedger) ledgerPatch[id] = { status: 'deleted', at };
      nextSyncMap[id] = {
        status: 'deleted',
        at,
        ...((needsLedger || Boolean(remoteItem)) ? { pending: true } : {}),
      };
      continue;
    }

    // 3. Active vs Trashed reconciliation.
    let resolved: PdfSyncEntry | null = null;
    let keepPending = false;

    if (localEntry?.pending) {
      if (!remoteEntry || localEntry.at >= remoteEntry.at) {
        resolved = {
          status: localEntry.status,
          at: localEntry.at,
          ...(localEntry.deletedAt ? { deletedAt: localEntry.deletedAt } : {}),
        };
        const ledgerMatches = ledgerEntry
          && ledgerEntry.status === resolved.status
          && ledgerEntry.at >= resolved.at;
        const trashMatches = remoteTrash === null
          || (resolved.status === 'trashed' ? trashTs !== undefined : trashTs === undefined);
        keepPending = !(ledgerMatches && trashMatches);
      } else {
        resolved = remoteEntry;
        keepPending = false;
      }
    } else if (remoteEntry) {
      resolved = remoteEntry;
    } else if (localEntry) {
      resolved = {
        status: localEntry.status,
        at: localEntry.at,
        ...(localEntry.deletedAt ? { deletedAt: localEntry.deletedAt } : {}),
      };
    }

    if (!resolved) continue;

    // Only keep non-deleted sync entries for PDFs that still exist in `pdf_library` (or are pending).
    if (!remoteById.has(id) && !keepPending) {
      continue;
    }

    if (resolved.status === 'trashed') {
      const deletedAt = resolved.deletedAt ?? resolved.at;
      if (remoteById.has(id)) {
        nextTrash[id] = deletedAt;
        if (!localTrashFallback[id] && localEntry?.status !== 'trashed') {
          newlyTrashedIds.push(id);
        }
      }
      nextSyncMap[id] = { status: 'trashed', at: resolved.at, deletedAt, ...(keepPending ? { pending: true } : {}) };
      if (keepPending) {
        if (remoteTrash !== null && trashTs === undefined) {
          pendingTrashWrites.push({ pdfId: id, deletedAt });
        }
        if (!ledgerEntry || ledgerEntry.status !== 'trashed' || ledgerEntry.at < resolved.at) {
          ledgerPatch[id] = { status: 'trashed', at: resolved.at, deletedAt };
        }
      } else if (trashTs !== undefined && !ledgerEntry) {
        // Mirror `pdf_trash` into the ledger so devices/tabs listening via Realtime also see it.
        ledgerPatch[id] = { status: 'trashed', at: resolved.at, deletedAt };
      }
    } else {
      // status === 'active'
      if (resolved.at > 0 || keepPending) {
        nextSyncMap[id] = { status: 'active', at: resolved.at, ...(keepPending ? { pending: true } : {}) };
      }
      if (keepPending) {
        if (remoteTrash !== null && trashTs !== undefined) {
          pendingRestores.push(id);
        }
        if (!ledgerEntry || ledgerEntry.status !== 'active' || ledgerEntry.at < resolved.at) {
          ledgerPatch[id] = { status: 'active', at: resolved.at };
        }
      } else if (remoteTrash !== null && trashTs !== undefined && ledgerEntry?.status === 'active' && ledgerEntry.at > trashTs) {
        // Ledger recorded a newer restore than a leftover `pdf_trash` row: clean `pdf_trash` up.
        pendingRestores.push(id);
      }
    }
  }

  // Keep guest session-only trash entries untouched.
  for (const id of sessionIds) {
    if (localTrashFallback[id]) nextTrash[id] = localTrashFallback[id];
    if (workingLocal[id]) nextSyncMap[id] = workingLocal[id];
  }

  const items = sortLibrary([
    ...remotePdfs.filter((item) => !deletedSet.has(item.id)),
    ...localSessionPdfs.filter((item) => item.sessionOnly && !deletedSet.has(item.id)),
  ]);

  return {
    items,
    trash: nextTrash,
    syncMap: nextSyncMap,
    deletedIds: [...deletedSet],
    newlyTrashedIds,
    pendingTrashWrites,
    pendingRestores,
    pendingHardDeletes,
    ledgerPatch,
  };
}
