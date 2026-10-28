/**
 * Cross-device file, PDF library, and lesson deletion simulation across three schema/clock
 * environments:
 *   1. Full schema + heavy clock skew (+90 s on Device B, -90 s on Device A).
 *   2. Missing `pdf_trash` table (`SIM_OMIT_TABLES=pdf_trash`, before migration 005).
 *   3. Missing `watch_items.deleted_at` column (`SIM_OMIT_WATCH_COLUMNS=deleted_at`, before migration 008).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const buildDir = join(here, '.build');
const profileDir = join(here, '.profiles');

const PORT = Number(process.env.SIM_FILE_DELETE_PORT || 8792);
const API = `http://127.0.0.1:${PORT}`;
const USER = '11111111-1111-4111-8111-111111111111';

mkdirSync(buildDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });

console.log('• bundling the multi-device file deletion browser…');
const bundle = spawnSync('node_modules/.bin/esbuild', [
  join(here, 'file-device.ts'),
  '--bundle', '--format=esm', '--platform=node', '--packages=external',
  '--loader:.ts=ts', '--loader:.tsx=tsx', '--loader:.css=empty', '--jsx=automatic',
  `--define:import.meta.env.VITE_SUPABASE_URL=${JSON.stringify(API)}`,
  `--define:import.meta.env.VITE_SUPABASE_ANON_KEY=${JSON.stringify('sim-anon-key')}`,
  `--outfile=${join(buildDir, 'file-device.mjs')}`,
  '--log-level=warning',
], { cwd: root, encoding: 'utf8' });
if (bundle.error || bundle.status !== 0) {
  console.error(bundle.stdout, bundle.stderr, bundle.error?.message ?? '');
  process.exit(1);
}

let failures = 0;
function check(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${same ? '  ok  ' : '  FAIL'} ${label}`);
  if (!same) {
    failures += 1;
    console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function withMockServer(extraEnv, fn) {
  const server = spawn(process.execPath, [join(here, 'mock-supabase.mjs')], {
    cwd: root,
    env: { ...process.env, SIM_PORT: String(PORT), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += chunk; });
  server.stderr.on('data', (chunk) => { serverLog += chunk; });

  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API}/__state`);
      if (response.ok) { ready = true; break; }
    } catch {
      // still starting
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) {
    server.kill('SIGTERM');
    throw new Error(`mock-supabase never started:\n${serverLog}`);
  }

  try {
    await fn();
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
  }
}

function runStep(step, profile, extraEnv = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(buildDir, 'file-device.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        SIM_STEP: step,
        SIM_USER: USER,
        SIM_API: API,
        SIM_PROFILE: profile,
        ...extraEnv,
      },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('exit', () => {
      clearTimeout(timer);
      const line = out.split('\n').find((entry) => entry.startsWith('RESULT '));
      const payload = line ? JSON.parse(line.slice('RESULT '.length)) : { error: 'no result line', out, err };
      if (payload.error) {
        console.log(`  error (${step}): ${String(payload.error).split('\n').slice(0, 6).join('\n    ')}`);
      }
      resolveRun(payload);
    });
  });
}

// 1. Full schema + clock skew (+90s on Device B, -90s on Device A)
console.log('\n— Suite 1: full schema + ±90 s clock skew across devices —');
await withMockServer({}, async () => {
  const profA = join(profileDir, 'file-full-a.json');
  const profB = join(profileDir, 'file-full-b.json');
  rmSync(profA, { force: true });
  rmSync(profB, { force: true });
  const envA = { SIM_LESSON: 'file-4646c87259fca6da', SIM_CLOCK_OFFSET_MS: '-90000' };
  const envB = { SIM_LESSON: 'file-4646c87259fca6da', SIM_CLOCK_OFFSET_MS: '90000' };

  const seeded = await runStep('seed', profB, envB);
  check('Device B (+90s) uploads library PDF + lesson + lesson PDF', [seeded.activePdfs, seeded.activeLessons, seeded.storageObjects.length], [
    ['Formula-Sheet.pdf'],
    ['file-4646c87259fca6da'],
    2,
  ]);

  const aInitial = await runStep('check', profA, envA);
  check('Device A (-90s) sees both files', [aInitial.activePdfs, aInitial.activeLessons], [
    ['Formula-Sheet.pdf'],
    ['file-4646c87259fca6da'],
  ]);

  await runStep('trash-pdf', profA, envA);
  const bAfterTrash = await runStep('check', profB, envB);
  check('soft-deleting a library PDF on behind-clock Device A moves it to Recently deleted on Device B', [
    bAfterTrash.activePdfs,
    bAfterTrash.trashedPdfs,
  ], [[], ['Formula-Sheet.pdf']]);

  await runStep('restore-pdf', profB, envB);
  const aAfterRestore = await runStep('check', profA, envA);
  check('restoring the PDF on Device B brings it back to active on Device A', [
    aAfterRestore.activePdfs,
    aAfterRestore.trashedPdfs,
  ], [['Formula-Sheet.pdf'], []]);

  await runStep('trash-pdf', profA, envA);
  await runStep('delete-pdf-forever', profA, envA);
  const bAfterForeverPdf = await runStep('check', profB, envB);
  check('permanently deleting the PDF on Device A removes it + its storage object on Device B', [
    bAfterForeverPdf.activePdfs,
    bAfterForeverPdf.trashedPdfs,
    bAfterForeverPdf.storageObjects.length,
  ], [[], [], 1]);

  await runStep('detach-lesson-pdf', profA, envA);
  const bAfterDetach = await runStep('check', profB, envB);
  check('detaching lesson PDF notes on behind-clock Device A clears notes + storage on ahead-clock Device B', [
    bAfterDetach.lessonPdfPaths,
    bAfterDetach.storageObjects.length,
  ], [[null], 0]);

  await runStep('archive-lesson', profA, envA);
  const bAfterArchive = await runStep('check', profB, envB);
  check('removing a lesson on behind-clock Device A moves it to Removed on ahead-clock Device B', [
    bAfterArchive.activeLessons,
    bAfterArchive.removedLessons,
  ], [[], ['file-4646c87259fca6da']]);

  await runStep('restore-lesson', profB, envB);
  const aAfterLessonRestore = await runStep('check', profA, envA);
  check('restoring a lesson on Device B brings it back to active on Device A', [
    aAfterLessonRestore.activeLessons,
    aAfterLessonRestore.removedLessons,
  ], [['file-4646c87259fca6da'], []]);

  await runStep('delete-lesson-forever', profA, envA);
  const bAfterLessonForever = await runStep('check', profB, envB);
  check('deleting a lesson forever on behind-clock Device A wipes ahead-clock Device B cache', [
    bAfterLessonForever.activeLessons,
    bAfterLessonForever.removedLessons,
  ], [[], []]);

  await runStep('reopen-lesson', profA, envA);
  const bAfterReopen = await runStep('check', profB, envB);
  check('reopening a deleted lesson on behind-clock Device A lifts Device B tombstone too', bAfterReopen.activeLessons, [
    'file-4646c87259fca6da',
  ]);
});

// 2. Missing `pdf_trash` table (migration 005 not run)
console.log('\n— Suite 2: project without `pdf_trash` table (migration 005 absent) —');
await withMockServer({ SIM_OMIT_TABLES: 'pdf_trash' }, async () => {
  const profA = join(profileDir, 'file-notrash-a.json');
  const profB = join(profileDir, 'file-notrash-b.json');
  rmSync(profA, { force: true });
  rmSync(profB, { force: true });
  const env = { SIM_LESSON: 'dQw4w9WgXcQ', SIM_LESSON_KIND: 'youtube' };

  await runStep('seed', profA, env);
  await runStep('check', profB, env);

  await runStep('trash-pdf', profA, env);
  const bTrashed = await runStep('check', profB, env);
  check('without pdf_trash table, PDF soft-delete still syncs to Device B via SyncLedger', [
    bTrashed.activePdfs,
    bTrashed.trashedPdfs,
    bTrashed.trashUnavailable,
  ], [[], ['Formula-Sheet.pdf'], false]);

  await runStep('restore-pdf', profB, env);
  const aRestored = await runStep('check', profA, env);
  check('without pdf_trash table, PDF restore syncs back to Device A', [
    aRestored.activePdfs,
    aRestored.trashedPdfs,
  ], [['Formula-Sheet.pdf'], []]);

  await runStep('delete-pdf-forever', profA, env);
  const bGone = await runStep('check', profB, env);
  check('without pdf_trash table, permanent PDF delete removes it on Device B', [
    bGone.activePdfs,
    bGone.trashedPdfs,
  ], [[], []]);
});

// 3. Missing `watch_items.deleted_at` column (migration 008 not run)
console.log('\n— Suite 3: project without `watch_items.deleted_at` column (migration 008 absent) —');
await withMockServer({ SIM_OMIT_WATCH_COLUMNS: 'deleted_at,source_kind,source_url' }, async () => {
  const profA = join(profileDir, 'file-nodelcol-a.json');
  const profB = join(profileDir, 'file-nodelcol-b.json');
  rmSync(profA, { force: true });
  rmSync(profB, { force: true });
  const env = { SIM_LESSON: 'dQw4w9WgXcQ', SIM_LESSON_KIND: 'youtube' };

  await runStep('seed', profA, env);
  const bCached = await runStep('check', profB, env);
  check('Device B caches YouTube lesson without migration 008', bCached.activeLessons, ['dQw4w9WgXcQ']);

  await runStep('delete-lesson-forever', profA, env);
  const bDeleted = await runStep('check', profB, env);
  check('without watch_items.deleted_at, SyncLedger tombstone still prevents Device B from resurrecting the lesson', [
    bDeleted.activeLessons,
    bDeleted.removedLessons,
  ], [[], []]);
});

// 4. Full mounted `<App />` UI clicks across two devices (with clock skew & missing `pdf_trash`)
console.log('\n— Suite 4: mounted <App /> UI clicks across two devices (clock skew + missing pdf_trash) —');
await withMockServer({ SIM_OMIT_TABLES: 'pdf_trash' }, async () => {
  const profA = join(profileDir, 'file-ui-a.json');
  const profB = join(profileDir, 'file-ui-b.json');
  rmSync(profA, { force: true });
  rmSync(profB, { force: true });
  const envA = { SIM_LESSON: 'dQw4w9WgXcQ', SIM_LESSON_KIND: 'youtube', SIM_CLOCK_OFFSET_MS: '-60000' };
  const envB = { SIM_LESSON: 'dQw4w9WgXcQ', SIM_LESSON_KIND: 'youtube', SIM_CLOCK_OFFSET_MS: '60000' };

  await runStep('seed', profB, envB);
  const bUiInit = await runStep('ui-focus-check', profB, envB);
  check('Device B <App /> renders both uploaded PDF and lesson', [bUiInit.uiActivePdfs, bUiInit.uiActiveLessons], [
    ['Formula-Sheet'],
    ['Electrostatics 01'],
  ]);

  await runStep('ui-trash-pdf-and-archive-lesson', profA, envA);
  const bUiAfterTrash = await runStep('ui-focus-check', profB, envB);
  check('clicking Delete PDF + Remove lesson in <App /> on Device A updates Device B <App /> on focus', [
    bUiAfterTrash.uiActivePdfs,
    bUiAfterTrash.uiTrashCount,
    bUiAfterTrash.uiActiveLessons,
    bUiAfterTrash.removedTabText.includes('Removed'),
  ], [[], 1, [], true]);

  await runStep('ui-delete-forever-both', profB, envB);
  const aUiAfterForever = await runStep('ui-focus-check', profA, envA);
  check('clicking Delete forever on PDF + lesson in <App /> on Device B wipes both from Device A <App />', [
    aUiAfterForever.uiActivePdfs,
    aUiAfterForever.uiTrashCount,
    aUiAfterForever.uiActiveLessons,
    aUiAfterForever.removedTabText,
  ], [[], 0, [], '']);
});

console.log(failures === 0
  ? '\nPASS — cross-device file, PDF & lesson deletions stay synced across schemas and clock skew.'
  : `\nFAIL — ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
