/** Run the lesson PDF opening regressions without a real account or network. */
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const buildDir = join(here, '.build');
const output = join(buildDir, 'test.mjs');

await mkdir(buildDir, { recursive: true });
try {
  await build({
    entryPoints: [join(here, 'test.tsx')],
    outfile: output,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    jsx: 'automatic',
    logLevel: 'warning',
    plugins: [{
      name: 'browser-and-cloud-stubs',
      setup(plugin) {
        plugin.onResolve({ filter: /(?:^|\/)lib\/supabase$/ }, () => ({ path: join(here, 'mock-supabase.ts') }));
        plugin.onResolve({ filter: /^pdfjs-dist\/legacy\/build\/pdf\.mjs$/ }, () => ({ path: join(here, 'mock-pdfjs.ts') }));
        plugin.onResolve({ filter: /^pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs\?url$/ }, () => ({ path: 'worker', namespace: 'stub' }));
        plugin.onResolve({ filter: /\/components\/(?:YouTubePlayer|FilePlayer)$/ }, () => ({ path: join(here, 'mock-player.tsx') }));
        plugin.onResolve({ filter: /^@vercel\/analytics\/react$/ }, () => ({ path: 'analytics', namespace: 'stub' }));
        plugin.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: args.path === 'worker' ? "export default '/test-worker.mjs'" : 'export const Analytics = () => null',
          loader: 'js',
        }));
        plugin.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'css' }));
      },
    }],
  });
  await import(pathToFileURL(output).href);
} finally {
  await rm(buildDir, { recursive: true, force: true });
}
