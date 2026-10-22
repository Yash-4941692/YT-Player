/**
 * Fast checks on the two helpers the cross-device sync rests on. Bundled and run by
 * tools/sync-sim/run-all.mjs — no browser, no network.
 */
// eslint-disable-next-line import/order -- must install the WebSocket fallback first
import './websocket-shim';
import { annotationChangeFromRow } from '../../src/lib/supabase';
import { nextRevisionStamp, type AnnotationCacheEntry } from '../../src/lib/storage';
import { mergeLessonCopies, withDeletion, withoutDeletion, withoutDeletedPdfs } from '../../src/lib/lessonSync';
import { fileLessonId, isYouTubeLink, parseLessonInput } from '../../src/lib/youtube';
import type { VideoRecord } from '../../src/types';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${same ? '  ok  ' : '  FAIL'} ${label}`);
  if (!same) {
    failures += 1;
    console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log('\n• revision stamps (a device whose clock is wrong must still publish a newer revision)');
const seen: AnnotationCacheEntry = { data: null, localUpdatedAt: 10, cloudUpdatedAt: 5_000, pending: false };
check('clock 5 s behind the stored copy → strictly newer', nextRevisionStamp(seen, 100), 5_001);
check('repeated writes keep moving forward', nextRevisionStamp({ ...seen, cloudUpdatedAt: 5_001 }, 100), 5_002);
check('a device already ahead keeps its clock', nextRevisionStamp(seen, 7_000), 7_000);
check('unsaved local edits raise the next stamp too', nextRevisionStamp({ ...seen, cloudUpdatedAt: 0, localUpdatedAt: 9_000 }, 100), 9_001);
check('no cache yet → the clock', nextRevisionStamp(null, 42), 42);

console.log('\n• realtime payloads (an event without the document must never read as "PDF is empty")');
const stamp = '2026-01-01T00:00:00.000Z';
check('row missing data → refuse', annotationChangeFromRow({ updated_at: stamp }), null);
check('data:null → refuse', annotationChangeFromRow({ data: null, updated_at: stamp }), null);
check('not a row → refuse', annotationChangeFromRow(null), null);
check('a deleted row → refuse', annotationChangeFromRow('deleted'), null);
check(
  'a real document → accepted',
  annotationChangeFromRow({ data: { version: 1, annotations: [] }, updated_at: stamp }),
  { annotations: { version: 1, annotations: [] }, updatedAt: Date.parse(stamp) },
);


/* ---------------------------------------------------------------------------------------
 * Deletions across devices.
 *
 * The bug being locked down: a lesson deleted on device A came back, because device B still
 * had a cached copy and merged it back into the account. A tombstone is what stops that.
 * ------------------------------------------------------------------------------------- */

function lesson(videoId: string, updatedAt: number, extra: Partial<VideoRecord> = {}): VideoRecord {
  return {
    videoId,
    title: videoId,
    channel: '',
    thumbnail: '',
    chaptersRaw: '',
    currentTime: 0,
    duration: 0,
    subject: 'Physics',
    updatedAt,
    ...extra,
  };
}

console.log('\n• deletions across devices');
{
  const tombstone = lesson('dQw4w9WgXcQ', 5_000, { deletedAt: 5_000 });
  // Device B still caches the lesson from before device A deleted it.
  const cached = lesson('dQw4w9WgXcQ', 1_000);
  const result = mergeLessonCopies([cached], [tombstone], {});
  check('a cached copy cannot resurrect a deleted lesson', result.videos.map((v) => v.videoId), []);
  check('the account tombstone is remembered', result.deletions['lesson:dQw4w9WgXcQ'], 5_000);
  check('nothing is pushed back for a deleted lesson', Object.keys(result.confirmed), []);
  check('the lesson is reported as removed', result.removedIds, ['dQw4w9WgXcQ']);
}
{
  // Device B deleted the lesson while offline: its own tombstone must also hide it, and the
  // delete still has to reach the account once the connection is back.
  const cached = lesson('dQw4w9WgXcQ', 1_000);
  const deletions = withDeletion({}, 'lesson', 'dQw4w9WgXcQ', 2_000);
  const result = mergeLessonCopies([cached], [lesson('dQw4w9WgXcQ', 1_000)], deletions);
  check('a local tombstone hides the cached copy', result.videos.map((v) => v.videoId), []);
  check('the pending delete is queued for the account', result.pendingDeletes, [{ videoId: 'dQw4w9WgXcQ', deletedAt: 2_000 }]);
}
{
  // The lesson was deliberately opened again after being deleted: the account row is back and
  // newer than the stale local tombstone, so it must be shown, not hidden forever.
  const deletions = withDeletion({}, 'lesson', 'dQw4w9WgXcQ', 2_000);
  const result = mergeLessonCopies([], [lesson('dQw4w9WgXcQ', 9_000)], deletions);
  check('opening a deleted lesson again brings it back', result.videos.map((v) => v.videoId), ['dQw4w9WgXcQ']);
  check('the stale tombstone is dropped', result.deletions, {});
}
{
  // Unrelated lessons keep syncing exactly as before.
  const result = mergeLessonCopies(
    [lesson('newerlocal', 8_000), lesson('olderlocal', 1_000)],
    [lesson('newerlocal', 2_000), lesson('olderlocal', 7_000), lesson('remoteonly', 3_000)],
    {},
  );
  check('the newer copy wins on both sides', result.videos.map((v) => `${v.videoId}@${v.updatedAt}`), ['newerlocal@8000', 'olderlocal@7000', 'remoteonly@3000']);
  check('the local copy that won is still uploaded', 'newerlocal' in result.confirmed, false);
  check('the account copy that won is not re-uploaded', result.confirmed.olderlocal, 7_000);
  check('a lesson this device has never seen is not re-uploaded', result.confirmed.remoteonly, 3_000);
}
{
  // Device B was watching the lesson when device A deleted it: a progress tick re-saves the
  // record locally with a newer timestamp. That must not beat the account's tombstone.
  const tombstone = lesson('dQw4w9WgXcQ', 5_000, { deletedAt: 5_000 });
  const tickedDuringDelete = lesson('dQw4w9WgXcQ', 9_000);
  const result = mergeLessonCopies([tickedDuringDelete], [tombstone], {});
  check('a newer cached copy still cannot beat the account tombstone', result.videos.map((v) => v.videoId), []);
}

console.log('\n• tombstone helpers');
check('adding a tombstone', withDeletion({}, 'pdf', 'abc', 10)['pdf:abc'], 10);
check('removing one again', withoutDeletion({ 'pdf:abc': 10 }, 'pdf', 'abc'), {});
check('deleted PDFs are dropped from the library', withoutDeletedPdfs([{ id: 'a' }, { id: 'b' }], { 'pdf:a': 1 }), [{ id: 'b' }]);

/* ---------------------------------------------------------------------------------------
 * Direct video links.
 * ------------------------------------------------------------------------------------- */

console.log('\n• direct video links');
{
  const file = parseLessonInput('https://filesto.o2zone.space/d/TnYng8W');
  check('a file-host link is a file lesson', file.kind, 'file');
  check('its link is kept for playback', file.fileUrl, 'https://filesto.o2zone.space/d/TnYng8W');
  check('its host becomes the channel', file.channel, 'filesto.o2zone.space');
  check('the lesson id is stable', fileLessonId('https://filesto.o2zone.space/d/TnYng8W'), fileLessonId('https://filesto.o2zone.space/d/TnYng8W#start'));
  check('different links get different ids', fileLessonId('https://a.example/one.mp4') === fileLessonId('https://a.example/two.mp4'), false);
  check('the id is safe inside a storage path', /^file-[a-f0-9]{16}$/.test(fileLessonId('https://a.example/one.mp4')), true);

  const mp4 = parseLessonInput('https://cdn.example.com/lectures/kinematics-01.mp4');
  check('an .mp4 link is a file lesson with a readable title', [mp4.kind, mp4.title], ['file', 'kinematics 01']);

  const youtube = parseLessonInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567890');
  check('YouTube links are still YouTube lessons', [youtube.kind, youtube.videoId, youtube.playlistId], ['youtube', 'dQw4w9WgXcQ', 'PL1234567890']);
  check('a bare video id is still YouTube', parseLessonInput('dQw4w9WgXcQ').kind, 'youtube');
  check('isYouTubeLink spots a YouTube link', isYouTubeLink('https://youtu.be/dQw4w9WgXcQ'), true);
  check('isYouTubeLink spots a file link', isYouTubeLink('https://filesto.o2zone.space/d/TnYng8W'), false);
  try {
    parseLessonInput('javascript:alert(1)');
    check('a non-http link is rejected', 'accepted', 'rejected');
  } catch (error) {
    check('a non-http link is rejected', (error as Error).message.includes('http'), true);
  }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nPASS — sync helpers behave as documented.');
}
