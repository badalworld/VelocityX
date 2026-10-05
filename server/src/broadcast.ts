/**
 * WebSocket hub pushing live updates to the browser UI.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

export function initBroadcast(server: HttpServer): void {
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    ws.on('message', (raw) => {
      // allow client pings
      try {
        const m = JSON.parse(String(raw));
        if (m?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch { /* ignore */ }
    });
    ws.send(JSON.stringify({ type: 'hello', t: Date.now() }));
  });
  setInterval(() => {
    for (const c of clients) {
      if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'ping', t: Date.now() }));
    }
  }, 25000);
}

export interface LogEntry { t: number; level: string; msg: string }
const logRing: LogEntry[] = [];

export function getLogs(limit = 80): LogEntry[] {
  return logRing.slice(-limit);
}

export function emit(type: string, data: unknown): void {
  if (type === 'log') {
    const d = data as any;
    logRing.push({ t: d?.t || Date.now(), level: d?.level || 'info', msg: d?.msg || '' });
    if (logRing.length > 300) logRing.shift();
  }
  if (!wss) return;
  const msg = JSON.stringify({ type, data, t: Date.now() });
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) {
      try {
        c.send(msg);
      } catch { /* ignore */ }
    }
  }
}

export function clientCount(): number {
  return clients.size;
}
