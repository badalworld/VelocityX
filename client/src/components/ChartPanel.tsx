import { useEffect, useRef } from 'react';
import { createChart, IChartApi, ISeriesApi, IPriceLine, UTCTimestamp, ColorType } from 'lightweight-charts';
import { ChartData } from '../types';

const RIBBON = ['#1573d4', '#3096ff', '#57abff', '#85c2ff', '#9bcdff', '#b3d9ff', '#c9e5ff', '#dfecfb'];

interface Props {
  data: ChartData | null;
  symbol: string;
}

export default function ChartPanel({ data, symbol }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const emaRefs = useRef<ISeriesApi<'Line'>[]>([]);
  const extraRef = useRef<ISeriesApi<'Line'> | null>(null);
  const priceLines = useRef<IPriceLine[]>([]);
  const inited = useRef(false);
  const fitted = useRef(false);

  // create chart once
  useEffect(() => {
    if (!wrapRef.current || inited.current) return;
    inited.current = true;
    const chart = createChart(wrapRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#141926' },
        textColor: '#7c86a0',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(35,42,59,0.5)' },
        horzLines: { color: 'rgba(35,42,59,0.5)' },
      },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: '#232a3b' },
      timeScale: { borderColor: '#232a3b', timeVisible: true, secondsVisible: false },
      width: wrapRef.current.clientWidth,
      height: wrapRef.current.clientHeight,
    });
    chartRef.current = chart;

    const candles = chart.addCandlestickSeries({
      upColor: '#089981',
      downColor: '#f23645',
      borderVisible: false,
      wickUpColor: '#089981',
      wickDownColor: '#f23645',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    candleRef.current = candles;

    chart.priceScale('ribbon').applyOptions({
      scaleMargins: { top: 0.08, bottom: 0.08 },
      visible: false,
    });
    emaRefs.current = RIBBON.map((c) =>
      chart.addLineSeries({
        color: c,
        lineWidth: 2,
        priceScaleId: 'ribbon',
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        priceLineVisible: false,
      }),
    );
    extraRef.current = chart.addLineSeries({
      color: '#b44bdd',
      lineWidth: 2,
      priceScaleId: 'ribbon',
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceLineVisible: false,
    });

    const onResize = () => {
      if (wrapRef.current) chart.applyOptions({ width: wrapRef.current.clientWidth, height: wrapRef.current.clientHeight });
    };
    window.addEventListener('resize', onResize);

    const ro = new ResizeObserver(onResize);
    ro.observe(wrapRef.current);

    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      chart.remove();
      inited.current = false;
      chartRef.current = null;
      candleRef.current = null;
      emaRefs.current = [];
      extraRef.current = null;
    };
  }, []);

  // apply data
  useEffect(() => {
    if (!data || !candleRef.current || !chartRef.current) return;
    const chart = chartRef.current;
    if (data.candles.length === 0) return;

    candleRef.current.setData(data.candles as any);

    data.emas.forEach((series, i) => {
      const target = emaRefs.current[i];
      if (target) target.setData(series.map((p) => ({ time: p.time as UTCTimestamp, value: p.value as number })).filter((p) => p.value != null) as any);
    });
    extraRef.current?.setData(data.emaExtra.map((p) => ({ time: p.time as UTCTimestamp, value: p.value as number })).filter((p) => p.value != null) as any);

    // signal markers
    const markers = data.signals
      .filter((s) => s.time >= (data.candles[0]?.time ?? 0))
      .map((s) => ({
        time: s.time as UTCTimestamp,
        position: (s.side === 'LONG' ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
        color: s.side === 'LONG' ? '#00c853' : '#f23645',
        shape: (s.side === 'LONG' ? 'arrowUp' : 'arrowDown') as 'arrowUp' | 'arrowDown',
        text: s.side === 'LONG' ? 'B' : 'S',
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    candleRef.current.setMarkers(markers as any);

    if (!fitted.current) {
      chart.timeScale().fitContent();
      fitted.current = true;
    }
  }, [data]);

  // trade levels as price lines
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    for (const pl of priceLines.current) {
      try { series.removePriceLine(pl); } catch { /* gone */ }
    }
    priceLines.current = [];
    const t = data?.trade;
    if (!t) return;
    const mk = (price: number, color: string, title: string, style = 0) => {
      const pl = series.createPriceLine({
        price,
        color,
        lineWidth: 2,
        lineStyle: style,
        axisLabelVisible: true,
        title,
      });
      priceLines.current.push(pl);
    };
    mk(t.entry, '#fff100', 'ENTRY');
    mk(t.sl, t.slStage === 0 ? '#f23645' : t.slStage === 1 ? '#fff100' : '#3096ff', t.slStage === 0 ? 'SL' : t.slStage === 1 ? 'SL·BE' : 'SL·TP1');
    if (!t.tp1Filled) mk(t.tp1, '#00c853', 'TP1 1.5R');
    if (!t.tp2Filled) mk(t.tp2, '#00c853', 'TP2 3R');
    if (!t.tp3Filled) mk(t.tp3, '#00c853', 'TP3 4.5R');
  }, [data?.trade, data?.trade?.slStage, data?.trade?.tp1Filled, data?.trade?.tp2Filled, data?.trade?.tp3Filled]);

  return (
    <div className="card">
      <div className="card-head">
        <span>
          <span className="accent">{symbol}</span> · 5m · SUPER INDIBOT (EMA 5-34 Ribbon + EMA 200)
        </span>
        <span style={{ fontSize: 10 }}>
          non-repaint cross EMA11/EMA34 · ATR×2 SL · RR 1:1.5
        </span>
      </div>
      <div className="chart-wrap" ref={wrapRef} />
    </div>
  );
}
