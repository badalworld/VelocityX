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
 * Default: 60 requests / minute per IP (burst 20) — generous for a human
 * dashboard, far below anything that could disturb the exchange budget.
 */
export function rateLimit(opts: { perMinute?: number; burst?: number } = {}) {
  const perMinute = opts.perMinute ?? 60;
  const burst = opts.burst ?? 20;
  const buckets = new Map<string, Bucket>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local').split(',')[0].trim();
    const now = Date.now();
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
