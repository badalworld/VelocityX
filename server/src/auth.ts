/**
 * HTTP/WS hardening for the trading API.
 *
 *  • `VX_API_TOKEN` (optional) turns on token auth for the whole API + the
 *    WebSocket hub. Recommended whenever the dashboard is reachable from a
 *    network (VPS, tunnel, sandbox preview). Without it the API is open — the
 *    server logs a loud warning in that case, because this API can place real
 *    orders, change the trading mode and hold exchange API keys.
 *  • Mutating endpoints are rate limited per IP so a stuck client or a
 *    malicious page cannot hammer the kill switch / settings endpoints (and
 *    through them the exchange order budget).
 */
import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export function apiToken(): string {
  return (process.env.VX_API_TOKEN || '').trim();
}

export function authRequired(): boolean {
  return apiToken().length > 0;
}

/** Address the server listens on (VX_HOST — default: every interface). */
export function bindHost(): string {
  return (process.env.VX_HOST || '0.0.0.0').trim();
}

/** True when only this machine can reach the API. */
export function loopbackOnly(): boolean {
  const h = bindHost().toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h);
}

/**
 * Real-money execution must never sit behind an open, network-reachable control
 * API: whoever could reach it could change leverage and size, arm auto-trade or
 * swap the exchange keys. LIVE needs VX_API_TOKEN (or a loopback-only bind).
 */
export function liveControlProtected(): boolean {
  return authRequired() || loopbackOnly();
}

export const LIVE_CONTROL_MESSAGE =
  'LIVE execution requires VX_API_TOKEN to be set (the control API is otherwise open to anyone who can reach this port) — set it in the server environment and restart';

/** Constant-time comparison so the token cannot be probed byte by byte. */
export function tokenMatches(provided: unknown): boolean {
  const expected = apiToken();
  if (!expected) return true;
  const got = typeof provided === 'string' ? provided : '';
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Token from the `X-VX-Token` header or a `?token=` query parameter. */
export function requestToken(req: Request): string {
  const header = req.headers['x-vx-token'];
  if (typeof header === 'string' && header) return header;
  const q = req.query?.token;
  return typeof q === 'string' ? q : '';
}

/** Express guard: 401 unless the request carries the configured token. */
export function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!authRequired()) return next();
  if (tokenMatches(requestToken(req))) return next();
  res.status(401).json({ error: 'Unauthorised — set the API token in the dashboard settings (VX_API_TOKEN)' });
}

interface Bucket { tokens: number; at: number }

/**
 * Simple token-bucket limiter for state-changing requests.
 * Default: 60 requests / minute per connection address (burst 20) — generous
 * for a human dashboard, far below anything that could disturb the exchange
 * budget. The key is the socket address, never a client-supplied header
 * (X-Forwarded-For can be forged to mint a fresh bucket per request).
 */
export function rateLimit(opts: { perMinute?: number; burst?: number } = {}) {
  const perMinute = opts.perMinute ?? 60;
  const burst = opts.burst ?? 20;
  const buckets = new Map<string, Bucket>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.socket.remoteAddress || 'local';
    const now = Date.now();
    // Bound the map: drop buckets that have fully refilled (idle clients).
    if (buckets.size > 2000) {
      for (const [k, v] of buckets) if (now - v.at > 120_000) buckets.delete(k);
    }
    const b = buckets.get(ip) ?? { tokens: burst, at: now };
    // refill
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    if (b.tokens < 1) {
      buckets.set(ip, b);
      res.status(429).json({ error: 'Too many requests — slow down' });
      return;
    }
    b.tokens -= 1;
    buckets.set(ip, b);
    next();
  };
}
