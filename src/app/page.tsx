"use client";

import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, CandlestickSeries, LineSeries, AreaSeries } from 'lightweight-charts';
import { createClient } from '@supabase/supabase-js';

// Setup Supabase Client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://znejercxaxygncotvqpa.supabase.co";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpuZWplcmN4YXh5Z25jb3R2cXBhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3MDE5NTAsImV4cCI6MjA5NTI3Nzk1MH0.pFhQ30-ZGf0af6AdvW1mm0hx66BsRqtlG1muGYLIzBc";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

interface Trade {
  id: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  entry_time: string;
  exit_time: string | null;
  status: 'OPEN' | 'CLOSED';
  pnl: number;
  execution_hash?: string;
  slippage?: number;
  setup_logic?: string;
}

interface AccountMetrics {
  account_capital: number;
  win_rate: number;
  net_profit: number;
  active_allocations: number;
  safety_state: string;
  daily_realized_pnl: number;
  total_trades: number;
}

export default function Dashboard() {
  const [mounted, setMounted] = useState(false);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const equityChartContainerRef = useRef<HTMLDivElement>(null);
  
  // State variables
  const [metrics, setMetrics] = useState<AccountMetrics>({
    account_capital: 100000.0,
    win_rate: 0.0,
    net_profit: 0.0,
    active_allocations: 0,
    safety_state: "SAFE",
    daily_realized_pnl: 0.0,
    total_trades: 0
  });
  
  const [trades, setTrades] = useState<Trade[]>([]);
  const [activeTab, setActiveTab] = useState<'LEDGER' | 'LOGS'>('LEDGER');
  const [expandedTradeId, setExpandedTradeId] = useState<string | null>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [marketState, setMarketState] = useState<'OPEN' | 'CLOSED'>('CLOSED');
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [currentTimeStr, setCurrentTimeStr] = useState<string>("");

  // Chart instances
  const mainChartRef = useRef<any>(null);
  const equityChartRef = useRef<any>(null);
  const candleSeriesRef = useRef<any>(null);
  const emaSeriesRef = useRef<any>(null);
  const fvgTopSeriesRef = useRef<any>(null);
  const fvgBottomSeriesRef = useRef<any>(null);
  const equityAreaSeriesRef = useRef<any>(null);

  // Initialize clock and mount state
  useEffect(() => {
    setMounted(true);
    const updateTime = () => {
      const options: Intl.DateTimeFormatOptions = {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      };
      setCurrentTimeStr(new Date().toLocaleTimeString('en-US', options) + " IST");
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Fetch all dashboard data from Supabase and FastAPI
  const loadData = async () => {
    try {
      // 1. Fetch metrics from Supabase /account_summary
      const { data: summaryData, error: summaryError } = await supabase
        .from('account_summary')
        .select('*')
        .eq('id', 1)
        .single();

      // 2. Fetch trades from Supabase /trades
      const { data: tradesData, error: tradesError } = await supabase
        .from('trades')
        .select('*')
        .order('entry_time', { ascending: false });

      if (tradesData) {
        setTrades(tradesData);
        
        // Calculate Win Rate and active allocations locally for redundancy
        const closed = tradesData.filter(t => t.status === 'CLOSED');
        const wins = closed.filter(t => Number(t.pnl || 0) > 0);
        const calculatedWinRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0.0;
        const active = tradesData.filter(t => t.status === 'OPEN').length;
        const realizedPnl = closed.reduce((acc, curr) => acc + Number(curr.pnl || 0), 0);
        
        if (summaryData) {
          setMetrics({
            account_capital: Number(summaryData.net_equity),
            win_rate: Number(calculatedWinRate.toFixed(2)),
            net_profit: Number(summaryData.net_equity) - 100000.0,
            active_allocations: active,
            safety_state: realizedPnl <= -2000.0 ? "DAILY_LOSS_HALT" : "SAFE",
            daily_realized_pnl: Number(summaryData.daily_realized_pnl),
            total_trades: tradesData.length
          });
        } else {
          // Setup metrics directly from trades
          setMetrics({
            account_capital: 100000.0 + realizedPnl,
            win_rate: Number(calculatedWinRate.toFixed(2)),
            net_profit: realizedPnl,
            active_allocations: active,
            safety_state: realizedPnl <= -2000.0 ? "DAILY_LOSS_HALT" : "SAFE",
            daily_realized_pnl: realizedPnl,
            total_trades: tradesData.length
          });
        }

        // Draw Equity Curve
        updateEquityCurveChart(tradesData);
      }

      // 3. Fetch logs for legacy tab
      const { data: logsData } = await supabase
        .from('execution_logs')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(20);
      if (logsData) {
        setLogs(logsData);
      }
    } catch (e) {
      console.error("Error loading data:", e);
    }
  };

  // Fetch charts & market details from FastAPI backend
  const loadChartAndState = async () => {
    try {
      const res = await fetch("http://localhost:8000/api/chart-data");
      const data = await res.json();
      
      if (data && data.candles && candleSeriesRef.current) {
        const candles = data.candles;
        candleSeriesRef.current.setData(candles.map((c: any) => ({
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close
        })));

        // Set indicators
        if (emaSeriesRef.current) {
          const emaData = candles
            .filter((c: any) => c.ema !== null)
            .map((c: any) => ({ time: c.time, value: c.ema }));
          emaSeriesRef.current.setData(emaData);
        }

        if (fvgTopSeriesRef.current && fvgBottomSeriesRef.current) {
          const fvgTopData = candles
            .filter((c: any) => c.fvg_top !== null)
            .map((c: any) => ({ time: c.time, value: c.fvg_top }));
          const fvgBottomData = candles
            .filter((c: any) => c.fvg_bottom !== null)
            .map((c: any) => ({ time: c.time, value: c.fvg_bottom }));
            
          fvgTopSeriesRef.current.setData(fvgTopData);
          fvgBottomSeriesRef.current.setData(fvgBottomData);
        }

        // Apply buy markers
        const markers = candles
          .filter((c: any) => c.long_signal === true)
          .map((c: any) => ({
            time: c.time,
            position: 'belowBar' as const,
            color: '#10b981',
            shape: 'arrowUp' as const,
            text: 'SMC BUY'
          }));
        candleSeriesRef.current.setMarkers(markers);
        setIsLive(true);
      }
    } catch (e) {
      console.warn("Backend API not reachable. Generating simulated chart data locally.");
      setIsLive(false);
      generateLocalSimulatedData();
    }
  };

  // Check market hours status locally / backend
  const checkMarketState = async () => {
    try {
      const res = await fetch("http://localhost:8000/api/live-state");
      const data = await res.json();
      // If we fetch metrics, map them
      if (data && data.metrics) {
        setMarketState(data.metrics.safety_state === "DAILY_LOSS_HALT" ? "CLOSED" : "OPEN");
      }
    } catch (e) {
      // Fallback local calculation for Indian market hours (09:15 - 15:30 IST, Mon-Fri)
      const options = { timeZone: 'Asia/Kolkata' };
      const kolkataTime = new Date(new Date().toLocaleString('en-US', options));
      const day = kolkataTime.getDay(); // 0 is Sunday, 6 is Saturday
      const hour = kolkataTime.getHours();
      const minute = kolkataTime.getMinutes();
      
      const isWeekend = day === 0 || day === 6;
      const totalMinutes = hour * 60 + minute;
      const isOpenTime = totalMinutes >= 9 * 60 + 15 && totalMinutes <= 15 * 60 + 30;
      
      setMarketState(isWeekend || !isOpenTime ? 'CLOSED' : 'OPEN');
    }
  };

  // Generate simulated candle data if backend is offline
  const generateLocalSimulatedData = () => {
    if (!candleSeriesRef.current) return;
    let mockCandles = [];
    let mockEma = [];
    let mockFvgTop = [];
    let mockFvgBottom = [];
    let mockMarkers = [];

    let basePrice = 22600.0;
    let time = Math.floor(Date.now() / 1000) - 150 * 900; // 150 candles back (15m interval)

    for (let i = 0; i < 150; i++) {
      const open = basePrice;
      const high = open + Math.random() * 25 + 5;
      const low = open - Math.random() * 25 - 5;
      const close = low + Math.random() * (high - low);
      
      mockCandles.push({ time: time as any, open, high, low, close });
      
      // Seed EMA
      const ema = basePrice * 0.998 + (i * 0.1);
      mockEma.push({ time: time as any, value: ema });
      
      // FVG
      if (i % 25 === 0) {
        mockFvgTop.push({ time: time as any, value: high + 10 });
        mockFvgBottom.push({ time: time as any, value: low - 5 });
        mockMarkers.push({
          time: time as any,
          position: 'belowBar' as const,
          color: '#06b6d4',
          shape: 'arrowUp' as const,
          text: 'SMC BUY'
        });
      }
      
      basePrice = close;
      time += 900;
    }

    candleSeriesRef.current.setData(mockCandles);
    if (emaSeriesRef.current) emaSeriesRef.current.setData(mockEma);
    if (fvgTopSeriesRef.current) fvgTopSeriesRef.current.setData(mockFvgTop);
    if (fvgBottomSeriesRef.current) fvgBottomSeriesRef.current.setData(mockFvgBottom);
    candleSeriesRef.current.setMarkers(mockMarkers);
  };

  // Render/Update the Equity Curve Chart
  const updateEquityCurveChart = (tradesList: Trade[]) => {
    if (!equityAreaSeriesRef.current) return;

    // Filter closed trades and sort chronologically (oldest to newest) to plot curve
    const closed = [...tradesList]
      .filter(t => t.status === 'CLOSED')
      .sort((a, b) => new Date(a.exit_time || "").getTime() - new Date(b.exit_time || "").getTime());

    let startingEquity = 100000.00;
    const equityCurveData = [{
      time: Math.floor((Date.now() - 3600 * 24 * 7 * 1000) / 1000) as any, // start 1 week ago
      value: startingEquity
    }];

    closed.forEach(t => {
      startingEquity += Number(t.pnl || 0);
      equityCurveData.push({
        time: Math.floor(new Date(t.exit_time || "").getTime() / 1000) as any,
        value: startingEquity
      });
    });

    // If no closed trades, push current time to avoid empty plot
    if (equityCurveData.length === 1) {
      equityCurveData.push({
        time: Math.floor(Date.now() / 1000) as any,
        value: startingEquity
      });
    }

    equityAreaSeriesRef.current.setData(equityCurveData);
  };

  // Main UI charts initialization
  useEffect(() => {
    if (!mounted) return;

    // 1. NIFTY50 Spot Chart Setup
    if (chartContainerRef.current && !mainChartRef.current) {
      const chart = createChart(chartContainerRef.current, {
        layout: {
          background: { type: ColorType.Solid, color: '#090d16' },
          textColor: '#94a3b8',
        },
        grid: {
          vertLines: { color: 'rgba(30, 41, 59, 0.3)' },
          horzLines: { color: 'rgba(30, 41, 59, 0.3)' },
        },
        width: chartContainerRef.current.clientWidth,
        height: 380,
        timeScale: {
          timeVisible: true,
          borderColor: '#1e293b',
        },
        rightPriceScale: {
          borderColor: '#1e293b',
        }
      });

      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: '#10b981',
        downColor: '#f43f5e',
        borderUpColor: '#10b981',
        borderDownColor: '#f43f5e',
        wickUpColor: '#10b981',
        wickDownColor: '#f43f5e',
      });

      const emaSeries = chart.addSeries(LineSeries, {
        color: '#eab308',
        lineWidth: 2,
        title: 'EMA 50',
      });

      const fvgTopSeries = chart.addSeries(LineSeries, {
        color: '#06b6d4',
        lineWidth: 1,
        lineStyle: 2, // Dashed
        title: 'FVG High',
      });

      const fvgBottomSeries = chart.addSeries(LineSeries, {
        color: '#0891b2',
        lineWidth: 1,
        lineStyle: 2, // Dashed
        title: 'FVG Low',
      });

      mainChartRef.current = chart;
      candleSeriesRef.current = candleSeries;
      emaSeriesRef.current = emaSeries;
      fvgTopSeriesRef.current = fvgTopSeries;
      fvgBottomSeriesRef.current = fvgBottomSeries;

      const handleResize = () => {
        if (chartContainerRef.current) {
          chart.applyOptions({ width: chartContainerRef.current.clientWidth });
        }
      };
      window.addEventListener('resize', handleResize);
    }

    // 2. Equity Curve Chart Setup
    if (equityChartContainerRef.current && !equityChartRef.current) {
      const chart = createChart(equityChartContainerRef.current, {
        layout: {
          background: { type: ColorType.Solid, color: '#090d16' },
          textColor: '#94a3b8',
        },
        grid: {
          vertLines: { color: 'rgba(30, 41, 59, 0.2)' },
          horzLines: { color: 'rgba(30, 41, 59, 0.2)' },
        },
        width: equityChartContainerRef.current.clientWidth,
        height: 180,
        timeScale: {
          timeVisible: true,
          borderColor: '#1e293b',
        },
        rightPriceScale: {
          borderColor: '#1e293b',
        }
      });

      const areaSeries = chart.addSeries(AreaSeries, {
        topColor: 'rgba(6, 182, 212, 0.4)',
        bottomColor: 'rgba(6, 182, 212, 0.0)',
        lineColor: '#06b6d4',
        lineWidth: 2,
        priceFormat: {
          type: 'price',
          precision: 2,
          minMove: 0.01,
        }
      });

      equityChartRef.current = chart;
      equityAreaSeriesRef.current = areaSeries;

      const handleResize = () => {
        if (equityChartContainerRef.current) {
          chart.applyOptions({ width: equityChartContainerRef.current.clientWidth });
        }
      };
      window.addEventListener('resize', handleResize);
    }

    // Initial loading
    loadData();
    loadChartAndState();
    checkMarketState();

    // 4. Supabase Real-Time Subscriptions
    const tradesChannel = supabase
      .channel('trades-realtime-channel')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trades' },
        (payload) => {
          console.log('🔔 Trades updated:', payload);
          loadData();
        }
      )
      .subscribe();

    const metricsChannel = supabase
      .channel('metrics-realtime-channel')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'account_summary' },
        (payload) => {
          console.log('🔔 Metrics updated:', payload);
          loadData();
        }
      )
      .subscribe();

    // Periodic checks
    const pollInterval = setInterval(() => {
      loadChartAndState();
      checkMarketState();
    }, 5000);

    return () => {
      clearInterval(pollInterval);
      supabase.removeChannel(tradesChannel);
      supabase.removeChannel(metricsChannel);
    };
  }, [mounted]);

  const copyToClipboard = (hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  if (!mounted) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#020617] text-cyan-400 font-mono">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-cyan-500 mx-auto mb-4"></div>
          <div>BIFROST SYSTEM STARTING...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#02050f] text-slate-100 font-sans p-4 md:p-6 selection:bg-cyan-500/30 selection:text-cyan-200">
      {/* 1. Cyber Dashboard Header */}
      <header className="relative flex flex-col md:flex-row items-center justify-between border border-slate-800 bg-[#070b15]/95 backdrop-blur-md rounded-2xl p-4 md:p-6 mb-6 shadow-2xl overflow-hidden">
        {/* Decorative Grid Light */}
        <div className="absolute top-0 right-0 w-96 h-20 bg-cyan-500/10 rounded-full blur-3xl -z-10" />
        <div className="absolute bottom-0 left-0 w-80 h-20 bg-emerald-500/5 rounded-full blur-3xl -z-10" />

        <div className="flex items-center gap-4 mb-4 md:mb-0">
          <div className="relative flex items-center justify-center h-12 w-12 rounded-xl bg-gradient-to-tr from-cyan-600 to-indigo-700 shadow-lg shadow-cyan-900/30">
            <span className="text-xl font-black text-white">B</span>
            <div className="absolute inset-0 rounded-xl border border-cyan-400/20 animate-pulse" />
          </div>
          <div>
            <h1 className="text-lg md:text-xl font-bold tracking-wider bg-gradient-to-r from-slate-100 via-cyan-100 to-cyan-400 bg-clip-text text-transparent">
              BIFROST // QUANT_ENGINE
            </h1>
            <p className="text-xs text-slate-400 font-mono mt-0.5">SMC INSTITUTIONAL INTRADAY DASHBOARD</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
          {/* Market Status Badge */}
          <div className="flex items-center gap-2 border border-slate-800 bg-slate-900/40 px-3 py-1.5 rounded-lg">
            <span className="text-slate-400">MARKET:</span>
            <div className="flex items-center gap-1.5">
              <span className={`inline-block h-2 w-2 rounded-full ${marketState === 'OPEN' ? 'bg-emerald-500 animate-ping' : 'bg-rose-500'}`} />
              <span className={marketState === 'OPEN' ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                {marketState === 'OPEN' ? 'OPEN' : 'CLOSED'}
              </span>
            </div>
          </div>

          {/* Connection Status */}
          <div className="flex items-center gap-2 border border-slate-800 bg-slate-900/40 px-3 py-1.5 rounded-lg">
            <span className="text-slate-400">ENGINE:</span>
            <div className="flex items-center gap-1.5">
              <span className={`inline-block h-2 w-2 rounded-full ${isLive ? 'bg-emerald-400' : 'bg-cyan-400 animate-pulse'}`} />
              <span className={isLive ? 'text-emerald-400' : 'text-cyan-400'}>
                {isLive ? 'LIVE' : 'SIMULATION'}
              </span>
            </div>
          </div>

          {/* Clock Display */}
          <div className="border border-slate-800 bg-slate-900/40 px-3 py-1.5 rounded-lg text-cyan-400 font-semibold shadow-inner">
            {currentTimeStr || "00:00:00 IST"}
          </div>
        </div>
      </header>

      {/* 2. Top-Line Metrics Grid */}
      <section className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        {/* Net Equity */}
        <div className="relative border border-slate-800 bg-[#070b15]/80 hover:bg-[#070b15]/90 rounded-2xl p-4 shadow-xl transition-all duration-200 group">
          <div className="absolute top-3 right-3 text-slate-500 group-hover:text-cyan-400 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          </div>
          <span className="text-slate-500 font-mono text-[10px] uppercase tracking-wider block mb-1">Net Equity</span>
          <span className="text-xl md:text-2xl font-black text-slate-100 font-mono">
            ₹{metrics.account_capital.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </span>
          <div className="flex items-center gap-1 mt-1 text-[11px]">
            <span className={metrics.net_profit >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>
              {metrics.net_profit >= 0 ? "+" : ""}
              {((metrics.net_profit / 100000) * 100).toFixed(2)}%
            </span>
            <span className="text-slate-500">cumulative return</span>
          </div>
        </div>

        {/* Daily realized pnl */}
        <div className="relative border border-slate-800 bg-[#070b15]/80 hover:bg-[#070b15]/90 rounded-2xl p-4 shadow-xl transition-all duration-200 group">
          <span className="text-slate-500 font-mono text-[10px] uppercase tracking-wider block mb-1">Daily Realized P&L</span>
          <span className={`text-xl md:text-2xl font-black font-mono ${metrics.daily_realized_pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            ₹{metrics.daily_realized_pnl >= 0 ? "+" : ""}
            {metrics.daily_realized_pnl.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </span>
          <div className="flex items-center gap-1 mt-1 text-[11px]">
            <span className={metrics.daily_realized_pnl >= 0 ? "text-emerald-400" : "text-rose-400"}>
              {metrics.daily_realized_pnl >= 0 ? "Profit" : "Loss"}
            </span>
            <span className="text-slate-500">since midnight</span>
          </div>
        </div>

        {/* Win Rate */}
        <div className="relative border border-slate-800 bg-[#070b15]/80 hover:bg-[#070b15]/90 rounded-2xl p-4 shadow-xl transition-all duration-200 group">
          <div className="absolute top-3 right-3 text-slate-500 group-hover:text-cyan-400 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          </div>
          <span className="text-slate-500 font-mono text-[10px] uppercase tracking-wider block mb-1">Win Rate</span>
          <span className="text-xl md:text-2xl font-black text-cyan-400 font-mono">{metrics.win_rate}%</span>
          <div className="flex items-center gap-1 mt-1 text-[11px]">
            <span className="text-emerald-400 font-bold">
              {metrics.total_trades > 0 ? Math.round((metrics.win_rate / 100) * metrics.total_trades) : 0} wins
            </span>
            <span className="text-slate-500">out of {metrics.total_trades} trades</span>
          </div>
        </div>

        {/* Active Allocations */}
        <div className="relative border border-slate-800 bg-[#070b15]/80 hover:bg-[#070b15]/90 rounded-2xl p-4 shadow-xl transition-all duration-200 group">
          <span className="text-slate-500 font-mono text-[10px] uppercase tracking-wider block mb-1">Active Positions</span>
          <span className="text-xl md:text-2xl font-black text-slate-100 font-mono">{metrics.active_allocations}</span>
          <div className="flex items-center gap-1 mt-1 text-[11px]">
            <span className={`font-semibold ${metrics.active_allocations > 0 ? "text-cyan-400" : "text-slate-400"}`}>
              {metrics.active_allocations > 0 ? "Position Open" : "Idle"}
            </span>
            <span className="text-slate-500">monitoring ticks</span>
          </div>
        </div>

        {/* Safety Risk State */}
        <div className="relative border border-slate-800 bg-[#070b15]/80 hover:bg-[#070b15]/90 rounded-2xl p-4 shadow-xl transition-all duration-200 col-span-2 lg:col-span-1">
          <span className="text-slate-500 font-mono text-[10px] uppercase tracking-wider block mb-1">Risk System Status</span>
          <span className={`text-lg md:text-xl font-bold font-mono inline-flex items-center gap-1.5 mt-0.5 ${metrics.safety_state === 'SAFE' ? 'text-emerald-400' : 'text-rose-400 font-black animate-pulse'}`}>
            <span className={`h-2.5 w-2.5 rounded-full ${metrics.safety_state === 'SAFE' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
            {metrics.safety_state}
          </span>
          <div className="text-[11px] text-slate-400 mt-2 font-mono">
            Loss Limit: ₹2,000.00
          </div>
        </div>
      </section>

      {/* 3. Double Chart Visualization Panel */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* NIFTY50 Candlestick Chart (Occupies 2 columns) */}
        <div className="border border-slate-800 bg-[#070b15]/95 rounded-2xl p-4 shadow-2xl col-span-1 lg:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-800/80 pb-3 mb-4">
            <div className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 rounded-full bg-cyan-500" />
              <h2 className="text-sm font-semibold tracking-wider font-mono">NIFTY 50 SPOT PRICE INTERVAL (15M)</h2>
            </div>
            <div className="flex items-center gap-3 font-mono text-[11px] text-slate-400 bg-slate-900/60 border border-slate-800/80 rounded-lg px-3 py-1">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 bg-[#eab308] rounded-full" /> EMA 50
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 bg-[#06b6d4] rounded-full" /> Bullish FVG
              </span>
            </div>
          </div>
          
          {/* Main Chart Mount Div */}
          <div ref={chartContainerRef} className="w-full h-[380px] rounded-xl overflow-hidden bg-[#090d16]" />
        </div>

        {/* Equity Curve & Performance Metrics (Occupies 1 column) */}
        <div className="flex flex-col gap-6 col-span-1">
          {/* Cumulative Equity Curve */}
          <div className="border border-slate-800 bg-[#070b15]/95 rounded-2xl p-4 shadow-2xl flex-1 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 border-b border-slate-800/80 pb-3 mb-3">
                <span className="inline-block h-3 w-3 rounded-full bg-[#06b6d4]" />
                <h2 className="text-sm font-semibold tracking-wider font-mono">CUMULATIVE EQUITY CURVE (INR)</h2>
              </div>
              <p className="text-xs text-slate-400 mb-2 font-mono">Net equity trajectory over closed trades ledger.</p>
            </div>
            
            {/* Equity Curve Mount */}
            <div ref={equityChartContainerRef} className="w-full h-[180px] rounded-xl overflow-hidden bg-[#090d16] mb-2" />
          </div>

          {/* Quick Stats Panel */}
          <div className="border border-slate-800 bg-[#070b15]/95 rounded-2xl p-4 shadow-2xl">
            <h2 className="text-xs font-semibold tracking-widest font-mono text-slate-400 mb-3 uppercase">RISK CONSOLE PANEL</h2>
            <div className="grid grid-cols-2 gap-3 text-xs font-mono">
              <div className="bg-slate-900/40 border border-slate-850 p-2 rounded-lg">
                <span className="text-[10px] text-slate-500 block mb-1">Risk per Trade</span>
                <span className="text-slate-300 font-bold">2.0%</span>
              </div>
              <div className="bg-slate-900/40 border border-slate-850 p-2 rounded-lg">
                <span className="text-[10px] text-slate-500 block mb-1">Max Daily Drawdown</span>
                <span className="text-slate-300 font-bold">₹2,000.00</span>
              </div>
              <div className="bg-slate-900/40 border border-slate-850 p-2 rounded-lg">
                <span className="text-[10px] text-slate-500 block mb-1">Lot Size</span>
                <span className="text-slate-300 font-bold">25 Qty</span>
              </div>
              <div className="bg-slate-900/40 border border-slate-850 p-2 rounded-lg">
                <span className="text-[10px] text-slate-500 block mb-1">ATM Option Delta</span>
                <span className="text-slate-300 font-bold">1.0</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 4. Ledger and System Activity log */}
      <section className="border border-slate-800 bg-[#070b15]/95 rounded-2xl p-4 md:p-6 shadow-2xl mb-6">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
          <div className="flex gap-4">
            <button 
              onClick={() => setActiveTab('LEDGER')}
              className={`text-xs font-bold font-mono tracking-widest pb-3 border-b-2 transition-colors cursor-pointer ${activeTab === 'LEDGER' ? 'border-cyan-400 text-cyan-400' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
            >
              INTRADAY TRADES LEDGER
            </button>
            <button 
              onClick={() => setActiveTab('LOGS')}
              className={`text-xs font-bold font-mono tracking-widest pb-3 border-b-2 transition-colors cursor-pointer ${activeTab === 'LOGS' ? 'border-cyan-400 text-cyan-400' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
            >
              SYSTEM AUDIT LOGS
            </button>
          </div>
        </div>

        {/* A. Trades Ledger View */}
        {activeTab === 'LEDGER' && (
          <div className="overflow-x-auto">
            {trades.length === 0 ? (
              <div className="text-center py-10 text-slate-500 font-mono text-sm">
                NO TRADES RECORDED IN ACTIVE LEDGER. RUN THE ENGINE TO SIMULATE TRADES.
              </div>
            ) : (
              <table className="w-full text-left border-collapse font-mono text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-500 text-[10px]">
                    <th className="py-3 px-2">ENTRY TIME</th>
                    <th className="py-3 px-2">SYMBOL</th>
                    <th className="py-3 px-2">DIRECTION</th>
                    <th className="py-3 px-2">QTY</th>
                    <th className="py-3 px-2 text-right">ENTRY</th>
                    <th className="py-3 px-2 text-right">EXIT</th>
                    <th className="py-3 px-2 text-right">REALIZED P&L</th>
                    <th className="py-3 px-2 text-center">STATUS</th>
                    <th className="py-3 px-2 text-center">METADATA</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => {
                    const isExpanded = expandedTradeId === t.id;
                    const dateStr = new Date(t.entry_time).toLocaleString('en-US', {
                      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
                    });
                    
                    return (
                      <>
                        {/* Table Row */}
                        <tr 
                          key={t.id} 
                          onClick={() => setExpandedTradeId(isExpanded ? null : t.id)}
                          className="border-b border-slate-850 hover:bg-slate-900/40 cursor-pointer transition-colors"
                        >
                          <td className="py-4 px-2 text-slate-400">{dateStr}</td>
                          <td className="py-4 px-2 font-bold text-slate-200">{t.symbol}</td>
                          <td className="py-4 px-2">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${t.direction === 'BUY' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}`}>
                              {t.direction}
                            </span>
                          </td>
                          <td className="py-4 px-2 text-slate-300 font-bold">{t.quantity}</td>
                          <td className="py-4 px-2 text-right text-slate-300">₹{Number(t.entry_price).toFixed(2)}</td>
                          <td className="py-4 px-2 text-right text-slate-300">
                            {t.exit_price ? `₹${Number(t.exit_price).toFixed(2)}` : '—'}
                          </td>
                          <td className={`py-4 px-2 text-right font-black ${Number(t.pnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                            {t.status === 'CLOSED' ? `₹${Number(t.pnl).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : 'unrealized'}
                          </td>
                          <td className="py-4 px-2 text-center">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${t.status === 'CLOSED' ? 'bg-slate-800 text-slate-300' : 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 animate-pulse'}`}>
                              {t.status}
                            </span>
                          </td>
                          <td className="py-4 px-2 text-center text-slate-500">
                            {isExpanded ? '▲ hide' : '▼ expand'}
                          </td>
                        </tr>

                        {/* Expanded details row */}
                        {isExpanded && (
                          <tr className="bg-slate-900/30">
                            <td colSpan={9} className="py-3 px-4 border-b border-slate-850">
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 py-2 px-2 text-xs">
                                <div>
                                  <span className="text-[10px] text-slate-500 block mb-1">Execution Hash</span>
                                  <div className="flex items-center gap-2">
                                    <span className="font-mono text-cyan-400 font-bold bg-slate-900 px-2 py-1 rounded border border-slate-800">
                                      {t.execution_hash || "0x00000000"}
                                    </span>
                                    <button 
                                      onClick={(e) => { e.stopPropagation(); copyToClipboard(t.execution_hash || ""); }}
                                      className="text-slate-400 hover:text-white cursor-pointer bg-slate-800 hover:bg-slate-755 p-1 rounded transition-colors"
                                      title="Copy Hash"
                                    >
                                      {copiedHash === t.execution_hash ? 'copied!' : 'copy'}
                                    </button>
                                  </div>
                                </div>
                                
                                <div>
                                  <span className="text-[10px] text-slate-500 block mb-1">Slip Offset (Slippage)</span>
                                  <span className="font-mono text-slate-300 font-bold">
                                    ₹{Number(t.slippage || 0).toFixed(2)} points
                                  </span>
                                </div>

                                <div>
                                  <span className="text-[10px] text-slate-500 block mb-1">Setup Logic Explanation</span>
                                  <span className="text-slate-300 italic font-mono block max-w-lg">
                                    {t.setup_logic || "Algorithm detected bullish trend tapping into 15m bullish Fair Value Gap zone above 50 period EMA filter."}
                                  </span>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* B. Legacy logs Audit view */}
        {activeTab === 'LOGS' && (
          <div className="bg-[#05080e] border border-slate-850 rounded-xl p-4 font-mono text-[11px] text-slate-400 max-h-[300px] overflow-y-auto scrollbar-thin">
            {logs.length === 0 ? (
              <div className="text-slate-600 italic py-4 text-center">NO LOGS AVAILABLE IN DATABASE snapshot.</div>
            ) : (
              logs.map((log) => {
                const logTime = new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false });
                return (
                  <div key={log.id} className="py-1 flex border-b border-slate-900/30 last:border-0">
                    <span className="text-slate-600 mr-2">[{logTime}]</span>
                    <span className="text-cyan-400 font-semibold mr-2">[{log.metric_state}]</span>
                    <span className="text-slate-300 flex-1">{log.action_details}</span>
                    {log.contract_targeted && (
                      <span className="text-yellow-500 font-semibold">({log.contract_targeted})</span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </section>
    </div>
  );
}
