/** HTTP and WebSocket authentication for the dashboard API. */
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
  const query = req.query?.token;
  return typeof query === 'string' ? query : '';
}

/** Express guard: 401 unless the request carries the configured token. */
export function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!authRequired() || tokenMatches(requestToken(req))) return next();
  res.status(401).json({ error: 'Unauthorised — enter the dashboard API token (VX_API_TOKEN).' });
}

interface Bucket { tokens: number; at: number }

/** Token-bucket limiter for settings changes and other HTTP mutations. */
export function rateLimit(opts: { perMinute?: number; burst?: number } = {}) {
  const perMinute = opts.perMinute ?? 60;
  const burst = opts.burst ?? 20;
  const buckets = new Map<string, Bucket>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.socket.remoteAddress || 'local';
    const now = Date.now();
    if (buckets.size > 2000) {
      for (const [key, bucket] of buckets) if (now - bucket.at > 120_000) buckets.delete(key);
    }
    const bucket = buckets.get(ip) ?? { tokens: burst, at: now };
    bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 60_000) * perMinute);
    bucket.at = now;
    if (bucket.tokens < 1) {
      buckets.set(ip, bucket);
      res.status(429).json({ error: 'Too many requests — slow down.' });
      return;
    }
    bucket.tokens -= 1;
    buckets.set(ip, bucket);
    next();
  };
}
