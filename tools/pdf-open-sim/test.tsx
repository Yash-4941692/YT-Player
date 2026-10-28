import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://focusframe.test/',
  pretendToBeVisual: true,
});
const { window } = dom;
for (const key of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'HTMLCanvasElement', 'Element', 'Node', 'SVGElement', 'DOMParser', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? window : (window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 });
Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({}) });
(window.HTMLElement.prototype as any).scrollTo = function ({ top }: { top: number }) { this.scrollTop = top; };

class ResizeObserverStub { observe() {} disconnect() {} }
const intersectionObservers: IntersectionObserverStub[] = [];
class IntersectionObserverStub {
  callback: (entries: any[]) => void;
  stopped = false;
  constructor(callback: (entries: any[]) => void) { this.callback = callback; intersectionObservers.push(this); }
  observe(element: HTMLElement) {
    if (element.dataset.page !== '1') return;
    queueMicrotask(() => { if (!this.stopped) this.callback([{ target: element, isIntersecting: true }]); });
  }
  disconnect() { this.stopped = true; }
}
(globalThis as any).ResizeObserver = window.ResizeObserver = ResizeObserverStub as any;
(globalThis as any).IntersectionObserver = window.IntersectionObserver = IntersectionObserverStub as any;
// A regression to FileReader/data URLs must fail immediately, regardless of file size or device speed.
class ForbiddenFileReader { constructor() { throw new Error('Lesson PDFs must not be base64-encoded'); } }
(globalThis as any).FileReader = window.FileReader = ForbiddenFileReader as any;
let objectSequence = 0;
const objectUrls = new Map<string, File>();
const revoked: string[] = [];
const createObjectURL = (file: File) => {
  const url = `blob:focusframe-test/${++objectSequence}`;
  objectUrls.set(url, file);
  return url;
};
const revokeObjectURL = (url: string) => { revoked.push(url); objectUrls.delete(url); };
URL.createObjectURL = window.URL.createObjectURL = createObjectURL as any;
URL.revokeObjectURL = window.URL.revokeObjectURL = revokeObjectURL;

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { default: App } = await import('../../src/App');

const user = { id: 'user-1', email: 'student@example.test' };
const videoId = 'dQw4w9WgXcQ';
function lesson(path?: string) {
  return {
    videoId, sourceKind: 'youtube', title: 'Physics lesson', channel: 'Teacher',
    thumbnail: 'https://example.test/thumb.jpg', chaptersRaw: '', currentTime: 0, duration: 0,
    subject: 'Physics', updatedAt: Date.now(),
    ...(path ? { pdfPath: path, pdfName: 'notes.pdf', pdfSize: 1234 } : {}),
  };
}
function state(record: ReturnType<typeof lesson>, signedIn = true) {
  return {
    user: signedIn ? { ...user } : null,
    videos: signedIn ? [{ ...record }] : [],
    pdfs: [] as any[], trash: {} as Record<string, number>, ledgerPdfs: {} as Record<string, any>,
    signs: [] as any[], uploads: [] as any[], deletedPaths: [] as string[],
    events: [] as string[], documents: [] as string[], destroyed: [] as string[], renders: [] as string[],
    pageCount: 3, player: null as any,
  };
}
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
async function waitFor(predicate: () => boolean, message: string) {
  for (let i = 0; i < 40 && !predicate(); i += 1) await flush();
  assert.ok(predicate(), message);
}
async function click(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  assert.ok(element, `missing element: ${selector}`);
  await act(async () => { element.click(); });
  await flush();
}
async function focus() {
  await act(async () => { window.dispatchEvent(new window.Event('focus')); });
  await flush();
}
async function chooseFile(file: File) {
  const input = document.querySelector<HTMLInputElement>('.app-shell > input[type="file"]');
  assert.ok(input, 'lesson PDF input is present');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await flush();
}
async function mount(sim: ReturnType<typeof state>, record: ReturnType<typeof lesson>) {
  (globalThis as any).__pdfOpenSim = sim;
  window.localStorage.clear();
  window.localStorage.setItem('focusframe.jee.v1', JSON.stringify({ videos: [record] }));
  const root = createRoot(document.getElementById('root')!);
  await act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(App))); });
  await flush();
  await click('.library-resume-button');
  await waitFor(() => Boolean(sim.player), 'study room opens');
  return root;
}
async function unmount(root: ReturnType<typeof createRoot>) {
  await act(async () => { root.unmount(); });
  await flush();
}
function pdfFile(name: string) { return new window.File(['%PDF-1.7 test'], name, { type: 'application/pdf' }); }
function visibleUrl() { return document.querySelector('[aria-label="Open notes in a new tab"]')?.getAttribute('href') ?? ''; }

// A slow signing request must not be restarted by player metadata or ordinary account refreshes.
{
  const path = 'user-1/library/first.pdf';
  const record = lesson(path);
  const sim = state(record);
  sim.pdfs = [{ id: 'library-1', name: 'notes.pdf', subject: 'Physics', size: 1234, storagePath: path, createdAt: 1, updatedAt: 1 }];
  const root = await mount(sim, record);
  await waitFor(() => sim.signs.length === 1, 'one signed URL is requested');
  await waitFor(() => sim.events.includes('pdfjs-imported'), 'PDF.js loads while the signed URL is still pending');
  assert.equal(sim.documents.length, 0, 'no document starts until the URL is available');
  await act(async () => { sim.player.onVideoChange({ videoId, title: 'Physics lesson', channel: 'Teacher' }); });
  await focus();
  await focus();
  assert.equal(sim.signs.length, 1, 'metadata and unrelated library refreshes do not restart signing');
  await act(async () => { sim.signs[0].resolve('https://files.test/first'); });
  await waitFor(() => sim.renders.length > 0, 'first page renders');
  assert.deepEqual(sim.documents, ['https://files.test/first']);
  assert.equal(document.querySelectorAll('.pdf-annotation-layer').length, 1, 'offscreen pages do not create editors on open');
  const observer = [...intersectionObservers].reverse().find((entry) => !entry.stopped)!;
  const secondPage = document.querySelector<HTMLElement>('.pdf-page[data-page="2"]')!;
  await act(async () => { observer.callback([{ target: secondPage, isIntersecting: true }]); });
  await flush();
  const secondOverlay = secondPage.querySelector('.pdf-annotation-layer');
  assert.ok(secondOverlay, 'an editor is created when a later page becomes visible');
  await act(async () => { observer.callback([{ target: secondPage, isIntersecting: false }]); });
  assert.equal(secondPage.querySelector('.pdf-annotation-layer'), secondOverlay, 'visited editors stay mounted so unfinished notes survive scrolling');
  const canvas = document.querySelector('.pdf-page canvas');
  const scroll = document.querySelector<HTMLDivElement>('.study-panel .pdf-scroll')!;
  scroll.scrollTop = 250;
  await focus();
  assert.equal(sim.signs.length, 1, 'refreshing a loaded PDF does not re-sign it');
  assert.equal(sim.documents.length, 1, 'refreshing a loaded PDF does not parse it again');
  sim.videos = [{ ...sim.videos[0], pdfName: 'renamed.pdf', updatedAt: Date.now() + 10000 }];
  await focus();
  assert.match(document.querySelector('.pdf-toolbar-name')?.textContent ?? '', /renamed\.pdf/, 'metadata still updates');
  assert.equal(sim.signs.length, 1, 'a rename does not reopen the same file');
  assert.equal(sim.documents.length, 1);
  await click('[role="tab"]:nth-child(2)');
  assert.equal(document.querySelector('.pdf-viewer')?.hasAttribute('hidden'), true);
  await click('[role="tab"]:first-child');
  assert.equal(document.querySelector('.pdf-page canvas'), canvas, 'switching tabs keeps the existing canvas');
  assert.equal(scroll.scrollTop, 250, 'switching tabs keeps the reading position');
  assert.equal(sim.documents.length, 1, 'switching tabs does not reopen the PDF');

  // Moving the linked library file to trash must still close it; restoring must open it again.
  sim.trash = { 'library-1': Date.now() + 1000 };
  await focus();
  await waitFor(() => sim.destroyed.includes('https://files.test/first'), 'trashing the attached PDF closes it');
  assert.equal(visibleUrl(), '');
  sim.trash = {};
  sim.ledgerPdfs = { 'library-1': { status: 'active', at: Date.now() + 2000 } };
  await focus();
  await waitFor(() => sim.signs.length === 2, 'restoring the PDF requests a new link');
  await act(async () => { sim.signs[1].resolve('https://files.test/restored'); });
  await waitFor(() => sim.documents.includes('https://files.test/restored'), 'restored PDF opens');
  await unmount(root);
  console.log('✓ slow cloud opening, background refresh, tab switching, trash and restore');
}

// Uploads open from the original File before the cloud responds, without a second parse on success.
{
  const record = lesson();
  const sim = state(record);
  const root = await mount(sim, record);
  const first = pdfFile('first.pdf');
  await chooseFile(first);
  await waitFor(() => sim.uploads.length === 1 && sim.documents.length === 1, 'local preview opens while upload is pending');
  const firstUrl = sim.documents[0];
  assert.equal(objectUrls.get(firstUrl), first, 'the original File backs the object URL');
  assert.equal(sim.signs.length, 0, 'preview does not wait for a cloud link');
  assert.equal(sim.uploads[0].file, first);
  await focus();
  assert.equal(sim.documents.length, 1, 'background sync does not restart the local preview');
  await act(async () => { sim.uploads[0].resolve('user-1/lesson/first.pdf'); });
  await flush();
  assert.equal(sim.documents.length, 1, 'successful upload does not reload the local preview');
  assert.equal(visibleUrl(), firstUrl);
  assert.equal(objectUrls.get(firstUrl), first);
  assert.equal(sim.videos.find((item: any) => item.videoId === videoId)?.pdfPath, 'user-1/lesson/first.pdf');

  const second = pdfFile('second.pdf');
  const third = pdfFile('third.pdf');
  await chooseFile(second);
  await chooseFile(third);
  await waitFor(() => sim.uploads.length === 3 && sim.documents.length === 3, 'replacements each open immediately');
  const thirdUrl = sim.documents[2];
  assert.ok(revoked.includes(firstUrl), 'the old object URL is revoked on replacement');
  await act(async () => { sim.uploads[1].resolve('user-1/lesson/obsolete.pdf'); });
  await flush();
  assert.equal(visibleUrl(), thirdUrl, 'an older upload cannot replace the newer file');
  assert.ok(sim.deletedPaths.includes('user-1/lesson/obsolete.pdf'), 'obsolete cloud uploads are cleaned up');
  await act(async () => { sim.uploads[2].resolve('user-1/lesson/third.pdf'); });
  await flush();
  assert.equal(visibleUrl(), thirdUrl, 'the winning upload retains its local preview');
  assert.equal(sim.documents.length, 3);
  assert.ok(sim.deletedPaths.includes('user-1/lesson/first.pdf'), 'the replaced lesson file is cleaned up');

  // A remote replacement must invalidate the local cached File instead of hiding the new PDF.
  sim.videos = [{ ...sim.videos.find((item: any) => item.videoId === videoId), pdfPath: 'user-1/lesson/remote.pdf', pdfName: 'remote.pdf', updatedAt: Date.now() + 10000 }];
  await focus();
  await waitFor(() => sim.signs.length === 1, 'remote replacement requests its own signed URL');
  assert.ok(revoked.includes(thirdUrl), 'remote replacement releases the old local URL');
  await act(async () => { sim.signs[0].resolve('https://files.test/remote'); });
  await waitFor(() => sim.documents.includes('https://files.test/remote'), 'remote replacement opens');

  // Removing while an upload is pending must not let the completed upload resurrect it.
  const fourth = pdfFile('fourth.pdf');
  await chooseFile(fourth);
  await waitFor(() => sim.uploads.length === 4, 'fourth upload starts');
  await click('[aria-label="Remove notes"]');
  assert.equal(visibleUrl(), '', 'removal is immediate');
  await act(async () => { sim.uploads[3].resolve('user-1/lesson/removed.pdf'); });
  await flush();
  assert.equal(visibleUrl(), '', 'a late upload cannot restore a removed PDF');
  assert.ok(sim.deletedPaths.includes('user-1/lesson/removed.pdf'));
  await unmount(root);
  console.log('✓ immediate uploads, no post-upload reload, replacement, remote update and removal races');
}

// Failure stays readable in this tab; guest uploads never need the cloud or browser storage.
{
  const record = lesson();
  const sim = state(record);
  const root = await mount(sim, record);
  await chooseFile(pdfFile('offline.pdf'));
  const localUrl = sim.documents[0];
  await act(async () => { sim.uploads[0].reject(new Error('offline')); });
  await flush();
  assert.equal(visibleUrl(), localUrl);
  assert.match(document.querySelector('.pdf-error')?.textContent ?? '', /Cloud upload failed/);
  await unmount(root);

  const guest = state(record, false);
  const guestRoot = await mount(guest, record);
  const file = pdfFile('guest.pdf');
  await chooseFile(file);
  await waitFor(() => guest.documents.length === 1, 'guest PDF opens');
  assert.equal(objectUrls.get(guest.documents[0]), file);
  assert.equal(guest.uploads.length, 0);
  assert.ok(!window.localStorage.getItem('focusframe.jee.v1')?.includes('%PDF'), 'PDF bytes are not written to localStorage');
  const oversized = pdfFile('large.pdf');
  Object.defineProperty(oversized, 'size', { value: 100 * 1024 * 1024 + 1 });
  await chooseFile(oversized);
  assert.equal(guest.documents.length, 1, 'oversized PDFs are rejected without replacing the current document');
  assert.match(document.querySelector('.pdf-error')?.textContent ?? '', /larger than 100 MB/);
  await act(async () => { guest.player.onVideoChange({ videoId: '9bZkp7q19f0', title: 'Other lesson', channel: 'Teacher' }); });
  await act(async () => { guest.player.onVideoChange({ videoId, title: 'Physics lesson', channel: 'Teacher' }); });
  await waitFor(() => guest.documents.length === 2, 'guest file remains available when returning to the lesson');
  assert.equal(objectUrls.get(guest.documents[1]), file);
  await unmount(guestRoot);
  console.log('✓ failed upload, guest file privacy and size validation');
}

// Saved files are released after leaving a lesson; a pending upload can finish off-screen.
{
  const record = lesson();
  const sim = state(record);
  const root = await mount(sim, record);
  await chooseFile(pdfFile('saved.pdf'));
  const savedLocalUrl = sim.documents[0];
  await act(async () => { sim.uploads[0].resolve('user-1/lesson/saved.pdf'); });
  await flush();
  await act(async () => { sim.player.onVideoChange({ videoId: '9bZkp7q19f0', title: 'Other lesson', channel: 'Teacher' }); });
  await flush();
  assert.ok(revoked.includes(savedLocalUrl), 'leaving the lesson releases its object URL');
  await act(async () => { sim.player.onVideoChange({ videoId, title: 'Physics lesson', channel: 'Teacher' }); });
  await waitFor(() => sim.signs.length === 1, 'returning to a saved lesson uses its cloud copy');
  await act(async () => { sim.signs[0].resolve('https://files.test/saved'); });
  await waitFor(() => sim.documents.includes('https://files.test/saved'), 'saved cloud copy opens');

  await chooseFile(pdfFile('background.pdf'));
  await waitFor(() => sim.uploads.length === 2, 'background upload starts');
  await act(async () => { sim.player.onVideoChange({ videoId: '9bZkp7q19f0', title: 'Other lesson', channel: 'Teacher' }); });
  await act(async () => { sim.uploads[1].resolve('user-1/lesson/background.pdf'); });
  await flush();
  assert.equal(sim.videos.find((item: any) => item.videoId === videoId)?.pdfPath, 'user-1/lesson/background.pdf');
  await act(async () => { sim.player.onVideoChange({ videoId, title: 'Physics lesson', channel: 'Teacher' }); });
  await waitFor(() => sim.signs.length === 2, 'off-screen upload is released and reopens from cloud');
  assert.equal(sim.signs[1].path, 'user-1/lesson/background.pdf');
  await unmount(root);
  console.log('✓ saved file memory is released on navigation, including off-screen uploads');
}

// Long PDFs should not create hundreds of annotation editors before the first page is read.
{
  const record = lesson();
  const sim = state(record, false);
  sim.pageCount = 750;
  const root = await mount(sim, record);
  await chooseFile(pdfFile('long.pdf'));
  await waitFor(() => document.querySelectorAll('.pdf-page').length === 750, 'all page placeholders exist');
  assert.equal(document.querySelectorAll('.pdf-annotation-layer').length, 1, 'only the near-viewport editor mounts initially');
  const observer = [...intersectionObservers].reverse().find((entry) => !entry.stopped)!;
  const distant = document.querySelector<HTMLElement>('.pdf-page[data-page="500"]')!;
  await act(async () => { observer.callback([{ target: distant, isIntersecting: true }]); });
  assert.ok(distant.querySelector('.pdf-annotation-layer'), 'jumping to a distant page mounts its editor');
  assert.equal(document.querySelectorAll('.pdf-annotation-layer').length, 2);
  await unmount(root);
  console.log('✓ long PDFs create annotation editors only for visited pages');
}

// A link that resolves after switching lessons must never open in the wrong lesson.
{
  const first = lesson('user-1/lesson/a.pdf');
  const second = { ...lesson('user-1/lesson/b.pdf'), videoId: '9bZkp7q19f0', title: 'Second lesson' };
  const sim = state(first);
  sim.videos.push(second);
  const root = await mount(sim, first);
  await waitFor(() => sim.signs.length === 1, 'first link requested');
  await act(async () => { sim.player.onVideoChange({ videoId: second.videoId, title: second.title, channel: 'Teacher' }); });
  await waitFor(() => sim.signs.length === 2, 'second lesson requests its own link');
  await act(async () => { sim.signs[0].resolve('https://files.test/stale'); });
  await flush();
  assert.equal(sim.documents.length, 0, 'late link from the previous lesson is ignored');
  await act(async () => { sim.signs[1].resolve('https://files.test/current'); });
  await waitFor(() => sim.documents.includes('https://files.test/current'), 'current lesson opens');
  await unmount(root);
  console.log('✓ stale signed URLs cannot cross lesson boundaries');
}

// Cached files must not shadow remote removals or stay visible after signing out.
for (const change of ['remote removal', 'sign-out']) {
  const record = lesson();
  const sim = state(record);
  const root = await mount(sim, record);
  await chooseFile(pdfFile('cached.pdf'));
  const localUrl = sim.documents[0];
  await act(async () => { sim.uploads[0].resolve('user-1/lesson/cached.pdf'); });
  await flush();
  if (change === 'remote removal') {
    sim.videos = [{ ...sim.videos[0], pdfPath: undefined, pdfName: undefined, pdfSize: undefined, updatedAt: Date.now() + 10000 }];
    await focus();
    await waitFor(() => visibleUrl() === '', 'remote removal closes the local preview');
  } else {
    await click('.sign-out-button');
    await waitFor(() => Boolean(document.querySelector('.pdf-empty-state')?.textContent?.includes('Private cloud notes')), 'signed-out notes are locked');
    assert.equal(visibleUrl(), '');
  }
  assert.ok(revoked.includes(localUrl), `${change} revokes the local file URL`);
  await unmount(root);
}
console.log('✓ remote removal and sign-out invalidate cached files');

window.close();
console.log('All lesson PDF opening checks passed.');
