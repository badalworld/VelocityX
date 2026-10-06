/**
 * Last market price per symbol.
 *
 * A tiny leaf module so every part of the read-only server can use the latest
 * market price without a dependency on exchange sockets.
 */

const prices = new Map<string, number>();

export function setPrice(symbol: string, price: number): void {
  if (!symbol || !Number.isFinite(price) || price <= 0) return;
  prices.set(symbol.toUpperCase(), price);
}

/** Latest price for a symbol (0 when the feed has never printed one). */
export function priceOf(symbol: string): number {
  return prices.get(String(symbol).toUpperCase()) ?? 0;
}
