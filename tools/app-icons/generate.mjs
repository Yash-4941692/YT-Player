// Regenerates the raster icons that Chrome, Windows, Android and iOS need when Focusframe is
// installed as an app. They are all drawn from public/favicon.svg, so the tab icon and the
// installed-app icon can never drift apart:
//
//   npm install --no-save @resvg/resvg-js && npm run build:app-icons
//
// The output is committed, so you only need this when the artwork changes. @resvg/resvg-js is
// installed on demand (--no-save) instead of being a dependency, to keep `npm ci` light; the
// committed PNGs mean a normal install never needs it. resvg is used because the favicon has a
// gradient, which ImageMagick's built-in renderer draws incorrectly.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const publicDir = join(root, 'public');
const iconsDir = join(publicDir, 'icons');

/** The dark background the app itself uses (`theme-color` in index.html). */
const BACKGROUND = '#0b0d13';
/** How much of a maskable icon the tile fills; 0.62 keeps it inside the 80% safe zone. */
const MASKABLE_SCALE = 0.62;
/** Slightly larger for iOS, which shows the icon in a squircle without cropping as tightly. */
const APPLE_SCALE = 0.72;

const svg = readFileSync(join(publicDir, 'favicon.svg'), 'utf8');
const innerStart = svg.indexOf('>', svg.indexOf('<svg')) + 1;
const artwork = svg.slice(innerStart, svg.lastIndexOf('</svg>'));

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">';

/** The favicon as it is: the rounded tile on a transparent background. */
const tileOnly = () => `${HEAD}${artwork}</svg>`;

/** The tile on a full-bleed background, for platforms that crop the icon to a circle. */
const tileOnBackground = (scale) =>
  `${HEAD}<rect width="64" height="64" fill="${BACKGROUND}"/>` +
  `<g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${artwork}</g></svg>`;

const render = (markup, size) =>
  new Resvg(markup, { fitTo: { mode: 'width', value: size } }).render().asPng();

/** A Windows .ico holding PNG payloads — the format Chrome writes its shortcuts with. */
const ico = (sizes) => {
  const payloads = sizes.map((size) => render(tileOnly(), size));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(payloads.length, 4);
  let offset = 6 + 16 * payloads.length;
  const entries = payloads.map((data, index) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(sizes[index], 0);
    entry.writeUInt8(sizes[index], 1);
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...payloads]);
};

mkdirSync(iconsDir, { recursive: true });

const targets = [
  ['icons/icon-16.png', render(tileOnly(), 16)],
  ['icons/icon-32.png', render(tileOnly(), 32)],
  ['icons/icon-192.png', render(tileOnly(), 192)],
  ['icons/icon-512.png', render(tileOnly(), 512)],
  ['icons/icon-maskable-192.png', render(tileOnBackground(MASKABLE_SCALE), 192)],
  ['icons/icon-maskable-512.png', render(tileOnBackground(MASKABLE_SCALE), 512)],
  ['icons/apple-touch-icon.png', render(tileOnBackground(APPLE_SCALE), 180)],
  ['favicon.ico', ico([16, 32, 48])],
];

for (const [relative, data] of targets) {
  writeFileSync(join(publicDir, relative), data);
  console.log(`wrote public/${relative} (${data.length} bytes)`);
}
