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
      height: 380,
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    chartRef.current = chart;

    const executionSeries = chart.addSeries(LineSeries, {
      color: '#38bdf8', 
      lineWidth: 2,
      crosshairMarkerVisible: true,
      priceLineVisible: true,
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
            safety_state: metricsData.open_positions > 0 ? "MARKET EXPOSED" : "FLAT (NO EXPOSURE)"
          });
        }

        const { data: logsData } = await supabase
          .from('execution_logs')
          .select('*')
          .order('timestamp', { ascending: true }) 
          .limit(200);

        if (logsData && logsData.length > 0) {
          setLiveLogs([...logsData].reverse().slice(0, 50)); 
          
          const chartData = logsData
            .map((log: any) => ({
               time: Math.floor(new Date(log.timestamp).getTime() / 1000),
               value: Number(log.asset_price)
            }))
            .filter((data: any) => data.value > 100); // FIX: Prevents anomalous drops to 0 on the chart
          
          const uniqueChartData = chartData.filter((v: any, i: number, a: any[]) => a.findIndex(t => (t.time === v.time)) === i);
          
          if (uniqueChartData.length > 0) {
            (executionSeries as any).setData(uniqueChartData);
            
            const markers = uniqueChartData.map((point: any) => ({
              time: point.time,
              position: 'belowBar',
              color: '#10b981',
              shape: 'arrowUp',
              text: 'B'
            }));
            (executionSeries as any).setMarkers(markers);
          }
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
        setLiveLogs((prev) => [payload.new as SystemLog, ...prev].slice(0, 50));
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'account_metrics' }, (payload) => {
        setMetrics((prev) => ({
          ...prev,
          account_capital: Number(payload.new.base_capital || 0) + Number(payload.new.unrealized_pnl || 0),
          net_profit: Number(payload.new.unrealized_pnl || 0),
          active_allocations: payload.new.open_positions || 0,
          safety_state: payload.new.open_positions > 0 ? "MARKET EXPOSED" : "FLAT (NO EXPOSURE)",
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

  return (
    <div className="min-h-screen bg-[#020617] text-slate-100 p-6 font-sans">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* HEADER */}
        <div className="flex justify-between items-center bg-[#0f172a] border border-slate-800 rounded-xl p-4 shadow-lg">
          <div>
            <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-sky-400 to-blue-500 bg-clip-text text-transparent">BIFROST // QUANT_TERMINAL</h1>
            <p className="text-xs text-slate-400">AWS EC2 Production Engine // Indian Standard Time (IST)</p>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            <div className="bg-slate-900 border border-slate-700 px-3 py-1.5 rounded-md flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.8)]" />
              <span className="text-emerald-400 font-semibold">BROKER PIPELINE ACTIVE</span>
            </div>
          </div>
        </div>

        {/* BROKER METRICS STRIP */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-[#0f172a] border border-slate-800 p-4 rounded-xl shadow-lg border-t-2 border-t-sky-500">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Available Margin</p>
            <p className="text-2xl font-bold font-mono mt-1 text-slate-100">₹{metrics.account_capital?.toLocaleString('en-IN', {minimumFractionDigits: 2})}</p>
          </div>

          <div className="bg-[#0f172a] border border-slate-800 p-4 rounded-xl shadow-lg border-t-2 border-t-indigo-500">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Active Positions</p>
            <div className="flex items-baseline gap-2 mt-1">
              <p className="text-2xl font-bold font-mono text-indigo-400">{metrics.active_allocations}</p>
              <p className="text-xs text-slate-500 font-mono">Open Contracts</p>
            </div>
          </div>

          <div className="bg-[#0f172a] border border-slate-800 p-4 rounded-xl shadow-lg border-t-2 border-t-amber-500">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Total P&L (MTM)</p>
            <p className={`text-2xl font-bold font-mono mt-1 ${metrics.net_profit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {metrics.net_profit >= 0 ? '+' : '-'}₹{Math.abs(metrics.net_profit).toLocaleString('en-IN', {minimumFractionDigits: 2})}
            </p>
          </div>

          <div className="bg-[#0f172a] border border-slate-800 p-4 rounded-xl shadow-lg border-t-2 border-t-slate-500">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">System State</p>
            <p className={`text-xl font-bold font-mono mt-2 ${metrics.active_allocations > 0 ? 'text-sky-400' : 'text-slate-400'}`}>
              {metrics.safety_state}
            </p>
          </div>
        </div>

        {/* MAIN TERMINAL LAYOUT */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* LEFT: CHART & ACTIVE POSITIONS */}
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-[#0f172a] p-2 rounded-xl shadow-2xl border border-slate-800 relative">
              <div className="absolute top-4 left-4 z-10 flex gap-2">
                <span className="px-2 py-1 bg-slate-900/80 rounded border border-slate-700 text-xs font-mono text-slate-300">NIFTY50 / PRICE TRAJECTORY</span>
              </div>
              {loading && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#020617]/80 rounded-xl">
                  <div className="text-sky-400 animate-pulse font-mono text-sm tracking-widest">LOADING MARKET DATA...</div>
                </div>
              )}
              <div ref={chartContainerRef} className="w-full" />
            </div>

            {/* ACTIVE POSITIONS WIDGET */}
            <div className="bg-[#0f172a] rounded-xl border border-slate-800 shadow-2xl overflow-hidden">
              <div className="bg-slate-900/50 p-4 border-b border-slate-800 flex justify-between items-center">
                <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-2 font-mono">
                  <div className={`w-2 h-2 rounded-full ${metrics.active_allocations > 0 ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`} />
                  OPEN POSITIONS
                </h2>
                {metrics.active_allocations > 0 && (
                   <span className="text-xs font-mono text-slate-400">Auto-Square Off scheduled for 15:15 IST</span>
                )}
              </div>
              <div className="p-4">
                {metrics.active_allocations === 0 ? (
                  <div className="text-center py-6">
                    <p className="text-slate-500 font-mono text-sm">No active positions. Engine is seeking setups.</p>
                  </div>
                ) : (
                  <div className="flex justify-between items-center p-4 bg-slate-900/50 rounded-lg border border-slate-700/50">
                    <div>
                      <p className="text-lg font-bold text-sky-400">NIFTY DERIVATIVES</p>
                      <p className="text-xs text-slate-400 mt-1">Managed by AWS Node • MIS</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-slate-400 uppercase mb-1">Live MTM</p>
                      <p className={`text-xl font-mono font-bold ${metrics.net_profit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {metrics.net_profit >= 0 ? '+' : '-'}₹{Math.abs(metrics.net_profit).toLocaleString('en-IN', {minimumFractionDigits: 2})}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* RIGHT: ORDER BOOK / HISTORICAL LEDGER */}
          <div className="bg-[#0f172a] rounded-xl border border-slate-800 shadow-2xl flex flex-col h-[650px]">
            <div className="p-4 border-b border-slate-800 bg-slate-900/50">
              <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-2 font-mono">
                <svg className="w-4 h-4 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                ORDER BOOK
              </h2>
            </div>
            
            <div className="overflow-y-auto flex-1 p-2 space-y-2">
              {liveLogs.length === 0 ? (
                <div className="p-6 text-center text-slate-500 italic text-xs">Awaiting execution data...</div>
              ) : (
                liveLogs.map((log, index) => {
                  const details = (log.action_details || "").toUpperCase();
                  const isLoss = details.includes('LOSS') || details.includes('SL');
                  const isProfit = details.includes('PROFIT') || details.includes('TARGET');
                  
                  return (
                    <div key={index} className="bg-slate-900/40 p-3 rounded-lg border border-slate-800/60 hover:border-slate-700 transition-colors">
                      <div className="flex justify-between items-start mb-2">
                        <span className={`text-[10px] px-2 py-0.5 rounded font-bold tracking-wider ${isProfit ? 'bg-emerald-500/10 text-emerald-400' : isLoss ? 'bg-rose-500/10 text-rose-400' : 'bg-sky-500/10 text-sky-400'}`}>
                          {isProfit ? 'PROFIT TAKEN' : isLoss ? 'STOP LOSS HIT' : 'ORDER EXECUTED'}
                        </span>
                        <span className="text-[10px] font-mono text-slate-500">
                          {new Date(log.timestamp || new Date()).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second:'2-digit' })}
                        </span>
                      </div>
                      <p className="text-sm font-semibold text-slate-200">{log.contract_targeted || "NIFTY50"}</p>
                      <div className="flex justify-between mt-1 text-xs">
                        <span className="text-slate-400">Price: ₹{parseFloat(log.asset_price as any || 0).toFixed(2)}</span>
                        <span className="text-slate-500 truncate max-w-[120px]">{log.metric_state}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          
        </div>
      </div>
    </div>
  );
}
