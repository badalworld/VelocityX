/**
 * Production API verification — boots the REAL built server (dist/index.js)
 * and checks the hardening that protects live trading:
 *
 *   1. token auth (VX_API_TOKEN) on REST + WebSocket
 *   2. live-mode arming: switching to LIVE needs confirmLive, LIVE without keys
 *      is rejected, entering LIVE always lands disarmed, and arming execution
 *      in LIVE needs its own confirmation
 *   3. removed/dead endpoints are gone (JSON 404, never the SPA shell)
 *   4. API keys are never returned in clear text
 *   5. graceful shutdown on SIGTERM
 *   6. restart safety: a persisted LIVE + auto-trade boots DISARMED without
 *      VX_ALLOW_LIVE (there is no simulated fallback)
 *   7. LIVE needs a protected control API: without VX_API_TOKEN (and without a
 *      loopback-only bind) real-money arming is refused at runtime and at boot
 *   8. open bot trades pin the environment: no mode switch while one is open,
 *      the kill switch disarms auto-trade, strict boolean switches
 *
 * The run is hermetic: its own data dir, testnet mode, auto-trade off at boot.
 *   npm run test:api
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const TOKEN = 'test-token-abcdef123456';
const PORT = 4500 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-api-'));

let failures = 0;
function assert(cond, name, extra) {
  if (cond) console.log(`ok   ${name}${extra ? ` — ${extra}` : ''}`);
  else {
    failures++;
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, pathname, { body, token, raw } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers['x-vx-token'] = token;
  const res = await fetch(BASE + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (raw) return { status: res.status, text };
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

async function waitForBoot(timeoutMs = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await req('GET', '/api/health');
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

/** Boot a throw-away server instance on its own data dir; resolves once /api/health answers. */
async function bootInstance({ port, env = {}, files = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-api-x-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      VX_DATA_DIR: dir,
      // hermetic: neutralise anything inherited from the caller's shell
      VX_API_TOKEN: '', VX_ALLOW_LIVE: '', VX_HOST: '', BINANCE_MODE: '',
      BINANCE_TESTNET_KEY: '', BINANCE_TESTNET_SECRET: '', BINANCE_LIVE_KEY: '', BINANCE_LIVE_SECRET: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += String(d)));
  child.stderr.on('data', (d) => (out += String(d)));
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, pathname, { body, token } = {}) => {
    const headers = {};
    if (body) headers['content-type'] = 'application/json';
    if (token) headers['x-vx-token'] = token;
    const res = await fetch(base + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  };
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 15_000 && !up) {
    try { up = (await call('GET', '/api/health')).status === 200; } catch { /* not up yet */ }
    if (!up) await sleep(250);
  }
  return {
    up,
    call,
    dir,
    logs: () => out,
    stop: () => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const KEYS = { testnet: { key: 'TK1234567890', secret: 'TS1234567890' }, live: { key: 'LK1234567890', secret: 'LS1234567890' } };
const OPEN_TRADE = (mode) => ({
  id: 'zz' + mode.slice(0, 4) + '01', symbol: 'BTCUSDT', side: 'LONG', status: 'OPEN', qty: 0.01, q1: 0.003, q2: 0.003, q3: 0.004,
  entryPrice: 68000, atrAtEntry: 100, slInitial: 67800, slCurrent: 67800, slStage: 0, tp1: 68300, tp2: 68600, tp3: 68900,
  notional: 680, margin: 68, leverage: 10, openedAt: Date.now(), closedAt: null, closeReason: null,
  tp1Filled: false, tp2Filled: false, tp3Filled: false, realizedPnl: 0, fees: 0, funding: 0, binanceRealizedPnl: 0,
  commissionOtherAsset: 0, initialRisk: 2, orders: { entry: 'VXzz01E', sl: 'VXzz01S0', tp3: 'VXzz013' }, mode, result: null, botOwned: true,
});

function wsProbe(query) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${query}`);
    const done = (result) => {
      try {
        ws.close();
      } catch { /* ignore */ }
      resolve(result);
    };
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (m.type === 'hello') done('hello');
      } catch { /* ignore */ }
    });
    ws.on('unexpected-response', () => done('rejected'));
    ws.on('error', () => done('rejected'));
    setTimeout(() => done('timeout'), 4000);
  });
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      VX_DATA_DIR: DATA_DIR,
      VX_API_TOKEN: TOKEN,
      BINANCE_MODE: 'testnet',
      BINANCE_TESTNET_KEY: 'TESTKEY1234567890',
      BINANCE_TESTNET_SECRET: 'TESTSECRET1234567890',
      // deliberately NOT set: VX_ALLOW_LIVE
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => (logs += String(d)));
  child.stderr.on('data', (d) => (logs += String(d)));

  try {
    const up = await waitForBoot();
    if (!up) throw new Error(`server did not boot:\n${logs.slice(-2000)}`);
    assert(true, 'server boots and answers /api/health');

    /* ---------------- 1. auth ---------------- */
    console.log('\n— API token auth —');
    const health = await req('GET', '/api/health');
    assert(health.status === 200 && health.json?.ok === true, 'health is public (for supervisors)');
    assert(health.json?.authRequired === true, 'health advertises that a token is required');

    for (const p of ['/api/status', '/api/settings', '/api/positions', '/api/trades']) {
      const r = await req('GET', p);
      assert(r.status === 401, `GET ${p} without a token → 401`);
    }
    const authed = await req('GET', '/api/status', { token: TOKEN });
    assert(authed.status === 200 && authed.json?.mode === 'testnet', 'GET /api/status with the token → 200 (testnet)');
    const readiness = await req('GET', '/api/execution/readiness', { token: TOKEN });
    assert(readiness.status === 200 && ['READY', 'DISARMED', 'BLOCKED'].includes(readiness.json?.state), 'execution-readiness contract is available to the frontend');
    assert(typeof readiness.json?.checks?.engine === 'boolean' && Array.isArray(readiness.json?.reasons), 'readiness exposes server-enforced checks and reasons');
    assert(authed.json?.execution?.state === readiness.json?.state, 'status and readiness endpoint use the same execution contract');
    const badBacktestDays = await req('POST', '/api/backtest/run', { token: TOKEN, body: { symbol: 'BTCUSDT', days: 1.5 } });
    assert(badBacktestDays.status === 400, 'backtest rejects fractional/out-of-range history windows before fetching candles');
    const badBacktestRisk = await req('POST', '/api/backtest/run', { token: TOKEN, body: { riskPercent: 99 } });
    assert(badBacktestRisk.status === 400, 'backtest risk settings are bounded before simulation');
    const queryToken = await req('GET', `/api/status?token=${TOKEN}`);
    assert(queryToken.status === 200, 'token is also accepted as ?token= (WS/preview friendly)');

    console.log('\n— WebSocket auth —');
    assert((await wsProbe('')) === 'rejected', 'WS upgrade without a token is rejected');
    assert((await wsProbe(`?token=${TOKEN}`)) === 'hello', 'WS upgrade with the token receives hello');

    /* ---------------- 2. dead endpoints ---------------- */
    console.log('\n— Removed endpoints answer JSON 404 —');
    for (const p of ['/api/chart', '/api/screener', '/api/does-not-exist']) {
      const r = await req('GET', p, { token: TOKEN });
      assert(r.status === 404 && !!r.json?.error, `GET ${p} → JSON 404 (never the SPA shell)`);
    }

    /* ---------------- 3. live arming ---------------- */
    console.log('\n— Live-trading arming —');
    const noConfirm = await req('POST', '/api/settings', { token: TOKEN, body: { mode: 'live' } });
    assert(noConfirm.status === 400 && /confirmLive/i.test(noConfirm.json?.error || ''), 'mode→live without confirmLive is rejected');
    const stillTestnet = await req('GET', '/api/status', { token: TOKEN });
    assert(stillTestnet.json?.mode === 'testnet', 'mode stayed testnet after the rejected switch');

    const paperRejected = await req('POST', '/api/settings', { token: TOKEN, body: { mode: 'paper' } });
    assert(paperRejected.status === 400 && /testnet \| live/i.test(paperRejected.json?.error || ''), 'paper order-execution mode is rejected; only Binance Demo and LIVE are execution environments');

    const liveNoKeys = await req('POST', '/api/settings', { token: TOKEN, body: { mode: 'live', confirmLive: true } });
    assert(liveNoKeys.status === 400, 'LIVE is refused when no live keys are configured');

    const badSymbol = await req('POST', '/api/settings', { token: TOKEN, body: { symbol: '<script>' } });
    assert(badSymbol.status === 400, 'invalid symbols are rejected');

    const autoTestnet = await req('POST', '/api/autotrade', { token: TOKEN, body: { enabled: true } });
    assert(autoTestnet.status === 200 && autoTestnet.json?.autoTrade === true, 'auto-trade toggles on testnet without confirmation');
    await req('POST', '/api/autotrade', { token: TOKEN, body: { enabled: false } });

    console.log('\n— Strict switches and the kill switch —');
    const strSettings = await req('POST', '/api/settings', { token: TOKEN, body: { autoTrade: 'false' } });
    assert(strSettings.status === 400, 'settings reject a string autoTrade (the string "false" is truthy)');
    assert((await req('GET', '/api/status', { token: TOKEN })).json?.autoTrade === false, 'a rejected switch leaves auto-trade OFF');

    await req('POST', '/api/autotrade', { token: TOKEN, body: { enabled: true } });
    const killed = await req('POST', '/api/kill', { token: TOKEN });
    assert(killed.status === 200 && killed.json?.ok === true && killed.json?.attempted === 0, 'kill with nothing open succeeds');
    assert((await req('GET', '/api/status', { token: TOKEN })).json?.autoTrade === false, 'KILL disarms auto-trade (the next signal cannot re-enter)');

    // Entering LIVE must always land disarmed: even if the caller arms
    // auto-trade in the same breath, the server forces it back OFF.
    const keysPatch = await req('POST', '/api/settings', {
      token: TOKEN,
      body: { keys: { live: { key: 'TESTLIVEKEY0001', secret: 'TESTLIVESECRET0001' } } },
    });
    assert(keysPatch.status === 200, 'live keys can be saved (masked back) while still on testnet');
    const liveArm = await req('POST', '/api/settings', {
      token: TOKEN,
      body: { mode: 'live', confirmLive: true, autoTrade: true },
    });
    assert(liveArm.status === 200 && liveArm.json?.mode === 'live', 'mode→live succeeds with confirmLive + keys');
    assert(liveArm.json?.autoTrade === false, 'entering LIVE forces auto-trade OFF regardless of the request');
    assert(liveArm.json?.confirmLive === undefined, 'one-shot LIVE confirmation is never persisted or echoed');
    const settingsBypass = await req('POST', '/api/settings', { token: TOKEN, body: { autoTrade: true } });
    assert(settingsBypass.status === 400 && /confirmLive/i.test(settingsBypass.json?.error || ''), 'settings endpoint cannot bypass LIVE auto-trade confirmation');
    const liveAuto = await req('POST', '/api/autotrade', {
      token: TOKEN,
      body: { enabled: true, confirmLive: true },
    });
    assert(liveAuto.status === 200 && liveAuto.json?.autoTrade === true, 'auto-trade in LIVE needs its own explicit arming');
    const liveAutoNoConfirm = await req('POST', '/api/autotrade', { token: TOKEN, body: { enabled: false } });
    assert(liveAutoNoConfirm.status === 200 && liveAutoNoConfirm.json?.autoTrade === false, 'disarming LIVE needs no confirmation');
    const backToTestnet = await req('POST', '/api/settings', { token: TOKEN, body: { mode: 'testnet', autoTrade: false } });
    assert(backToTestnet.status === 200, 'switching back to testnet works');
    const statusNow = await req('GET', '/api/status', { token: TOKEN });
    assert(statusNow.json?.mode === 'testnet', 'returned to testnet for the remaining checks');

    /* ---------------- 4. secrets ---------------- */
    console.log('\n— Secrets never leave in clear text —');
    const settings = await req('GET', '/api/settings', { token: TOKEN });
    const raw = settings.text || '';
    assert(!raw.includes('TESTSECRET1234567890') && !raw.includes('TESTKEY1234567890'), 'API keys/secrets are masked in /api/settings');
    assert(settings.json?.keys?.testnet?.configured === true, 'settings still report that testnet keys are configured');
    assert(settings.json?.scanner?.candidates === 50, 'frontend settings contract defaults to a 50-asset scan batch');
    assert(settings.json?.scanner?.minOpportunityScore > 0 && settings.json?.scanner?.zoneRetentionMin > 0, 'opportunity quality and retention settings are exposed');

    /* ---------------- 5. graceful shutdown ---------------- */
    console.log('\n— Graceful shutdown —');
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.kill('SIGTERM');
    const result = await Promise.race([exited, sleep(8000).then(() => null)]);
    assert(!!result, 'process exits after SIGTERM (no dangling sockets/timers)');
    assert(/\[shutdown\]/.test(logs), 'shutdown path ran (protective stops stay armed on the exchange)');
    /* ---------------- 6. live-mode boot safety ---------------- */
    console.log('\n— Live mode is not resumed by a restart (VX_ALLOW_LIVE) —');
    {
      const livePort = PORT + 1;
      const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-api-live-'));
      fs.writeFileSync(
        path.join(liveDir, 'settings.json'),
        JSON.stringify({ mode: 'live', autoTrade: true, keys: { live: { key: 'LK1234567890', secret: 'LS1234567890' } } }),
      );
      const child2 = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(livePort), VX_DATA_DIR: liveDir, VX_API_TOKEN: TOKEN },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let logs2 = '';
      child2.stdout.on('data', (d) => (logs2 += String(d)));
      child2.stderr.on('data', (d) => (logs2 += String(d)));
      try {
        const base2 = `http://127.0.0.1:${livePort}`;
        const t0 = Date.now();
        let st = null;
        while (Date.now() - t0 < 15_000) {
          try {
            const r = await fetch(`${base2}/api/status`, { headers: { 'x-vx-token': TOKEN } });
            if (r.status === 200) {
              st = await r.json();
              break;
            }
          } catch { /* not up yet */ }
          await sleep(250);
        }
        assert(!!st, 'second instance booted with a persisted live config');
        assert(st?.mode === 'live', `persisted LIVE stays LIVE (no simulation fallback) (${st?.mode})`);
        assert(st?.autoTrade === false, 'auto-trade was forced OFF without VX_ALLOW_LIVE');
        assert(/VX_ALLOW_LIVE/.test(logs2), 'boot log explains why real execution was not resumed');
      } finally {
        try {
          child2.kill('SIGTERM');
        } catch { /* ignore */ }
        fs.rmSync(liveDir, { recursive: true, force: true });
      }
    }

    /* ---------------- 7. live needs a protected control API ---------------- */
    console.log('\n— LIVE needs VX_API_TOKEN (or a loopback-only bind) —');
    {
      const open = await bootInstance({ port: PORT + 2, files: { 'settings.json': { mode: 'testnet', keys: KEYS } } });
      try {
        assert(open.up, 'unauthenticated instance booted');
        const toLive = await open.call('POST', '/api/settings', { body: { mode: 'live', confirmLive: true } });
        assert(toLive.status === 200 && toLive.json?.mode === 'live' && toLive.json?.autoTrade === false, 'entering LIVE (disarmed) is allowed');
        const arm = await open.call('POST', '/api/autotrade', { body: { enabled: true, confirmLive: true } });
        assert(arm.status === 403 && /VX_API_TOKEN/.test(arm.json?.error || ''), 'arming LIVE without a token is refused');
        const armViaSettings = await open.call('POST', '/api/settings', { body: { autoTrade: true, confirmLive: true } });
        assert(armViaSettings.status === 403, 'the settings route cannot arm LIVE without a token either');
        const ready = await open.call('GET', '/api/execution/readiness');
        assert(ready.json?.checks?.liveControl === false && ready.json?.ready === false, 'the execution gate itself blocks LIVE without a token (defence in depth)');
        const back = await open.call('POST', '/api/settings', { body: { mode: 'testnet' } });
        assert(back.status === 200, 'back to testnet');
        const armTestnet = await open.call('POST', '/api/autotrade', { body: { enabled: true } });
        assert(armTestnet.status === 200 && armTestnet.json?.autoTrade === true, 'testnet arming is unaffected by the rule');
      } finally { open.stop(); }

      const loop = await bootInstance({ port: PORT + 3, env: { VX_HOST: '127.0.0.1' }, files: { 'settings.json': { mode: 'live', keys: KEYS } } });
      try {
        assert(loop.up, 'loopback-only instance booted');
        const arm = await loop.call('POST', '/api/autotrade', { body: { enabled: true, confirmLive: true } });
        assert(arm.status === 200 && arm.json?.autoTrade === true, 'LIVE may be armed when the API is reachable from this machine only');
      } finally { loop.stop(); }

      const bootOpen = await bootInstance({ port: PORT + 4, env: { VX_ALLOW_LIVE: '1' }, files: { 'settings.json': { mode: 'live', autoTrade: true, keys: KEYS } } });
      try {
        assert(bootOpen.up, 'instance with a persisted armed LIVE config booted (VX_ALLOW_LIVE=1, no token)');
        const st = await bootOpen.call('GET', '/api/status');
        assert(st.json?.mode === 'live' && st.json?.autoTrade === false, 'VX_ALLOW_LIVE alone is not enough: no token → booted DISARMED');
        assert(/VX_API_TOKEN/.test(bootOpen.logs()), 'the boot log says why');
      } finally { bootOpen.stop(); }

      const bootOk = await bootInstance({ port: PORT + 5, env: { VX_ALLOW_LIVE: '1', VX_API_TOKEN: TOKEN }, files: { 'settings.json': { mode: 'live', autoTrade: true, keys: KEYS } } });
      try {
        assert(bootOk.up, 'instance with VX_ALLOW_LIVE=1 and a token booted');
        const st = await bootOk.call('GET', '/api/status', { token: TOKEN });
        assert(st.json?.mode === 'live' && st.json?.autoTrade === true, 'VX_ALLOW_LIVE=1 + VX_API_TOKEN resumes the armed LIVE config (positive control)');
      } finally { bootOk.stop(); }
    }

    /* ---------------- 8. open trades pin the environment ---------------- */
    console.log('\n— An open bot trade pins its environment —');
    {
      const pinned = await bootInstance({
        port: PORT + 6,
        env: { VX_API_TOKEN: TOKEN },
        files: { 'settings.json': { mode: 'testnet', keys: KEYS }, 'trades.json': [OPEN_TRADE('testnet')] },
      });
      try {
        assert(pinned.up, 'instance with one open testnet trade booted');
        const sw = await pinned.call('POST', '/api/settings', { token: TOKEN, body: { mode: 'live', confirmLive: true } });
        assert(sw.status === 409 && /still open/.test(sw.json?.error || ''), 'mode switch is refused while a bot position is open');
        assert((await pinned.call('GET', '/api/status', { token: TOKEN })).json?.mode === 'testnet', 'the mode did not change');
        const other = await pinned.call('POST', '/api/settings', { token: TOKEN, body: { leverage: 5 } });
        assert(other.status === 200, 'other settings can still be changed');
        for (const bad of ['true', 'false', 1, 0, null, undefined]) {
          const r = await pinned.call('POST', '/api/autotrade', { token: TOKEN, body: { enabled: bad } });
          assert(r.status === 400, `/api/autotrade rejects enabled=${JSON.stringify(bad)} (only a real boolean is accepted)`);
        }
        assert((await pinned.call('GET', '/api/status', { token: TOKEN })).json?.autoTrade === false, 'rejected switches leave auto-trade OFF');
        await pinned.call('POST', '/api/autotrade', { token: TOKEN, body: { enabled: true } });
        const kill = await pinned.call('POST', '/api/kill', { token: TOKEN });
        assert(kill.status === 502 && kill.json?.ok === false, 'an unconfirmed close is reported as a failure (never as success)');
        assert((await pinned.call('GET', '/api/status', { token: TOKEN })).json?.autoTrade === false, 'the kill switch disarmed auto-trade even though the close was not confirmed');
        assert((await pinned.call('GET', '/api/status', { token: TOKEN })).json?.openTrades?.length === 1, 'the unconfirmed trade stays OPEN and managed');
      } finally { pinned.stop(); }

      // Hand-edited / legacy settings must not arm the bot or erase operator keys.
      const odd = await bootInstance({
        port: PORT + 8,
        env: { VX_API_TOKEN: TOKEN, BINANCE_TESTNET_KEY: 'ENVKEY-AAAA1111', BINANCE_TESTNET_SECRET: 'ENVSECRET-BBBB2222' },
        files: { 'settings.json': { mode: 'testnet', autoTrade: 'false', keys: { testnet: { key: '', secret: '' }, live: { key: '', secret: '' } } } },
      });
      try {
        assert(odd.up, 'instance with a hand-edited settings file booted');
        const st = await odd.call('GET', '/api/status', { token: TOKEN });
        assert(st.json?.autoTrade === false, 'a string autoTrade in the settings file never arms the bot');
        assert(st.json?.keysConfigured?.testnet === true, 'empty keys in the settings file do not erase keys supplied by the environment');
        await odd.call('POST', '/api/settings', { token: TOKEN, body: { leverage: 7 } });
        const onDisk = fs.readFileSync(path.join(odd.dir, 'settings.json'), 'utf8');
        assert(!onDisk.includes('ENVKEY-AAAA1111') && !onDisk.includes('ENVSECRET-BBBB2222'), 'environment-supplied keys are never copied into settings.json');
        assert(JSON.parse(onDisk).leverage === 7, 'other settings are persisted as usual');
        await odd.call('POST', '/api/settings', { token: TOKEN, body: { keys: { testnet: { key: 'DASHKEY-CCCC3333', secret: 'DASHSECRET-DDDD4444' } } } });
        assert(fs.readFileSync(path.join(odd.dir, 'settings.json'), 'utf8').includes('DASHKEY-CCCC3333'), 'keys typed into the dashboard are persisted');
        const proto = await odd.call('POST', '/api/settings', { token: TOKEN, body: JSON.parse('{"__proto__": {"polluted": true}, "leverage": 6}') });
        assert(proto.status === 200 && JSON.parse((await odd.call('GET', '/api/settings', { token: TOKEN })).text).leverage === 6, 'a __proto__ key in a settings patch is skipped harmlessly while the rest of the patch applies');
      } finally { odd.stop(); }

      const foreign = await bootInstance({
        port: PORT + 7,
        env: { VX_API_TOKEN: TOKEN },
        files: { 'settings.json': { mode: 'testnet', keys: KEYS }, 'trades.json': [OPEN_TRADE('live')] },
      });
      try {
        assert(foreign.up, 'instance with an open LIVE trade running in testnet booted');
        assert(/NOT monitored/.test(foreign.logs()) && /BTCUSDT\(live\)/.test(foreign.logs()), 'the boot log warns about the trade of the other environment');
      } finally { foreign.stop(); }
    }
  } catch (e) {
    failures++;
    console.log(`FAIL crashed: ${e?.message || e}`);
  } finally {
    try {
      child.kill('SIGKILL');
    } catch { /* ignore */ }
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  console.log(failures === 0 ? '\nAPI HARDENING: ALL CHECKS PASSED' : `\nAPI HARDENING: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();

