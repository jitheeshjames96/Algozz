"use client";
import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, IChartApi, LineSeries } from 'lightweight-charts';
import { createClient } from '@supabase/supabase-js';

// 1. Initialize Supabase Client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

interface SystemLog {
  id: number;
  timestamp: string;
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

    // COMPILER FIX: Updated syntax for lightweight-charts v4+
    const executionSeries = chart.addSeries(LineSeries, {
      color: '#38bdf8', 
      lineWidth: 2,
      crosshairMarkerVisible: true,
    });

    // 3. Fetch Initial Data
    const fetchInitialData = async () => {
      try {
        const { data: metricsData } = await supabase
          .from('account_metrics')
          .select('*')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle(); 

        if (metricsData) {
          setMetrics({
            account_capital: Number(metricsData.base_capital || 100000) + Number(metricsData.unrealized_pnl || 0),
            win_rate: Number(metricsData.win_rate || 0),
            net_profit: Number(metricsData.unrealized_pnl || 0),
            active_allocations: metricsData.open_positions || 0,
            safety_state: "SYSTEM LIVE & ARMED"
          });
        }

        const { data: logsData } = await supabase
          .from('execution_logs')
          .select('*')
          .order('timestamp', { ascending: true }) 
          .limit(100);

        if (logsData && logsData.length > 0) {
          setLiveLogs([...logsData].reverse().slice(0, 30)); 
          
          const chartData = logsData.map((log: any) => ({
             time: new Date(log.timestamp).getTime() / 1000,
             value: Number(log.asset_price)
          }));
          
          const uniqueChartData = chartData.filter((v, i, a) => a.findIndex(t => (t.time === v.time)) === i);
          if (uniqueChartData.length > 0) executionSeries.setData(uniqueChartData);
          
          const markers = uniqueChartData.map((point: any) => ({
            time: point.time,
            position: 'belowBar',
            color: '#10b981',
            shape: 'arrowUp',
            text: 'EXECUTION'
          }));

          if (markers.length > 0) (executionSeries as any).setMarkers(markers);
        }
      } catch (err) {
        console.error("Supabase Fetch Error:", err);
      }
      setLoading(false);
    };

    fetchInitialData();

    // 4. Realtime WebSockets
    const realtimeChannel = supabase
      .channel('dashboard-metrics')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'execution_logs' }, (payload) => {
        setLiveLogs((prev) => [payload.new as SystemLog, ...prev].slice(0, 30));
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'account_metrics' }, (payload) => {
        setMetrics((prev) => ({
          ...prev,
          account_capital: Number(payload.new.base_capital || 0) + Number(payload.new.unrealized_pnl || 0),
          net_profit: Number(payload.new.unrealized_pnl || 0),
          active_allocations: payload.new.open_positions || 0,
          win_rate: Number(payload.new.win_rate || prev.win_rate)
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

  // UI HELPER: Determine Trade Outcome Color
  const getOutcomeStyle = (details: string, state: string) => {
    const text = (details + " " + state).toUpperCase();
    if (text.includes('STOP LOSS') || text.includes('SL HIT') || text.includes('LOSS')) {
      return "bg-rose-500/10 border-l-2 border-rose-500 text-rose-400";
    }
    if (text.includes('TARGET') || text.includes('PROFIT') || text.includes('TP HIT')) {
      return "bg-emerald-500/10 border-l-2 border-emerald-500 text-emerald-400";
    }
    if (text.includes('BUY') || text.includes('SELL') || text.includes('EXECUTED')) {
      return "bg-sky-500/10 border-l-2 border-sky-500 text-sky-400";
    }
    return "hover:bg-slate-900/50 text-slate-400";
  };

  return (
    <div className="min-h-screen bg-[#020617] text-slate-100 p-6 font-sans">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* HEADER */}
        <div className="flex justify-between items-center bg-[#0f172a] border border-slate-800 rounded-xl p-4 shadow-xl">
          <div>
            <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-sky-400 to-blue-500 bg-clip-text text-transparent">BIFROST // QUANT_ENGINE</h1>
            <p className="text-xs text-slate-400">Autonomous Market Execution Node</p>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            <div className="bg-slate-900 border border-slate-700 px-3 py-1.5 rounded-md flex items-center gap-2 shadow-inner">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.8)]" />
              <span className="text-emerald-400 font-semibold">DATA PIPELINE ACTIVE</span>
            </div>
          </div>
        </div>

        {/* METRICS ROW */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="bg-[#0f172a] border border-slate-800 p-4 rounded-xl shadow-lg relative overflow-hidden">
            <div className="absolute top-0 right-0 w-16 h-16 bg-slate-800/20 rounded-bl-full -mr-8 -mt-8" />
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Account Equity</p>
            <p className="text-2xl font-bold font-mono mt-1 text-slate-100">₹{metrics.account_capital?.toLocaleString('en-IN', {minimumFractionDigits: 2})}</p>
          </div>
          
          <div className="bg-[#0f172a] border border-slate-800 p-4 rounded-xl shadow-lg">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Win/Loss Ratio</p>
            <p className={`text-2xl font-bold font-mono mt-1 ${metrics.win_rate >= 50 ? 'text-emerald-400' : 'text-amber-400'}`}>
              {metrics.win_rate.toFixed(1)}%
            </p>
          </div>

          <div className="bg-[#0f172a] border border-slate-800 p-4 rounded-xl shadow-lg">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Net PnL</p>
            <p className={`text-2xl font-bold font-mono mt-1 ${metrics.net_profit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {metrics.net_profit >= 0 ? '+' : '-'}₹{Math.abs(metrics.net_profit).toLocaleString('en-IN', {minimumFractionDigits: 2})}
            </p>
          </div>

          <div className="bg-[#0f172a] border border-slate-800 p-4 rounded-xl shadow-lg">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Active Contracts</p>
            <p className="text-2xl font-bold font-mono mt-1 text-sky-400">{metrics.active_allocations}</p>
          </div>

          <div className="bg-[#0f172a] border border-slate-800 p-4 rounded-xl shadow-lg">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">System Status</p>
            <p className="text-xl font-bold font-mono mt-2 text-emerald-500">{metrics.safety_state}</p>
          </div>
        </div>

        {/* CHART */}
        <div className="bg-[#0f172a] p-2 rounded-xl shadow-2xl border border-slate-800 relative">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#020617]/80 rounded-xl">
              <div className="text-sky-400 animate-pulse font-mono text-sm tracking-widest">RENDERING MARKET DATA...</div>
            </div>
          )}
          <div ref={chartContainerRef} className="w-full" />
        </div>

        {/* PROFESSIONAL TRADE LEDGER */}
        <div className="bg-[#0f172a] rounded-xl border border-slate-800 p-5 shadow-2xl">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-2 font-mono">
              <svg className="w-4 h-4 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
              LIVE TRADE LEDGER
            </h2>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs text-slate-300">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 bg-slate-900/80">
                  <th className="p-3 font-semibold tracking-wider">TIME (IST)</th>
                  <th className="p-3 font-semibold tracking-wider">ASSET / PRICE</th>
                  <th className="p-3 font-semibold tracking-wider">TRADE BASIS (SETUP)</th>
                  <th className="p-3 font-semibold tracking-wider">OUTCOME / DETAILS</th>
                </tr>
              </thead>
              <tbody>
                {liveLogs.length === 0 ? (
                  <tr><td colSpan={4} className="p-6 text-center text-slate-500 italic">Awaiting execution data from AWS engine...</td></tr>
                ) : (
                  liveLogs.map((log, index) => {
                    const rowStyle = getOutcomeStyle(log.action_details || "", log.metric_state || "");
                    
                    return (
                      <tr key={index} className={`border-b border-slate-800/50 transition-colors ${rowStyle}`}>
                        
                        {/* Time */}
                        <td className="p-3 whitespace-nowrap opacity-90">
                          {new Date(log.timestamp || new Date()).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second:'2-digit' })}
                        </td>
                        
                        {/* Asset / Price */}
                        <td className="p-3 font-semibold">
                          <span className="block text-slate-200">{log.contract_targeted || "NIFTY50-INDEX"}</span>
                          <span className="text-slate-500 text-[10px]">₹{parseFloat(log.asset_price as any || 0).toFixed(2)}</span>
                        </td>
                        
                        {/* Strategy / Setup */}
                        <td className="p-3">
                          <span className="px-2 py-1 rounded bg-slate-950/40 border border-slate-700/50 text-[10px] uppercase font-bold tracking-wider">
                            {log.metric_state || 'MARKET_EXECUTION'}
                          </span>
                        </td>
                        
                        {/* Outcome & Details */}
                        <td className="p-3">
                          <span className="font-medium tracking-wide">
                            {log.action_details || "Order executed successfully."}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  );
}
