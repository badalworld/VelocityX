import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavRow, Ticker, Topbar, ViewKey } from './components/Header';
import PnlDock from './components/PnlDock';
import Overview from './views/Overview';
import ScannerView from './views/ScannerView';
import PositionsView from './views/PositionsView';
import ChartView from './views/ChartView';
import TradesView from './views/TradesView';
import SettingsView from './views/SettingsView';
import LiquidBackground from './motion/LiquidBackground';
import ErrorBoundary from './components/ErrorBoundary';
import { AnimatedNumber, Btn } from './motion/primitives';
import { IconAlert, IconCheck, IconInfo, IconWaves } from './motion/Icons';
import { apiGet, apiPost, fmt } from './api';
import { subscribe } from './ws';
import { useGlassSheen, useLocalState, useMediaQuery, useReveal, useScrollProgress } from './hooks/motion';
import { usePnlModel } from './pnl';
import {
  AccountView, ChartData, Mtf, PositionsPayload, ScanResult, ScreenerData, Settings,
  SignalRecord, Stats, Status, Trade,
} from './types';

interface Toast {
  id: number;
  msg: string;
  type: 'info' | 'error' | 'win';
}

export default function App() {
  /* ---------------- data ---------------- */
  const [status, setStatus] = useState<Status | null>(null);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [signals, setSignals] = useState<SignalRecord[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mtf, setMtf] = useState<Mtf | null>(null);
  const [screener, setScreener] = useState<ScreenerData | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [positions, setPositions] = useState<PositionsPayload | null>(null);
  const [scanning, setScanning] = useState(false);
  const [logs, setLogs] = useState<{ t: number; level: string; msg: string }[]>([]);
  const [wsUp, setWsUp] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const lastCandle = useRef(0);
  const toastId = useRef(1);

  /* ---------------- ui shell state ---------------- */
  const [view, setView] = useState<ViewKey>('dash');
  const [motionOn, setMotionOn] = useLocalState('vx.motion', true);
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
  const loadStatus = useCallback(async () => {
    try {
      const s = await apiGet<Status>('/status');
      setStatus(s);
      if (s.account) setAccount(s.account);
      if (s.logs) setLogs(s.logs);
      const lc = s.engine?.lastClosedCandleTime ?? 0;
      if (lc && lc !== lastCandle.current) {
        lastCandle.current = lc;
        void apiGet<ChartData>('/chart').then(setChart).catch(() => {});
      }
    } catch {
      /* server briefly unreachable */
    }
  }, []);

  const loadAccount = useCallback(() => {
    void apiGet<AccountView>('/account').then(setAccount).catch(() => {});
  }, []);
  const loadPositions = useCallback(() => {
    void apiGet<PositionsPayload>('/positions').then(setPositions).catch(() => {});
  }, []);
  const loadScanner = useCallback(() => {
    void apiGet<ScanResult>('/scanner').then(setScan).catch(() => {});
    void apiGet<ScreenerData>('/screener').then(setScreener).catch(() => {});
  }, []);
  const loadChart = useCallback(() => {
    void apiGet<ChartData>('/chart').then(setChart).catch(() => {});
  }, []);
  const loadTrades = useCallback(() => {
    void apiGet<Trade[]>('/trades').then(setTrades).catch(() => {});
  }, []);
  const loadSignals = useCallback(() => {
    void apiGet<SignalRecord[]>('/signals').then(setSignals).catch(() => {});
  }, []);
  const loadStats = useCallback(() => {
    void apiGet<Stats>('/stats').then(setStats).catch(() => {});
  }, []);

  const refreshAll = useCallback(() => {
    void loadStatus();
    void loadAccount();
    void loadPositions();
    void loadTrades();
    void loadStats();
  }, [loadStatus, loadAccount, loadPositions, loadTrades, loadStats]);

  useEffect(() => {
    void apiGet<Settings>('/settings').then(setSettings).catch(() => {});
    refreshAll();
    void loadChart();
    void loadSignals();
    void loadScanner();
    void apiGet<Mtf>('/mtf').then(setMtf).catch(() => {});

    const un = subscribe((e) => {
      if (e.type === '_open') {
        setWsUp(true);
        refreshAll();
        void loadChart();
        void loadSignals();
        void loadScanner();
        return;
      }
      if (e.type === '_close') {
        setWsUp(false);
        return;
      }
      const d = e.data;
      switch (e.type) {
        case 'price': {
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
          break;
        case 'signal':
          void loadSignals();
          void loadChart();
          void loadStatus();
          break;
        case 'trade':
          refreshAll();
          void loadChart();
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
    const slow = window.setInterval(() => {
      void loadStats();
      void loadTrades();
      void apiGet<Mtf>('/mtf').then(setMtf).catch(() => {});
    }, 60000);

    return () => {
      un();
      window.clearInterval(fast);
      window.clearInterval(accountPoll);
      window.clearInterval(posPoll);
      window.clearInterval(scanPoll);
      window.clearInterval(slow);
    };
  }, [refreshAll, loadStatus, loadAccount, loadPositions, loadScanner, loadChart, loadSignals, loadStats, loadTrades, toast]);

  /* ---------------- actions ---------------- */
  const onToggleAuto = async (v: boolean) => {
    try {
      await apiPost('/autotrade', { enabled: v });
      await loadStatus();
      toast(v ? 'Auto-trading ENABLED — the bot will execute signals' : 'Auto-trading disabled', v ? 'win' : 'info');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const onKill = async () => {
    const n = status?.slots?.used ?? 0;
    if (!window.confirm(`Market-close all ${n} bot position(s)? External positions are never touched.`)) return;
    try {
      await apiPost('/kill');
      await Promise.all([loadStatus(), loadAccount(), loadPositions(), loadTrades(), loadStats(), loadChart()]);
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
      toast(`Scanner analysed ${res?.analysed ?? 0} markets · ${res?.selected?.length ?? 0} selected`, 'info');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setScanning(false);
    }
  };

  const openCount = status?.slots?.used ?? 0;
  const headModel = usePnlModel(status, trades, account, 'all');
  const headTotal = (account?.bot.netPnl ?? headModel.realized) + 0;
  void openCount;

  const tickerRows = useMemo(() => screener?.rows ?? [], [screener]);

  return (
    <div className="app">
      <LiquidBackground />

      <div className="scroll-progress" style={{ width: `${(scrollProgress * 100).toFixed(2)}%` }} />

      <div className="topbar-wrap">
        <Topbar
          status={status}
          wsUp={wsUp}
          onKill={onKill}
          onOpenSheet={isMobile ? () => setSheetOpen(true) : undefined}
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
            <ErrorBoundary label={view === 'chart' ? 'Chart module' : view === 'settings' ? 'Settings module' : 'Dashboard module'}>
              {view === 'dash' && (
                <Overview
                  status={status}
                  stats={stats}
                  mtf={mtf}
                  screener={screener}
                  scan={scan}
                  account={account}
                  positions={positions}
                  trades={trades}
                  logs={logs}
                  onKill={onKill}
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
              {view === 'chart' && (
                <ChartView status={status} trades={trades} signals={signals} logs={logs} onKill={onKill} />
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

        {/* ---------------- fixed P&L rail ---------------- */}
        <aside className="rail" data-open={isMobile ? (sheetOpen ? 'true' : 'false') : 'true'}>
          <div className="rail-inner panel glass-frost">
            <div
              className="rail-head"
              onClick={isMobile ? () => setSheetOpen((v) => !v) : undefined}
              role={isMobile ? 'button' : undefined}
              aria-expanded={isMobile ? sheetOpen : undefined}
              tabIndex={isMobile ? 0 : undefined}
              onKeyDown={
                isMobile
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') setSheetOpen((v) => !v);
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
              <ErrorBoundary label="P&L dock" compact>
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

      {/* mobile helper: account equity pill */}
      {isMobile && account && (
        <Btn className="mobile-equity" size="sm" onClick={() => setSheetOpen(true)} title="Binance equity">
          <AnimatedNumber value={account.equity ?? 0} decimals={2} /> USDT
        </Btn>
      )}
    </div>
  );
}
