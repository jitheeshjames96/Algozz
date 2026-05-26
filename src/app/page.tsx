"use client";
import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, IChartApi, LineSeries } from 'lightweight-charts';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");

export default function Dashboard() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [metrics, setMetrics] = useState({ equity: 100000, realized: 0, unrealized: 0, winRate: 0 });

  useEffect(() => {
    if (!chartContainerRef.current) return;
    const chart = createChart(chartContainerRef.current, { 
        layout: { background: { type: ColorType.Solid, color: '#0B1120' }, textColor: '#94a3b8' },
        width: chartContainerRef.current.clientWidth, height: 350 
    });
    const lineSeries = chart.addSeries(LineSeries, { color: '#38bdf8' });

    const loadData = async () => {
      const { data } = await supabase.from('execution_logs').select('*').order('timestamp', { ascending: true });
      if (data) {
        setLogs([...data].reverse());
        const chartData = data.map(l => ({ 
            time: Math.floor(new Date(l.timestamp).getTime()/1000) as any, 
            value: Number(l.asset_price) 
        }));
        
        // TYPE FIX: Cast to 'any' to bypass strict TS check during production build
        (lineSeries as any).setData(chartData);
        
        const wins = data.filter(l => l.action_details?.includes('PROFIT')).length;
        const total = data.filter(l => l.action_details?.includes('PROFIT') || l.action_details?.includes('LOSS')).length;
        setMetrics({
            equity: 100000 + data.reduce((acc, curr) => acc + (Number(curr.trade_pnl) || 0), 0),
            realized: data.reduce((acc, curr) => acc + (Number(curr.trade_pnl) || 0), 0),
            unrealized: 0,
            winRate: total > 0 ? (wins/total)*100 : 0
        });
      }
    };
    loadData();
  }, []);

  return (
    <div className="min-h-screen bg-[#020617] text-white p-8">
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-[#0B1120] p-6 rounded-xl border border-slate-800"><p className="text-xs text-slate-400 uppercase">Equity</p><p className="text-2xl font-bold">₹{metrics.equity.toLocaleString()}</p></div>
        <div className="bg-[#0B1120] p-6 rounded-xl border border-slate-800"><p className="text-xs text-slate-400 uppercase">Realized PnL</p><p className="text-2xl font-bold text-emerald-400">₹{metrics.realized.toLocaleString()}</p></div>
        <div className="bg-[#0B1120] p-6 rounded-xl border border-slate-800"><p className="text-xs text-slate-400 uppercase">Win Rate</p><p className="text-2xl font-bold">{metrics.winRate.toFixed(1)}%</p></div>
        <div className="bg-[#0B1120] p-6 rounded-xl border border-slate-800"><p className="text-xs text-slate-400 uppercase">System</p><p className="text-2xl font-bold text-emerald-500">ARMED</p></div>
      </div>
      <div ref={chartContainerRef} className="rounded-xl overflow-hidden border border-slate-800 mb-6" />
      <div className="bg-[#0B1120] p-6 rounded-xl border border-slate-800">
        <h2 className="text-lg font-bold mb-4">Trade Ledger</h2>
        {logs.map((log: any) => (
            <div key={log.id} className="flex justify-between p-3 border-b border-slate-800 hover:bg-slate-900">
                <span className="font-mono text-sm">{new Date(log.timestamp).toLocaleTimeString()}</span>
                <span className="text-sm">{log.contract_targeted}</span>
                <span className={`font-bold ${Number(log.trade_pnl || 0) > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>₹{Number(log.trade_pnl || 0).toFixed(2)}</span>
            </div>
        ))}
      </div>
    </div>
  );
}
