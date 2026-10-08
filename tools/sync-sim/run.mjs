/**
 * Two-device sync checks for PDF annotations.
 *
 *   node tools/sync-sim/run.mjs fresh          device B opens the PDF for the first time
 *   node tools/sync-sim/run.mjs returning      both devices keep their cached copies
 *   node tools/sync-sim/run.mjs flaky          the account write fails twice, then works
 *   node tools/sync-sim/run.mjs fresh --clock-skew
 *   node tools/sync-sim/run.mjs returning --clock-skew
 *   node tools/sync-sim/run.mjs lesson         a lesson's own PDF (lesson_annotations)
 *
 * Each device is its own process with its own localStorage (`tools/sync-sim/.profiles`),
 * so "device B" really is a second browser: fresh storage, fresh caches, its own clock.
 * Drawings must follow the account: whatever device A draws has to be on device B, and
 * the other way round, without either device silently dropping the other's copy.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const buildDir = join(here, '.build');
const profileDir = join(here, '.profiles');

const scenario = process.argv[2] || 'fresh';
const flaky = scenario === 'flaky';
const clockSkew = process.argv.includes('--clock-skew');
const lesson = scenario === 'lesson';

const PORT = Number(process.env.SIM_PORT || 8787);
const API = `http://127.0.0.1:${PORT}`;
const USER = '11111111-1111-4111-8111-111111111111';
const PDF = '22222222-2222-4222-8222-222222222222';
const LESSON = 'dQw4w9WgXcQ';

const profileA = join(profileDir, `a-${scenario}${clockSkew ? '-skew' : ''}.json`);
const profileB = join(profileDir, `b-${scenario}${clockSkew ? '-skew' : ''}.json`);

mkdirSync(buildDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
if (scenario === 'fresh') {
  rmSync(profileA, { force: true });
  rmSync(profileB, { force: true });
}

console.log('• bundling the simulated browser…');
const bundle = spawnSync('node_modules/.bin/esbuild', [
  join(here, 'device.tsx'),
  '--bundle',
  '--format=esm',
  '--platform=node',
  '--packages=external',
  '--loader:.tsx=tsx',
  '--jsx=automatic',
  `--define:import.meta.env.VITE_SUPABASE_URL=${JSON.stringify(API)}`,
  `--define:import.meta.env.VITE_SUPABASE_ANON_KEY=${JSON.stringify('sim-anon-key')}`,
  `--outfile=${join(buildDir, 'device.mjs')}`,
  '--log-level=warning',
], { cwd: root, encoding: 'utf8' });
if (bundle.error) {
  console.error('could not run node_modules/.bin/esbuild:', bundle.error.message);
  process.exit(1);
}
if (bundle.status !== 0) {
  console.error(bundle.stdout, bundle.stderr);
  process.exit(1);
}

const SCOPE = lesson ? { SIM_LESSON: LESSON } : { SIM_PDF: PDF };

function runDevice(label, mode, extraEnv = {}, waitMs = 90000) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(buildDir, 'device.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        SIM_MODE: mode,
        SIM_USER: USER,
        SIM_API: API,
        ...SCOPE,
        ...extraEnv,
      },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), waitMs);
    child.on('exit', () => {
      clearTimeout(timer);
      const line = out.split('\n').find((entry) => entry.startsWith('RESULT '));
      const payload = line ? JSON.parse(line.slice('RESULT '.length)) : { error: 'no result line', out, err };
      console.log(`\n— ${label} (${mode}) —`);
      if (payload.error) {
        console.log(`  error: ${String(payload.error).split('\n').slice(0, 6).join('\n         ')}`);
        if (payload.out) console.log(`  stdout: ${String(payload.out).trim().slice(0, 600) || '(empty)'}`);
        if (payload.err) console.log(`  stderr: ${String(payload.err).trim().slice(0, 600) || '(empty)'}`);
      }
      console.log(`  annotations on this device: ${JSON.stringify(payload.annotations)}`);
      if (payload.bridge?.status) console.log(`  reader status: ${payload.bridge.status}`);
      resolveRun(payload);
    });
  });
}

const server = spawn(process.execPath, [join(here, 'mock-supabase.mjs')], {
  cwd: root,
  env: {
    ...process.env,
    SIM_PORT: String(PORT),
    SIM_FAIL_WRITES: flaky ? '2' : '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });
/**
 * Wait until the stand-in API is really listening. A fixed sleep is not enough on a cold CI
 * machine: the first device would then fail to reach the server and the whole run would look
 * like a sync failure.
 */
async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API}/__state`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return false;
}

if (!(await waitForServer())) {
  console.error('the stand-in Supabase API never started listening:');
  console.error(serverLog || '(no output)');
  server.kill('SIGTERM');
  process.exit(1);
}

const headers = {
  fresh: `=== ${scenario}: device B opens the PDF for the first time ===`,
  returning: `=== ${scenario}: both devices keep the copies they already cached ===`,
  lesson: `=== ${scenario}: a lesson's own PDF notes (lesson_annotations) ===`,
};

try {
  console.log(`\n${headers[scenario] || headers.fresh}${clockSkew ? ' + clock skew' : ''}`);
  const aSkew = clockSkew ? { SIM_CLOCK_OFFSET_MS: '120000' } : {};
  const bSkew = clockSkew ? { SIM_CLOCK_OFFSET_MS: '-300000' } : {};

  const steps = flaky
    ? [['device A (draws while the account write fails)', 'draw', profileA, aSkew]]
    : scenario === 'lesson'
    ? [
        // A lesson PDF: device A draws, device B (first open) has to see it and add a stroke.
        ['device A (draws on the lesson PDF)', 'draw', profileA, aSkew, 'A'],
        ['device B (opens the lesson PDF)', 'read-then-draw', profileB, bSkew, 'B'],
        ['device A (reopens the lesson PDF)', 'read', profileA, aSkew, 'A'],
      ]
    : scenario === 'returning'
      ? [
        // Both devices already have a cached copy, and both keep editing it.
        ['device A (draws, keeps its cached copy)', 'read-then-draw', profileA, aSkew, 'A'],
        ['device B (draws, keeps its cached copy)', 'read-then-draw', profileB, bSkew, 'B'],
        ['device A (comes back to the PDF)', 'read-after-focus', profileA, aSkew, 'A'],
      ]
      : [
        ['device A (draws a pen stroke)', 'draw', profileA, aSkew, 'A'],
        ['device B (opens the same PDF)', 'read', profileB, bSkew, 'B'],
        ['device B (adds a second stroke)', 'draw-second', profileB, bSkew, 'B'],
        ['device A (comes back to the PDF)', 'read-after-focus', profileA, aSkew, 'A'],
      ];

  const results = [];
  for (const [label, mode, profile, skew, which] of steps) {
    results.push(await runDevice(label, mode, {
      SIM_PROFILE: profile,
      SIM_DEVICE: which,
      ...(flaky ? { SIM_SETTLE_MS: '16000' } : {}),
      ...skew,
    }));
  }
  const rejected = await (await fetch(`${API}/__writes-rejected`)).json();
  for (const entry of results) entry.rejectedWrites = rejected.rejected;

  const failures = [];
  if (flaky) {
    // The first two writes are rejected; the reader retries on its own and must end up saved.
    const [only] = results;
    if (only.annotations.length !== 1) failures.push('device A lost its own stroke');
    if (only.bridge?.dirty) failures.push('the stroke was still unsaved after the retries');
    const row = only.cloud?.pdf_annotations?.[0];
    if (!row) failures.push('the retry never reached the account');
    const rejected = only.rejectedWrites ?? 0;
    if (rejected < 2) failures.push(`the account only rejected ${rejected} write(s)`);
  } else if (scenario === 'lesson') {
    if (results[0].annotations.length !== 1) failures.push('device A did not save its stroke');
    if (results[1].annotations.length !== 2) failures.push('device B did not see device A\'s stroke on the lesson PDF');
    if (results[2].annotations.length !== 2) failures.push('device A did not see both strokes on the lesson PDF');
    const row = results[0].cloud?.lesson_annotations?.[0];
    if (!row) failures.push('nothing was written to lesson_annotations');
    else if (row.video_id !== LESSON) failures.push(`lesson annotations were stored under ${row.video_id}`);
  } else if (scenario === 'returning') {
    if (results[0].annotations.length !== 1) failures.push('device A did not save its stroke');
    if (results[1].annotations.length !== 2) failures.push('device B did not merge device A\'s stroke with its own');
    if (results[2].annotations.length !== 2) failures.push('device A did not pick up device B\'s stroke');
  } else {
    if (results[0].annotations.length !== 1) failures.push('device A did not save its stroke');
    if (results[1].annotations.length !== 1) failures.push('device B did not see device A\'s stroke');
    if (results[2].annotations.length !== 2) failures.push('device B did not merge the second stroke');
    if (results[3].annotations.length !== 2) failures.push('device A did not see device B\'s stroke');
  }

  const cloud = await (await fetch(`${API}/__state`)).json();
  for (const [table, rows] of Object.entries(cloud)) {
    if (!rows.length) continue;
    console.log(`\n  account table ${table}: ${rows.length} row(s)`);
    for (const row of rows) {
      const annotations = Array.isArray(row.data?.annotations) ? row.data.annotations.map((entry) => entry.id) : [];
      console.log(`    key=${JSON.stringify({ pdf_id: row.pdf_id, video_id: row.video_id })} updated_at=${row.updated_at} annotations=${JSON.stringify(annotations)}`);
    }
  }

  console.log('\n=== verdict ===');
  if (failures.length === 0) {
    console.log('PASS — drawings follow the account across devices.');
  } else {
    console.log('FAIL');
    for (const failure of failures) console.log(`  • ${failure}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.log('simulation error', error);
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  rmSync(buildDir, { recursive: true, force: true });
}
