import { useCallback, useEffect, useRef, useState } from 'react';
import Header from './components/Header';
import ChartPanel from './components/ChartPanel';
import PositionCard from './components/PositionCard';
import StatsTable from './components/StatsTable';
import { TrendDashboard, Screener } from './components/Panels';
import SettingsPanel from './components/SettingsPanel';
import { TradeHistory, SignalList, LogFeed } from './components/History';
import { apiGet, apiPost } from './api';
import { subscribe } from './ws';
import { ChartData, Mtf, ScreenerData, Settings, SignalRecord, Stats, Status, Trade } from './types';

interface Toast { id: number; msg: string; type: 'info' | 'error' | 'win' }

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [signals, setSignals] = useState<SignalRecord[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mtf, setMtf] = useState<Mtf | null>(null);
  const [screener, setScreener] = useState<ScreenerData | null>(null);
  const [logs, setLogs] = useState<{ t: number; level: string; msg: string }[]>([]);
  const [wsUp, setWsUp] = useState(false);
  const [tab, setTab] = useState<'trades' | 'signals' | 'log'>('log');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const lastCandle = useRef(0);
  const toastId = useRef(1);

  const toast = useCallback((msg: string, type: 'info' | 'error' | 'win' = 'info') => {
    const id = toastId.current++;
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const s = await apiGet<Status>('/status');
      setStatus(s);
      if (s.logs) setLogs(s.logs);
      const lc = s.engine?.lastClosedCandleTime ?? 0;
      if (lc && lc !== lastCandle.current) {
        lastCandle.current = lc;
        void apiGet<ChartData>('/chart').then(setChart).catch(() => {});
      }
    } catch { /* server briefly down */ }
  }, []);

  const loadChart = useCallback(() => { void apiGet<ChartData>('/chart').then(setChart).catch(() => {}); }, []);
  const loadTrades = useCallback(() => { void apiGet<Trade[]>('/trades').then(setTrades).catch(() => {}); }, []);
  const loadSignals = useCallback(() => { void apiGet<SignalRecord[]>('/signals').then(setSignals).catch(() => {}); }, []);
  const loadStats = useCallback(() => { void apiGet<Stats>('/stats').then(setStats).catch(() => {}); }, []);

  // initial load + ws + polling
  useEffect(() => {
    void apiGet<Settings>('/settings').then(setSettings).catch(() => {});
    loadStatus(); loadChart(); loadTrades(); loadSignals(); loadStats();
    void apiGet<Mtf>('/mtf').then(setMtf).catch(() => {});
    void apiGet<ScreenerData>('/screener').then(setScreener).catch(() => {});

    const un = subscribe((e) => {
      if (e.type === '_open') {
        setWsUp(true);
        loadStatus(); loadChart(); loadTrades(); loadSignals(); loadStats();
        return;
      }
      if (e.type === '_close') { setWsUp(false); return; }
      const d = e.data;
      switch (e.type) {
        case 'price': {
          setStatus((prev) => {
            if (!prev) return prev;
            const nt = prev.openTrade
              ? { ...prev.openTrade, unrealized: (d.price - prev.openTrade.entryPrice) * (prev.openTrade.side === 'LONG' ? 1 : -1) * prev.openTrade.qty }
              : null;
            return { ...prev, price: d.price, openTrade: nt };
          });
          break;
        }
        case 'signal':
          loadSignals(); loadChart(); loadStatus();
          break;
        case 'trade':
          loadStatus(); loadChart(); loadTrades(); loadStats();
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

    const poll = setInterval(loadStatus, 5000);
    const slow = setInterval(() => {
      loadStats(); loadTrades();
      void apiGet<Mtf>('/mtf').then(setMtf).catch(() => {});
      void apiGet<ScreenerData>('/screener').then(setScreener).catch(() => {});
    }, 60000);
    return () => { un(); clearInterval(poll); clearInterval(slow); };
  }, [loadStatus, loadChart, loadTrades, loadSignals, loadStats, toast]);

  const onToggleAuto = async (v: boolean) => {
    try {
      await apiPost('/autotrade', { enabled: v });
      await loadStatus();
      toast(v ? 'Auto-trading ENABLED — bot will execute signals' : 'Auto-trading disabled', v ? 'win' : 'info');
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const onKill = async () => {
    if (!window.confirm('Close the open position at market and cancel all orders?')) return;
    try {
      await apiPost('/kill');
      await Promise.all([loadStatus(), loadTrades(), loadStats(), loadChart()]);
      toast('Position closed', 'info');
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const openTrade = status?.openTrade ?? null;

  return (
    <div className="app">
      <Header status={status} wsUp={wsUp} onToggleAuto={onToggleAuto} onKill={onKill} />

      <div className="grid">
        <div className="col">
          <ChartPanel data={chart} symbol={status?.symbol ?? 'BTCUSDT'} />
          {openTrade && <PositionCard trade={openTrade} price={status?.price ?? 0} onKill={onKill} />}

          <div className="card">
            <div className="card-head">
              <span className="row" style={{ gap: 6 }}>
                {(['trades', 'signals', 'log'] as const).map((t) => (
                  <button key={t} className={`btn small ${tab === t ? 'primary' : ''}`} onClick={() => setTab(t)}>
                    {t === 'trades' ? 'TRADE HISTORY' : t === 'signals' ? 'SIGNALS' : 'ACTIVITY'}
                  </button>
                ))}
              </span>
              <span>{tab === 'trades' ? `${trades.length} trades` : tab === 'signals' ? `${signals.length} signals` : ''}</span>
            </div>
            <div className="card-body">
              {tab === 'trades' && <TradeHistory trades={trades} />}
              {tab === 'signals' && <SignalList signals={signals} currentSymbol={status?.symbol ?? 'BTCUSDT'} />}
              {tab === 'log' && <LogFeed logs={logs} />}
            </div>
          </div>
        </div>

        <div className="col">
          <div className="card">
            <div className="card-head"><span className="accent">Weekly Stats</span><span>{stats ? `${stats.windowDays}d window` : ''}</span></div>
            <StatsTable stats={stats} />
          </div>

          <div className="card">
            <div className="card-head"><span className="accent">Trend Analysis</span><span>MTF</span></div>
            <TrendDashboard mtf={mtf} status={status} />
          </div>

          <div className="card">
            <div className="card-head"><span className="accent">Screener</span><span>5m EMA cross</span></div>
            <Screener data={screener} />
          </div>

          <div className="card">
            <div className="card-head"><span className="accent">Settings</span><span>{status?.mode}</span></div>
            <SettingsPanel settings={settings} onSaved={(s) => { setSettings(s); void loadStatus(); toast('Settings saved', 'info'); }} onError={(m) => m && toast(m, 'error')} />
          </div>
        </div>
      </div>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>
        ))}
      </div>
    </div>
  );
}
