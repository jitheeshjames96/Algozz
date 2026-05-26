"use client";
import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, IChartApi, AreaSeries } from 'lightweight-charts';
import { createClient } from '@supabase/supabase-js';

// --- SUPABASE CLIENT ---
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

// --- INTERFACES ---
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
  realized_pnl: number; // Added for realistic vs unrealistic
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

  // --- CHART INITIALIZATION & DATA FETCHING ---
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8' },
      grid: { vertLines: { color: '#1e293b80' }, horzLines: { color: '#1e293b80' } },
      width: chartContainerRef.current.clientWidth,
      height: 400,
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#334155' },
      rightPriceScale: { borderColor: '#334155' },
      crosshair: {
        mode: 1, // Magnet mode
        vertLine: { color: '#38bdf8', width: 1, style: 3, labelBackgroundColor: '#0284c7' },
        horzLine: { color: '#38bdf8', width: 1, style: 3, labelBackgroundColor: '#0284c7' },
      }
    });
    chartRef.current = chart;

    const areaSeries = chart.addSeries(AreaSeries, {
      lineColor: '#38bdf8',
      topColor: 'rgba(56, 189, 248, 0.4)',
      bottomColor: 'rgba(56, 189, 248, 0.0)',
      lineWidth: 2,
      priceLineColor: '#38bdf8',
      crosshairMarkerRadius: 6,
    });

    const fetchInitialData = async () => {
      try {
        // 1. Fetch Metrics
        const { data: mData } = await supabase.from('account_metrics').select('*').order('updated_at', { ascending: false }).limit(1).maybeSingle(); 
        if (mData) {
          setMetrics({
            base_capital: Number(mData.base_capital || 100000),
            unrealized_pnl: Number(mData.unrealized_pnl || 0),
            realized_pnl: Number(mData.realized_pnl || 0), // Assuming backend provides this
            win_rate: Number(mData.win_rate || 0),
            open_positions: Number(mData.open_positions || 0),
            safety_state: mData.open_positions > 0 ? "EXPOSURE ACTIVE" : "FLAT (NO EXPOSURE)"
          });
        }

        // 2. Fetch Logs
        const { data: logsData } = await supabase.from('execution_logs').select('*').order('timestamp', { ascending: true }).limit(300);
        
        if (logsData && logsData.length > 0) {
          setLiveLogs([...logsData].reverse()); 
          
          const chartData = logsData
            .map((log: any) => ({ time: Math.floor(new Date(log.timestamp).getTime() / 1000), value: Number(log.asset_price) }))
            .filter((data: any) => data.value > 0);
          
          const uniqueChartData = chartData.filter((v: any, i: number, a: any[]) => a.findIndex(t => (t.time === v.time)) === i);
          if (uniqueChartData.length > 0) (areaSeries as any).setData(uniqueChartData);
          
          // 3. Generate TradingView Markers
          const markers = uniqueChartData.map((point: any, index: number) => {
            const originalLog = logsData.find((l: any) => Math.floor(new Date(l.timestamp).getTime() / 1000) === point.time);
            if (!originalLog) return null;
            
            const isBuy = originalLog.action_details?.toUpperCase().includes('BUY');
            const isSell = originalLog.action_details?.toUpperCase().includes('SELL') || originalLog.action_details?.toUpperCase().includes('LOSS');
            
            if (isBuy) return { time: point.time, position: 'belowBar', color: '#10b981', shape: 'arrowUp', text: 'BUY' };
            if (isSell) return { time: point.time, position: 'aboveBar', color: '#ef4444', shape: 'arrowDown', text: 'EXIT' };
            return null;
          }).filter(Boolean);

          if (markers.length > 0) (areaSeries as any).setMarkers(markers);
        }
      } catch (err) { console.error("DB Error:", err); }
      setLoading(false);
    };

    fetchInitialData();

    // --- REALTIME SUBSCRIPTION ---
    const channel = supabase.channel('realtime-bot')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'execution_logs' }, (payload) => {
        setLiveLogs((prev) => [payload.new as SystemLog, ...prev]);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'account_metrics' }, (payload) => {
        setMetrics({
          base_capital: Number(payload.new.base_capital || 100000),
          unrealized_pnl: Number(payload.new.unrealized_pnl || 0),
          realized_pnl: Number(payload.new.realized_pnl || 0),
          win_rate: Number(payload.new.win_rate || metrics.win_rate),
          open_positions: Number(payload.new.open_positions || 0),
          safety_state: payload.new.open_positions > 0 ? "EXPOSURE ACTIVE" : "FLAT (NO EXPOSURE)"
        });
      }).subscribe();

    const handleResize = () => chart.applyOptions({ width: chartContainerRef.current?.clientWidth });
    window.addEventListener('resize', handleResize);
    return () => { window.removeEventListener('resize', handleResize); supabase.removeChannel(channel); chart.remove(); };
  }, []);

  // --- DERIVED DAILY ANALYTICS ---
  const todayStr = new Date().toLocaleDateString();
  const todaysLogs = liveLogs.filter(log => new Date(log.timestamp).toLocaleDateString() === todayStr);
  const todaysTradesCount = todaysLogs.length;
  
  // Calculate a mock Daily PnL based on Win/Loss strings if backend doesn't provide exact daily PnL
  const dailyWins = todaysLogs.filter(l => l.action_details?.toUpperCase().includes('PROFIT') || l.action_details?.toUpperCase().includes('TARGET')).length;
  const dailyLosses = todaysLogs.filter(l => l.action_details?.toUpperCase().includes('LOSS') || l.action_details?.toUpperCase().includes('SL')).length;
  const dailyWinRate = todaysTradesCount > 0 ? ((dailyWins / (dailyWins + dailyLosses || 1)) * 100).toFixed(1) : "0.0";

  const totalEquity = metrics.base_capital + metrics.realized_pnl + metrics.unrealized_pnl;

  return (
    <div className="min-h-screen bg-[#020617] text-slate-100 p-4 md:p-8 font-sans selection:bg-sky-500/30">
      <div className="max-w-[1400px] mx-auto space-y-6">
        
        {/* --- HEADER --- */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center bg-[#0B1120] border border-slate-800/60 rounded-2xl p-6 shadow-2xl backdrop-blur-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-sky-500/5 rounded-full blur-3xl -mr-32 -mt-32" />
          <div className="z-10">
            <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-sky-400 via-blue-500 to-indigo-500 bg-clip-text text-transparent drop-shadow-sm">BIFROST // TERMINAL</h1>
            <p className="text-sm text-slate-400 mt-1 font-mono">Quant Execution Engine v2.0 • IST Timezone</p>
          </div>
          <div className="z-10 mt-4 md:mt-0 flex items-center gap-3 bg-[#0f172a] border border-slate-700/50 px-4 py-2 rounded-xl shadow-inner">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_12px_rgba(16,185,129,0.9)]" />
            <span className="text-sm text-emerald-400 font-bold tracking-wide">SYSTEM ARMED</span>
          </div>
        </div>

        {/* --- KPI METRICS STRIP --- */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          
          {/* Main Fund / Equity */}
          <div className="col-span-2 lg:col-span-1 bg-gradient-to-br from-[#0f172a] to-[#0B1120] border border-slate-800/80 p-5 rounded-2xl shadow-xl hover:border-sky-500/30 transition-colors">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2">Net Equity</p>
            <p className="text-3xl font-bold font-mono text-slate-100">₹{totalEquity.toLocaleString('en-IN', {minimumFractionDigits: 2})}</p>
            <p className="text-xs text-slate-500 mt-2 font-mono">Base: ₹{metrics.base_capital.toLocaleString('en-IN')}</p>
          </div>

          {/* Realized PnL */}
          <div className="bg-gradient-to-br from-[#0f172a] to-[#0B1120] border border-slate-800/80 p-5 rounded-2xl shadow-xl hover:border-slate-700 transition-colors">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2 flex items-center justify-between">Realized P&L <span className="text-[10px] bg-slate-800 px-2 py-0.5 rounded text-slate-300">BOOKED</span></p>
            <p className={`text-2xl font-bold font-mono ${metrics.realized_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {metrics.realized_pnl >= 0 ? '+' : '-'}₹{Math.abs(metrics.realized_pnl).toLocaleString('en-IN', {minimumFractionDigits: 2})}
            </p>
          </div>

          {/* Unrealized (MTM) PnL */}
          <div className="bg-gradient-to-br from-[#0f172a] to-[#0B1120] border border-slate-800/80 p-5 rounded-2xl shadow-xl hover:border-slate-700 transition-colors relative overflow-hidden">
            {metrics.unrealized_pnl !== 0 && <div className={`absolute top-0 right-0 w-1 h-full ${metrics.unrealized_pnl > 0 ? 'bg-emerald-500' : 'bg-rose-500'}`} />}
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2 flex items-center justify-between">Unrealized P&L <span className="text-[10px] bg-sky-500/20 text-sky-400 px-2 py-0.5 rounded animate-pulse">LIVE</span></p>
            <p className={`text-2xl font-bold font-mono ${metrics.unrealized_pnl >= 0 ? 'text-sky-400' : 'text-rose-400'}`}>
              {metrics.unrealized_pnl >= 0 ? '+' : '-'}₹{Math.abs(metrics.unrealized_pnl).toLocaleString('en-IN', {minimumFractionDigits: 2})}
            </p>
          </div>

          {/* Daily Analytics */}
          <div className="bg-gradient-to-br from-[#0f172a] to-[#0B1120] border border-slate-800/80 p-5 rounded-2xl shadow-xl hover:border-slate-700 transition-colors">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2">Today's Session</p>
            <div className="flex justify-between items-end">
              <div>
                <p className="text-2xl font-bold font-mono text-indigo-400">{todaysTradesCount}</p>
                <p className="text-[10px] text-slate-500 font-mono mt-1">TOTAL TRADES</p>
              </div>
              <div className="text-right">
                <p className="text-xl font-bold font-mono text-slate-200">{dailyWinRate}%</p>
                <p className="text-[10px] text-slate-500 font-mono mt-1">DAILY WIN RATE</p>
              </div>
            </div>
          </div>

          {/* Active Positions */}
          <div className="bg-gradient-to-br from-[#0f172a] to-[#0B1120] border border-slate-800/80 p-5 rounded-2xl shadow-xl hover:border-slate-700 transition-colors">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2">Market Exposure</p>
            <p className={`text-2xl font-bold font-mono ${metrics.open_positions > 0 ? 'text-amber-400' : 'text-slate-500'}`}>{metrics.open_positions} <span className="text-sm font-sans text-slate-400 font-normal">Contracts</span></p>
            <p className="text-[10px] text-slate-500 font-mono mt-2">{metrics.safety_state}</p>
          </div>

        </div>

        {/* --- MAIN LAYOUT --- */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          
          {/* LEFT: CHART */}
          <div className="xl:col-span-2 space-y-6">
            <div className="bg-[#0B1120] p-4 rounded-2xl shadow-2xl border border-slate-800/60 relative">
              <div className="flex justify-between items-center mb-4 px-2">
                <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                  <svg className="w-5 h-5 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"></path></svg>
                  MARKET TRAJECTORY (NIFTY50)
                </h2>
                <span className="px-2 py-1 bg-slate-800/50 rounded text-xs font-mono text-slate-400 border border-slate-700">1m Timeframe</span>
              </div>
              
              {loading && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0B1120]/80 rounded-2xl backdrop-blur-sm">
                  <div className="text-sky-400 animate-pulse font-mono text-sm tracking-widest border border-sky-500/30 bg-sky-500/10 px-6 py-3 rounded-full">SYPHONING MARKET DATA...</div>
                </div>
              )}
              {/* Chart Mount */}
              <div ref={chartContainerRef} className="w-full rounded-xl overflow-hidden" />
            </div>

            {/* ACTIVE POSITIONS WIDGET */}
            <div className="bg-[#0B1120] rounded-2xl border border-slate-800/60 shadow-2xl overflow-hidden">
              <div className="bg-slate-900/50 p-5 border-b border-slate-800 flex justify-between items-center">
                <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${metrics.open_positions > 0 ? 'bg-amber-500 animate-pulse' : 'bg-slate-600'}`} />
                  LIVE OPEN POSITIONS
                </h2>
              </div>
              <div className="p-6">
                {metrics.open_positions === 0 ? (
                  <div className="text-center py-8">
                    <svg className="w-12 h-12 text-slate-700 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    <p className="text-slate-400 font-mono text-sm">No active positions. Scanning for algorithmic setups.</p>
                  </div>
                ) : (
                  <div className="flex flex-col md:flex-row justify-between items-center p-5 bg-gradient-to-r from-slate-900 to-[#0B1120] rounded-xl border border-slate-700/50 shadow-inner gap-4">
                    <div>
                      <span className="bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider mb-2 inline-block">MIS INTRADAY</span>
                      <p className="text-xl font-bold text-slate-100">NIFTY OPTIONS (AUTO)</p>
                      <p className="text-sm text-slate-400 mt-1 font-mono">Qty: {metrics.open_positions} Contracts</p>
                    </div>
                    <div className="text-center md:text-right">
                      <p className="text-xs text-slate-500 uppercase tracking-widest mb-1">Live MTM</p>
                      <p className={`text-3xl font-mono font-bold ${metrics.unrealized_pnl >= 0 ? 'text-sky-400' : 'text-rose-400'}`}>
                        {metrics.unrealized_pnl >= 0 ? '+' : '-'}₹{Math.abs(metrics.unrealized_pnl).toLocaleString('en-IN', {minimumFractionDigits: 2})}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* RIGHT: INTERACTIVE ORDER BOOK */}
          <div className="bg-[#0B1120] rounded-2xl border border-slate-800/60 shadow-2xl flex flex-col h-[700px] xl:h-auto">
            <div className="p-5 border-b border-slate-800 bg-slate-900/50 flex justify-between items-center">
              <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                <svg className="w-5 h-5 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                INTERACTIVE LEDGER
              </h2>
              <span className="text-[10px] text-slate-500 font-mono">CLICK ROW TO EXPAND</span>
            </div>
            
            <div className="overflow-y-auto flex-1 p-3 space-y-3 custom-scrollbar">
              {liveLogs.length === 0 ? (
                <div className="p-8 text-center text-slate-500 italic text-sm font-mono">Awaiting execution payloads...</div>
              ) : (
                liveLogs.map((log) => {
                  const details = (log.action_details || "").toUpperCase();
                  const isLoss = details.includes('LOSS') || details.includes('SL');
                  const isProfit = details.includes('PROFIT') || details.includes('TARGET');
                  const isExpanded = expandedLogId === log.id;
                  
                  return (
                    <div 
                      key={log.id} 
                      onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                      className={`group cursor-pointer p-4 rounded-xl border transition-all duration-200 ${isExpanded ? 'bg-slate-800/80 border-slate-600 shadow-lg' : 'bg-slate-900/40 border-slate-800 hover:border-slate-600 hover:bg-slate-800/40'}`}
                    >
                      <div className="flex justify-between items-start mb-3">
                        <span className={`text-[10px] px-2.5 py-1 rounded shadow-sm font-bold tracking-wider ${isProfit ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : isLoss ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30' : 'bg-sky-500/20 text-sky-400 border border-sky-500/30'}`}>
                          {isProfit ? 'TARGET HIT' : isLoss ? 'STOP LOSS' : 'ORDER EXECUTED'}
                        </span>
                        <span className="text-[11px] font-mono text-slate-400 group-hover:text-slate-300">
                          {new Date(log.timestamp || new Date()).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second:'2-digit' })}
                        </span>
                      </div>
                      
                      <div className="flex justify-between items-center">
                        <p className="text-sm font-bold text-slate-100">{log.contract_targeted || "NIFTY50"}</p>
                        <p className="text-sm font-mono text-slate-300">₹{parseFloat(log.asset_price as any || 0).toFixed(2)}</p>
                      </div>

                      {/* --- EXPANDED DETAILS (The Click-to-View feature) --- */}
                      {isExpanded && (
                        <div className="mt-4 pt-4 border-t border-slate-700/50 text-xs font-mono text-slate-300 space-y-2 animate-in fade-in slide-in-from-top-2 duration-200">
                           <div className="flex justify-between">
                             <span className="text-slate-500">Setup Logic:</span>
                             <span className="text-sky-400 font-bold">{log.metric_state}</span>
                           </div>
                           <div className="flex justify-between">
                             <span className="text-slate-500">Execution Hash:</span>
                             <span className="text-slate-400">{log.id}</span>
                           </div>
                           <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 mt-2">
                             <p className="text-slate-400 mb-1 font-sans text-[10px] uppercase tracking-widest">Broker Raw Response</p>
                             <p className={`${isProfit ? 'text-emerald-400' : isLoss ? 'text-rose-400' : 'text-slate-200'}`}>
                                {log.action_details}
                             </p>
                           </div>
                           {/* Simulated PnL Row based on text parsing (If backend provides exact PnL per trade, map it here) */}
                           {(isProfit || isLoss) && (
                             <div className="flex justify-between items-center mt-2 pt-2 border-t border-slate-800">
                               <span className="text-slate-500 uppercase tracking-widest text-[10px]">Trade P&L</span>
                               <span className={`font-bold text-sm ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                                 {isProfit ? '+ PROFIT SECURED' : '- RISK MITIGATED'}
                               </span>
                             </div>
                           )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
          
        </div>
      </div>
      
      {/* Inline Styles for custom scrollbar */}
      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #475569; }
      `}} />
    </div>
  );
}
