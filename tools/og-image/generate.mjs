// Regenerates public/og-image.png — the 1200×630 card that WhatsApp, X, LinkedIn,
// Slack and Google Discover show when the site is shared.
//
//   npm install --no-save @resvg/resvg-js
//   node tools/og-image/generate.mjs
//
// The PNG is committed, so a normal `npm ci` never needs resvg. The three typefaces
// the app already uses (Manrope, DM Sans, DM Mono) are committed as small latin
// subsets in tools/og-image/fonts, because resvg cannot read the woff2 files the
// Google Fonts stylesheet serves. They are SIL Open Font License 1.1 — see
// tools/og-image/fonts/OFL.txt.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const fontsDir = join(here, 'fonts');

const WIDTH = 1200;
const HEIGHT = 630;

/** Family names as they are recorded inside the subset files, so resvg needs no guessing. */
const DISPLAY = 'Manrope ExtraBold';
const DISPLAY_BOLD = 'Manrope';
const DISPLAY_SEMI = 'Manrope SemiBold';
const BODY = 'DM Sans';
const BODY_MEDIUM = 'DM Sans Medium';
const MONO = 'DM Mono';

/** Stand-in for the in-app notes panel: page bars, one highlighted line, a mint trace. */
const notesPanel = (x, y) => {
  const bars = Array.from({ length: 9 }, (_, index) => {
    const width = [232, 250, 214, 244, 196, 250, 226, 240, 172][index];
    const top = y + 28 + index * 30;
    const highlighted = index === 4;
    return highlighted
      ? `<rect x="${x + 22}" y="${top - 7}" width="${width}" height="30" rx="6" fill="#ffd193" fill-opacity="0.28"/>`
      : `<rect x="${x + 22}" y="${top}" width="${width}" height="9" rx="4.5" fill="#ffffff" fill-opacity="${index % 3 === 2 ? 0.1 : 0.16}"/>`;
  }).join('');

  return `<g>
    <rect x="${x}" y="${y}" width="300" height="368" rx="20" fill="#0f1018" stroke="#ffffff" stroke-opacity="0.1"/>
    <rect x="${x}" y="${y}" width="300" height="34" rx="20" fill="#ffffff" fill-opacity="0.03"/>
    <circle cx="${x + 22}" cy="${y + 17}" r="4" fill="#83e4c0" fill-opacity="0.8"/>
    <rect x="${x + 34}" y="${y + 13}" width="58" height="8" rx="4" fill="#ffffff" fill-opacity="0.18"/>
    ${bars}
    <polyline points="${x + 24},${y + 316} ${x + 66},${y + 288} ${x + 104},${y + 322} ${x + 142},${y + 296} ${x + 180},${y + 330} ${x + 218},${y + 286} ${x + 260},${y + 300}"
      fill="none" stroke="#83e4c0" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="${x + 24},${y + 340} ${x + 80},${y + 340}" stroke="#ffffff" stroke-opacity="0.12" stroke-width="3" stroke-linecap="round"/>
    <polyline points="${x + 24},${y + 352} ${x + 52},${y + 352}" stroke="#ffffff" stroke-opacity="0.08" stroke-width="3" stroke-linecap="round"/>
  </g>`;
};

/** The faint blueprint grid, faded out towards the bottom of the card. */
const grid = () => {
  const lines = [];
  for (let x = 0; x <= WIDTH; x += 66) {
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${HEIGHT}" />`);
  }
  for (let y = 0; y <= HEIGHT; y += 66) {
    const fade = Math.max(0, 1 - y / 560);
    lines.push(`<line x1="0" y1="${y}" x2="${WIDTH}" y2="${y}" opacity="${fade.toFixed(3)}" />`);
  }
  return `<g stroke="#b9b3de" stroke-opacity="0.09" stroke-width="1">${lines.join('')}</g>`;
};

const pill = (x, y, label, width) => `<g>
    <rect x="${x}" y="${y}" width="${width}" height="46" rx="12" fill="#ffffff" fill-opacity="0.05" stroke="#ffffff" stroke-opacity="0.1"/>
    <text x="${x + width / 2}" y="${y + 30}" text-anchor="middle" font-family="${BODY_MEDIUM}" font-size="19" fill="#dedbe9">${label}</text>
  </g>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="0%" r="70%">
      <stop offset="0%" stop-color="#3b316b" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#08090f" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="mint" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#a4f2cf"/>
      <stop offset="100%" stop-color="#7bdab9"/>
    </linearGradient>
    <linearGradient id="underline" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#b9a1ff"/>
      <stop offset="100%" stop-color="#83e4c0"/>
    </linearGradient>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="#08090f"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>
  ${grid()}

  <!-- brand -->
  <g>
    <rect x="72" y="62" width="46" height="46" rx="14" fill="url(#mint)"/>
    <path d="M91 78 L91 92 L103 85 Z" fill="#0b1012"/>
    <text x="132" y="96" font-family="${DISPLAY}" font-size="34" letter-spacing="-1.6" fill="#f1f0f7">focusframe<tspan fill="#83e4c0">.</tspan></text>
    <text x="133" y="122" font-family="${MONO}" font-size="12" letter-spacing="2.4" fill="#888797">STUDY PLAYER</text>
  </g>

  <!-- headline -->
  <text x="70" y="268" font-family="${DISPLAY}" font-size="62" letter-spacing="-2.6" fill="#f1f0f7">Your study videos,</text>
  <text x="70" y="342" font-family="${DISPLAY}" font-size="62" letter-spacing="-2.6" fill="#f1f0f7">with your <tspan fill="#bba1ff">notes open.</tspan></text>
  <rect x="72" y="366" width="120" height="4" rx="2" fill="url(#underline)" opacity="0.85"/>

  <!-- promise -->
  <text x="72" y="420" font-family="${BODY}" font-size="21" fill="#a2a0af">Watch the lesson, follow the timestamps, and read your PDF notes</text>
  <text x="72" y="450" font-family="${BODY}" font-size="21" fill="#a2a0af">right beside the video — ad-free, on any device.</text>

  ${pill(72, 486, 'YouTube &amp; direct links', 246)}
  ${pill(332, 486, 'PDF notes', 132)}
  ${pill(478, 486, 'Highlight &amp; annotate', 236)}

  ${notesPanel(828, 132)}

  <!-- maker credit -->
  <g>
    <circle cx="94" cy="576" r="18" fill="#bba1ff" fill-opacity="0.16" stroke="#bba1ff" stroke-opacity="0.4"/>
    <text x="94" y="582" text-anchor="middle" font-family="${DISPLAY_SEMI}" font-size="14" fill="#d5c9ff">YS</text>
    <text x="124" y="572" font-family="${BODY_MEDIUM}" font-size="17" fill="#e6e4ef">Built by Yash Sharma</text>
    <text x="124" y="592" font-family="${MONO}" font-size="12" fill="#777582">github.com/Yash-4941692</text>
  </g>
</svg>`;

const fontFiles = [
  join(fontsDir, 'manrope-800.ttf'),
  join(fontsDir, 'manrope-700.ttf'),
  join(fontsDir, 'manrope-600.ttf'),
  join(fontsDir, 'dm-sans-400.ttf'),
  join(fontsDir, 'dm-sans-500.ttf'),
  join(fontsDir, 'dm-mono-400.ttf'),
];

// Fail loudly if a face is missing instead of silently drawing a fallback font.
for (const file of fontFiles) readFileSync(file);

const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: WIDTH },
  font: { fontFiles, loadSystemFonts: false, defaultFontFamily: BODY },
});

const png = resvg.render().asPng();
const out = join(root, 'public/og-image.png');
writeFileSync(out, png);
console.log(`Wrote ${out} (${WIDTH}×${HEIGHT}, ${(png.length / 1024).toFixed(0)} KB)`);
