/**
 * Runs every cross-device sync check: the helper-level checks plus the two-device
 * simulations (fresh devices, devices that keep their cached copies, a lesson's own PDF
 * notes, and a flaky account connection).
 *
 *   npm run test:sync
 *
 * Exits non-zero as soon as anything fails, so it can gate a deploy or a pull request.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const buildDir = join(here, '.build');

mkdirSync(buildDir, { recursive: true });

console.log('• bundling the helper checks…');
const bundle = spawnSync('node_modules/.bin/esbuild', [
  join(here, 'unit.ts'),
  '--bundle',
  '--format=esm',
  '--platform=node',
  '--packages=external',
  '--loader:.ts=ts',
  `--define:import.meta.env.VITE_SUPABASE_URL=${JSON.stringify('http://127.0.0.1:8787')}`,
  `--define:import.meta.env.VITE_SUPABASE_ANON_KEY=${JSON.stringify('sim-anon-key')}`,
  `--outfile=${join(buildDir, 'unit.mjs')}`,
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

const unit = spawnSync(process.execPath, [join(buildDir, 'unit.mjs')], { cwd: root, stdio: 'inherit' });
rmSync(buildDir, { recursive: true, force: true });
if (unit.status !== 0) {
  console.log('\nFAIL — the sync helpers did not behave as documented.');
  process.exit(1);
}

const scenarios = [
  ['fresh'],
  ['fresh', '--clock-skew'],
  ['returning'],
  ['returning', '--clock-skew'],
  ['lesson'],
  ['flaky'],
];

for (const args of scenarios) {
  rmSync(join(here, '.profiles'), { recursive: true, force: true });
  const run = spawnSync(process.execPath, [join(here, 'run.mjs'), ...args], { cwd: root, stdio: 'inherit' });
  if (run.status !== 0) {
    console.log(`\nFAIL — scenario "${args.join(' ')}" did not reach the account.`);
    process.exit(1);
  }
}

console.log('\nAll cross-device sync checks passed.');
