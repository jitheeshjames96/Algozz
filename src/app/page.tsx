"use client";
import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, CandlestickSeries, IChartApi } from 'lightweight-charts';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");

export default function Dashboard() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [trades, setTrades] = useState<any[]>([]);
  const [metrics, setMetrics] = useState({ equity: 100000, realized: 0, winRate: 0, active: 0 });

  useEffect(() => {
    if (!chartContainerRef.current) return;
    const chart = createChart(chartContainerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#020617' }, textColor: '#cbd5e1' },
      width: chartContainerRef.current.clientWidth, height: 400,
      grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } }
    });
    const candleSeries = chart.addSeries(CandlestickSeries);

    const fetchData = async () => {
      // 1. Fetch only closed/active trades (Filtered)
      const { data } = await supabase.from('execution_logs')
        .select('*')
        .not('trade_pnl', 'is', null) 
        .order('timestamp', { ascending: true });

      if (data) {
        setTrades(data.reverse());
        // Calculate Metrics
        const realized = data.reduce((acc, curr) => acc + Number(curr.trade_pnl || 0), 0);
        const wins = data.filter(l => Number(l.trade_pnl) > 0).length;
        setMetrics({
            equity: 100000 + realized,
            realized,
            winRate: data.length > 0 ? (wins / data.length) * 100 : 0,
            active: 0 // Logic to check open orders goes here
        });
      }
    };
    fetchData();
  }, []);

  return (
    <div className="min-h-screen bg-[#020617] text-slate-100 p-6 font-sans">
      {/* KPI DASHBOARD */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-[#0B1120] p-5 rounded-xl border border-slate-800">
            <p className="text-slate-500 text-[10px] uppercase">Net Equity</p>
            <p className="text-2xl font-bold font-mono">₹{metrics.equity.toLocaleString()}</p>
        </div>
        <div className="bg-[#0B1120] p-5 rounded-xl border border-slate-800">
            <p className="text-slate-500 text-[10px] uppercase">Realized PnL</p>
            <p className={`text-2xl font-bold font-mono ${metrics.realized >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {metrics.realized >= 0 ? '+' : ''}₹{metrics.realized.toFixed(0)}
            </p>
        </div>
        <div className="bg-[#0B1120] p-5 rounded-xl border border-slate-800">
            <p className="text-slate-500 text-[10px] uppercase">Win Ratio</p>
            <p className="text-2xl font-bold font-mono">{metrics.winRate.toFixed(1)}%</p>
        </div>
        <div className="bg-[#0B1120] p-5 rounded-xl border border-slate-800 border-l-4 border-l-emerald-500">
            <p className="text-slate-500 text-[10px] uppercase">System</p>
            <p className="text-2xl font-bold">ONLINE</p>
        </div>
      </div>

      {/* CHART AREA */}
      <div ref={chartContainerRef} className="rounded-xl border border-slate-800 bg-[#0B1120] p-2 mb-6" />

      {/* INTERACTIVE ORDER BOOK */}
      <div className="bg-[#0B1120] rounded-xl border border-slate-800 p-6">
        <h2 className="text-lg font-bold mb-4 border-b border-slate-800 pb-2">Completed Orders</h2>
        <div className="space-y-2">
            {trades.map(t => (
                <div key={t.id} className="grid grid-cols-4 items-center p-3 hover:bg-slate-900 rounded cursor-pointer border border-transparent hover:border-slate-700">
                    <span className="font-mono text-sm">{new Date(t.timestamp).toLocaleTimeString()}</span>
                    <span className="text-sm font-bold">{t.contract_targeted}</span>
                    <span className={`font-bold ${Number(t.trade_pnl) > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {Number(t.trade_pnl) > 0 ? 'PROFIT' : 'LOSS'} (₹{Number(t.trade_pnl).toFixed(0)})
                    </span>
                    <span className="text-xs text-slate-500 text-right">{t.action_details}</span>
                </div>
            ))}
        </div>
      </div>
    </div>
  );
}
