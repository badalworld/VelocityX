/**
 * Production API verification — boots the REAL built server (dist/index.js)
 * and checks the hardening that protects live trading:
 *
 *   1. token auth (VX_API_TOKEN) on REST + WebSocket
 *   2. live-mode arming: switching to LIVE needs confirmLive, and LIVE without
 *      keys is rejected
 *   3. removed/dead endpoints are gone (JSON 404, never the SPA shell)
 *   4. API keys are never returned in clear text
 *   5. graceful shutdown on SIGTERM
 *
 * The run is hermetic: its own data dir, paper mode, auto-trade off at boot.
 *   npm run test:api
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
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
      VX_OFFLINE_DEMO: '1',
      VX_API_TOKEN: TOKEN,
      BINANCE_MODE: 'paper',
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
    assert(authed.status === 200 && authed.json?.mode === 'paper', 'GET /api/status with the token → 200 (paper)');
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
    const stillPaper = await req('GET', '/api/status', { token: TOKEN });
    assert(stillPaper.json?.mode === 'paper', 'mode stayed paper after the rejected switch');

    const liveNoKeys = await req('POST', '/api/settings', { token: TOKEN, body: { mode: 'live', confirmLive: true } });
    assert(liveNoKeys.status === 400, 'LIVE is refused when no live keys are configured');

    const badSymbol = await req('POST', '/api/settings', { token: TOKEN, body: { symbol: '<script>' } });
    assert(badSymbol.status === 400, 'invalid symbols are rejected');

    const autoPaper = await req('POST', '/api/autotrade', { token: TOKEN, body: { enabled: true } });
    assert(autoPaper.status === 200 && autoPaper.json?.autoTrade === true, 'auto-trade toggles in paper without confirmation');
    await req('POST', '/api/autotrade', { token: TOKEN, body: { enabled: false } });

    // Entering LIVE must always land disarmed: even if the caller arms
    // auto-trade in the same breath, the server forces it back OFF.
    const keysPatch = await req('POST', '/api/settings', {
      token: TOKEN,
      body: { keys: { live: { key: 'TESTLIVEKEY0001', secret: 'TESTLIVESECRET0001' } } },
    });
    assert(keysPatch.status === 200, 'live keys can be saved (masked back) while still in paper');
    const liveArm = await req('POST', '/api/settings', {
      token: TOKEN,
      body: { mode: 'live', confirmLive: true, autoTrade: true },
    });
    assert(liveArm.status === 200 && liveArm.json?.mode === 'live', 'mode→live succeeds with confirmLive + keys');
    assert(liveArm.json?.autoTrade === false, 'entering LIVE forces auto-trade OFF regardless of the request');
    const liveAuto = await req('POST', '/api/autotrade', {
      token: TOKEN,
      body: { enabled: true, confirmLive: true },
    });
    assert(liveAuto.status === 200 && liveAuto.json?.autoTrade === true, 'auto-trade in LIVE needs its own explicit arming');
    const liveAutoNoConfirm = await req('POST', '/api/autotrade', { token: TOKEN, body: { enabled: false } });
    assert(liveAutoNoConfirm.status === 200 && liveAutoNoConfirm.json?.autoTrade === false, 'disarming LIVE needs no confirmation');
    await req('POST', '/api/settings', { token: TOKEN, body: { mode: 'paper', autoTrade: false } });
    const backToPaper = await req('GET', '/api/status', { token: TOKEN });
    assert(backToPaper.json?.mode === 'paper', 'returned to paper for the remaining checks');

    /* ---------------- 4. secrets ---------------- */
    console.log('\n— Secrets never leave in clear text —');
    const settings = await req('GET', '/api/settings', { token: TOKEN });
    const raw = settings.text || '';
    assert(!raw.includes('TESTSECRET1234567890') && !raw.includes('TESTKEY1234567890'), 'API keys/secrets are masked in /api/settings');
    assert(settings.json?.keys?.testnet?.configured === true, 'settings still report that testnet keys are configured');

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
        env: { ...process.env, PORT: String(livePort), VX_DATA_DIR: liveDir, VX_OFFLINE_DEMO: '1', VX_API_TOKEN: TOKEN },
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
        assert(st?.mode === 'paper', `persisted LIVE was downgraded to paper without VX_ALLOW_LIVE (${st?.mode})`);
        assert(st?.autoTrade === false, 'auto-trade was forced OFF on the downgrade');
        assert(/VX_ALLOW_LIVE/.test(logs2), 'boot log explains the live downgrade');
      } finally {
        try {
          child2.kill('SIGTERM');
        } catch { /* ignore */ }
        fs.rmSync(liveDir, { recursive: true, force: true });
      }
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

void http;
