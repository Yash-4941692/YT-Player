/**
 * Fast checks on the two helpers the cross-device sync rests on. Bundled and run by
 * tools/sync-sim/run-all.mjs — no browser, no network.
 */
import { annotationChangeFromRow } from '../../src/lib/supabase';
import { nextRevisionStamp, type AnnotationCacheEntry } from '../../src/lib/storage';

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

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nPASS — sync helpers behave as documented.');
}
