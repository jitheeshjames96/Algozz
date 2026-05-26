"use client";
import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, IChartApi, LineSeries } from 'lightweight-charts';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase Client
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");

interface SystemLog {
  id: number;
  timestamp: string;
  asset_price: number;
  metric_state: string;
  action_details: string;
  contract_targeted: string | null;
}

interface PerformanceMetrics {
  base_capital: number;
  unrealized_pnl: number;
  realized_pnl: number;
  win_rate: number;
  open_positions: number;
  safety_state: string;
}

export default function Dashboard() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveLogs, setLiveLogs] = useState<SystemLog[]>([]);
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<PerformanceMetrics>({
    base_capital: 100000.00,
    unrealized_pnl: 0.00,
    realized_pnl: 0.00,
    win_rate: 0.00,
    open_positions: 0,
    safety_state: "INITIALIZING..."
  });

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8' },
      grid: { vertLines: { color: '#1e293b80' }, horzLines: { color: '#1e293b80' } },
      width: chartContainerRef.current.clientWidth,
      height: 400,
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#334155' },
    });
    chartRef.current = chart;

    const areaSeries = chart.addSeries(LineSeries, {
      color: '#38bdf8',
      lineWidth: 2,
      priceLineVisible: true,
    });

    const fetchInitialData = async () => {
      try {
        const { data: mData } = await supabase.from('account_metrics').select('*').order('updated_at', { ascending: false }).limit(1).maybeSingle(); 
        if (mData) {
          setMetrics({
            base_capital: Number(mData.base_capital || 100000),
            unrealized_pnl: Number(mData.unrealized_pnl || 0),
            realized_pnl: Number(mData.realized_pnl || 0),
            win_rate: Number(mData.win_rate || 0),
            open_positions: Number(mData.open_positions || 0),
            safety_state: mData.open_positions > 0 ? "EXPOSURE ACTIVE" : "FLAT"
          });
        }

        const { data: logsData } = await supabase.from('execution_logs').select('*').order('timestamp', { ascending: true }).limit(300);
        
        if (logsData && logsData.length > 0) {
          setLiveLogs([...logsData].reverse()); 
          
          const chartData = logsData
            .map((log: any) => ({ time: Math.floor(new Date(log.timestamp).getTime() / 1000), value: Number(log.asset_price) }))
            .filter((data: any) => data.value > 100);
          
          if (chartData.length > 0) {
             (areaSeries as any).setData(chartData);
             const markers = chartData.map((p: any) => ({ time: p.time, position: 'belowBar', color: '#10b981', shape: 'arrowUp', text: 'B' }));
             (areaSeries as any).setMarkers(markers);
          }
        }
      } catch (err) { console.error("DB Error:", err); }
      setLoading(false);
    };

    fetchInitialData();

    const channel = supabase.channel('realtime-bot')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'execution_logs' }, (payload) => {
        setLiveLogs((prev) => [payload.new as SystemLog, ...prev]);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'account_metrics' }, (payload) => {
        setMetrics((prev) => ({ ...prev, ...payload.new }));
      }).subscribe();

    const handleResize = () => chart.applyOptions({ width: chartContainerRef.current?.clientWidth });
    window.addEventListener('resize', handleResize);
    return () => { window.removeEventListener('resize', handleResize); supabase.removeChannel(channel); chart.remove(); };
  }, []);

  return (
    <div className="min-h-screen bg-[#020617] text-slate-100 p-8 font-sans">
      <div className="max-w-[1400px] mx-auto space-y-6">
        <div className="flex justify-between items-center bg-[#0B1120] border border-slate-800 rounded-2xl p-6">
          <h1 className="text-3xl font-extrabold text-sky-400">BIFROST // QUANT_TERMINAL</h1>
          <span className="text-emerald-400 font-bold bg-emerald-500/10 px-4 py-1 rounded-full text-sm">SYSTEM ARMED</span>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <div className="bg-[#0B1120] p-5 rounded-2xl border border-slate-800">
            <p className="text-slate-400 text-xs uppercase">Equity</p>
            <p className="text-2xl font-mono">₹{(metrics.base_capital + metrics.unrealized_pnl + metrics.realized_pnl).toLocaleString()}</p>
          </div>
          <div className="bg-[#0B1120] p-5 rounded-2xl border border-slate-800">
             <p className="text-slate-400 text-xs uppercase">Realized PnL</p>
             <p className="text-2xl font-mono text-emerald-400">₹{metrics.realized_pnl.toLocaleString()}</p>
          </div>
          <div className="bg-[#0B1120] p-5 rounded-2xl border border-slate-800">
             <p className="text-slate-400 text-xs uppercase">Unrealized MTM</p>
             <p className="text-2xl font-mono text-sky-400">₹{metrics.unrealized_pnl.toLocaleString()}</p>
          </div>
          <div className="bg-[#0B1120] p-5 rounded-2xl border border-slate-800">
             <p className="text-slate-400 text-xs uppercase">Win Ratio</p>
             <p className="text-2xl font-mono">{metrics.win_rate}%</p>
          </div>
        </div>

        <div ref={chartContainerRef} className="bg-[#0B1120] border border-slate-800 rounded-2xl" />

        <div className="bg-[#0B1120] border border-slate-800 rounded-2xl p-5">
           <h2 className="text-lg font-bold mb-4">LIVE TRADE LEDGER</h2>
           {liveLogs.map(log => (
             <div key={log.id} onClick={() => setExpandedLogId(expandedLogId === log.id ? null : log.id)} className="p-4 border-b border-slate-800 cursor-pointer hover:bg-slate-900">
                <div className="flex justify-between">
                  <span>{log.contract_targeted}</span>
                  <span className={log.action_details?.includes('LOSS') ? 'text-rose-400' : 'text-emerald-400'}>{log.action_details}</span>
                </div>
             </div>
           ))}
        </div>
      </div>
    </div>
  );
}
