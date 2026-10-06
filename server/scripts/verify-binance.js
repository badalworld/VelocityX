// Optional live connectivity check. Uses public read-only Binance endpoints only.
const { api } = require('../dist/binance');

(async () => {
  const ping = await api.ping();
  if (!ping.ok) {
    console.error(`Binance public REST unavailable: ${ping.error || 'unknown error'}`);
    process.exit(1);
  }
  const candles = await api.klines('BTCUSDT', '5m', 3, 0);
  console.log(`Binance public REST OK — ${ping.latencyMs} ms, ${candles.length} BTCUSDT candles.`);
  console.log('This check performs no signed account reads and submits no orders.');
})().catch((error) => {
  console.error(`Read-only Binance verification failed: ${error?.message || error}`);
  process.exit(1);
});
