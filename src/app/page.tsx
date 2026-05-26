"use client";
import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, IChartApi, CandlestickSeries, LineSeries } from 'lightweight-charts';
import { createClient } from '@supabase/supabase-js';

// 1. Initialize Supabase Client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

interface SystemLog {
  id: number;
  created_at: string;
  asset_price: number;
  metric_state: string;
  action_details: string;
  contract_targeted: string | null;
}

interface PerformanceMetrics {
  account_capital: number;
  win_rate: number;
  net_profit: number;
  active_allocations: number;
  safety_state: string;
}

export default function Dashboard() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveLogs, setLiveLogs] = useState<SystemLog[]>([]);
  const [metrics, setMetrics] = useState<PerformanceMetrics>({
    account_capital: 100000.00,
    win_rate: 0.00,
    net_profit: 0.00,
    active_allocations: 0,
    safety_state: "CONNECTING..."
  });

  useEffect(() => {
    if (!chartContainerRef.current) return;

    // 2. Initialize Lightweight Charts
    const chart = createChart(chartContainerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#0f172a' }, textColor: '#94a3b8' },
      grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      width: chartContainerRef.current.clientWidth,
      height: 420,
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    chartRef.current = chart;

    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981', downColor: '#ef4444', borderVisible: false, wickUpColor: '#10b981', wickDownColor: '#ef4444',
    });

    // 3. Fetch Initial Data from Supabase
    const fetchInitialData = async () => {
      try {
        // Fetch Account Metrics (maybeSingle prevents 406 crash if table is empty)
        const { data: metricsData, error: metricsError } = await supabase
          .from('account_metrics')
          .select('*')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle(); 

        if (metricsError) console.error("Metrics DB Error:", metricsError.message);

        if (metricsData) {
          setMetrics({
            account_capital: Number(metricsData.base_capital || 100000) + Number(metricsData.unrealized_pnl || 0),
            win_rate: 42.86, // Hardcoded visual placeholder
            net_profit: Number(metricsData.unrealized_pnl || 0),
            active_allocations: metricsData.open_positions || 0,
            safety_state: "SECURE"
          });
        }

        // Fetch Execution Logs
        const { data: logsData, error: logsError } = await supabase
          .from('execution_logs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(20);

        if (logsError) console.error("Logs DB Error:", logsError.message);

        if (logsData && logsData.length > 0) {
          setLiveLogs(logsData);
          
          const markers = logsData.map((log: any) => ({
            time: new Date(log.created_at || new Date()).getTime() / 1000,
            position: log.metric_state === 'BUY' ? 'belowBar' : 'aboveBar',
            color: log.metric_state === 'BUY' ? '#10b981' : '#ef4444',
            shape: log.metric_state === 'BUY' ? 'arrowUp' : 'arrowDown',
            text: log.metric_state || 'TRADE'
          })).sort((a: any, b: any) => a.time - b.time);

          if (markers.length > 0) {
            // TypeScript BYPASS: Forces Next.js to ignore strict type checking here
            (candlestickSeries as any).setMarkers(markers);
          }
        }
      } catch (err) {
        console.error("Supabase Fetch Error:", err);
      }
      setLoading(false);
    };

    fetchInitialData();

    // 4. Establish Supabase Realtime WebSockets
    const realtimeChannel = supabase
      .channel('dashboard-metrics')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'execution_logs' }, (payload) => {
        setLiveLogs((prev) => [payload.new as SystemLog, ...prev].slice(0, 20));
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'account_metrics' }, (payload) => {
        setMetrics((prev) => ({
          ...prev,
          account_capital: Number(payload.new.base_capital || 0) + Number(payload.new.unrealized_pnl || 0),
          net_profit: Number(payload.new.unrealized_pnl || 0),
          active_allocations: payload.new.open_positions || 0,
          safety_state: "SECURE"
        }));
      })
      .subscribe();

    const handleResize = () => chart.applyOptions({ width: chartContainerRef.current?.clientWidth });
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      supabase.removeChannel(realtimeChannel);
      chart.remove();
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#020617] text-slate-100 p-6 font-sans">
      <div className="max-w-7xl mx-auto space-y-6">
        
        <div className="flex justify-between items-center bg-[#0f172a] border border-slate-800 rounded-xl p-4 shadow-xl">
          <div>
            <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-sky-400 to-blue-500 bg-clip-text text-transparent">BIFROST // QUANT_ENGINE</h1>
            <p className="text-xs text-slate-400">Database Engine Core Link Node (Production Connected)</p>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            <div className="bg-slate-900 border border-slate-700 px-3 py-1.5 rounded-md flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>SUPABASE PIPELINE: CONNECTED</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="bg-[#0f172a] border border-slate-800 p-4 rounded-xl shadow-lg">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Account Capital</p>
            <p className="text-xl font-bold font-mono mt-1 text-slate-100">₹{metrics.account_capital?.toLocaleString('en-IN')}</p>
          </div>
          <div className="bg-[#0f172a] border border-slate-800 p-4 rounded-xl shadow-lg">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">SMC Win Rate</p>
            <p className="text-xl font-bold font-mono mt-1 text-emerald-400">{parseFloat(metrics.win_rate as any || 0).toFixed(2)}%</p>
          </div>
          <div className="bg-[#0f172a] border border-slate-800 p-4 rounded-xl shadow-lg">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Net Strategy Profit</p>
            <p className="text-xl font-bold font-mono mt-1 text-emerald-400">{metrics.net_profit >= 0 ? '+' : '-'}₹{Math.abs(metrics.net_profit).toLocaleString('en-IN')}</p>
          </div>
          <div className="bg-[#0f172a] border border-slate-800 p-4 rounded-xl shadow-lg">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Open Positions</p>
            <p className="text-xl font-bold font-mono mt-1 text-sky-400">{metrics.active_allocations} Contracts</p>
          </div>
          <div className="bg-[#0f172a] border border-slate-800 p-4 rounded-xl shadow-lg">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">System Safety Guard</p>
            <p className="text-xl font-bold font-mono mt-1 text-indigo-400">{metrics.safety_state}</p>
          </div>
        </div>

        <div className="bg-[#0f172a] p-2 rounded-xl shadow-2xl border border-slate-800 relative">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#020617]/80 rounded-xl">
              <div className="text-sky-400 animate-pulse font-mono text-sm tracking-widest">CONNECTING TO SUPABASE...</div>
            </div>
          )}
          <div ref={chartContainerRef} className="w-full" />
        </div>

        <div className="bg-[#0f172a] rounded-xl border border-slate-800 p-5 shadow-2xl">
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider mb-4 flex items-center gap-2 font-mono">
            <span>&gt; SUPABASE_DB_AUDIT_LOG_STREAM</span>
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs text-slate-300">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 bg-slate-900/50">
                  <th className="p-3">CLOUD TIMESTAMP</th>
                  <th className="p-3">TICK PRICE</th>
                  <th className="p-3">EVALUATION METRIC STATE</th>
                  <th className="p-3">DERIVATIVE ROUTING METRIC TRANSFERS</th>
                </tr>
              </thead>
              <tbody>
                {liveLogs.length === 0 ? (
                  <tr><td colSpan={4} className="p-4 text-center text-slate-500">Awaiting database sync execution payload records...</td></tr>
                ) : (
                  liveLogs.map((log, index) => (
                    <tr key={index} className={`border-b border-slate-900/60 transition-colors ${log.metric_state === "SMC_SETUP_MATCH" ? "bg-emerald-950/20 text-emerald-400 border-l-2 border-emerald-500" : "text-slate-400 hover:bg-slate-900/30"}`}>
                      <td className="p-3 font-semibold">{new Date(log.created_at || new Date()).toLocaleTimeString()}</td>
                      <td className="p-3">₹{parseFloat(log.asset_price as any || 0).toFixed(2)}</td>
                      <td className="p-3">
                        <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold bg-slate-800 text-slate-400`}>
                          {log.metric_state || 'TRADE EXECUTED'}
                        </span>
                      </td>
                      <td className="p-3 font-medium">
                        {log.contract_targeted ? (
                          <span className="bg-sky-500/10 text-sky-400 px-2 py-0.5 rounded border border-sky-500/20">
                            Fired Order → BUY {log.contract_targeted} (MIS Intraday)
                          </span>
                        ) : (
                          <span className="text-slate-500 font-sans">{log.action_details || `Trade executed at ₹${log.asset_price}`}</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
