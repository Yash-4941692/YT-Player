// Guards the installed-app icon: Chrome silently falls back to a text placeholder when the
// manifest is missing, unparseable, or points at an icon that is not there or is the wrong
// size. This reads what actually ships and fails the build if any of it is off.
//
//   npm run check:app-icon
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');

const failures = [];
const fail = (message) => failures.push(message);

/** Reads the size out of a PNG header — no image library needed. */
const pngSize = (data) => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!data.subarray(0, 8).equals(signature)) throw new Error('not a PNG');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), bitDepth: data[24], colourType: data[25] };
};

/** Decodes an 8-bit RGB/RGBA PNG into a flat pixel buffer, enough to inspect alpha. */
const pngPixels = (data) => {
  const { width, height, bitDepth, colourType } = pngSize(data);
  if (bitDepth !== 8 || (colourType !== 6 && colourType !== 2)) {
    throw new Error(`unsupported PNG (bit depth ${bitDepth}, colour type ${colourType})`);
  }
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(collectIdat(data));
  const out = Buffer.alloc(height * stride);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[at];
    at += 1;
    const line = raw.subarray(at, at + stride);
    at += stride;
    const current = out.subarray(y * stride, (y + 1) * stride);
    const previous = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= channels ? previous[x - channels] : 0;
      const value = line[x];
      let decoded;
      if (filter === 0) decoded = value;
      else if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + up;
      else if (filter === 3) decoded = value + ((left + up) >> 1);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        decoded = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else throw new Error(`unknown PNG filter ${filter}`);
      current[x] = decoded & 0xff;
    }
  }
  return { width, height, channels, pixels: out };
};

/** Concatenates the IDAT chunks of a PNG. */
const collectIdat = (data) => {
  const parts = [];
  let at = 8;
  while (at < data.length) {
    const length = data.readUInt32BE(at);
    const type = data.toString('ascii', at + 4, at + 8);
    const body = data.subarray(at + 8, at + 8 + length);
    if (type === 'IDAT') parts.push(body);
    if (type === 'IEND') break;
    at += 12 + length;
  }
  return Buffer.concat(parts);
};

const read = (relative) => {
  try {
    return readFileSync(join(publicDir, relative));
  } catch {
    fail(`${relative} is missing`);
    return null;
  }
};

/* ------------------------------------------------------------------ manifest */

const manifestText = read('manifest.webmanifest');
let manifest = null;
if (manifestText) {
  try {
    manifest = JSON.parse(manifestText.toString('utf8'));
  } catch (error) {
    fail(`manifest.webmanifest is not valid JSON: ${error.message}`);
  }
}

if (manifest) {
  for (const field of ['name', 'short_name', 'start_url', 'display', 'background_color', 'theme_color']) {
    if (!manifest[field]) fail(`manifest.webmanifest has no ${field}`);
  }
  if (manifest.display && !['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display)) {
    fail(`manifest.webmanifest display "${manifest.display}" installs as a tab, not an app`);
  }
  if (manifest.start_url && manifest.scope && !manifest.start_url.startsWith(manifest.scope)) {
    fail('manifest.webmanifest start_url sits outside its own scope');
  }
  if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
    fail('manifest.webmanifest lists no icons — Chrome would install with a placeholder');
  }

  /** Chrome needs a raster icon of at least this size to draw the installed app's icon. */
  const wanted = [192, 512];
  const pngIcons = (manifest.icons ?? []).filter((icon) => icon.type === 'image/png');

  for (const size of wanted) {
    const matches = pngIcons.filter((icon) => icon.sizes === `${size}x${size}`);
    if (matches.length === 0) fail(`manifest.webmanifest has no ${size}x${size} PNG icon`);
    if (!matches.some((icon) => (icon.purpose ?? 'any').includes('any'))) {
      fail(`manifest.webmanifest has no ${size}x${size} icon usable as "any"`);
    }
    if (!matches.some((icon) => (icon.purpose ?? '').includes('maskable'))) {
      fail(`manifest.webmanifest has no ${size}x${size} maskable icon`);
    }
  }

  /* ------------------------------------------------------------- every icon */

  for (const icon of manifest.icons ?? []) {
    if (!icon.src?.startsWith('/')) {
      fail(`icon ${JSON.stringify(icon)} has a src that is not an absolute path`);
      continue;
    }
    const purpose = icon.purpose ?? 'any';
    if (!purpose.split(/\s+/).every((p) => ['any', 'maskable', 'monochrome'].includes(p))) {
      fail(`${icon.src} has an unknown purpose "${purpose}"`);
    }
    const data = read(icon.src.slice(1));
    if (!data) continue;

    if (icon.type === 'image/svg+xml') {
      if (!data.toString('utf8').includes('<svg')) fail(`${icon.src} is not an SVG`);
      continue;
    }
    if (icon.type !== 'image/png') {
      fail(`${icon.src} is ${icon.type}; Chrome on Windows needs PNG`);
      continue;
    }

    let image;
    try {
      image = pngPixels(data);
    } catch (error) {
      fail(`${icon.src} could not be read as a PNG: ${error.message}`);
      continue;
    }

    const [declaredWidth, declaredHeight] = String(icon.sizes).split('x').map(Number);
    if (image.width !== declaredWidth || image.height !== declaredHeight) {
      fail(`${icon.src} is ${image.width}x${image.height} but the manifest says ${icon.sizes}`);
    }
    if (image.width !== image.height) fail(`${icon.src} is not square`);

    const alpha = (x, y) =>
      image.channels === 4 ? image.pixels[(y * image.width + x) * 4 + 3] : 255;
    const edge = [];
    for (let i = 0; i < image.width; i += 1) {
      edge.push(alpha(i, 0), alpha(i, image.height - 1), alpha(0, i), alpha(image.width - 1, i));
    }
    const fullBleed = edge.every((value) => value === 255);

    if (purpose.includes('maskable') && !fullBleed) {
      fail(`${icon.src} is marked maskable but has transparent edges — it would be clipped`);
    }
    if (purpose === 'any' && alpha(0, 0) !== 0) {
      // The plain icons are the rounded tile with nothing behind it, so the app icon keeps the
      // shape you see in the tab.
      fail(`${icon.src} should be the rounded tile on a transparent background`);
    }
  }
}

/* --------------------------------------------------------------- .ico + head */

const ico = read('favicon.ico');
if (ico) {
  if (ico.readUInt16LE(2) !== 1) fail('favicon.ico is not an icon file');
  const count = ico.readUInt16LE(4);
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    const size = ico[entry] || 256;
    const offset = ico.readUInt32LE(entry + 12);
    const length = ico.readUInt32LE(entry + 8);
    const payload = ico.subarray(offset, offset + length);
    let embedded;
    try {
      embedded = pngSize(payload);
    } catch {
      fail(`favicon.ico entry ${i} is not a PNG payload`);
      continue;
    }
    if (embedded.width !== size) fail(`favicon.ico entry ${i} holds a ${embedded.width}px image, not ${size}px`);
  }
}

const html = readFileSync(join(root, 'index.html'), 'utf8');
for (const [needle, what] of [
  ['rel="manifest"', 'a link to the web app manifest'],
  ['rel="apple-touch-icon"', 'an apple-touch-icon link'],
  ['/favicon.svg', 'the SVG tab icon'],
]) {
  if (!html.includes(needle)) fail(`index.html is missing ${what}`);
}
const manifestHref = html.match(/rel="manifest"[^>]*href="([^"]+)"/)?.[1];
if (manifestHref && manifestHref !== '/manifest.webmanifest') {
  fail(`index.html points the manifest at ${manifestHref}, not /manifest.webmanifest`);
}

/* -------------------------------------------------------------------- report */

if (failures.length) {
  console.error('The installed-app icon is not right:');
  for (const message of failures) console.error(`  ✗ ${message}`);
  console.error('\nFix the artwork with `npm run build:app-icons` (see tools/app-icons/generate.mjs).');
  process.exit(1);
}

const icons = (manifest?.icons ?? []).map((icon) => `${icon.src} ${icon.sizes}${icon.purpose ? ` (${icon.purpose})` : ''}`);
console.log('Installed-app icon checks passed.');
console.log(`  name: ${manifest.name} / ${manifest.short_name}`);
console.log(`  window: ${manifest.display}, start_url ${manifest.start_url}, scope ${manifest.scope}`);
console.log(`  colours: theme ${manifest.theme_color}, background ${manifest.background_color}`);
console.log(`  icons: ${icons.join(', ')}`);
