import { getApiToken } from './api';
export interface WsEvent { type: string; data: any; t: number }

type Listener = (e: WsEvent) => void;

const listeners = new Set<Listener>();
let ws: WebSocket | null = null;
let backoff = 1000;
let closedByUs = false;

function connect(): void {
  if (closedByUs) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // The server requires the same token as the REST API when VX_API_TOKEN is set.
  const token = getApiToken();
  const url = `${proto}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  try {
    ws = new WebSocket(url);
  } catch {
    setTimeout(connect, backoff);
    return;
  }
  ws.onopen = () => {
    backoff = 1000;
    listeners.forEach((l) => l({ type: '_open', data: null, t: Date.now() }));
  };
  ws.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data);
      if (e.type === 'ping') {
        ws?.send(JSON.stringify({ type: 'ping' }));
        return;
      }
      listeners.forEach((l) => l(e as WsEvent));
    } catch { /* ignore */ }
  };
  ws.onclose = () => {
    listeners.forEach((l) => l({ type: '_close', data: null, t: Date.now() }));
    if (!closedByUs) {
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10000);
    }
  };
  ws.onerror = () => {
    try { ws?.close(); } catch { /* ignore */ }
  };
}

/** Re-open the socket (used after the API token changes). */
export function reconnect(): void {
  closedByUs = false;
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
  connect();
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  if (!ws) connect();
  return () => listeners.delete(l);
}
