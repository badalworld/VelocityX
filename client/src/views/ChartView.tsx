import { useEffect, useRef, useState } from 'react';
import { ChartData, SignalRecord, Status, Trade } from '../types';
import { apiGet } from '../api';
import ChartPanel from '../components/ChartPanel';
import PositionCard from '../components/PositionCard';
import { SignalList, LogFeed } from '../components/History';
import { LiquidLoader } from '../motion/primitives';

export default function ChartView({
  status,
  trades,
  signals,
  logs,
  onKill,
}: {
  status: Status | null;
  trades: Trade[];
  signals: SignalRecord[];
  logs: { t: number; level: string; msg: string }[];
  onKill: () => void;
}) {
  const [limit, setLimit] = useState(300);
  const [data, setData] = useState<ChartData | null>(null);
  const [loading, setLoading] = useState(true);
  const candleKey = status?.engine?.lastClosedCandleTime ?? 0;
  const lastKey = useRef(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    apiGet<ChartData>(`/chart?limit=${limit}`)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [limit]);

  // refresh whenever a candle closes in the engine
  useEffect(() => {
    if (!candleKey || candleKey === lastKey.current) return;
    lastKey.current = candleKey;
    void apiGet<ChartData>(`/chart?limit=${limit}`)
      .then(setData)
      .catch(() => {});
  }, [candleKey, limit]);

  const open = status?.openTrade ?? null;

  return (
    <>
      {loading && !data ? (
        <LiquidLoader label="Loading candles + indicator ribbon…" />
      ) : (
        <ChartPanel
          data={data}
          symbol={status?.symbol ?? 'BTCUSDT'}
          interval={status?.interval ?? '5m'}
          limit={limit}
          onLimit={setLimit}
          live={status?.feed !== 'offline-demo'}
        />
      )}

      {open && <PositionCard trade={open} price={status?.price ?? 0} onKill={onKill} />}

      <div className="grid-2">
        <SignalList signals={signals} currentSymbol={status?.symbol ?? 'BTCUSDT'} />
        <LogFeed logs={logs} />
      </div>
    </>
  );
}
