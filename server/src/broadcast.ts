/**
 * WebSocket hub pushing live updates to the browser UI.
 *
 * Production notes:
 *  • When `VX_API_TOKEN` is configured the upgrade request must carry the same
 *    token (`/ws?token=…`), so a network-reachable dashboard cannot be read by
 *    an unauthenticated client.
 *  • The hub is closed cleanly on shutdown (no dangling sockets blocking exit).
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';
import type { IncomingMessage } from 'http';
import { apiToken, tokenMatches } from './auth';

let wss: WebSocketServer | null = null;
let heartbeat: NodeJS.Timeout | null = null;
const clients = new Set<WebSocket>();

export function initBroadcast(server: HttpServer): void {
  wss = new WebSocketServer({ server, path: '/ws', verifyClient: (info: { req: IncomingMessage }) => wsAuthorised(info.req) });
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
  heartbeat = setInterval(() => {
    for (const c of clients) {
      if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'ping', t: Date.now() }));
    }
  }, 25000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
}

/** Token gate for the socket, mirroring the REST API rules. */
function wsAuthorised(req: IncomingMessage): boolean {
  const token = apiToken();
  if (!token) return true;
  try {
    const url = new URL(req.url || '/ws', 'http://localhost');
    const provided = url.searchParams.get('token') || req.headers['x-vx-token'];
    return tokenMatches(Array.isArray(provided) ? provided[0] : provided);
  } catch {
    return false;
  }
}

/** Close every socket and stop the heartbeat (graceful shutdown). */
export function closeBroadcast(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  for (const c of clients) {
    try {
      c.close(1001, 'server shutting down');
    } catch { /* ignore */ }
  }
  clients.clear();
  try {
    wss?.close();
  } catch { /* ignore */ }
  wss = null;
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
