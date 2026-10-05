import { useEffect, useRef, useState } from 'react';
import { createChart, IChartApi, IPriceLine, ISeriesApi, UTCTimestamp, ColorType } from 'lightweight-charts';
import { ChartData } from '../types';
import { Btn, Segmented } from '../motion/primitives';
import { IconBolt, IconCandles, IconChart, IconPlay } from '../motion/Icons';
import { useReveal } from '../hooks/motion';

const RIBBON = [
  { color: '#3ef0ff', label: 'EMA 5' },
  { color: '#5b9dff', label: 'EMA 11' },
  { color: '#7fb7ff', label: 'EMA 15' },
  { color: '#9cc9ff', label: 'EMA 18' },
  { color: '#b3d9ff', label: 'EMA 21' },
  { color: '#c9e5ff', label: 'EMA 24' },
  { color: '#dbefff', label: 'EMA 28' },
  { color: '#b0c4e8', label: 'EMA 34' },
];

interface Props {
  data: ChartData | null;
  symbol: string;
  interval: string;
  limit: number;
  onLimit: (n: number) => void;
  live?: boolean;
}

export default function ChartPanel({ data, symbol, interval, limit, onLimit, live }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const emaRefs = useRef<ISeriesApi<'Line'>[]>([]);
  const extraRef = useRef<ISeriesApi<'Line'> | null>(null);
  const priceLines = useRef<IPriceLine[]>([]);
  const inited = useRef(false);
  const fitted = useRef(false);

  const [showRibbon, setShowRibbon] = useState(true);
  const [showExtra, setShowExtra] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [showLevels, setShowLevels] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useReveal('chart-view');

  /* ---------- chart lifecycle ------------------------------------------- */
  useEffect(() => {
    const host = wrapRef.current;
    if (!host || inited.current) return;
    inited.current = true;

    let chart: IChartApi;
    try {
      chart = createChart(host, {
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: 'rgba(200,214,240,.55)',
          fontSize: 11,
          fontFamily: "'Inter','SF Pro Display','Segoe UI',system-ui,sans-serif",
        },
        grid: {
          vertLines: { color: 'rgba(255,255,255,.035)' },
          horzLines: { color: 'rgba(255,255,255,.045)' },
        },
        crosshair: {
          mode: 0,
          vertLine: { color: 'rgba(62,240,255,.5)', width: 1, style: 2, labelBackgroundColor: '#123040' },
          horzLine: { color: 'rgba(62,240,255,.5)', width: 1, style: 2, labelBackgroundColor: '#123040' },
        },
        rightPriceScale: { borderColor: 'rgba(255,255,255,.09)', scaleMargins: { top: 0.12, bottom: 0.1 } },
        timeScale: { borderColor: 'rgba(255,255,255,.09)', timeVisible: true, secondsVisible: false, rightOffset: 4 },
        width: Math.max(240, host.clientWidth),
        height: Math.max(200, host.clientHeight),
      });
    } catch (err) {
      console.error('[VelocityX] chart library failed to initialise', err);
      inited.current = false;
      setChartError(err instanceof Error ? err.message : String(err));
      return;
    }

    chartRef.current = chart;
    setChartError(null);

    try {
      candleRef.current = chart.addCandlestickSeries({
        upColor: 'rgba(35,221,138,.95)',
        downColor: 'rgba(255,79,116,.95)',
        borderVisible: false,
        wickUpColor: 'rgba(35,221,138,.75)',
        wickDownColor: 'rgba(255,79,116,.75)',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });

      chart.priceScale('ribbon').applyOptions({ scaleMargins: { top: 0.06, bottom: 0.06 }, visible: false });
      emaRefs.current = RIBBON.map((r) =>
        chart.addLineSeries({
          color: r.color,
          lineWidth: 2,
          priceScaleId: 'ribbon',
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          priceLineVisible: false,
        }),
      );
      extraRef.current = chart.addLineSeries({
        color: '#a874ff',
        lineWidth: 2,
        lineStyle: 2,
        priceScaleId: 'ribbon',
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        priceLineVisible: false,
      });
    } catch (err) {
      console.error('[VelocityX] series setup failed', err);
      setChartError(err instanceof Error ? err.message : String(err));
    }

    const onResize = () => {
      const el = wrapRef.current;
      const c = chartRef.current;
      if (!el || !c) return;
      try {
        c.applyOptions({ width: Math.max(240, el.clientWidth), height: Math.max(200, el.clientHeight) });
      } catch {
        /* chart already disposed */
      }
    };
    window.addEventListener('resize', onResize);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    ro?.observe(host);

    return () => {
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      try {
        chart.remove();
      } catch {
        /* already gone */
      }
      inited.current = false;
      chartRef.current = null;
      candleRef.current = null;
      emaRefs.current = [];
      extraRef.current = null;
      priceLines.current = [];
    };
  }, [attempt]);

  /* ---------- data ------------------------------------------------------- */
  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    if (!data || !chart || !candles || data.candles.length === 0) return;

    try {
      candles.setData(data.candles as never);

      data.emas.forEach((series, i) => {
        const target = emaRefs.current[i];
        if (!target) return;
        target.setData(
          series
            .filter((p) => p.value != null)
            .map((p) => ({ time: p.time as UTCTimestamp, value: p.value as number })) as never,
        );
      });
      extraRef.current?.setData(
        data.emaExtra
          .filter((p) => p.value != null)
          .map((p) => ({ time: p.time as UTCTimestamp, value: p.value as number })) as never,
      );

      const markers = data.signals
        .filter((s) => s.time >= (data.candles[0]?.time ?? 0))
        .map((s) => ({
          time: s.time as UTCTimestamp,
          position: (s.side === 'LONG' ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
          color: s.side === 'LONG' ? '#23dd8a' : '#ff4f74',
          shape: (s.side === 'LONG' ? 'arrowUp' : 'arrowDown') as 'arrowUp' | 'arrowDown',
          text: `${s.side === 'LONG' ? 'LONG' : 'SHORT'}${s.acted ? ' · traded' : ''}`,
          size: 1,
        }))
        .sort((a, b) => (a.time as number) - (b.time as number));
      candles.setMarkers(showMarkers ? (markers as never) : ([] as never));

      if (!fitted.current) {
        chart.timeScale().fitContent();
        fitted.current = true;
      }
    } catch (err) {
      console.error('[VelocityX] chart data rejected', err);
    }
  }, [data, showMarkers, chartError]);

  /* ---------- visibility toggles ---------------------------------------- */
  useEffect(() => {
    emaRefs.current.forEach((s) => {
      try {
        s.applyOptions({ visible: showRibbon });
      } catch {
        /* ignore */
      }
    });
  }, [showRibbon, data]);

  useEffect(() => {
    try {
      extraRef.current?.applyOptions({ visible: showExtra });
    } catch {
      /* ignore */
    }
  }, [showExtra, data]);

  /* ---------- trade levels --------------------------------------------- */
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    for (const pl of priceLines.current) {
      try {
        series.removePriceLine(pl);
      } catch {
        /* already gone */
      }
    }
    priceLines.current = [];
    const t = data?.trade;
    if (!t || !showLevels) return;

    const mk = (price: number, color: string, title: string, style = 0) => {
      if (!Number.isFinite(price)) return;
      try {
        priceLines.current.push(
          series.createPriceLine({ price, color, lineWidth: 2, lineStyle: style, axisLabelVisible: true, title }),
        );
      } catch {
        /* ignore */
      }
    };
    mk(t.entry, 'rgba(255,255,255,.9)', 'ENTRY');
    mk(
      t.sl,
      t.slStage === 0 ? '#ff4f74' : t.slStage === 1 ? '#ffc857' : '#5b9dff',
      t.slStage === 0 ? 'SL' : t.slStage === 1 ? 'SL·BE' : 'SL·TP1',
    );
    if (!t.tp1Filled) mk(t.tp1, '#23dd8a', 'TP1 1.5R', 1);
    if (!t.tp2Filled) mk(t.tp2, '#23dd8a', 'TP2 3R', 1);
    if (!t.tp3Filled) mk(t.tp3, '#34f0b2', 'TP3 4.5R', 1);
  }, [data, data?.trade, data?.trade?.slStage, data?.trade?.tp1Filled, data?.trade?.tp2Filled, data?.trade?.tp3Filled, showLevels]);

  const lastCandle = data?.candles?.[data.candles.length - 1];
  const firstCandle = data?.candles?.[0];
  const change = lastCandle && firstCandle && firstCandle.open ? ((lastCandle.close - firstCandle.open) / firstCandle.open) * 100 : 0;

  return (
    <section className="panel chart-stage" data-reveal="true">
      <div className="chart-toolbar">
        <span className="panel-title" style={{ letterSpacing: 1 }}>
          <span className="ico">
            <IconCandles />
          </span>
          {symbol}
          <span className="tx-sub">{interval} · SUPER INDIBOT</span>
        </span>

        {lastCandle && (
          <span className={`chip ${change >= 0 ? 'green' : 'red'}`}>
            {change >= 0 ? '▲' : '▼'} {change.toFixed(2)}%
          </span>
        )}
        {live && <span className="chip live cyan">live feed</span>}

        <div className="spacer" />

        <Segmented
          value={String(limit)}
          onChange={(v) => {
            fitted.current = false;
            onLimit(Number(v));
          }}
          items={[
            { value: '150', label: '150' },
            { value: '300', label: '300' },
            { value: '600', label: '600' },
            { value: '1000', label: '1000' },
          ]}
          ariaLabel="Candle count"
        />

        <Btn size="sm" active={showRibbon} onClick={() => setShowRibbon((v) => !v)} title="Toggle EMA ribbon">
          <IconChart style={{ width: 13, height: 13 }} />
          Ribbon
        </Btn>
        <Btn size="sm" active={showExtra} onClick={() => setShowExtra((v) => !v)} title="Toggle EMA 200">
          EMA200
        </Btn>
        <Btn size="sm" active={showMarkers} onClick={() => setShowMarkers((v) => !v)} title="Toggle signal markers">
          Signals
        </Btn>
        <Btn size="sm" active={showLevels} onClick={() => setShowLevels((v) => !v)} title="Toggle entry/SL/TP lines">
          Levels
        </Btn>
        <Btn
          size="sm"
          onClick={() => {
            try {
              chartRef.current?.timeScale().fitContent();
            } catch {
              /* ignore */
            }
          }}
          title="Fit all candles"
        >
          <IconPlay style={{ width: 12, height: 12 }} />
          Fit
        </Btn>
      </div>

      {chartError ? (
        <div className="chart-fallback">
          <strong>Candlestick engine unavailable in this browser</strong>
          <span>
            The chart library could not start ({chartError}). Signals, execution and every other panel keep working —
            try another browser, or relax tracking protection for this origin.
          </span>
          <Btn
            size="sm"
            variant="primary"
            onClick={() => {
              setChartError(null);
              setAttempt((a) => a + 1);
            }}
          >
            Retry chart engine
          </Btn>
        </div>
      ) : (
        <div className="chart-canvas" ref={wrapRef} />
      )}

      <div className="chart-legend">
        {RIBBON.map((r) => (
          <span className="lg" key={r.label} style={{ color: r.color, opacity: showRibbon ? 1 : 0.35 }}>
            <i />
            {r.label.replace('EMA ', '')}
          </span>
        ))}
        <span className="lg" style={{ color: '#a874ff', opacity: showExtra ? 1 : 0.35 }}>
          <i />
          200
        </span>
        <span className="lg" style={{ color: 'var(--cyan)' }}>
          <i />
          entry / SL / TP levels
        </span>
        <span className="lg" style={{ color: 'var(--green)' }}>
          <i />
          LONG signal
        </span>
        <span className="lg" style={{ color: 'var(--red)' }}>
          <i />
          SHORT signal
        </span>
        <div className="spacer" />
        <span className="lg" style={{ color: 'var(--dim)' }}>
          <IconBolt style={{ width: 12, height: 12 }} />
          {data?.candles?.length ?? 0} candles · entry on signal candle close · ATR×2 stop
        </span>
      </div>
    </section>
  );
}
