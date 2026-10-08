/**
 * One simulated browser. Started as its own process so each device gets its own
 * localStorage, its own in-memory caches and (optionally) its own clock, exactly like a
 * real second device.
 *
 * Env:
 *   SIM_MODE=read|draw|draw-second|read-after-focus   what this device should do
 *   SIM_USER=<uuid>            signed-in user id
 *   SIM_PDF=<uuid>             library PDF id (library scope) …
 *   SIM_LESSON=<videoId>       … or the YouTube video id of a lesson PDF (lesson scope)
 *   SIM_CLOCK_OFFSET_MS=0      pretend this device's clock is off by this much
 *   SIM_SETTLE_MS=2600         how long to wait for the sync round trip
 *   SIM_API=http://127.0.0.1:8787
 *   SIM_PROFILE=<file>         keep this device's localStorage between runs (a real device
 *                              keeps its cached copies, which is where stale data shows up)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const mode = process.env.SIM_MODE || 'read';
const device = process.env.SIM_DEVICE || 'A';
const user = process.env.SIM_USER || '11111111-1111-4111-8111-111111111111';
const pdfId = process.env.SIM_PDF || '22222222-2222-4222-8222-222222222222';
const lessonId = process.env.SIM_LESSON || '';
const clockOffset = Number(process.env.SIM_CLOCK_OFFSET_MS || 0);
const settleMs = Number(process.env.SIM_SETTLE_MS || 2600);
const api = process.env.SIM_API || 'http://127.0.0.1:8787';

const profileFile = process.env.SIM_PROFILE || '';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://focusframe.test/',
  pretendToBeVisual: true,
});

if (profileFile && existsSync(profileFile)) {
  const saved = JSON.parse(readFileSync(profileFile, 'utf8'));
  for (const [key, value] of Object.entries(saved)) dom.window.localStorage.setItem(key, String(value));
}

const { window } = dom;
for (const key of [
  'window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Element', 'Node',
  'SVGElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'DOMParser',
]) {
  const value = key === 'window' ? window : window[key];
  if (value === undefined) continue;
  const bound = typeof value === 'function' && key.startsWith('request') ? value.bind(window) : value;
  try {
    Object.defineProperty(globalThis, key, { value: bound, writable: true, configurable: true });
  } catch {
    // Some Node versions expose a few of these as read-only getters; the DOM copy wins anyway.
  }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The browser always has a WebSocket; Node 20 (which CI runs) does not, and the reader treats
 * live updates as optional (it re-reads the account copy on focus). Give the simulated device a
 * socket that reports a failed connection instead of throwing, so the sync itself is still
 * exercised. `SIM_NO_WEBSOCKET=1` reproduces the same situation on a newer Node.
 */
if (process.env.SIM_NO_WEBSOCKET === '1') delete (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
if (typeof globalThis.WebSocket !== 'function') {
  class UnavailableWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 3;
    url = '';
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    constructor(url: string | URL) {
      super();
      this.url = String(url);
      window.setTimeout(() => {
        this.onerror?.({ type: 'error', target: this });
        this.onclose?.({ type: 'close', target: this });
      }, 0);
    }
    send(): void {}
    close(): void {}
  }
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = UnavailableWebSocket;
}

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}
globalThis.ResizeObserver = NoopObserver;
window.ResizeObserver = NoopObserver;
globalThis.IntersectionObserver = NoopObserver;
window.IntersectionObserver = NoopObserver;

/**
 * A device whose clock does not agree with the other device's clock. Both `Date.now()` and
 * `new Date()` have to move, because the app reads wall-clock time both ways.
 */
if (clockOffset) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      // @ts-expect-error -- mirroring the real Date constructor's overloads
      if (args.length === 0) super(realNow() + clockOffset);
      // @ts-expect-error -- mirroring the real Date constructor's overloads
      else super(...args);
    }
    static now() { return realNow() + clockOffset; }
  }
  globalThis.Date = ShiftedDate as unknown as DateConstructor;
  dom.window.Date = ShiftedDate as unknown as DateConstructor;
}
globalThis.window.__SIM_CLOCK_OFFSET__ = clockOffset;

const realLog = console.log.bind(console);
const result = { mode, annotations: [], bridge: {}, cloud: null, requests: [] };

async function main() {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react-dom/test-utils');
  const { supabase } = await import('../../src/lib/supabase');
  const { usePdfAnnotationController } = await import('../../src/components/PdfLibraryViewer');

  if (!supabase) throw new Error('the simulated client was built without Supabase credentials');
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.${encode('sim-signature')}`;
  const session = await supabase.auth.setSession({ access_token: token, refresh_token: 'sim-refresh-token' });
  if (session.error) throw new Error(`could not seed the simulated session: ${JSON.stringify(session.error)}`);
  const current = await supabase.auth.getSession();
  if (current.data.session?.access_token !== token) {
    throw new Error(`session was not stored: ${JSON.stringify(current.data.session)?.slice(0, 120)}`);
  }
  // A direct probe makes a broken session obvious before the app logic runs.
  const probe = await supabase.from('pdf_annotations').select('pdf_id').limit(1);
  if (probe.error) throw new Error(`the simulated session cannot read the table: ${JSON.stringify(probe.error)}`);
  await new Promise((resolve) => setTimeout(resolve, 120));

  let bridge;
  const annotateStatusRef = { current: '' };
  function Harness() {
    const controller = usePdfAnnotationController({
      cacheKey: lessonId ? `lesson:${lessonId}` : pdfId,
      libraryPdfId: lessonId ? null : pdfId,
      lessonVideoId: lessonId || null,
      isGuest: false,
      userId: user,
      shortcutsEnabled: false,
    });
    bridge = controller.bridge;
    annotateStatusRef.current = controller.annotateStatus;
    return React.createElement('div', null, String(controller.bridge.annotations.length));
  }

  const container = window.document.getElementById('root');
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Harness)); });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const flush = async (ms = 40) => { await act(async () => { await sleep(ms); }); };

  await flush(settleMs);

  if (mode === 'read-then-draw' || mode === 'draw' || mode === 'draw-second') {
    const offsetX = mode === 'draw-second' ? 0.6 : mode === 'read-then-draw' ? 0.4 : 0.1;
    await act(async () => {
      bridge.onAdd({
        id: `sim-${device}-${mode}`,
        type: 'pen',
        page: 1,
        color: 'red',
        points: [offsetX, 0.1, offsetX + 0.1, 0.2],
        width: 3,
      });
    });
    await flush(settleMs);
  }

  if (mode === 'read-after-focus') {
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'));
      await sleep(settleMs);
    });
  }

  result.annotations = bridge.annotations.map((annotation: { id: string }) => annotation.id);
  result.bridge = {
    dirty: bridge.dirty,
    saving: bridge.saving,
    savedAt: bridge.savedAt ?? null,
    annotations: bridge.annotations.length,
    status: annotateStatusRef.current,
  };
  result.cloud = await (await fetch(`${api}/__state`)).json();
  result.requests = (await (await fetch(`${api}/__log`)).json()).map((entry) => `${entry.method} ${entry.path} → ${entry.status}`);
  realLog(`RESULT ${JSON.stringify(result)}`);

  if (profileFile) {
    const dump: Record<string, string> = {};
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key) dump[key] = window.localStorage.getItem(key) ?? '';
    }
    writeFileSync(profileFile, JSON.stringify(dump, null, 2));
  }

  await act(async () => { root.unmount(); });
  await sleep(60);
  process.exit(0);
}

main().catch((error) => {
  realLog(`RESULT ${JSON.stringify({ ...result, error: String(error && error.stack || error) })}`);
  process.exit(1);
});
