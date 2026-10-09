/**
 * Import this BEFORE anything that imports `src/lib/supabase`.
 *
 * CI runs Node 20, which has no global WebSocket, and supabase-js refuses to build a client
 * without one ("Node.js detected but native WebSocket not found"). A real browser always has
 * one, and the reader treats live updates as optional — it re-reads the account copy whenever
 * it opens and whenever the tab regains focus — so the simulated devices get a socket that
 * reports a failed connection instead of the sync being untestable.
 *
 * `SIM_NO_WEBSOCKET=1` reproduces the same situation on a newer Node, where a global WebSocket
 * does exist.
 */
if (process.env.SIM_NO_WEBSOCKET === '1') {
  delete (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
}

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
      setTimeout(() => {
        this.onerror?.({ type: 'error', target: this });
        this.onclose?.({ type: 'close', target: this });
      }, 0);
    }
    send(): void {}
    close(): void {}
  }
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = UnavailableWebSocket;
}

export {};
