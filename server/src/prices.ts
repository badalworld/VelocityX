/**
 * Last market price per symbol.
 *
 * A tiny leaf module (no imports) so every part of the server can read the
 * freshest price the feed produced without importing the trader (which would
 * create a dependency cycle with the account/PnL layer). Written by the market
 * stream and the offline demo feed, read by the executor, the account service
 * and the dashboard.
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
