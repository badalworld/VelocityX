import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavRow, Ticker, Topbar, ViewKey } from './components/Header';
import PnlDock from './components/PnlDock';
import Overview from './views/Overview';
import ScannerView from './views/ScannerView';
import PositionsView from './views/PositionsView';
import TradesView from './views/TradesView';
import SettingsView from './views/SettingsView';
import LiquidBackground from './motion/LiquidBackground';
import ErrorBoundary from './components/ErrorBoundary';
import { AnimatedNumber, Btn } from './motion/primitives';
import { IconAlert, IconCheck, IconInfo, IconWaves } from './motion/Icons';
import { apiGet, apiPost, fmt } from './api';
import { reconnect, subscribe } from './ws';
import { useGlassSheen, useLocalState, useMediaQuery, useReveal, useScrollProgress } from './hooks/motion';
import { usePnlModel } from './pnl';
import {
  AccountView, Mtf, PositionsPayload, ScanResult, Settings,
  SignalRecord, Stats, Status, Trade,
} from './types';

interface Toast {
  id: number;
  msg: string;
  type: 'info' | 'error' | 'win';
}

const VIEW_LABELS: Record<ViewKey, string> = {
  dash: 'Dashboard',
  scanner: 'Scanner',
  positions: 'Positions',
  trades: 'Trades',
  settings: 'Settings',
};

export default function App() {
  /* ---------------- data ---------------- */
  const [status, setStatus] = useState<Status | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [signals, setSignals] = useState<SignalRecord[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [mtf, setMtf] = useState<Mtf | null>(null);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [positions, setPositions] = useState<PositionsPayload | null>(null);
  const [scanning, setScanning] = useState(false);
  const [logs, setLogs] = useState<{ t: number; level: string; msg: string }[]>([]);
  const [wsUp, setWsUp] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(1);
  const lastPriceAt = useRef(0);

  /* ---------------- ui shell state ---------------- */
  const [view, setView] = useState<ViewKey>('dash');
  // A new preference key intentionally ignores the old motion-on default. The
  // dashboard now starts calm; motion can still be enabled explicitly.
  const [motionOn, setMotionOn] = useLocalState('vx.motion.v2', false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const isMobile = useMediaQuery('(max-width: 1080px)');
  const scrollProgress = useScrollProgress();

  useGlassSheen();
  useReveal(view);

  useEffect(() => {
    document.documentElement.dataset.motion = motionOn ? 'on' : 'off';
  }, [motionOn]);

  const toast = useCallback((msg: string, type: Toast['type'] = 'info') => {
    const id = toastId.current++;
    setToasts((t) => [...t, { id, msg, type }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  /* ---------------- loaders ---------------- */
  const applyAccount = useCallback((next: AccountView) => {
    setAccount((previous) => {
      // `/status` contains a compact account snapshot while `/account` contains
      // the complete one. Never let an older/partial poll erase newer fields —
      // that used to make equity and margin values visibly jump every few seconds.
      if (previous && (next.at ?? 0) < (previous.at ?? 0)) return previous;
      const merged: AccountView = previous
        ? {
            ...previous,
            ...next,
            bot: { ...previous.bot, ...next.bot },
            external: { ...previous.external, ...next.external },
            income: next.income ?? previous.income,
          }
        : next;
      return previous && JSON.stringify(previous) === JSON.stringify(merged) ? previous : merged;
    });
  }, []);

  const loadStatus = useCallback(async () => {
    const requestedAt = Date.now();
    try {
      const s = await apiGet<Status>('/status');
      setStatus((previous) => {
        if (previous && (s.now ?? 0) < (previous.now ?? 0)) return previous;
        if (!previous || lastPriceAt.current <= requestedAt) return s;

        // A price tick arrived while this HTTP request was in flight. Keep the
        // newer tick instead of briefly painting the older REST price.
        const liveById = new Map((previous.openTrades ?? []).map((trade) => [trade.id, trade]));
        return {
          ...s,
          price: previous.price,
          openTrades: (s.openTrades ?? []).map((trade) => {
            const live = liveById.get(trade.id);
            return live ? { ...trade, markPrice: live.markPrice, unrealized: live.unrealized } : trade;
          }),
        };
      });
      if (s.account) applyAccount(s.account);
      if (s.logs) {
        setLogs((previous) => {
          const byKey = new Map<string, { t: number; level: string; msg: string }>();
          for (const line of [...previous, ...s.logs]) {
            byKey.set(`${line.t}:${line.level}:${line.msg}`, line);
          }
          const merged = [...byKey.values()].sort((a, b) => a.t - b.t).slice(-300);
          return JSON.stringify(previous) === JSON.stringify(merged) ? previous : merged;
        });
      }
    } catch {
      /* server briefly unreachable */
    }
  }, [applyAccount]);

  const loadAccount = useCallback(async () => {
    try {
      applyAccount(await apiGet<AccountView>('/account'));
    } catch {
      /* keep the last good account snapshot */
    }
  }, [applyAccount]);

  const loadPositions = useCallback(async () => {
    try {
      const next = await apiGet<PositionsPayload>('/positions');
      setPositions((previous) => {
        if (previous && next.at < previous.at) return previous;
        return previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
      });
    } catch {
      /* keep the last good positions snapshot */
    }
  }, []);

  const loadScanner = useCallback(async () => {
    try {
      const next = await apiGet<ScanResult>('/scanner');
      setScan((previous) => {
        if (previous && next.at < previous.at) return previous;
        return previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
      });
    } catch {
      /* keep the last good scan */
    }
  }, []);

  const loadMtf = useCallback(async () => {
    try {
      const next = await apiGet<Mtf>('/mtf');
      setMtf((previous) =>
        previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    } catch {
      /* keep the last good multi-timeframe snapshot */
    }
  }, []);

  const loadTrades = useCallback(async () => {
    try {
      const next = await apiGet<Trade[]>('/trades');
      setTrades((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    } catch {
      /* keep the last good trade log */
    }
  }, []);

  const loadSignals = useCallback(async () => {
    try {
      const next = await apiGet<SignalRecord[]>('/signals');
      setSignals((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    } catch {
      /* keep the last good signal log */
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const next = await apiGet<Stats>('/stats');
      setStats((previous) =>
        previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    } catch {
      /* keep the last good statistics snapshot */
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadStatus(), loadAccount(), loadPositions(), loadTrades(), loadStats()]);
  }, [loadStatus, loadAccount, loadPositions, loadTrades, loadStats]);

  useEffect(() => {
    void apiGet<Settings>('/settings').then(setSettings).catch(() => {});
    void refreshAll();
    void loadSignals();
    void loadScanner();
    void loadMtf();

    const un = subscribe((e) => {
      if (e.type === '_open') {
        setWsUp(true);
        void refreshAll();
        void loadSignals();
        void loadScanner();
        void loadMtf();
        return;
      }
      if (e.type === '_close') {
        setWsUp(false);
        return;
      }
      const d = e.data;
      switch (e.type) {
        case 'price': {
          lastPriceAt.current = Date.now();
          setStatus((prev) => {
            if (!prev) return prev;
            const openTrades = (prev.openTrades ?? []).map((t) =>
              t.symbol === d.symbol
                ? {
                    ...t,
                    markPrice: d.price,
                    unrealized:
                      (d.price - t.entryPrice) * (t.side === 'LONG' ? 1 : -1) * (t.remainingQty ?? t.qty),
                  }
                : t,
            );
            return { ...prev, price: d.symbol === prev.symbol ? d.price : prev.price, openTrades };
          });
          break;
        }
        case 'prices':
          break;
        case 'account':
          void loadAccount();
          break;
        case 'scanner':
          void loadScanner();
          void loadStatus();
          break;
        case 'scanner-progress':
          setScan((previous) => (previous ? { ...previous, progress: d } : previous));
          break;
        case 'signal':
          void loadSignals();
          void loadStatus();
          break;
        case 'trade':
          void refreshAll();
          void loadScanner();
          break;
        case 'log':
          setLogs((l) => [...l, { t: d.t || Date.now(), level: d.level || 'info', msg: d.msg || '' }].slice(-300));
          if (d.level === 'win') toast(d.msg, 'win');
          if (d.level === 'error') toast(d.msg, 'error');
          break;
        case 'error':
          toast(d.message || 'Error', 'error');
          break;
        default:
          break;
      }
    });

    const fast = window.setInterval(loadStatus, 5000);
    const accountPoll = window.setInterval(loadAccount, 10000);
    const posPoll = window.setInterval(loadPositions, 10000);
    const scanPoll = window.setInterval(loadScanner, 30000);
    const mtfPoll = window.setInterval(loadMtf, 60000);
    const slow = window.setInterval(() => {
      void loadStats();
      void loadTrades();
    }, 60000);

    return () => {
      un();
      window.clearInterval(fast);
      window.clearInterval(accountPoll);
      window.clearInterval(posPoll);
      window.clearInterval(scanPoll);
      window.clearInterval(mtfPoll);
      window.clearInterval(slow);
    };
  }, [refreshAll, loadStatus, loadAccount, loadPositions, loadScanner, loadMtf, loadSignals, loadStats, loadTrades, toast]);

  /* ---------------- actions ---------------- */
  const onToggleAuto = async (v: boolean) => {
    const live = status?.mode === 'live';
    if (v && live) {
      const ok = window.confirm(
        'Enable auto-trading on the LIVE mainnet account?\n\nThe bot will place REAL orders with real funds using the 5%/10x ladder.',
      );
      if (!ok) return;
    }
    try {
      const result = await apiPost<{ autoTrade: boolean; execution?: Status['execution'] }>(
        '/autotrade',
        { enabled: v, confirmLive: live && v },
      );
      await loadStatus();
      if (!v) {
        toast('Auto-trading disabled', 'info');
      } else if (result.execution?.ready) {
        toast('Auto-trading armed — execution bridge READY', 'win');
      } else {
        toast(`Auto-trading armed, but execution is ${result.execution?.state ?? 'BLOCKED'} — check readiness`, 'info');
      }
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const onKill = async () => {
    const n = status?.slots?.used ?? 0;
    if (!window.confirm(`Market-close all ${n} bot position(s)? External positions are never touched.`)) return;
    try {
      await apiPost('/kill');
      await Promise.all([loadStatus(), loadAccount(), loadPositions(), loadTrades(), loadStats()]);
      toast('Bot positions closed at market', 'info');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const onClosePosition = async (id: string) => {
    if (!window.confirm('Close this bot position at market?')) return;
    try {
      await apiPost('/positions/close', { id });
      await Promise.all([loadStatus(), loadAccount(), loadPositions(), loadTrades(), loadStats()]);
      toast('Position closed at market', 'info');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const onScanNow = async () => {
    setScanning(true);
    try {
      const res = await apiPost<ScanResult>('/scanner/scan');
      if (res && 'rows' in res) setScan(res);
      void loadStatus();
      toast(`Scanner analysed ${res?.analysed ?? 0}/${res?.target ?? 50} assets · ${res?.selected?.length ?? 0} opportunity zones`, 'info');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setScanning(false);
    }
  };

  const headModel = usePnlModel(status, trades, account, 'all');
  const headTotal = account?.bot.netPnl ?? headModel.realized;

  // The marquee is the scanner's volatility ranking.
  const tickerRows = useMemo(
    () =>
      (scan?.rows ?? []).map((r) => ({
        symbol: r.symbol,
        state: `${r.marketType} · ${r.trend}`,
        volatility: r.volatility,
        tradable: r.tradable,
      })),
    [scan],
  );

  return (
    <div className="app">
      <LiquidBackground />

      <div className="scroll-progress" style={{ width: `${(scrollProgress * 100).toFixed(2)}%` }} />

      <div className="topbar-wrap">
        <Topbar
          status={status}
          onKill={onKill}
          onOpenPnl={isMobile ? () => setSheetOpen(true) : undefined}
        />
        <NavRow
          view={view}
          onView={setView}
          status={status}
          wsUp={wsUp}
          onToggleAuto={onToggleAuto}
          motionOn={motionOn}
          onToggleMotion={() => setMotionOn(!motionOn)}
        />
      </div>

      <Ticker rows={tickerRows} />

      <div className="shell">
        <main className="content">
          <div className="view view-enter" key={view}>
            <ErrorBoundary label={`${VIEW_LABELS[view]} module`}>
              {view === 'dash' && (
                <Overview
                  status={status}
                  stats={stats}
                  scan={scan}
                  account={account}
                  positions={positions}
                  trades={trades}
                  logs={logs}
                  mtf={mtf}
                  onClose={onClosePosition}
                  onScan={onScanNow}
                  scanning={scanning}
                />
              )}
              {view === 'scanner' && (
                <ScannerView scan={scan} status={status} scanning={scanning} onScan={onScanNow} />
              )}
              {view === 'positions' && (
                <PositionsView
                  status={status}
                  account={account}
                  positions={positions}
                  trades={trades}
                  onClose={onClosePosition}
                  onKill={onKill}
                />
              )}
              {view === 'trades' && (
                <TradesView trades={trades} signals={signals} logs={logs} symbol={status?.symbol ?? 'BTCUSDT'} />
              )}
              {view === 'settings' && (
                <SettingsView
                  settings={settings}
                  status={status}
                  onSaved={(s) => {
                    setSettings(s);
                    void loadStatus();
                    void loadScanner();
                    void loadMtf();
                    reconnect();
                    toast('Settings applied to the engine', 'win');
                  }}
                  onError={(m) => m && toast(m, 'error')}
                  motionOn={motionOn}
                  onToggleMotion={() => setMotionOn(!motionOn)}
                />
              )}
            </ErrorBoundary>
          </div>
        </main>

        {/* P&L stays available; only the BTCUSDT candlestick chart was removed. */}
        <aside className="rail" data-open={isMobile ? (sheetOpen ? 'true' : 'false') : 'true'}>
          <div className="rail-inner panel glass-frost">
            <div
              className="rail-head"
              onClick={isMobile ? () => setSheetOpen((open) => !open) : undefined}
              role={isMobile ? 'button' : undefined}
              aria-expanded={isMobile ? sheetOpen : undefined}
              tabIndex={isMobile ? 0 : undefined}
              onKeyDown={
                isMobile
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSheetOpen((open) => !open);
                      }
                    }
                  : undefined
              }
            >
              <span className="sheet-grip" aria-hidden="true" />
              <span className="panel-title" style={{ letterSpacing: 1.2 }}>
                <span className="ico">
                  <IconWaves />
                </span>
                P&amp;L Chart
              </span>
              <span className="spacer" />

              <span className="pnl-mini">
                <span className={`mini-val ${headTotal >= 0 ? 'up' : 'down'}`}>
                  {headTotal >= 0 ? '+' : ''}
                  {fmt(headTotal, 2)}
                </span>
                <span className="chip">{headModel.trades} trades</span>
              </span>

              <span className="chip cyan hide-sm">binance equity</span>
              <span className="sheet-chev" aria-hidden="true">
                <IconWaves style={{ width: 12, height: 12 }} />
              </span>
            </div>
            <div className="rail-body">
              <ErrorBoundary label="P&L dock">
                <PnlDock account={account} trades={trades} />
              </ErrorBoundary>
            </div>
          </div>
        </aside>
      </div>

      <footer className="footbar">
        <span className="foot-brand">
          <span className="brand-mark" style={{ width: 22, height: 22, borderRadius: 8 }}>
            <IconWaves style={{ width: 12, height: 12 }} />
          </span>
          VelocityX · binance realtime edition
        </span>
        <span>
          {status?.autoScan ? 'scanner' : status?.symbol ?? 'BTCUSDT'} · {status?.interval ?? '5m'} · super indibot ·
          max {status?.maxPositions ?? 8} positions
        </span>
        <span>{wsUp ? 'stream connected' : 'reconnecting…'}</span>
        <span className="spacer" />
        <span className="foot-note">
          <IconAlert style={{ width: 11, height: 11 }} /> external positions are never touched
        </span>
      </footer>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            <span className="toast-ico">
              {t.type === 'error' ? <IconAlert /> : t.type === 'win' ? <IconCheck /> : <IconInfo />}
            </span>
            <span className="toast-msg">{t.msg}</span>
          </div>
        ))}
      </div>

      {isMobile && account && (
        <Btn className="mobile-equity" size="sm" onClick={() => setSheetOpen(true)} title="Open P&L chart">
          <AnimatedNumber value={account.equity ?? 0} decimals={2} /> USDT
        </Btn>
      )}
    </div>
  );
}
