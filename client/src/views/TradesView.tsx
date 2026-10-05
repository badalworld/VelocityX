import { SignalRecord, Trade } from '../types';
import { LogFeed, SignalList, TradeHistory, TradesSummary } from '../components/History';
import { Panel } from '../motion/primitives';
import { IconHistory } from '../motion/Icons';

export default function TradesView({
  trades,
  signals,
  logs,
  symbol,
}: {
  trades: Trade[];
  signals: SignalRecord[];
  logs: { t: number; level: string; msg: string }[];
  symbol: string;
}) {
  return (
    <>
      <Panel title="Journal Overview" icon={<IconHistory />} sub="all-time">
        <TradesSummary trades={trades} />
      </Panel>

      <TradeHistory trades={trades} />

      <div className="grid-2">
        <SignalList signals={signals} currentSymbol={symbol} />
        <LogFeed logs={logs} />
      </div>
    </>
  );
}
