/**
 * One simulated browser for the "deleted content really goes away" checks
 * (tools/sync-sim/lesson-delete.mjs).
 *
 * Every step behaves like the app around `reconcileLessons`: it reads the account, merges it
 * with the copy this browser has cached, and then does the one action the step is about.
 *
 *   SIM_STEP=save     open a lesson (it is saved to this browser and uploaded)
 *   SIM_STEP=cache    open the app on a device that has never seen it (cache what it gets)
 *   SIM_STEP=delete   \"Delete forever\" on the lesson (tombstone first, then the account)
 *   SIM_STEP=reopen   open the same lesson again from Removed (lifts the tombstone)
 *   SIM_STEP=check    just open the app and report what it shows
 *
 * Env: SIM_USER, SIM_API, SIM_LESSON, SIM_PROFILE (localStorage kept between steps).
 */
// eslint-disable-next-line import/order -- must install the WebSocket fallback first
import './websocket-shim';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const step = process.env.SIM_STEP || 'check';
const user = process.env.SIM_USER || '11111111-1111-4111-8111-111111111111';
const api = process.env.SIM_API || 'http://127.0.0.1:8791';
const lessonId = process.env.SIM_LESSON || 'dQw4w9WgXcQ';
const lessonUrl = process.env.SIM_LESSON_URL || 'https://filesto.o2zone.space/d/TnYng8W';
const profileFile = process.env.SIM_PROFILE || '';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://focusframe.test/',
  pretendToBeVisual: true,
});
const { window } = dom;
for (const key of [
  'window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Element', 'Node',
  'SVGElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'DOMParser',
]) {
  const value = key === 'window' ? window : window[key];
  if (value === undefined) continue;
  try {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  } catch {
    // read-only in this Node version
  }
}

if (profileFile && existsSync(profileFile)) {
  const saved = JSON.parse(readFileSync(profileFile, 'utf8'));
  for (const [key, value] of Object.entries(saved)) window.localStorage.setItem(key, String(value));
}

const realLog = console.log.bind(console);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const supabaseModule = await import('../../src/lib/supabase');
  const { supabase, fetchCloudVideos, saveCloudVideo, deleteCloudVideo, clearCloudVideoDeletion } = supabaseModule;
  const { mergeLessonCopies, withoutDeletion } = await import('../../src/lib/lessonSync');
  const { loadLocalState, saveLocalState, loadLocalDeletions, saveLocalDeletions } = await import('../../src/lib/storage');

  if (!supabase) throw new Error('the simulated client was built without Supabase credentials');
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.${encode('sim-signature')}`;
  const session = await supabase.auth.setSession({ access_token: token, refresh_token: 'sim-refresh-token' });
  if (session.error) throw new Error(`could not seed the simulated session: ${JSON.stringify(session.error)}`);

  let local = loadLocalState().videos;
  let deletions = loadLocalDeletions();

  const reconcile = async () => {
    const remote = await fetchCloudVideos(user);
    const result = mergeLessonCopies(local, remote, deletions);
    local = result.videos;
    deletions = result.deletions;
    for (const pending of result.pendingDeletes) await deleteCloudVideo(user, pending.videoId, pending.deletedAt);
    saveLocalState({ videos: local });
    saveLocalDeletions(deletions);
    return result;
  };

  if (step === 'save') {
    // Opening a direct video link for the first time, exactly like the app's load handler.
    const now = Date.now();
    const record = {
      videoId: lessonId,
      sourceKind: 'file',
      sourceUrl: lessonUrl,
      title: 'TnYng8W',
      channel: 'filesto.o2zone.space',
      thumbnail: '',
      chaptersRaw: '00:00 Introduction',
      currentTime: 0,
      duration: 0,
      subject: 'Physics',
      updatedAt: now,
    };
    local = [record];
    saveLocalState({ videos: local });
    await saveCloudVideo(user, record);
  }

  if (step === 'delete') {
    await reconcile();
    const record = local.find((video) => video.videoId === lessonId);
    if (!record) throw new Error('the lesson is not on this device, so there is nothing to delete');
    const deletedAt = Date.now();
    // Tombstone first (this is the order the app uses), then the account.
    deletions = { ...deletions, [`lesson:${lessonId}`]: deletedAt };
    saveLocalDeletions(deletions);
    local = local.filter((video) => video.videoId !== lessonId);
    saveLocalState({ videos: local });
    await deleteCloudVideo(user, lessonId, deletedAt);
  }

  if (step === 'reopen') {
    await reconcile();
    // "Open the lesson again": only this lifts the tombstone.
    deletions = withoutDeletion(deletions, 'lesson', lessonId);
    saveLocalDeletions(deletions);
    const record = {
      videoId: lessonId,
      sourceKind: 'file',
      sourceUrl: lessonUrl,
      title: 'TnYng8W',
      channel: 'filesto.o2zone.space',
      thumbnail: '',
      chaptersRaw: '00:00 Introduction',
      currentTime: 0,
      duration: 0,
      subject: 'Physics',
      updatedAt: Date.now(),
    };
    await clearCloudVideoDeletion(user, lessonId);
    await saveCloudVideo(user, record);
    local = [record];
    saveLocalState({ videos: local });
  }

  // Every step ends like the app does when it opens: read the account and merge.
  const final = await reconcile();
  const visible = final.videos.map((video) => video.videoId);
  const account = await (await fetch(`${api}/__state`)).json();
  const rows = account.watch_items ?? [];

  if (profileFile) {
    const dump = {};
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key) dump[key] = window.localStorage.getItem(key) ?? '';
    }
    writeFileSync(profileFile, JSON.stringify(dump, null, 2));
  }

  realLog(`RESULT ${JSON.stringify({
    step,
    visible,
    cached: loadLocalState().videos.map((video) => video.videoId),
    deletions: loadLocalDeletions(),
    accountRows: rows.map((row) => ({ video_id: row.video_id, deleted_at: row.deleted_at ?? null, source_url: row.source_url ?? null })),
  })}`);

  await sleep(50);
  process.exit(0);
}

main().catch((error) => {
  realLog(`RESULT ${JSON.stringify({ step, error: String((error && error.stack) || error) })}`);
  process.exit(1);
});
