// Lightweight PDF.js stand-in. Tests exercise the real PdfViewer lifecycle and canvas queue.
const sim = () => (globalThis as any).__pdfOpenSim;
sim().events.push('pdfjs-imported');
export const GlobalWorkerOptions = { workerSrc: '' };
export class TextLayer {
  constructor(_options: unknown) {}
  render() { return Promise.resolve(); }
  cancel() {}
}
export function getDocument({ url }: { url: string }) {
  sim().documents.push(url);
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, scale }),
    render: () => {
      sim().renders.push(url);
      return { promise: Promise.resolve(), cancel() {} };
    },
    streamTextContent: () => ({}),
  };
  return {
    promise: Promise.resolve({ numPages: sim().pageCount, getPage: async () => page }),
    destroy: async () => { sim().destroyed.push(url); },
  };
}
