/**
 * "Deleted content really stays deleted" — end to end, over a real (simulated) account.
 *
 *   node tools/sync-sim/lesson-delete.mjs
 *
 * Device A opens a lesson. Device B opens the app and caches it. A deletes it for good.
 * B — which still holds its own cached copy — must not bring it back, and B must not keep
 * showing it in its library. Then B opens the lesson again on purpose, which is the one thing
 * allowed to bring it back, and a third device must see it.
 *
 * Every device is a separate process with its own localStorage, exactly like
 * tools/sync-sim/run.mjs, and the account is the real PostgREST shapes through
 * tools/sync-sim/mock-supabase.mjs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const buildDir = join(here, '.build');
const profileDir = join(here, '.profiles');

const PORT = Number(process.env.SIM_DELETE_PORT || 8791);
const API = `http://127.0.0.1:${PORT}`;
const USER = '11111111-1111-4111-8111-111111111111';
const LESSON = 'file-4646c87259fca6da';

mkdirSync(buildDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
const profileA = join(profileDir, 'delete-a.json');
const profileB = join(profileDir, 'delete-b.json');
const profileC = join(profileDir, 'delete-c.json');
for (const file of [profileA, profileB, profileC]) rmSync(file, { force: true });

console.log('• bundling the simulated browser…');
const bundle = spawnSync('node_modules/.bin/esbuild', [
  join(here, 'lesson-device.ts'),
  '--bundle', '--format=esm', '--platform=node', '--packages=external',
  '--loader:.ts=ts', '--loader:.tsx=tsx', '--jsx=automatic',
  `--define:import.meta.env.VITE_SUPABASE_URL=${JSON.stringify(API)}`,
  `--define:import.meta.env.VITE_SUPABASE_ANON_KEY=${JSON.stringify('sim-anon-key')}`,
  `--outfile=${join(buildDir, 'lesson-device.mjs')}`,
  '--log-level=warning',
], { cwd: root, encoding: 'utf8' });
if (bundle.error || bundle.status !== 0) {
  console.error(bundle.stdout, bundle.stderr, bundle.error?.message ?? '');
  process.exit(1);
}

const server = spawn(process.execPath, [join(here, 'mock-supabase.mjs')], {
  cwd: root,
  env: { ...process.env, SIM_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API}/__state`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  }
  throw new Error(`the stand-in account never started:\n${serverLog}`);
}

function runDevice(label, step, profile) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(buildDir, 'lesson-device.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        SIM_STEP: step,
        SIM_USER: USER,
        SIM_API: API,
        SIM_LESSON: LESSON,
        SIM_PROFILE: profile,
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
      console.log(`\n— ${label} —`);
      if (payload.error) console.log(`  error: ${String(payload.error).split('\n').slice(0, 5).join('\n         ')}`);
      console.log(`  shows: ${JSON.stringify(payload.visible)}`);
      console.log(`  account rows: ${JSON.stringify(payload.accountRows)}`);
      resolveRun(payload);
    });
  });
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

try {
  await waitForServer();

  const saved = await runDevice('device A opens the lesson', 'save', profileA);
  check('the lesson reaches the account', saved.accountRows.length, 1);
  check('the direct video link is part of the lesson row', saved.accountRows[0]?.source_url, 'https://filesto.o2zone.space/d/TnYng8W');

  const cached = await runDevice('device B opens the app and caches it', 'cache', profileB);
  check('device B sees the lesson', cached.visible, [LESSON]);

  const deleted = await runDevice('device A deletes it for good', 'delete', profileA);
  check('device A stops showing it', deleted.visible, []);
  check('the account keeps a tombstone instead of dropping the row', deleted.accountRows[0]?.deleted_at !== null, true);

  const bAfter = await runDevice('device B re-opens the app with its stale cached copy', 'check', profileB);
  check('the cached copy does not resurrect the lesson on B', bAfter.visible, []);
  check('B drops the deleted lesson from its cache', bAfter.cached, []);

  const fresh = await runDevice('a third device opens the app', 'check', profileC);
  check('a device that never saw it does not show it either', fresh.visible, []);

  const reopened = await runDevice('device B opens the deleted lesson again on purpose', 'reopen', profileB);
  check('opening it again brings the lesson back on B', reopened.visible, [LESSON]);

  const cAfter = await runDevice('a device that still has the tombstone re-opens the app', 'check', profileC);
  check('the lifted tombstone reaches the other devices', cAfter.visible, [LESSON]);

  console.log(failures === 0 ? '\nPASS — deletions reach every device and stay deleted.' : `\nFAIL — ${failures} check(s) failed.`);
} finally {
  server.kill('SIGTERM');
}

process.exit(failures === 0 ? 0 : 1);
