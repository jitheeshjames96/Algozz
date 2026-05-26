"use client";

import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, CandlestickSeries, LineSeries, AreaSeries, createSeriesMarkers } from 'lightweight-charts';
import { createClient } from '@supabase/supabase-js';

// Setup Supabase Client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://znejercxaxygncotvqpa.supabase.co";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpuZWplcmN4YXh5Z25jb3R2cXBhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3MDE5NTAsImV4cCI6MjA5NTI3Nzk1MH0.pFhQ30-ZGf0af6AdvW1mm0hx66BsRqtlG1muGYLIzBc";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

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

// Supported Assets Configuration
const ASSETS = [
  { value: '^NSEI', label: 'NIFTY 50', category: 'Indian Indices' },
  { value: '^NSEBANK', label: 'BANK NIFTY', category: 'Indian Indices' },
  { value: '^BSESN', label: 'SENSEX', category: 'Indian Indices' },
  { value: 'RELIANCE.NS', label: 'Reliance Industries', category: 'Indian Equities' },
  { value: 'TCS.NS', label: 'TCS', category: 'Indian Equities' },
  { value: 'HDFCBANK.NS', label: 'HDFC Bank', category: 'Indian Equities' },
  { value: 'INFY.NS', label: 'Infosys', category: 'Indian Equities' },
  { value: '^GSPC', label: 'S&P 500 (US)', category: 'Global Indices' },
  { value: '^DJI', label: 'Dow Jones (US)', category: 'Global Indices' },
  { value: '^IXIC', label: 'Nasdaq (US)', category: 'Global Indices' },
  { value: '^GDAXI', label: 'DAX (Germany)', category: 'Global Indices' },
  { value: '^FTSE', label: 'FTSE 100 (UK)', category: 'Global Indices' },
  { value: '^FCHI', label: 'CAC 40 (France)', category: 'Global Indices' },
  { value: 'EURUSD=X', label: 'EUR / USD', category: 'Forex' },
  { value: 'GBPUSD=X', label: 'GBP / USD', category: 'Forex' },
  { value: 'GC=F', label: 'Gold Spot', category: 'Commodities' },
  { value: 'BTC-USD', label: 'Bitcoin USD', category: 'Crypto' },
];

// Helper Functions for Performance Analytics
const calculateProfitFactor = (tradesList: Trade[]) => {
  const closed = tradesList.filter(t => t.status === 'CLOSED');
  const profit = closed.filter(t => Number(t.pnl || 0) > 0).reduce((acc, t) => acc + Number(t.pnl || 0), 0);
  const loss = Math.abs(closed.filter(t => Number(t.pnl || 0) <= 0).reduce((acc, t) => acc + Number(t.pnl || 0), 0));
  return loss === 0 ? profit : profit / loss;
};

const calculateAvgWinLoss = (tradesList: Trade[]) => {
  const closed = tradesList.filter(t => t.status === 'CLOSED');
  const wins = closed.filter(t => Number(t.pnl || 0) > 0);
  const losses = closed.filter(t => Number(t.pnl || 0) <= 0);
  const avgWin = wins.length > 0 ? wins.reduce((acc, t) => acc + Number(t.pnl || 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((acc, t) => acc + Number(t.pnl || 0), 0)) / losses.length : 0;
  return { avgWin, avgLoss };
};

const calculatePeriodReturn = (tradesList: Trade[], periodType: 'weekly' | 'monthly') => {
  const closed = tradesList.filter(t => t.status === 'CLOSED');
  const now = new Date();
  let cutoff = new Date();
  if (periodType === 'weekly') {
    cutoff.setDate(now.getDate() - 7);
  } else {
    cutoff.setMonth(now.getMonth() - 1);
  }
  return closed
    .filter(t => new Date(t.exit_time || "").getTime() >= cutoff.getTime())
    .reduce((acc, t) => acc + Number(t.pnl || 0), 0);
};

const calculateDailyBreakdown = (tradesList: Trade[]) => {
  const closed = tradesList.filter(t => t.status === 'CLOSED');
  const groups: { [key: string]: { pnl: number, count: number, wins: number } } = {};
  
  closed.forEach(t => {
    const dateStr = new Date(t.exit_time || "").toLocaleDateString('en-IN', {
      year: 'numeric', month: 'short', day: 'numeric'
    });
    if (!groups[dateStr]) {
      groups[dateStr] = { pnl: 0, count: 0, wins: 0 };
    }
    const pnl = Number(t.pnl || 0);
    groups[dateStr].pnl += pnl;
    groups[dateStr].count += 1;
    if (pnl > 0) {
      groups[dateStr].wins += 1;
    }
  });

  return Object.keys(groups).map(date => {
    const g = groups[date];
    const winRate = g.count > 0 ? Math.round((g.wins / g.count) * 100) : 0;
    return {
      date,
      pnl: g.pnl,
      count: g.count,
      wins: g.wins,
      winRate
    };
  }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
};

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
  const [activeChartTab, setActiveChartTab] = useState<'PRICE' | 'EQUITY' | 'PERFORMANCE'>('PRICE');
  const [expandedTradeId, setExpandedTradeId] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [marketState, setMarketState] = useState<'OPEN' | 'CLOSED'>('CLOSED');
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [currentTimeStr, setCurrentTimeStr] = useState<string>("");
  const [liveSpotPrice, setLiveSpotPrice] = useState<number>(22660.00);
  const [resolution, setResolution] = useState<string>('15m');
  const [selectedAsset, setSelectedAsset] = useState<string>('^NSEI');
  const [selectedAssetLabel, setSelectedAssetLabel] = useState<string>('NIFTY 50');
  const resolutionRef = useRef('15m');
  const assetRef = useRef('^NSEI');

  useEffect(() => {
    resolutionRef.current = resolution;
  }, [resolution]);

  useEffect(() => {
    assetRef.current = selectedAsset;
  }, [selectedAsset]);

  // Chart instances
  const mainChartRef = useRef<any>(null);
  const equityChartRef = useRef<any>(null);
  const candleSeriesRef = useRef<any>(null);
  const candleMarkersRef = useRef<any>(null);
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
      const { data: summaryData } = await supabase
        .from('account_summary')
        .select('*')
        .eq('id', 1)
        .single();

      // 2. Fetch trades from Supabase /trades
      const { data: tradesData } = await supabase
        .from('trades')
        .select('*')
        .order('entry_time', { ascending: false });

      if (tradesData) {
        setTrades(tradesData);
        
        // Calculate Win Rate and active allocations locally
        const closed = tradesData.filter(t => t.status === 'CLOSED');
        const wins = closed.filter(t => Number(t.pnl || 0) > 0);
        const calculatedWinRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0.0;
        const active = tradesData.filter(t => t.status === 'OPEN').length;
        const realizedPnl = closed.reduce((acc, curr) => acc + Number(curr.pnl || 0), 0);
        
        if (summaryData) {
          setMetrics({
            account_capital: Number(summaryData.net_equity),
            win_rate: Number(calculatedWinRate.toFixed(2)),
            net_profit: realizedPnl,
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
        
        // Update live spot price from open trade if exists
        const openTrade = tradesData.find(t => t.status === 'OPEN');
        if (openTrade) {
          setLiveSpotPrice(Number(openTrade.entry_price));
        }
      }
    } catch (e) {
      console.error("Error loading data:", e);
    }
  };

  // Fetch charts & market details from FastAPI backend
  const loadChartAndState = async (resVal = resolution, assetVal = selectedAsset) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/chart-data?ticker=${assetVal}&resolution=${resVal}`);
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
        if (candleMarkersRef.current) {
          candleMarkersRef.current.setMarkers(markers);
        }
        setIsLive(true);
        
        // Update live spot price from latest candle close
        if (candles.length > 0) {
          setLiveSpotPrice(Number(candles[candles.length - 1].close));
        }
      }
    } catch (e) {
      console.warn("Backend API not reachable. Generating simulated chart data locally.");
      setIsLive(false);
      generateLocalSimulatedData(resVal, assetVal);
    }
  };

  // Check market hours status locally / backend
  const checkMarketState = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/live-state`);
      const data = await res.json();
      if (data && data.metrics) {
        setMarketState(data.metrics.safety_state === "DAILY_LOSS_HALT" ? "CLOSED" : "OPEN");
      }
    } catch (e) {
      const options = { timeZone: 'Asia/Kolkata' };
      const kolkataTime = new Date(new Date().toLocaleString('en-US', options));
      const day = kolkataTime.getDay();
      const hour = kolkataTime.getHours();
      const minute = kolkataTime.getMinutes();
      
      const isWeekend = day === 0 || day === 6;
      const totalMinutes = hour * 60 + minute;
      const isOpenTime = totalMinutes >= 9 * 60 + 15 && totalMinutes <= 15 * 60 + 30;
      
      setMarketState(isWeekend || !isOpenTime ? 'CLOSED' : 'OPEN');
    }
  };

  // Generate simulated candle data if backend is offline
  const generateLocalSimulatedData = (resVal = resolution, assetVal = selectedAsset) => {
    if (!candleSeriesRef.current) return;
    let mockCandles = [];
    let mockEma = [];
    let mockFvgTop = [];
    let mockFvgBottom = [];
    let mockMarkers = [];

    let basePrice = 22660.0;
    if (assetVal.includes('BTC')) basePrice = 68000.0;
    else if (assetVal === 'GC=F') basePrice = 2350.0;
    else if (assetVal.includes('EURUSD')) basePrice = 1.0850;
    else if (assetVal.includes('GBPUSD')) basePrice = 1.2720;
    else if (assetVal === '^GSPC') basePrice = 5300.0;
    else if (assetVal === '^DJI') basePrice = 39000.0;
    else if (assetVal === '^IXIC') basePrice = 16800.0;
    else if (assetVal === '^GDAXI') basePrice = 18600.0;
    else if (assetVal === '^FTSE') basePrice = 8300.0;
    else if (assetVal === '^FCHI') basePrice = 8100.0;
    else if (assetVal === '^BSESN') basePrice = 75000.0;
    else if (assetVal === 'RELIANCE.NS') basePrice = 2900.0;
    else if (assetVal === 'TCS.NS') basePrice = 3850.0;
    else if (assetVal === 'HDFCBANK.NS') basePrice = 1520.0;
    else if (assetVal === 'INFY.NS') basePrice = 1450.0;
    
    let secondsPerCandle = 15 * 60;
    if (resVal === '1m') secondsPerCandle = 60;
    else if (resVal === '5m') secondsPerCandle = 5 * 60;
    else if (resVal === '15m') secondsPerCandle = 15 * 60;
    else if (resVal === '1h') secondsPerCandle = 60 * 60;
    else if (resVal === '4h') secondsPerCandle = 4 * 60 * 60;
    else if (resVal === '1d') secondsPerCandle = 24 * 60 * 60;
    else if (resVal === '1w') secondsPerCandle = 7 * 24 * 60 * 60;
    else if (resVal === '1mo') secondsPerCandle = 30 * 24 * 60 * 60;

    let time = Math.floor(Date.now() / 1000) - 150 * secondsPerCandle;

    for (let i = 0; i < 150; i++) {
      const open = basePrice;
      const high = open + Math.random() * 8 + 2;
      const low = open - Math.random() * 8 - 2;
      const close = low + Math.random() * (high - low);
      
      mockCandles.push({ time: time as any, open, high, low, close });
      
      // Seed EMA
      const ema = basePrice * 0.999 + (i * 0.05);
      mockEma.push({ time: time as any, value: ema });
      
      // FVG
      if (i % 25 === 0) {
        mockFvgTop.push({ time: time as any, value: high + 4 });
        mockFvgBottom.push({ time: time as any, value: low - 2 });
        mockMarkers.push({
          time: time as any,
          position: 'belowBar' as const,
          color: '#06b6d4',
          shape: 'arrowUp' as const,
          text: 'SMC BUY'
        });
      }
      
      basePrice = close;
      time += secondsPerCandle;
    }

    candleSeriesRef.current.setData(mockCandles);
    if (emaSeriesRef.current) emaSeriesRef.current.setData(mockEma);
    if (fvgTopSeriesRef.current) fvgTopSeriesRef.current.setData(mockFvgTop);
    if (fvgBottomSeriesRef.current) fvgBottomSeriesRef.current.setData(mockFvgBottom);
    if (candleMarkersRef.current) {
      candleMarkersRef.current.setMarkers(mockMarkers);
    }
    
    // Set live spot price
    setLiveSpotPrice(Number(basePrice.toFixed(2)));
  };

  // Render/Update the Equity Curve Chart
  const updateEquityCurveChart = (tradesList: Trade[]) => {
    if (!equityAreaSeriesRef.current) return;

    const closed = [...tradesList]
      .filter(t => t.status === 'CLOSED')
      .sort((a, b) => new Date(a.exit_time || "").getTime() - new Date(b.exit_time || "").getTime());

    let startingEquity = 100000.00;
    const equityCurveData = [{
      time: Math.floor((Date.now() - 3600 * 24 * 7 * 1000) / 1000) as any,
      value: startingEquity
    }];

    closed.forEach(t => {
      startingEquity += Number(t.pnl || 0);
      equityCurveData.push({
        time: Math.floor(new Date(t.exit_time || "").getTime() / 1000) as any,
        value: startingEquity
      });
    });

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
          vertLines: { color: 'rgba(30, 41, 59, 0.2)' },
          horzLines: { color: 'rgba(30, 41, 59, 0.2)' },
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
        lineStyle: 2,
        title: 'FVG High',
      });

      const fvgBottomSeries = chart.addSeries(LineSeries, {
        color: '#0891b2',
        lineWidth: 1,
        lineStyle: 2,
        title: 'FVG Low',
      });

      const candleMarkers = createSeriesMarkers(candleSeries, []);

      mainChartRef.current = chart;
      candleSeriesRef.current = candleSeries;
      candleMarkersRef.current = candleMarkers;
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
          vertLines: { color: 'rgba(30, 41, 59, 0.15)' },
          horzLines: { color: 'rgba(30, 41, 59, 0.15)' },
        },
        width: equityChartContainerRef.current.clientWidth,
        height: 380, // matched to candlestick height
        timeScale: {
          timeVisible: true,
          borderColor: '#1e293b',
        },
        rightPriceScale: {
          borderColor: '#1e293b',
        }
      });

      const areaSeries = chart.addSeries(AreaSeries, {
        topColor: 'rgba(6, 182, 212, 0.35)',
        bottomColor: 'rgba(6, 182, 212, 0.0)',
        lineColor: '#06b6d4',
        lineWidth: 2,
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
    loadChartAndState(resolutionRef.current, assetRef.current);
    checkMarketState();

    // 3. Supabase Real-Time Subscriptions
    const tradesChannel = supabase
      .channel('trades-realtime-channel')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trades' },
        (payload) => {
          console.log('🔔 Real-time Trade Event:', payload);
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
          console.log('🔔 Real-time Account summary Event:', payload);
          loadData();
        }
      )
      .subscribe();

    // Periodic checks
    const pollInterval = setInterval(() => {
      loadChartAndState(resolutionRef.current, assetRef.current);
      checkMarketState();
    }, 4000);

    return () => {
      clearInterval(pollInterval);
      supabase.removeChannel(tradesChannel);
      supabase.removeChannel(metricsChannel);
    };
  }, [mounted]);

  // Reactive resolution/asset updates
  useEffect(() => {
    if (mounted) {
      loadChartAndState(resolution, selectedAsset);
    }
  }, [resolution, selectedAsset]);

  const copyToClipboard = (hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const openPosition = trades.find(t => t.status === 'OPEN');
  
  // Calculate live unrealized pnl
  let liveUnrealizedPnl = 0.00;
  if (openPosition) {
    const delta = openPosition.direction === 'BUY' 
      ? liveSpotPrice - Number(openPosition.entry_price)
      : Number(openPosition.entry_price) - liveSpotPrice;
    liveUnrealizedPnl = delta * openPosition.quantity;
  }

  if (!mounted) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#02050f] text-cyan-400 font-mono">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-cyan-500 mx-auto mb-4"></div>
          <div className="tracking-widest uppercase text-xs">BIFROST SYSTEM INITIALIZING...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#02050f] text-slate-200 font-sans p-4 md:p-6 selection:bg-cyan-500/30 selection:text-cyan-200">
      {/* 1. Cyber Dashboard Header */}
      <header className="relative flex flex-col md:flex-row items-center justify-between border border-slate-800 bg-[#070b15]/95 backdrop-blur-md rounded-2xl p-4 md:p-5 mb-6 shadow-2xl overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-20 bg-cyan-500/10 rounded-full blur-3xl -z-10" />
        
        <div className="flex items-center gap-4 mb-4 md:mb-0">
          <div className="relative flex items-center justify-center h-11 w-11 rounded-xl bg-gradient-to-tr from-cyan-600 to-indigo-700 shadow-lg shadow-cyan-900/30">
            <span className="text-xl font-black text-white">B</span>
            <div className="absolute inset-0 rounded-xl border border-cyan-400/20 animate-pulse" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wider bg-gradient-to-r from-slate-100 via-cyan-100 to-cyan-400 bg-clip-text text-transparent">
              BIFROST // QUANT_ENGINE
            </h1>
            <p className="text-[10px] text-slate-400 font-mono mt-0.5">SMC ALGORITHMIC TRADING TERMINAL</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
          <div className="flex items-center gap-2 border border-slate-800 bg-[#070b15] hover:border-cyan-500/50 px-3 py-1 rounded-xl transition-colors">
            <span className="text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Asset:</span>
            <select
              value={selectedAsset}
              onChange={(e) => {
                const val = e.target.value;
                setSelectedAsset(val);
                const asset = ASSETS.find(a => a.value === val);
                if (asset) setSelectedAssetLabel(asset.label);
              }}
              className="bg-transparent text-cyan-400 font-bold border-none outline-none cursor-pointer focus:ring-0 text-xs pr-2 py-0.5"
            >
              {Array.from(new Set(ASSETS.map(a => a.category))).map(cat => (
                <optgroup key={cat} label={cat} className="bg-[#070b15] text-slate-400 font-bold">
                  {ASSETS.filter(a => a.category === cat).map(a => (
                    <option key={a.value} value={a.value} className="bg-[#070b15] text-cyan-400">
                      {a.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 border border-slate-800 bg-slate-900/40 px-3 py-1.5 rounded-lg">
            <span className="text-slate-400">MARKET:</span>
            <div className="flex items-center gap-1.5">
              <span className={`inline-block h-2 w-2 rounded-full ${marketState === 'OPEN' ? 'bg-emerald-500 animate-ping' : 'bg-rose-500'}`} />
              <span className={marketState === 'OPEN' ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                {marketState === 'OPEN' ? 'OPEN' : 'CLOSED'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 border border-slate-800 bg-slate-900/40 px-3 py-1.5 rounded-lg">
            <span className="text-slate-400">ENGINE:</span>
            <div className="flex items-center gap-1.5">
              <span className={`inline-block h-2 w-2 rounded-full ${isLive ? 'bg-emerald-400 animate-pulse' : 'bg-cyan-400'}`} />
              <span className={isLive ? 'text-emerald-400' : 'text-cyan-400'}>
                {isLive ? 'LIVE' : 'SIMULATION'}
              </span>
            </div>
          </div>

          <div className="border border-slate-800 bg-slate-900/40 px-3 py-1.5 rounded-lg text-cyan-400 font-semibold shadow-inner">
            {currentTimeStr}
          </div>
        </div>
      </header>

      {/* 2. Top-Line Metrics Grid */}
      <section className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        {/* Net Equity */}
        <div className="relative border border-slate-800 bg-[#070b15]/80 rounded-2xl p-4 shadow-xl">
          <span className="text-slate-500 font-mono text-[9px] uppercase tracking-wider block mb-1">Net Equity</span>
          <span className="text-xl md:text-2xl font-black text-slate-100 font-mono">
            ₹{metrics.account_capital.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </span>
          <div className="text-[10px] text-slate-500 mt-1 font-mono">
            Base: ₹1,00,000.00
          </div>
        </div>

        {/* Realized P&L */}
        <div className="relative border border-slate-800 bg-[#070b15]/80 rounded-2xl p-4 shadow-xl">
          <div className="absolute top-3 right-3">
            <span className="text-[9px] font-bold font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/25">BOOKED</span>
          </div>
          <span className="text-slate-500 font-mono text-[9px] uppercase tracking-wider block mb-1">Realized P&L</span>
          <span className={`text-xl md:text-2xl font-black font-mono ${metrics.daily_realized_pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {metrics.daily_realized_pnl >= 0 ? "+" : ""}
            ₹{metrics.daily_realized_pnl.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </span>
          <div className="text-[10px] text-slate-500 mt-1 font-mono">
            Closed trades profit/loss
          </div>
        </div>

        {/* Unrealized P&L */}
        <div className="relative border border-slate-800 bg-[#070b15]/80 rounded-2xl p-4 shadow-xl">
          <div className="absolute top-3 right-3">
            <span className="text-[9px] font-bold font-mono px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/25 animate-pulse">LIVE</span>
          </div>
          <span className="text-slate-500 font-mono text-[9px] uppercase tracking-wider block mb-1">Unrealized P&L</span>
          <span className={`text-xl md:text-2xl font-black font-mono ${liveUnrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {liveUnrealizedPnl >= 0 ? "+" : ""}
            ₹{liveUnrealizedPnl.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </span>
          <div className="text-[10px] text-slate-500 mt-1 font-mono">
            Active position float
          </div>
        </div>

        {/* Today's Session */}
        <div className="relative border border-slate-800 bg-[#070b15]/80 rounded-2xl p-4 shadow-xl">
          <span className="text-slate-500 font-mono text-[9px] uppercase tracking-wider block mb-1">Today's Session</span>
          <span className="text-xl md:text-2xl font-black text-slate-100 font-mono">
            {metrics.total_trades}
          </span>
          <div className="text-[10px] text-slate-500 mt-1 font-mono flex items-center justify-between">
            <span>Total Trades</span>
            <span className="text-cyan-400 font-semibold">{metrics.win_rate}% Win Rate</span>
          </div>
        </div>

        {/* Market Exposure */}
        <div className="relative border border-slate-800 bg-[#070b15]/80 rounded-2xl p-4 shadow-xl col-span-2 lg:col-span-1">
          <span className="text-slate-500 font-mono text-[9px] uppercase tracking-wider block mb-1">Market Exposure</span>
          <span className="text-xl md:text-2xl font-black text-slate-100 font-mono">
            {openPosition ? openPosition.quantity : 0}
          </span>
          <div className="text-[10px] mt-1 font-mono flex items-center justify-between">
            <span className="text-slate-500">Contracts</span>
            <span className={metrics.safety_state === 'SAFE' ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-black animate-pulse'}>
              {metrics.safety_state === 'SAFE' ? 'SAFE' : 'HALT'}
            </span>
          </div>
        </div>
      </section>

      {/* 3. Split Screen Brokerage Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* LEFT COLUMN: Candlestick/Equity Curve + Open Positions (2/3 width) */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          
          {/* Main Chart Container */}
          <div className="border border-slate-800 bg-[#070b15]/95 rounded-2xl p-4 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-3 mb-4">
              <div className="flex gap-4">
                <button 
                  onClick={() => setActiveChartTab('PRICE')}
                  className={`text-xs font-bold font-mono tracking-widest pb-1 border-b-2 transition-colors cursor-pointer ${activeChartTab === 'PRICE' ? 'border-cyan-400 text-cyan-400' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
                >
                  MARKET TRAJECTORY ({selectedAssetLabel.toUpperCase()})
                </button>
                <button 
                  onClick={() => setActiveChartTab('EQUITY')}
                  className={`text-xs font-bold font-mono tracking-widest pb-1 border-b-2 transition-colors cursor-pointer ${activeChartTab === 'EQUITY' ? 'border-cyan-400 text-cyan-400' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
                >
                  EQUITY TRAJECTORY
                </button>
                <button 
                  onClick={() => setActiveChartTab('PERFORMANCE')}
                  className={`text-xs font-bold font-mono tracking-widest pb-1 border-b-2 transition-colors cursor-pointer ${activeChartTab === 'PERFORMANCE' ? 'border-cyan-400 text-cyan-400' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
                >
                  PERFORMANCE ANALYTICS
                </button>
              </div>
              {activeChartTab === 'PRICE' ? (
                <div className="flex items-center gap-1 bg-slate-950/85 border border-slate-850 p-0.5 rounded-lg">
                  {['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1mo'].map((res) => (
                    <button
                      key={res}
                      onClick={() => setResolution(res)}
                      className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold transition-all cursor-pointer ${
                        resolution === res
                          ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/35 font-extrabold shadow-sm'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border border-transparent'
                      }`}
                    >
                      {res === '1mo' ? '1M' : res === '1m' ? '1m' : res.toUpperCase()}
                    </button>
                  ))}
                </div>
              ) : activeChartTab === 'EQUITY' ? (
                <div className="text-[10px] font-mono text-cyan-400 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded">
                  cum PnL curve
                </div>
              ) : (
                <div className="text-[10px] font-mono text-cyan-400 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded">
                  key metrics report
                </div>
              )}
            </div>

            {/* Price Candlestick Chart */}
            <div className={activeChartTab === 'PRICE' ? 'block' : 'hidden'}>
              <div ref={chartContainerRef} className="w-full h-[380px] rounded-xl overflow-hidden bg-[#090d16]" />
            </div>

            {/* Equity Curve Chart */}
            <div className={activeChartTab === 'EQUITY' ? 'block' : 'hidden'}>
              <div ref={equityChartContainerRef} className="w-full h-[380px] rounded-xl overflow-hidden bg-[#090d16]" />
            </div>

            {/* Performance Analytics Tab */}
            <div className={activeChartTab === 'PERFORMANCE' ? 'block' : 'hidden'}>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 p-2 font-mono text-xs">
                {/* Left Panel: Win Rate & Profit Factor Summary */}
                <div className="md:col-span-1 border border-slate-800/80 bg-slate-950/40 rounded-xl p-4 flex flex-col gap-4">
                  <h3 className="text-slate-400 font-bold tracking-wider border-b border-slate-800/80 pb-2 text-[11px] uppercase">
                    Key Performance Metrics
                  </h3>
                  
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-850">
                      <span className="text-slate-500 text-[9px] uppercase tracking-wider block mb-1">Profit Factor</span>
                      <span className="text-lg font-black text-cyan-400">
                        {calculateProfitFactor(trades).toFixed(2)}
                      </span>
                    </div>
                    
                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-850">
                      <span className="text-slate-500 text-[9px] uppercase tracking-wider block mb-1">Win Ratio</span>
                      <span className="text-lg font-black text-emerald-400">
                        {metrics.win_rate}%
                      </span>
                    </div>

                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-850">
                      <span className="text-slate-500 text-[9px] uppercase tracking-wider block mb-1">Avg Win</span>
                      <span className="text-xs font-bold text-emerald-400">
                        ₹{calculateAvgWinLoss(trades).avgWin.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </span>
                    </div>

                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-850">
                      <span className="text-slate-500 text-[9px] uppercase tracking-wider block mb-1">Avg Loss</span>
                      <span className="text-xs font-bold text-rose-400">
                        ₹{calculateAvgWinLoss(trades).avgLoss.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </span>
                    </div>
                  </div>

                  <div className="bg-slate-900/40 p-4 rounded-xl border border-slate-850/60 mt-2">
                    <div className="flex justify-between mb-2">
                      <span className="text-slate-400 uppercase tracking-widest text-[9px]">Winning Trades</span>
                      <span className="text-emerald-400 font-bold">
                        {trades.filter(t => t.status === 'CLOSED' && Number(t.pnl || 0) > 0).length}
                      </span>
                    </div>
                    <div className="flex justify-between mb-2">
                      <span className="text-slate-400 uppercase tracking-widest text-[9px]">Losing Trades</span>
                      <span className="text-rose-400 font-bold">
                        {trades.filter(t => t.status === 'CLOSED' && Number(t.pnl || 0) <= 0).length}
                      </span>
                    </div>
                    <div className="flex justify-between border-t border-slate-800 pt-2">
                      <span className="text-slate-400 uppercase tracking-widest text-[9px]">Total Completed</span>
                      <span className="text-slate-200 font-bold">
                        {trades.filter(t => t.status === 'CLOSED').length}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Right Panel: Time Period Breakdowns (Daily/Weekly/Monthly) */}
                <div className="md:col-span-2 flex flex-col gap-4">
                  <div className="border border-slate-800/80 bg-slate-950/40 rounded-xl p-4">
                    <h3 className="text-slate-400 font-bold tracking-wider border-b border-slate-800/80 pb-2 mb-3 text-[11px] uppercase">
                      Timeframe Performance Breakdown
                    </h3>
                    
                    <div className="grid grid-cols-3 gap-4 mb-4">
                      <div className="bg-slate-900/30 p-3 rounded-lg border border-slate-850">
                        <span className="text-slate-500 text-[8px] uppercase tracking-wider block mb-1">Weekly Return</span>
                        <span className={`text-sm font-black ${calculatePeriodReturn(trades, 'weekly') >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          ₹{calculatePeriodReturn(trades, 'weekly').toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                        </span>
                      </div>
                      <div className="bg-slate-900/30 p-3 rounded-lg border border-slate-850">
                        <span className="text-slate-500 text-[8px] uppercase tracking-wider block mb-1">Monthly Return</span>
                        <span className={`text-sm font-black ${calculatePeriodReturn(trades, 'monthly') >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          ₹{calculatePeriodReturn(trades, 'monthly').toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                        </span>
                      </div>
                      <div className="bg-slate-900/30 p-3 rounded-lg border border-slate-850">
                        <span className="text-slate-500 text-[8px] uppercase tracking-wider block mb-1">All-Time Net PnL</span>
                        <span className={`text-sm font-black ${metrics.net_profit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          ₹{metrics.net_profit.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                        </span>
                      </div>
                    </div>

                    <div className="overflow-x-auto max-h-[220px] overflow-y-auto pr-1">
                      <table className="w-full text-left border-collapse text-[10px]">
                        <thead>
                          <tr className="border-b border-slate-800 text-slate-500 uppercase tracking-widest text-[8px]">
                            <th className="py-2 px-1">Date</th>
                            <th className="py-2 px-1 text-center">Trades</th>
                            <th className="py-2 px-1 text-center">Wins</th>
                            <th className="py-2 px-1 text-center">Win %</th>
                            <th className="py-2 px-1 text-right">Net P&L</th>
                          </tr>
                        </thead>
                        <tbody>
                          {calculateDailyBreakdown(trades).map((day, idx) => (
                            <tr key={idx} className="border-b border-slate-850/50 hover:bg-slate-900/20">
                              <td className="py-2 px-1 text-slate-300 font-bold">{day.date}</td>
                              <td className="py-2 px-1 text-slate-400 text-center font-bold">{day.count}</td>
                              <td className="py-2 px-1 text-emerald-500 text-center font-bold">{day.wins}</td>
                              <td className="py-2 px-1 text-slate-300 text-center">{day.winRate}%</td>
                              <td className={`py-2 px-1 text-right font-black ${day.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                ₹{day.pnl >= 0 ? '+' : ''}{day.pnl.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Live Open Positions Panel */}
          <div className="border border-slate-800 bg-[#070b15]/95 rounded-2xl p-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-3 mb-3">
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
                <h2 className="text-xs font-bold font-mono tracking-widest text-slate-400 uppercase">LIVE OPEN POSITIONS</h2>
              </div>
            </div>

            {!openPosition ? (
              <div className="flex flex-col items-center justify-center py-10 border border-dashed border-slate-850 rounded-xl bg-slate-900/10">
                <div className="h-8 w-8 rounded-full border border-slate-700/60 flex items-center justify-center text-slate-500 mb-2">✓</div>
                <p className="text-[11px] text-slate-500 font-mono tracking-wider">
                  No active positions. Scanning for algorithmic setups.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse font-mono text-[11px]">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-500 uppercase tracking-widest text-[9px]">
                      <th className="py-2 px-2">Symbol</th>
                      <th className="py-2 px-2">Direction</th>
                      <th className="py-2 px-2">Quantity</th>
                      <th className="py-2 px-2">Entry Price</th>
                      <th className="py-2 px-2">Live Price</th>
                      <th className="py-2 px-2 text-right">Float P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-slate-850 hover:bg-slate-900/30">
                      <td className="py-3 px-2 font-bold text-slate-200">{openPosition.symbol}</td>
                      <td className="py-3 px-2">
                        <span className={`px-1.5 py-0.5 rounded font-bold text-[9px] ${openPosition.direction === 'BUY' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}`}>
                          {openPosition.direction}
                        </span>
                      </td>
                      <td className="py-3 px-2 text-slate-300 font-bold">{openPosition.quantity}</td>
                      <td className="py-3 px-2 text-slate-300">₹{Number(openPosition.entry_price).toFixed(2)}</td>
                      <td className="py-3 px-2 text-cyan-400 font-bold animate-pulse">₹{liveSpotPrice.toFixed(2)}</td>
                      <td className={`py-3 px-2 text-right font-black ${liveUnrealizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        ₹{liveUnrealizedPnl >= 0 ? '+' : ''}{liveUnrealizedPnl.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: Interactive Ledger (1/3 width) */}
        <div className="border border-slate-800 bg-[#070b15]/95 rounded-2xl p-4 shadow-2xl h-fit">
          <div className="flex items-center justify-between border-b border-slate-800/80 pb-3 mb-4">
            <div className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 rounded-full bg-cyan-500" />
              <h2 className="text-xs font-bold font-mono tracking-widest text-slate-400 uppercase">INTERACTIVE LEDGER</h2>
            </div>
            <span className="text-[10px] text-slate-500 font-mono">click row to expand</span>
          </div>

          {/* Ledger scrollable container */}
          <div className="flex flex-col gap-3 max-h-[620px] overflow-y-auto pr-1 scrollbar-thin">
            {trades.length === 0 ? (
              <div className="text-center py-12 text-slate-550 font-mono text-xs border border-dashed border-slate-850 rounded-xl bg-slate-900/10">
                NO TRADES IN ACTIVE LEDGER.
              </div>
            ) : (
              trades.map((t) => {
                const isExpanded = expandedTradeId === t.id;
                const formattedTime = new Date(t.entry_time).toLocaleTimeString('en-US', {
                  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
                });

                // Determine badge style
                let badgeText = "ORDER EXECUTED";
                let badgeClass = "bg-cyan-500/10 text-cyan-400 border border-cyan-500/25";
                
                if (t.status === 'CLOSED') {
                  const closedPnl = Number(t.pnl || 0);
                  if (closedPnl < 0) {
                    badgeText = "STOP LOSS";
                    badgeClass = "bg-rose-500/10 text-rose-400 border border-rose-500/25";
                  } else {
                    badgeText = "TAKE PROFIT";
                    badgeClass = "bg-emerald-500/10 text-emerald-400 border border-emerald-500/25";
                  }
                }

                return (
                  <div 
                    key={t.id}
                    onClick={() => setExpandedTradeId(isExpanded ? null : t.id)}
                    className={`border border-slate-850 bg-slate-900/20 hover:bg-slate-900/40 rounded-xl p-3.5 cursor-pointer transition-all duration-200 ${isExpanded ? 'border-cyan-500/40 shadow-lg shadow-cyan-950/10 bg-[#090d16]/80' : ''}`}
                  >
                    {/* Header: Badge & Time */}
                    <div className="flex items-center justify-between mb-2">
                      <span className={`text-[9px] font-bold font-mono px-2 py-0.5 rounded ${badgeClass}`}>
                        {badgeText}
                      </span>
                      <span className="text-[10px] text-slate-500 font-mono">{formattedTime}</span>
                    </div>

                    {/* Body: Symbol & Price */}
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-200">{t.symbol}</span>
                      <span className="text-xs font-bold font-mono text-slate-300">
                        ₹{Number(t.entry_price).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </span>
                    </div>

                    {/* Expandable Section */}
                    {isExpanded && (
                      <div className="mt-3 pt-3 border-t border-slate-850/80 font-mono text-[10px] text-slate-400 space-y-2.5 animate-fadeIn">
                        <div>
                          <span className="text-slate-500 uppercase tracking-widest text-[8px] block mb-0.5">Setup Logic</span>
                          <span className="text-slate-300 font-semibold block bg-slate-900/50 p-1.5 rounded border border-slate-850/50 leading-relaxed">
                            {t.setup_logic || "Algorithm alignment trigger."}
                          </span>
                        </div>

                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <span className="text-slate-500 uppercase tracking-widest text-[8px] block mb-0.5">Execution Hash</span>
                            <div className="flex items-center gap-1.5">
                              <span className="text-cyan-400 font-bold bg-slate-900 px-1.5 py-0.5 rounded border border-slate-850/50">
                                {(t.execution_hash || "").slice(0, 10)}
                              </span>
                              <button 
                                onClick={(e) => { e.stopPropagation(); copyToClipboard(t.execution_hash || ""); }}
                                className="text-[9px] text-slate-500 hover:text-white cursor-pointer bg-slate-800 px-1 rounded transition-colors"
                              >
                                {copiedHash === t.execution_hash ? 'copied' : 'copy'}
                              </button>
                            </div>
                          </div>
                          <div>
                            <span className="text-slate-500 uppercase tracking-widest text-[8px] block mb-0.5 text-right">Slip Offset</span>
                            <span className="text-slate-300 font-bold block text-right mt-0.5">
                              {t.slippage ? `₹${Number(t.slippage).toFixed(2)} pts` : '—'}
                            </span>
                          </div>
                        </div>

                        <div className="pt-2 border-t border-slate-850/30 flex items-center justify-between">
                          <span className="text-slate-500 uppercase tracking-widest text-[8px]">PnL Outcome</span>
                          <span className={`text-xs font-black ${Number(t.pnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                            {t.status === 'CLOSED' 
                              ? `₹${Number(t.pnl).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
                              : 'RISK MITIGATED'
                            }
                          </span>
                        </div>

                        {t.status === 'CLOSED' && (
                          <div className="bg-[#0f1d17]/30 border border-emerald-950/20 p-2 rounded text-[10px] text-slate-400 leading-normal">
                            <span className="text-emerald-400 font-bold block uppercase text-[8px] mb-0.5">BROKER RAW RESPONSE</span>
                            BUY {t.symbol}_ATM_CE | SL: {Number(t.entry_price - 20).toFixed(1)} | TP: {Number(t.entry_price + 40).toFixed(1)}
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
  );
}
