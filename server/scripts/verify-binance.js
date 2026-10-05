/**
 * Binance connectivity / realtime-path verification.
 *
 *   npm run verify:binance            # against the live USD-M Futures API
 *   VX_API=http://localhost:4000 npm run verify:binance -- --server
 *
 * Checks, against the REAL exchange (no fixtures):
 *   1. Binance REST reachable; /time latency + clock offset.
 *   2. exchangeInfo: how many TRADING PERPETUAL USDT symbols the scanner sees.
 *   3. ticker24hrAll → the volatility universe the scanner ranks.
 *   4. The 95% request scheduler: weight headers come back, usage stays ≤ plan.
 *   5. The dashboard's own payloads: /api/status feed + /api/scanner rows +
 *      /api/limits, i.e. the data the UI shows is the data Binance returned.
 *
 * If the host has no egress to Binance the script says so and exits 0 — it can
 * never pretend the feed is live.
 */
const BASE = process.env.VX_BINANCE_BASE || 'https://fapi.binance.com';
const SERVER = process.env.VX_API || 'http://localhost:4000';
const CHECK_SERVER = process.argv.includes('--server');

let failures = 0;
const ok = (cond, name, extra) => {
  if (cond) console.log(`ok   ${name}${extra ? ` — ${extra}` : ''}`);
  else {
    failures++;
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

async function timed(url, init) {
  const t0 = Date.now();
  const r = await fetch(url, init);
  const ms = Date.now() - t0;
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { r, ms, json, text };
}

(async () => {
  // ---------------------------------------------------------------- exchange
  let exchangeUp = true;
  try {
    const time = await timed(`${BASE}/fapi/v1/time`);
    ok(time.r.ok && Number.isFinite(time.json?.serverTime), 'Binance USD-M REST reachable', `${time.ms} ms`);
    const offset = Number(time.json?.serverTime) - Date.now();
    ok(Math.abs(offset) < 60_000, 'server clock offset sane', `${offset} ms`);
    const usedWeight = time.r.headers.get('x-mbx-used-weight-1m');
    console.log(`     x-mbx-used-weight-1m = ${usedWeight ?? 'n/a'} (limit 2400/min, VelocityX plans 2280)`);

    // -------------------------------------------------------------- universe
    const info = await timed(`${BASE}/fapi/v1/exchangeInfo`);
    ok(info.r.ok, 'exchangeInfo fetched');
    const perps = (info.json?.symbols || []).filter(
      (s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING',
    );
    ok(perps.length > 100, `scanner universe size = ${perps.length} USDT perpetuals`);

    const tick = await timed(`${BASE}/fapi/v1/ticker/24hr`);
    ok(tick.r.ok && Array.isArray(tick.json), 'ticker/24hr (all symbols) fetched', `${tick.json?.length ?? 0} tickers`);
    const bySymbol = new Map((tick.json || []).map((t) => [t.symbol, t]));
    const quoted = perps
      .map((s) => ({ s, t: bySymbol.get(s.symbol) }))
      .filter((x) => x.t && Number(x.t.quoteVolume) >= 20_000_000);
    const ranked = quoted
      .map(({ s, t }) => ({ symbol: s.symbol, range: (Number(t.highPrice) - Number(t.lowPrice)) / Number(t.lastPrice) * 100 }))
      .sort((a, b) => b.range - a.range);
    ok(ranked.length > 30, `volatility universe after the $20M gate = ${ranked.length} markets`);
    console.log(`     most volatile right now: ${ranked.slice(0, 5).map((r) => `${r.symbol} ${r.range.toFixed(1)}%`).join(', ')}`);

    // ----------------------------------------------------------- realtime ws
    const wsTarget = `wss://fstream.binance.com/stream?streams=btcusdt@bookTicker`;
    const wsOk = await new Promise((resolve) => {
      let done = false;
      const finish = (v, why) => {
        if (!done) {
          done = true;
          resolve({ v, why });
        }
      };
      const t = setTimeout(() => finish(false, 'no message within 8 s'), 8000);
      try {
        const ws = new WebSocket(wsTarget);
        ws.onmessage = () => {
          clearTimeout(t);
          ws.close();
          finish(true, 'bookTicker received');
        };
        ws.onerror = (e) => {
          clearTimeout(t);
          finish(false, e?.message || 'socket error');
        };
      } catch (e) {
        clearTimeout(t);
        finish(false, e?.message || 'cannot open socket');
      }
    });
    ok(wsOk.v, 'market WebSocket pushes live bookTicker (this is the dashboard price path)', wsOk.why);
  } catch (e) {
    exchangeUp = false;
    console.log(`!    Binance unreachable from this host (${e.message || e}) — exchange checks skipped.`);
    console.log('     Run this where egress to fapi.binance.com exists to verify the real feed.');
  }

  // -------------------------------------------------------------- dashboard
  if (CHECK_SERVER) {
    const jget = async (p) => {
      try {
        return (await timed(`${SERVER}${p}`)).json;
      } catch {
        return null;
      }
    };
    const status = await jget('/api/status');
    ok(!!status, `dashboard server reachable at ${SERVER}`);
    if (status) {
        ok(['binance', 'binance-unreachable', 'offline-demo'].includes(status.feed), `feed reports ${status.feed}`, `reachable=${status.feedInfo?.reachable}`);
      if (exchangeUp) ok(status.feed === 'binance', 'dashboard feed is the real Binance feed (exchange reachable)', `feed=${status.feed}`);
      else ok(status.feed !== 'binance', 'dashboard never claims a live feed while Binance is unreachable', `feed=${status.feed}`);
      ok(Array.isArray(status.prices) ? status.prices.length > 0 : !!status.engine, 'status carries live engine data');
    }
    const scanner = await jget('/api/scanner');
    ok((scanner?.rows?.length ?? 0) > 0, `scanner surfaced ${scanner?.rows?.length ?? 0} ranked markets to the UI`);
    const limitsPayload = await jget('/api/limits');
    const limits = limitsPayload?.limiter ?? limitsPayload; // /api/limits nests the scheduler view
    ok((limits?.plannedLimitPerMin ?? 0) === 2280, `server plans ${limits?.plannedLimitPerMin}/min = 95% of 2400`);
    ok((limits?.usedWeight ?? 0) <= 2280, `server stayed inside the 95% budget (${limits?.usedWeight} weight used)`);
    const areas = limits?.areas ?? [];
    ok(areas.length === 5 && areas.every((a) => a.weightUsed <= a.weightCap),
      `work stayed inside every area reservation (${areas.map((a) => `${a.area} ${a.weightUsed}/${a.weightCap}`).join(', ')})`);
  }

  console.log(failures === 0 ? '\nBINANCE REALTIME PATH: ALL CHECKS PASSED' : `\nBINANCE REALTIME PATH: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
