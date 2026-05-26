"use client";
import { useEffect, useRef } from 'react';
import { createChart, ColorType, CandlestickSeries } from 'lightweight-charts';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");

export default function Dashboard() {
  const chartRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!chartRef.current) return;
    const chart = createChart(chartRef.current, { 
        layout: { background: { type: ColorType.Solid, color: '#020617' }, textColor: '#cbd5e1' },
        width: chartRef.current.clientWidth, height: 400 
    });
    const candleSeries = chart.addSeries(CandlestickSeries, { upColor: '#10b981', downColor: '#ef4444' });

    const load = async () => {
      const { data } = await supabase.from('execution_logs').select('*').order('timestamp', { ascending: true });
      if (data) {
        // Convert logs to OHLC candles (Grouping by minute)
        const candleData = data.map(t => ({
            time: Math.floor(new Date(t.timestamp).getTime() / 1000) as any,
            open: Number(t.asset_price), high: Number(t.asset_price) + 5,
            low: Number(t.asset_price) - 5, close: Number(t.asset_price)
        }));
        candleSeries.setData(candleData);
      }
    };
    load();
  }, []);
  return <div ref={chartRef} className="w-full h-[400px] border border-slate-800 rounded-2xl bg-[#0B1120]" />;
}
