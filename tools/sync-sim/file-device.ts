/**
 * Simulated browser process for cross-device file & lesson deletion checks
 * (`tools/sync-sim/file-delete.mjs`).
 *
 * Each invocation runs in its own OS process with its own `localStorage` file and optional
 * `SIM_CLOCK_OFFSET_MS`, calling the exact same `supabase.ts`, `lessonSync.ts`, and
 * `storage.ts` functions `src/App.tsx` runs.
 */
// eslint-disable-next-line import/order -- must install the WebSocket fallback first
import './websocket-shim';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const step = process.env.SIM_STEP || 'check';
const user = process.env.SIM_USER || '11111111-1111-4111-8111-111111111111';
const api = process.env.SIM_API || 'http://127.0.0.1:8792';
const lessonId = process.env.SIM_LESSON || 'dQw4w9WgXcQ';
const lessonKind = (process.env.SIM_LESSON_KIND || 'file') as 'file' | 'youtube';
const lessonUrl = process.env.SIM_LESSON_URL || 'https://filesto.o2zone.space/d/TnYng8W';
const profileFile = process.env.SIM_PROFILE || '';
const clockOffset = Number(process.env.SIM_CLOCK_OFFSET_MS || 0);

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://focusframe.test/',
  pretendToBeVisual: true,
});
const { window } = dom;
window.scrollTo = () => {};
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}
(globalThis as unknown as Record<string, unknown>).ResizeObserver = NoopObserver;
(window as unknown as Record<string, unknown>).ResizeObserver = NoopObserver;
(globalThis as unknown as Record<string, unknown>).IntersectionObserver = NoopObserver;
(window as unknown as Record<string, unknown>).IntersectionObserver = NoopObserver;
for (const key of [
  'window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Element', 'Node',
  'SVGElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'DOMParser',
  'Event', 'MouseEvent', 'KeyboardEvent',
]) {
  const value = key === 'window' ? window : (window as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  const bound = typeof value === 'function' && key.startsWith('request')
    ? (value as (...args: unknown[]) => unknown).bind(window)
    : value;
  try {
    Object.defineProperty(globalThis, key, { value: bound, writable: true, configurable: true });
  } catch {
    // read-only in this Node version
  }
}

if (profileFile && existsSync(profileFile)) {
  const saved = JSON.parse(readFileSync(profileFile, 'utf8')) as Record<string, string>;
  for (const [key, value] of Object.entries(saved)) window.localStorage.setItem(key, String(value));
}

if (clockOffset) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      // @ts-expect-error -- mirroring Date constructor overloads
      if (args.length === 0) super(realNow() + clockOffset);
      // @ts-expect-error -- mirroring Date constructor overloads
      else super(...args);
    }
    static now() { return realNow() + clockOffset; }
  }
  globalThis.Date = ShiftedDate as unknown as DateConstructor;
  dom.window.Date = ShiftedDate as unknown as DateConstructor;
}

const realLog = console.log.bind(console);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const supabaseModule = await import('../../src/lib/supabase');
  const {
    supabase,
    createLibraryPdf,
    deleteLibraryPdf,
    fetchLibraryPdfs,
    fetchPdfTrashMap,
    trashLibraryPdf,
    restoreLibraryPdf,
    uploadCloudPdf,
    deleteCloudPdf,
    fetchCloudVideos,
    saveCloudVideo,
    deleteCloudVideo,
    clearCloudVideoDeletion,
    fetchCloudSyncLedger,
    pushCloudSyncLedger,
    isLibraryPath,
  } = supabaseModule;
  const {
    deletionKey,
    isDeleted,
    mergeLessonCopies,
    nextLessonStamp,
    reconcilePdfState,
    withDeletion,
    withoutDeletion,
  } = await import('../../src/lib/lessonSync');
  const {
    loadLocalState,
    saveLocalState,
    loadLocalDeletions,
    saveLocalDeletions,
    loadLocalPdfTrash,
    saveLocalPdfTrash,
    loadLocalPdfSync,
    saveLocalPdfSync,
  } = await import('../../src/lib/storage');
  const { sortLibrary } = await import('../../src/lib/pdfLibrary');

  if (!supabase) throw new Error('the simulated client was built without Supabase credentials');
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user, role: 'authenticated', aud: 'authenticated', exp: nowSec + 7200 })}.${encode('sim-signature')}`;
  const session = await supabase.auth.setSession({ access_token: token, refresh_token: 'sim-refresh-token' });
  if (session.error) throw new Error(`could not seed simulated session: ${JSON.stringify(session.error)}`);

  if (step.startsWith('ui-')) {
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { default: App } = await import('../../src/App');
    const rootEl = document.getElementById('root') as HTMLElement;
    const root = createRoot(rootEl);
    root.render(React.createElement(App));
    await sleep(600);

    if (step === 'ui-focus-check') {
      window.dispatchEvent(new window.Event('focus'));
      await sleep(500);
    } else if (step === 'ui-trash-pdf-and-archive-lesson') {
      const pdfDelBtn = document.querySelector('button[aria-label="Delete Formula-Sheet.pdf"]') as HTMLButtonElement | null;
      if (!pdfDelBtn) throw new Error('Delete Formula-Sheet.pdf button not found in App UI');
      pdfDelBtn.click();
      await sleep(300);
      const lessonRemBtn = document.querySelector('button[aria-label="Remove Electrostatics 01 from your library"]') as HTMLButtonElement | null;
      if (!lessonRemBtn) throw new Error('Remove Electrostatics 01 button not found in App UI');
      lessonRemBtn.click();
      await sleep(450);
    } else if (step === 'ui-delete-forever-both') {
      const trashToggle = document.querySelector('.pdf-library-trash-toggle') as HTMLButtonElement | null;
      if (!trashToggle) throw new Error('Recently deleted toggle not found in App UI');
      trashToggle.click();
      await sleep(150);
      const pdfForeverBtn = document.querySelector('.pdf-library-delete-forever') as HTMLButtonElement | null;
      if (!pdfForeverBtn) throw new Error('PDF Delete forever button not found in App UI');
      pdfForeverBtn.click();
      await sleep(450);

      const removedTab = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Removed')) as HTMLButtonElement | undefined;
      if (!removedTab) throw new Error('Lesson Removed filter tab not found in App UI');
      removedTab.click();
      await sleep(150);
      const lessonForeverBtn = document.querySelector('.library-delete-forever') as HTMLButtonElement | null;
      if (!lessonForeverBtn) throw new Error('Lesson Delete forever button not found in App UI');
      lessonForeverBtn.click();
      await sleep(450);
    }

    const uiActivePdfs = Array.from(document.querySelectorAll('.pdf-library-grid .pdf-library-card:not(.is-deleted) .pdf-library-name'))
      .map((el) => el.textContent?.trim() ?? '');
    const trashBadge = document.querySelector('.pdf-library-trash-toggle span')?.textContent?.trim() ?? '0';
    const uiActiveLessons = Array.from(document.querySelectorAll('.library-grid .library-card:not(.library-card-removed) .library-video-title'))
      .map((el) => el.textContent?.trim() ?? '');
    const removedTabText = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Removed'))?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

    root.unmount();
    await sleep(50);

    if (profileFile) {
      const dump: Record<string, string> = {};
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key) dump[key] = window.localStorage.getItem(key) ?? '';
      }
      writeFileSync(profileFile, JSON.stringify(dump, null, 2));
    }

    realLog(`RESULT ${JSON.stringify({
      step,
      uiActivePdfs,
      uiTrashCount: Number(trashBadge),
      uiActiveLessons,
      removedTabText,
    })}`);
    process.exit(0);
  }

  let videos = loadLocalState().videos;
  let deletions = loadLocalDeletions();
  let pdfTrash = loadLocalPdfTrash();
  let pdfSync = loadLocalPdfSync();
  let libraryPdfs: Awaited<ReturnType<typeof fetchLibraryPdfs>> = [];

  const syncAll = async () => {
    const [remoteVideos, remotePdfs, remoteTrash, ledgerRecord] = await Promise.all([
      fetchCloudVideos(user),
      fetchLibraryPdfs(user),
      fetchPdfTrashMap(user),
      fetchCloudSyncLedger(user),
    ]);

    const lessonResult = mergeLessonCopies(videos, remoteVideos, deletions, ledgerRecord.ledger.lessons);
    videos = lessonResult.videos;
    deletions = lessonResult.deletions;
    for (const pending of lessonResult.pendingDeletes) {
      await deleteCloudVideo(user, pending.videoId, pending.deletedAt);
      await pushCloudSyncLedger(user, {
        lessons: { [pending.videoId]: { status: 'deleted', at: pending.deletedAt } },
        signalAt: pending.deletedAt,
      });
    }

    const pdfResult = reconcilePdfState({
      remotePdfs,
      localSessionPdfs: [],
      localSync: pdfSync,
      localTrashFallback: pdfTrash,
      localDeletionsFallback: deletions,
      remoteTrash,
      remoteLedgerPdfs: ledgerRecord.ledger.pdfs,
    });
    libraryPdfs = pdfResult.items;
    pdfTrash = pdfResult.trash;
    pdfSync = pdfResult.syncMap;
    for (const id of pdfResult.deletedIds) {
      deletions = withDeletion(deletions, 'pdf', id, pdfSync[id]?.at ?? Date.now());
    }

    const livePaths = new Set(libraryPdfs.map((item) => item.storagePath).filter(Boolean));
    videos = videos.map((video) => {
      if (video.pdfPath && isLibraryPath(video.pdfPath) && !livePaths.has(video.pdfPath)) {
        const cleaned = {
          ...video,
          pdfPath: undefined,
          pdfName: undefined,
          pdfSize: undefined,
          updatedAt: nextLessonStamp(video.updatedAt),
        };
        void saveCloudVideo(user, cleaned);
        return cleaned;
      }
      return video;
    });

    for (const item of pdfResult.pendingHardDeletes) await deleteLibraryPdf(user, item);
    for (const entry of pdfResult.pendingTrashWrites) await trashLibraryPdf(user, entry.pdfId, entry.deletedAt).catch(() => undefined);
    for (const pdfId of pdfResult.pendingRestores) await restoreLibraryPdf(user, pdfId).catch(() => undefined);
    if (Object.keys(pdfResult.ledgerPatch).length > 0) {
      const pushed = await pushCloudSyncLedger(user, { pdfs: pdfResult.ledgerPatch, signalAt: Date.now() });
      if (pushed.available) {
        for (const [id, sent] of Object.entries(pdfResult.ledgerPatch)) {
          const cur = pdfSync[id];
          if (cur?.pending && cur.status === sent.status && cur.at === sent.at) {
            pdfSync[id] = { status: cur.status, at: cur.at, ...(cur.deletedAt ? { deletedAt: cur.deletedAt } : {}) };
          }
        }
      }
    }

    saveLocalState({ videos });
    saveLocalDeletions(deletions);
    saveLocalPdfTrash(pdfTrash);
    saveLocalPdfSync(pdfSync);
    return { lessonResult, pdfResult, trashUnavailable: remoteTrash === null && !ledgerRecord.available };
  };

  await syncAll();

  if (step === 'seed') {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const libFile = new File([pdfBytes], 'Formula-Sheet.pdf', { type: 'application/pdf' });
    const created = await createLibraryPdf(user, libFile, 'Physics');
    libraryPdfs = sortLibrary([created, ...libraryPdfs]);
    pdfSync[created.id] = { status: 'active', at: created.updatedAt };
    await pushCloudSyncLedger(user, {
      pdfs: { [created.id]: { status: 'active', at: created.updatedAt } },
      signalAt: created.updatedAt,
    });

    const noteFile = new File([pdfBytes], 'Lecture-Notes.pdf', { type: 'application/pdf' });
    const notePath = await uploadCloudPdf(user, lessonId, noteFile);
    const stamp = nextLessonStamp();
    const record = {
      videoId: lessonId,
      sourceKind: lessonKind,
      ...(lessonKind === 'file' ? { sourceUrl: lessonUrl } : {}),
      title: 'Electrostatics 01',
      channel: lessonKind === 'file' ? 'filesto.o2zone.space' : 'Physics Wallah',
      thumbnail: '',
      chaptersRaw: '00:00 Intro',
      currentTime: 120,
      duration: 600,
      pdfPath: notePath,
      pdfName: 'Lecture-Notes.pdf',
      pdfSize: pdfBytes.byteLength,
      subject: 'Physics' as const,
      archived: false,
      updatedAt: stamp,
    };
    videos = [record];
    await saveCloudVideo(user, record);
    saveLocalState({ videos });
    saveLocalPdfSync(pdfSync);
  }

  if (step === 'trash-pdf') {
    const target = libraryPdfs[0];
    if (!target) throw new Error('no library PDF to move to Recently deleted');
    const prevAt = pdfSync[target.id]?.at ?? pdfTrash[target.id] ?? 0;
    const deletedAt = nextLessonStamp(prevAt, target.updatedAt);
    pdfTrash[target.id] = deletedAt;
    pdfSync[target.id] = { status: 'trashed', at: deletedAt, deletedAt, pending: true };
    saveLocalPdfTrash(pdfTrash);
    saveLocalPdfSync(pdfSync);
    const [tRes, lRes] = await Promise.allSettled([
      trashLibraryPdf(user, target.id, deletedAt),
      pushCloudSyncLedger(user, {
        pdfs: { [target.id]: { status: 'trashed', at: deletedAt, deletedAt } },
        signalAt: deletedAt,
      }),
    ]);
    if (tRes.status === 'fulfilled' || (lRes.status === 'fulfilled' && lRes.value.available)) {
      pdfSync[target.id] = { status: 'trashed', at: deletedAt, deletedAt };
      saveLocalPdfSync(pdfSync);
    }
  }

  if (step === 'restore-pdf') {
    const target = libraryPdfs[0];
    if (!target) throw new Error('no library PDF to restore');
    const prevAt = pdfSync[target.id]?.at ?? pdfTrash[target.id] ?? 0;
    const restoredAt = nextLessonStamp(prevAt, target.updatedAt);
    delete pdfTrash[target.id];
    pdfSync[target.id] = { status: 'active', at: restoredAt, pending: true };
    saveLocalPdfTrash(pdfTrash);
    saveLocalPdfSync(pdfSync);
    const [rRes, lRes] = await Promise.allSettled([
      restoreLibraryPdf(user, target.id),
      pushCloudSyncLedger(user, {
        pdfs: { [target.id]: { status: 'active', at: restoredAt } },
        signalAt: restoredAt,
      }),
    ]);
    if (rRes.status === 'fulfilled' || (lRes.status === 'fulfilled' && lRes.value.available)) {
      pdfSync[target.id] = { status: 'active', at: restoredAt };
      saveLocalPdfSync(pdfSync);
    }
  }

  if (step === 'delete-pdf-forever') {
    const target = libraryPdfs[0];
    if (!target) throw new Error('no library PDF to delete forever');
    const prevDel = deletions[deletionKey('pdf', target.id)] ?? 0;
    const prevSync = pdfSync[target.id]?.at ?? pdfTrash[target.id] ?? 0;
    const deletedAt = nextLessonStamp(Math.max(prevSync, target.updatedAt), prevDel);
    deletions = withDeletion(deletions, 'pdf', target.id, deletedAt);
    pdfSync[target.id] = { status: 'deleted', at: deletedAt };
    delete pdfTrash[target.id];
    libraryPdfs = libraryPdfs.filter((entry) => entry.id !== target.id);
    saveLocalDeletions(deletions);
    saveLocalPdfTrash(pdfTrash);
    saveLocalPdfSync(pdfSync);
    await Promise.all([
      deleteLibraryPdf(user, target),
      pushCloudSyncLedger(user, {
        pdfs: { [target.id]: { status: 'deleted', at: deletedAt } },
        signalAt: deletedAt,
      }),
    ]);
  }

  if (step === 'detach-lesson-pdf') {
    const target = videos.find((v) => v.videoId === lessonId);
    if (!target) throw new Error('lesson not found for detaching PDF');
    if (target.pdfPath && !isLibraryPath(target.pdfPath)) {
      await deleteCloudPdf(target.pdfPath);
    }
    const updated = {
      ...target,
      pdfPath: undefined,
      pdfName: undefined,
      pdfSize: undefined,
      updatedAt: nextLessonStamp(target.updatedAt),
    };
    videos = videos.map((v) => (v.videoId === lessonId ? updated : v));
    saveLocalState({ videos });
    await saveCloudVideo(user, updated);
    await pushCloudSyncLedger(user, { signalAt: updated.updatedAt });
  }

  if (step === 'archive-lesson') {
    const target = videos.find((v) => v.videoId === lessonId);
    if (!target) throw new Error('lesson not found for archiving');
    const updated = {
      ...target,
      archived: true,
      updatedAt: nextLessonStamp(target.updatedAt),
    };
    videos = videos.map((v) => (v.videoId === lessonId ? updated : v));
    saveLocalState({ videos });
    await saveCloudVideo(user, updated);
    await pushCloudSyncLedger(user, { signalAt: updated.updatedAt });
  }

  if (step === 'restore-lesson') {
    const target = videos.find((v) => v.videoId === lessonId);
    if (!target) throw new Error('lesson not found for restoring');
    const updated = {
      ...target,
      archived: false,
      updatedAt: nextLessonStamp(target.updatedAt),
    };
    videos = videos.map((v) => (v.videoId === lessonId ? updated : v));
    saveLocalState({ videos });
    await saveCloudVideo(user, updated);
    await pushCloudSyncLedger(user, { signalAt: updated.updatedAt });
  }

  if (step === 'delete-lesson-forever') {
    const target = videos.find((v) => v.videoId === lessonId);
    if (!target) throw new Error('lesson not found for permanent deletion');
    const prevDel = deletions[deletionKey('lesson', lessonId)] ?? 0;
    const deletedAt = nextLessonStamp(target.updatedAt, prevDel);
    if (target.pdfPath && !isLibraryPath(target.pdfPath)) {
      await deleteCloudPdf(target.pdfPath).catch(() => undefined);
    }
    deletions = withDeletion(deletions, 'lesson', lessonId, deletedAt);
    videos = videos.filter((v) => v.videoId !== lessonId);
    saveLocalDeletions(deletions);
    saveLocalState({ videos });
    await Promise.allSettled([
      deleteCloudVideo(user, lessonId, deletedAt),
      pushCloudSyncLedger(user, {
        lessons: { [lessonId]: { status: 'deleted', at: deletedAt } },
        signalAt: deletedAt,
      }),
    ]);
  }

  if (step === 'reopen-lesson') {
    const prevDel = deletions[deletionKey('lesson', lessonId)] ?? 0;
    const revivedAt = nextLessonStamp(0, prevDel);
    deletions = withoutDeletion(deletions, 'lesson', lessonId);
    saveLocalDeletions(deletions);
    const record = {
      videoId: lessonId,
      sourceKind: lessonKind,
      ...(lessonKind === 'file' ? { sourceUrl: lessonUrl } : {}),
      title: 'Electrostatics 01',
      channel: lessonKind === 'file' ? 'filesto.o2zone.space' : 'Physics Wallah',
      thumbnail: '',
      chaptersRaw: '',
      currentTime: 0,
      duration: 0,
      subject: 'Physics' as const,
      archived: false,
      updatedAt: revivedAt,
    };
    await clearCloudVideoDeletion(user, lessonId, revivedAt);
    await saveCloudVideo(user, record);
    await pushCloudSyncLedger(user, {
      lessons: { [lessonId]: { status: 'active', at: revivedAt } },
      signalAt: revivedAt,
    });
    videos = [record];
    saveLocalState({ videos });
  }

  const finalState = await syncAll();
  const account = await (await fetch(`${api}/__state`)).json() as { storage?: string[] };

  if (profileFile) {
    const dump: Record<string, string> = {};
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key) dump[key] = window.localStorage.getItem(key) ?? '';
    }
    writeFileSync(profileFile, JSON.stringify(dump, null, 2));
  }

  realLog(`RESULT ${JSON.stringify({
    step,
    activeLessons: videos.filter((v) => !v.archived && !isDeleted(deletions, 'lesson', v.videoId)).map((v) => v.videoId),
    removedLessons: videos.filter((v) => Boolean(v.archived)).map((v) => v.videoId),
    lessonPdfPaths: videos.map((v) => v.pdfPath ?? null),
    activePdfs: libraryPdfs.filter((p) => !pdfTrash[p.id]).map((p) => p.name),
    trashedPdfs: libraryPdfs.filter((p) => Boolean(pdfTrash[p.id])).map((p) => p.name),
    trashUnavailable: finalState.trashUnavailable,
    storageObjects: account.storage ?? [],
  })}`);

  await sleep(30);
  process.exit(0);
}

main().catch((error) => {
  realLog(`RESULT ${JSON.stringify({ step, error: String((error && error.stack) || error) })}`);
  process.exit(1);
});
