"use client";

import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, CandlestickSeries, LineSeries, AreaSeries, createSeriesMarkers } from 'lightweight-charts';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';

// Helper to resolve environment variables safely (checking for literal "undefined" or "null" from bundlers)
const getEnvVal = (val: any, fallback: string): string => {
  if (!val || val === "undefined" || val === "null" || val === "") {
    return fallback;
  }
  return String(val).trim();
};

// Setup Supabase Client
const supabaseUrl = getEnvVal(process.env.NEXT_PUBLIC_SUPABASE_URL, "https://znejercxaxygncotvqpa.supabase.co");
const supabaseAnonKey = getEnvVal(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpuZWplcmN4YXh5Z25jb3R2cXBhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3MDE5NTAsImV4cCI6MjA5NTI3Nzk1MH0.pFhQ30-ZGf0af6AdvW1mm0hx66BsRqtlG1muGYLIzBc");
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const BACKEND_URL = getEnvVal(process.env.NEXT_PUBLIC_BACKEND_URL, "http://localhost:8000");

// Helper to retrieve active Supabase session access token for Bearer headers
const getAuthHeaders = async () => {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return {
      'Content-Type': 'application/json',
      'Authorization': session ? `Bearer ${session.access_token}` : '',
    };
  } catch (err) {
    console.error("Error generating auth headers:", err);
    return {
      'Content-Type': 'application/json',
      'Authorization': '',
    };
  }
};

// =============================================================================
// SWING TRADING TECHNICAL INDICATORS & SCORING SYSTEM (Ported from analysis.js)
// =============================================================================

interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

const calcSMA = (closes: number[], period: number): (number | null)[] => {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1);
    return slice.reduce((s, v) => s + v, 0) / period;
  });
};

const calcEMA = (closes: number[], period: number): number[] => {
  const k = 2 / (period + 1);
  const ema: number[] = [];
  closes.forEach((c, i) => {
    if (i === 0) { ema.push(c); return; }
    ema.push(c * k + ema[i - 1] * (1 - k));
  });
  return ema;
};

const calcRSI = (closes: number[], period: number = 14): (number | null)[] => {
  if (closes.length < period + 1) return Array(closes.length).fill(50);
  const rsi: number[] = [];
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }

  const padding = Array(closes.length - rsi.length).fill(null);
  return [...padding, ...rsi];
};

const calcMACD = (closes: number[], fast: number = 12, slow: number = 26, signal: number = 9) => {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = calcEMA(macdLine.slice(slow - 1), signal);
  const histogram = macdLine.slice(slow - 1).map((m, i) => m - (signalLine[i] || 0));
  return {
    macd: macdLine,
    signal: [...Array(slow - 1).fill(null), ...signalLine],
    histogram: [...Array(slow - 1).fill(null), ...histogram],
  };
};

const calcBollingerBands = (closes: number[], period: number = 20, stdDev: number = 2) => {
  const sma = calcSMA(closes, period);
  return closes.map((_, i) => {
    if (i < period - 1 || sma[i] == null) return { upper: null, mid: null, lower: null };
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = sma[i] as number;
    const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;
    const std = Math.sqrt(variance);
    return { upper: mean + stdDev * std, mid: mean, lower: mean - stdDev * std };
  });
};

const calcATR = (highs: number[], lows: number[], closes: number[], period: number = 14): number[] => {
  const tr = closes.map((c, i) => {
    if (i === 0) return highs[i] - lows[i];
    return Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  });
  return calcEMA(tr, period);
};

const calcSupportResistance = (data: CandleData[]) => {
  const dummy = { pivot: 0, r1: 0, r2: 0, s1: 0, s2: 0, supports: [] as number[], resistances: [] as number[] };
  if (!data || data.length < 30) {
    return { daily: dummy, weekly: dummy, fourHour: dummy, pivot: 0, r1: 0, r2: 0, s1: 0, s2: 0, supports: [], resistances: [] };
  }

  const getPivots = (high: number, low: number, close: number) => {
    const pivot = (high + low + close) / 3;
    const r1 = 2 * pivot - low;
    const r2 = pivot + (high - low);
    const s1 = 2 * pivot - high;
    const s2 = pivot - (high - low);
    return { pivot, r1, r2, s1, s2 };
  };

  const prevDay = data[data.length - 2] || data[data.length - 1];
  const daily = getPivots(prevDay.high, prevDay.low, prevDay.close);

  // Simple weekly approximation
  const recent5 = data.slice(-5);
  const wHigh = Math.max(...recent5.map(d => d.high));
  const wLow = Math.min(...recent5.map(d => d.low));
  const wClose = data[data.length - 1].close;
  const weekly = getPivots(wHigh, wLow, wClose);

  const recent3 = data.slice(-3);
  const recentHigh = Math.max(...recent3.map(d => d.high));
  const recentLow = Math.min(...recent3.map(d => d.low));
  const recentClose = data[data.length - 1].close;
  const fourHour = getPivots(recentHigh, recentLow, recentClose);

  const recent = data.slice(-30);
  const resistances = recent
    .filter((d, i, arr) => i > 0 && i < arr.length - 1 && d.high > arr[i - 1].high && d.high > arr[i + 1].high)
    .map(d => d.high)
    .slice(-3);

  const supports = recent
    .filter((d, i, arr) => i > 0 && i < arr.length - 1 && d.low < arr[i - 1].low && d.low < arr[i + 1].low)
    .map(d => d.low)
    .slice(-3);

  return { 
    daily, 
    weekly, 
    fourHour, 
    pivot: daily.pivot, 
    r1: daily.r1, 
    r2: daily.r2, 
    s1: daily.s1, 
    s2: daily.s2, 
    supports, 
    resistances 
  };
};

const detectVolumeSpikes = (data: CandleData[]) => {
  if (!data || data.length < 21) return { spikes: 0, avgVolume: 0, latestVolume: 0, latestRatio: 1, institutionalSignal: 'neutral', accumulation: false, distribution: false };

  const volumes = data.map(d => d.volume || 0);
  const avgVols = calcSMA(volumes, 20);

  const latestVol = volumes[volumes.length - 1];
  const latestAvg = (avgVols[avgVols.length - 1] as number) || 1;
  const latestRatio = latestVol / latestAvg;

  const spikes = data.slice(-20).filter((d, i) => {
    const avg = avgVols[avgVols.length - 20 + i];
    return avg && d.volume && d.volume > (avg as number) * 1.5;
  });

  let institutionalSignal = 'neutral';
  if (latestRatio > 2.5) institutionalSignal = 'strong';
  else if (latestRatio > 1.5) institutionalSignal = 'moderate';
  else if (latestRatio < 0.7) institutionalSignal = 'weak';

  const lastCandle = data[data.length - 1];
  const prevCandle = data[data.length - 2];
  const priceUp = lastCandle && prevCandle && lastCandle.close > prevCandle.close;

  return {
    spikes: spikes.length,
    avgVolume: latestAvg,
    latestVolume: latestVol,
    latestRatio: parseFloat(latestRatio.toFixed(2)),
    institutionalSignal,
    accumulation: priceUp && latestRatio > 1.5,
    distribution: !priceUp && latestRatio > 1.5,
  };
};

const detectTrend = (data: CandleData[]): string => {
  if (!data || data.length < 50) return 'sideways';
  const closes = data.map(d => d.close);
  const sma20 = calcSMA(closes, 20);
  const sma50 = calcSMA(closes, 50);

  const last20 = sma20[sma20.length - 1] || 0;
  const last50 = sma50[sma50.length - 1] || 0;
  const currentPrice = closes[closes.length - 1];

  if (currentPrice > last20 && last20 > last50) return 'uptrend';
  if (currentPrice < last20 && last20 < last50) return 'downtrend';
  return 'sideways';
};

const scoreFundamentals = (fund: any, symbol: string, sector: string) => {
  if (!fund) {
    return {
      score: 0,
      checklist: [
        { label: 'Valuation Quality', passed: false, value: 'N/A', desc: 'PE below industry average or PB ratio under 3.0 indicates healthy valuation.', score: 0, max: 9 },
        { label: 'Earnings & Revenue Growth', passed: false, value: 'N/A', desc: 'Strong double digit top-line and bottom-line growth confirms business expansion.', score: 0, max: 8 },
        { label: 'Balance Sheet & ROE', passed: false, value: 'N/A', desc: 'Debt-to-equity below 1.0 limits insolvency risk, while ROE above 12% shows efficient capital use.', score: 0, max: 8 }
      ]
    };
  }

  const checklist: any[] = [];
  const sym = (symbol || '').toUpperCase();
  const sec = (sector || '').toUpperCase();
  
  const isFinancial = sec.includes('BANK') || sec.includes('NBFC') || sec.includes('FINANCIAL') || 
                      ['HDFCBANK.NS', 'ICICIBANK.NS', 'AXISBANK.NS', 'SBIN.NS', 'KOTAKBANK.NS', 'BAJFINANCE.NS', 'BAJAJFINSV.NS', 'JPM', 'GS', 'MS'].includes(sym);
                      
  const isIndian = sym.endsWith('.NS') || sym.endsWith('.BO');
  const marketCap = fund.marketCap || 0;
  const isMegaCap = isIndian ? (marketCap > 1.5e12) : (marketCap > 1.5e11);

  // 1. Valuation Quality
  let peScore = 0;
  let peDesc = '';
  if (fund.pe === null || fund.pe === undefined || fund.pe <= 0) {
    peScore = 5;
    peDesc = 'PE: N/A';
  } else if (fund.pe < 15) {
    peScore = 9;
    peDesc = `PE: ${fund.pe.toFixed(1)} (Highly Undervalued)`;
  } else if (fund.pe < 30) {
    peScore = 7;
    peDesc = `PE: ${fund.pe.toFixed(1)} (Reasonable/Fair)`;
  } else if (fund.pe < 45) {
    peScore = 5;
    peDesc = `PE: ${fund.pe.toFixed(1)} (Premium Valuation)`;
  } else {
    peScore = 2;
    peDesc = `PE: ${fund.pe.toFixed(1)} (Highly Stretched)`;
  }
  
  let peBonus = 0;
  if (fund.pe && fund.industryPe && fund.pe < fund.industryPe * 1.1) {
    peBonus = 1;
    peDesc += ` [Industry PE: ${fund.industryPe.toFixed(1)}]`;
  }
  
  let pbScore = 0;
  let pbDesc = '';
  if (fund.pb === null || fund.pb === undefined || fund.pb <= 0) {
    pbScore = 5;
    pbDesc = 'PB: N/A';
  } else if (fund.pb < 3) {
    pbScore = 9;
    pbDesc = `PB: ${fund.pb.toFixed(2)} (Value)`;
  } else if (fund.pb < 6) {
    pbScore = 7;
    pbDesc = `PB: ${fund.pb.toFixed(2)} (Reasonable)`;
  } else {
    pbScore = 4;
    pbDesc = `PB: ${fund.pb.toFixed(2)} (Stretched)`;
  }
  
  const valScore = Math.min(9, Math.round((peScore + pbScore) / 2) + peBonus);
  checklist.push({
    label: 'Valuation Quality',
    passed: valScore >= 6,
    value: `${peDesc}, ${pbDesc}`,
    desc: 'Assesses P/E vs industry averages and P/B ratios. Moat companies are allowed premium multiples.',
    score: valScore,
    max: 9
  });

  // 2. Earnings & Revenue Growth
  let revScore = 0;
  let revDesc = '';
  if (fund.revenueGrowth === null || fund.revenueGrowth === undefined) {
    revScore = 1;
    revDesc = 'N/A';
  } else if (fund.revenueGrowth > 12) {
    revScore = 4;
    revDesc = `Rev YoY: +${fund.revenueGrowth.toFixed(1)}%`;
  } else if (fund.revenueGrowth > 6) {
    revScore = 3;
    revDesc = `Rev YoY: +${fund.revenueGrowth.toFixed(1)}%`;
  } else if (fund.revenueGrowth >= 0) {
    revScore = 2;
    revDesc = `Rev YoY: +${fund.revenueGrowth.toFixed(1)}%`;
  } else {
    revScore = 0;
    revDesc = `Rev YoY: ${fund.revenueGrowth.toFixed(1)}% (Decline)`;
  }

  let earnScore = 0;
  let earnDesc = '';
  if (fund.earningsGrowth === null || fund.earningsGrowth === undefined) {
    earnScore = 1;
    earnDesc = 'N/A';
  } else if (fund.earningsGrowth > 15) {
    earnScore = 4;
    earnDesc = `EPS YoY: +${fund.earningsGrowth.toFixed(1)}%`;
  } else if (fund.earningsGrowth > 8) {
    earnScore = 3;
    earnDesc = `EPS YoY: +${fund.earningsGrowth.toFixed(1)}%`;
  } else if (fund.earningsGrowth >= 0) {
    earnScore = 2;
    earnDesc = `EPS YoY: +${fund.earningsGrowth.toFixed(1)}%`;
  } else {
    earnScore = 0;
    earnDesc = `EPS YoY: ${fund.earningsGrowth.toFixed(1)}% (Decline)`;
  }

  const growthScore = Math.min(8, revScore + earnScore);
  checklist.push({
    label: 'Earnings & Revenue Growth',
    passed: growthScore >= 5,
    value: `${revDesc}, ${earnDesc}`,
    desc: 'Measures top-line revenue expansion and bottom-line EPS acceleration year-over-year.',
    score: growthScore,
    max: 8
  });

  // 3. Balance Sheet & ROE
  let debtScore = 0;
  let debtDesc = '';
  if (isFinancial) {
    if (fund.currentRatio !== null && fund.currentRatio !== undefined) {
      if (fund.currentRatio > 1.2) {
        debtScore = 4;
        debtDesc = `Financials: Strong Liquidity (Current Ratio: ${fund.currentRatio.toFixed(2)})`;
      } else {
        debtScore = 3;
        debtDesc = `Financials: Adequate Liquidity (Current Ratio: ${fund.currentRatio.toFixed(2)})`;
      }
    } else {
      debtScore = 4;
      debtDesc = `Leverage: N/A (Financial Sector)`;
    }
  } else if (fund.debtToEquity === null || fund.debtToEquity === undefined) {
    debtScore = 2;
    debtDesc = 'D/E: N/A';
  } else if (fund.debtToEquity < 0.5) {
    debtScore = 4;
    debtDesc = `D/E: ${fund.debtToEquity.toFixed(2)} (Minimal Debt)`;
  } else if (fund.debtToEquity < 1.0) {
    debtScore = 3;
    debtDesc = `D/E: ${fund.debtToEquity.toFixed(2)} (Healthy)`;
  } else if (fund.debtToEquity < 1.5) {
    debtScore = 2;
    debtDesc = `D/E: ${fund.debtToEquity.toFixed(2)} (Moderate Debt)`;
  } else {
    debtScore = 1;
    debtDesc = `D/E: ${fund.debtToEquity.toFixed(2)} (Leveraged)`;
  }

  let roeScore = 0;
  let roeDesc = '';
  const roeVal = fund.roe !== null && fund.roe !== undefined ? fund.roe : (fund.roce !== null && fund.roce !== undefined ? fund.roce : null);
  const isRoceFallback = fund.roe === null || fund.roe === undefined;
  const metricLabel = isRoceFallback ? 'ROCE' : 'ROE';

  if (roeVal === null || roeVal === undefined) {
    roeScore = 1;
    roeDesc = 'Profitability: N/A';
  } else if (isMegaCap) {
    if (roeVal > 12) {
      roeScore = 4;
      roeDesc = `${metricLabel}: ${roeVal.toFixed(1)}% (Excellent for scale)`;
    } else if (roeVal > 9) {
      roeScore = 3;
      roeDesc = `${metricLabel}: ${roeVal.toFixed(1)}% (Solid for scale)`;
    } else if (roeVal >= 5) {
      roeScore = 2;
      roeDesc = `${metricLabel}: ${roeVal.toFixed(1)}% (Low/Consolidating)`;
    } else {
      roeScore = 1;
      roeDesc = `${metricLabel}: ${roeVal.toFixed(1)}% (Poor)`;
    }
  } else {
    if (roeVal > 15) {
      roeScore = 4;
      roeDesc = `${metricLabel}: ${roeVal.toFixed(1)}% (Excellent)`;
    } else if (roeVal > 10) {
      roeScore = 3;
      roeDesc = `${metricLabel}: ${roeVal.toFixed(1)}% (Good)`;
    } else if (roeVal >= 6) {
      roeScore = 2;
      roeDesc = `${metricLabel}: ${roeVal.toFixed(1)}% (Subpar)`;
    } else {
      roeScore = 1;
      roeDesc = `${metricLabel}: ${roeVal.toFixed(1)}% (Poor)`;
    }
  }

  let marginBonus = 0;
  if (fund.profitMargin !== null && fund.profitMargin !== undefined && fund.profitMargin > 15) {
    marginBonus = 1;
    roeDesc += ` [Margin: ${fund.profitMargin.toFixed(1)}%]`;
  }

  const balanceScore = Math.min(8, debtScore + roeScore + marginBonus);
  checklist.push({
    label: 'Balance Sheet & ROE',
    passed: balanceScore >= 6,
    value: `${debtDesc}, ${roeDesc}`,
    desc: 'Verifies leverage limits to avoid insolvency and confirms capital efficiency via Return on Equity.',
    score: balanceScore,
    max: 8
  });

  return { score: Math.min(25, valScore + growthScore + balanceScore), checklist };
};

const scoreTechnicalSetup = (data: CandleData[], quote: any) => {
  if (!data || data.length < 30) {
    return {
      score: 0,
      checklist: [
        { label: 'Trend Structure (SMA)', passed: false, value: 'N/A', desc: 'Price > SMA20 > SMA50 > SMA200', score: 0, max: 8 },
        { label: 'Support Zone Proximity', passed: false, value: 'N/A', desc: 'Price within 3% of support (S1/S2 or SMA200)', score: 0, max: 6 },
        { label: 'Volatility Squeeze/Breakout', passed: false, value: 'N/A', desc: 'Bollinger Band squeeze or upper band breakout', score: 0, max: 6 }
      ],
      indicators: {} as any
    };
  }

  const closes = data.map(d => d.close);
  const currentPrice = closes[closes.length - 1];
  const sma20 = calcSMA(closes, 20);
  const sma50 = calcSMA(closes, 50);
  const sma200 = calcSMA(closes, 200);

  const lastSma20 = (sma20[sma20.length - 1] as number) || 0;
  const lastSma50 = (sma50[sma50.length - 1] as number) || 0;
  const lastSma200 = (sma200[sma200.length - 1] as number) || 0;

  const sr = calcSupportResistance(data);
  const bb = calcBollingerBands(closes, 20, 2);
  const lastBB = bb[bb.length - 1] || {};

  const checklist: any[] = [];
  let score = 0;

  // 1. SMA Trend Structure
  const smaPassed = currentPrice > lastSma20 && lastSma20 > lastSma50;
  const smaText = [];
  if (currentPrice > lastSma20) smaText.push('Price > SMA20');
  if (lastSma20 > lastSma50) smaText.push('SMA20 > SMA50');
  if (lastSma50 > lastSma200) smaText.push('SMA50 > SMA200');
  
  const smaScore = smaPassed ? (lastSma50 > lastSma200 ? 8 : 6) : 2;
  score += smaScore;
  checklist.push({
    label: 'Trend Structure (SMA)',
    passed: smaPassed,
    value: smaText.length > 0 ? smaText.join(', ') : 'Downtrend alignment',
    desc: 'Aligning with SMA20, 50, and 200 ensures trading in the direction of the primary market trend.',
    score: smaScore,
    max: 8
  });

  // 2. Support Zone Proximity
  let supportPassed = false;
  const symbol = quote?.symbol || '';
  const isUS = !symbol.endsWith('.NS') && !symbol.endsWith('.BO');
  const cSym = isUS ? '$' : '₹';
  let supportVal = 'Far from support';
  
  const distS1 = sr.s1 ? Math.abs(currentPrice - sr.s1) / currentPrice : 99;
  const distS2 = sr.s2 ? Math.abs(currentPrice - sr.s2) / currentPrice : 99;
  const distSma200 = lastSma200 ? Math.abs(currentPrice - lastSma200) / currentPrice : 99;

  if (distS1 < 0.03) {
    supportPassed = true;
    supportVal = `Near S1 (${cSym}${sr.s1.toFixed(1)})`;
  } else if (distS2 < 0.03) {
    supportPassed = true;
    supportVal = `Near S2 (${cSym}${sr.s2.toFixed(1)})`;
  } else if (distSma200 < 0.03) {
    supportPassed = true;
    supportVal = `Near SMA200 (${cSym}${lastSma200.toFixed(1)})`;
  }
  const supportScore = supportPassed ? 6 : 2;
  score += supportScore;
  checklist.push({
    label: 'Support Zone Proximity',
    passed: supportPassed,
    value: supportPassed ? supportVal : `S1: ${cSym}${sr.s1?.toFixed(1) || 'N/A'}`,
    desc: 'Entering trades near key supports provides optimal risk-to-reward setup.',
    score: supportScore,
    max: 6
  });

  // 3. Volatility Breakout
  let bbPassed = false;
  let bbVal = 'Normal Bandwidth';
  if (lastBB.mid && lastBB.upper && lastBB.lower) {
    const bbBandwidth = (lastBB.upper - lastBB.lower) / lastBB.mid;
    if (bbBandwidth < 0.12) {
      bbPassed = true;
      bbVal = `Squeeze (Bandwidth: ${(bbBandwidth * 100).toFixed(1)}%)`;
    } else if (currentPrice >= lastBB.upper) {
      bbPassed = true;
      bbVal = 'Upper Band Breakout';
    }
  }
  const bbScore = bbPassed ? 6 : 3;
  score += bbScore;
  checklist.push({
    label: 'Volatility Squeeze/Breakout',
    passed: bbPassed,
    value: bbVal,
    desc: 'Bollinger Band Squeeze hints at imminent expansion. Breakout above upper band indicates strong momentum.',
    score: bbScore,
    max: 6
  });

  const volData = detectVolumeSpikes(data);
  const trend = detectTrend(data);

  return {
    score: Math.min(20, score),
    checklist,
    indicators: {
      sma20: lastSma20,
      sma50: lastSma50,
      sma200: lastSma200,
      sr,
      lastBB,
      currentPrice,
      volData,
      trend
    }
  };
};

const scoreMomentum = (data: CandleData[]) => {
  if (!data || data.length < 30) {
    return {
      score: 0,
      checklist: [
        { label: 'RSI Momentum Zone', passed: false, value: 'N/A', desc: 'RSI between 40 and 65 (bull phase)', score: 0, max: 10 },
        { label: 'MACD Trend Confirmation', passed: false, value: 'N/A', desc: 'MACD Line > Signal Line', score: 0, max: 10 }
      ],
      indicators: {} as any
    };
  }

  const closes = data.map(d => d.close);
  const highs = data.map(d => d.high);
  const lows = data.map(d => d.low);

  const rsiArr = calcRSI(closes, 14);
  const rsi = (rsiArr[rsiArr.length - 1] as number) || 50;

  const macdData = calcMACD(closes);
  const lastMacd = macdData.macd[macdData.macd.length - 1] || 0;
  const lastSignal = macdData.signal[macdData.signal.length - 1] || 0;
  const prevMacd = macdData.macd[macdData.macd.length - 2] || 0;
  const prevSignal = macdData.signal[macdData.signal.length - 2] || 0;
  const macdCrossover = lastMacd > lastSignal && prevMacd <= prevSignal;
  const macdBullish = lastMacd > lastSignal;

  const volData = detectVolumeSpikes(data);
  const atrArr = calcATR(highs, lows, closes, 14);
  const atr = atrArr[atrArr.length - 1] || closes[closes.length - 1] * 0.02;

  const checklist: any[] = [];
  let score = 0;

  // 1. RSI Zone Check
  let rsiVal = `RSI: ${rsi.toFixed(1)}`;
  if (rsi >= 40 && rsi <= 65) {
    rsiVal += ' (Bullish Zone)';
  } else if (rsi < 40) {
    rsiVal += ' (Oversold/Weak)';
  } else {
    rsiVal += ' (Overbought Alert)';
  }
  const rsiScore = rsi >= 40 && rsi <= 65 ? 10 : rsi >= 30 && rsi < 40 ? 6 : rsi > 65 && rsi <= 75 ? 5 : 2;
  score += rsiScore;
  checklist.push({
    label: 'RSI Momentum Zone',
    passed: rsi >= 40 && rsi <= 70,
    value: rsiVal,
    desc: 'RSI between 40 and 65 signals healthy trend momentum. Avoid entry when RSI is > 75 (overbought).',
    score: rsiScore,
    max: 10
  });

  // 2. MACD Trend Check
  let macdVal = 'Bearish';
  if (macdCrossover) {
    macdVal = 'Bullish Crossover! 🔥';
  } else if (macdBullish) {
    macdVal = 'Bullish Alignment';
  }
  const macdScore = macdCrossover ? 10 : macdBullish ? 7 : 2;
  score += macdScore;
  checklist.push({
    label: 'MACD Trend Confirmation',
    passed: macdCrossover || macdBullish,
    value: macdVal,
    desc: 'Bullish MACD line crossing above the signal line indicates positive momentum acceleration.',
    score: macdScore,
    max: 10
  });

  return {
    score: Math.min(20, score),
    checklist,
    indicators: {
      rsi,
      rsiSignal: rsi < 30 ? 'Oversold' : rsi > 70 ? 'Overbought' : rsi >= 40 && rsi <= 60 ? 'Healthy' : 'Neutral',
      macd: parseFloat(lastMacd.toFixed(3)),
      macdSignal: parseFloat(lastSignal.toFixed(3)),
      macdCrossover,
      macdBullish,
      volData,
      atr
    }
  };
};

const scoreSentiment = (fearGreed: any, news: any[]) => {
  const checklist: any[] = [];
  let score = 0;

  // 1. Fear & Greed Index
  const fgVal = fearGreed?.value || 50;
  const fgValText = `${fgVal} - ${fearGreed?.text || 'Neutral'}`;

  let fgScore = 4;
  if (fgVal <= 45) {
    fgScore = fgVal <= 25 ? 8 : 7;
  } else if (fgVal <= 60) {
    fgScore = 5;
  } else {
    fgScore = fgVal > 75 ? 2 : 3;
  }
  score += fgScore;
  checklist.push({
    label: 'Market Sentiment (Fear & Greed)',
    passed: fgVal <= 45,
    value: fgValText,
    desc: 'Buying in Fear zones limits structural risk, while buying in Greed zones exposes to market reversals.',
    score: fgScore,
    max: 8
  });

  // 2. News Sentiment Bias
  let newsVal = 'No News Sentiment';
  let newsScore = 4;

  if (news && news.length > 0) {
    const pos = news.filter(n => n.sentiment === 'positive').length;
    const neg = news.filter(n => n.sentiment === 'negative').length;
    const total = news.length;
    const ratio = (pos - neg) / total;

    if (ratio > 0.1) {
      newsVal = `Positive bias (+${Math.round(ratio * 100)}%)`;
      newsScore = ratio > 0.4 ? 7 : 5;
    } else if (ratio < -0.1) {
      newsVal = `Negative bias (${Math.round(ratio * 100)}%)`;
      newsScore = ratio < -0.4 ? 1 : 2;
    } else {
      newsVal = 'Neutral news bias';
      newsScore = 4;
    }
  }
  score += newsScore;
  checklist.push({
    label: 'News Sentiment Ratio',
    passed: newsScore >= 4,
    value: newsVal,
    desc: 'Monitors the ratio of positive to negative press and research reports on the stock.',
    score: newsScore,
    max: 7
  });

  return { score: Math.min(15, score), checklist };
};

const scoreInstitutional = (fund: any, volData: any) => {
  const checklist: any[] = [];
  let score = 0;

  // 1. Shareholding & FII/DII positioning
  let flowPassed = false;
  let flowVal = 'Neutral Flows';
  const sh = fund?.shareholding || {};

  let instPercentage = null;
  if (sh.fii && sh.fii.length > 0) {
    instPercentage = sh.fii[sh.fii.length - 1] || 0;
  } else if (sh.institutions !== undefined && sh.institutions !== null) {
    instPercentage = sh.institutions;
  }

  if (instPercentage !== null && instPercentage > 25) {
    flowPassed = true;
    flowVal = `High FII/DII (${instPercentage.toFixed(1)}%)`;
  } else if (volData?.accumulation) {
    flowPassed = true;
    flowVal = 'Accumulation Spike (Est)';
  } else if (instPercentage !== null) {
    flowVal = `FII/DII: ${instPercentage.toFixed(1)}%`;
  }

  const instScore = instPercentage && instPercentage > 35 ? 10 : (instPercentage && instPercentage > 25 ? 8 : (volData?.accumulation ? 8 : (volData?.institutionalSignal === 'moderate' ? 6 : 4)));
  score += instScore;
  checklist.push({
    label: 'Institutional Holdings (FII/DII)',
    passed: flowPassed || instScore >= 6,
    value: flowVal,
    desc: 'Tracking promoter holding and institutional accumulation reveals smart money actions.',
    score: instScore,
    max: 10
  });

  // 2. Volume & Delivery/Block deals indicators
  let volPassed = false;
  let volVal = `${volData?.latestRatio || 1.0}x avg`;
  if (volData?.latestRatio >= 1.5) {
    volPassed = true;
    volVal += ' (Surge)';
  }
  const volScore = volData?.latestRatio >= 2.0 ? 10 : (volData?.latestRatio >= 1.5 ? 8 : (volData?.latestRatio >= 1.0 ? 6 : 2));
  score += volScore;
  checklist.push({
    label: 'Volume Flow & Block Indicators',
    passed: volPassed,
    value: volVal,
    desc: 'Volume expansion confirms the price move is backed by institutional buying, not noise.',
    score: volScore,
    max: 10
  });

  return { score: Math.min(20, score), checklist };
};

const compositeScore = (
  fundScore: number, 
  setupScore: number, 
  momScore: number, 
  sentScore: number, 
  instScore: number, 
  price: number, 
  sma200: number | null, 
  customWeights: any, 
  activeRegime: 'bull' | 'bear' = 'bull'
) => {
  const w = customWeights || {
    fundamental: 25,
    technical: 30,
    momentum: 20,
    sentiment: 10,
    institutional: 15
  };

  let wFund = w.fundamental;
  let wSetup = w.technical;
  let wMom = w.momentum;
  let wSent = w.sentiment;
  let wInst = w.institutional;

  if (activeRegime === 'bear') {
    wMom = wMom * 0.7;
    wSetup = wSetup * 0.7;
    wFund = wFund * 1.3;
    
    const sum = wFund + wSetup + wMom + wSent + wInst;
    if (sum > 0) {
      wFund = (wFund / sum) * 100;
      wSetup = (wSetup / sum) * 100;
      wMom = (wMom / sum) * 100;
      wSent = (wSent / sum) * 100;
      wInst = (wInst / sum) * 100;
    }
  }

  const pFund = fundScore / 25;
  const pSetup = setupScore / 20;
  const pMom = momScore / 20;
  const pSent = sentScore / 15;
  const pInst = instScore / 20;

  let total = (pFund * wFund) + (pSetup * wSetup) + (pMom * wMom) + (pSent * wSent) + (pInst * wInst);
  total = Math.round(Math.min(100, Math.max(0, total)));

  let isInvalidated = false;
  if (sma200 && price < sma200) {
    isInvalidated = true;
    if (total >= 65) {
      total = 64; // strictly cap below 65
    }
  }

  let rating: string;
  let ratingClass: string;
  let emoji: string;

  if (isInvalidated && total >= 50) {
    rating = 'High-Risk Contrarian Mean-Reversion Play';
    ratingClass = 'watch';
    emoji = '⚠️';
  } else if (total >= 80) {
    rating = 'Strong Buy';
    ratingClass = 'strong-buy';
    emoji = '🟢';
  } else if (total >= 65) {
    rating = 'Buy';
    ratingClass = 'buy';
    emoji = '🟡';
  } else if (total >= 50) {
    rating = 'Watch';
    ratingClass = 'watch';
    emoji = '🟠';
  } else if (total >= 35) {
    rating = 'Avoid';
    ratingClass = 'avoid';
    emoji = '🔴';
  } else {
    rating = 'Strong Avoid';
    ratingClass = 'strong-avoid';
    emoji = '⛔';
  }

  return { total, rating, ratingClass, emoji, isInvalidated };
};

const getComponentsForSymbol = (symbol: string) => {
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) {
    hash = symbol.charCodeAt(i) + ((hash << 5) - hash);
  }
  const getVal = (seed: number, max: number) => {
    return Math.abs((hash * seed) % (max + 1));
  };
  return {
    fund: getVal(17, 25),
    tech: getVal(31, 20),
    mom: getVal(43, 20),
    sent: getVal(59, 15),
    inst: getVal(73, 20)
  };
};

const calcTradeSetup = (currentPrice: number, setupInds: any, momInds: any) => {
  const atr = momInds?.atr || currentPrice * 0.02;
  const sr = setupInds?.sr || {};

  const stopLoss = parseFloat((currentPrice - 1.5 * atr).toFixed(2));

  const t1 = sr.r1 && sr.r1 > currentPrice ? sr.r1 : currentPrice + 1.5 * atr;
  const t2 = sr.r2 && sr.r2 > t1 ? sr.r2 : t1 + 1.5 * atr;
  const t3 = sr.r3 && sr.r3 > t2 ? sr.r3 : t2 + 1.5 * atr;

  let target1 = parseFloat(t1.toFixed(2));
  if (target1 <= currentPrice) {
    target1 = parseFloat((currentPrice + 1.5 * atr).toFixed(2));
  }

  let target2 = parseFloat(t2.toFixed(2));
  if (target2 <= target1) {
    target2 = parseFloat((target1 + 1.5 * atr).toFixed(2));
  }

  let target3 = parseFloat(t3.toFixed(2));
  if (target3 <= target2) {
    target3 = parseFloat((target2 + 1.5 * atr).toFixed(2));
  }

  const riskReward = parseFloat(((target2 - currentPrice) / (currentPrice - stopLoss)).toFixed(2));

  return { stopLoss, target1, target2, target3, riskReward };
};

const determineMarketPhase = (price: number, fiftyTwoWeekHigh: number, s1: number | null, score: number) => {
  const drawdown = (fiftyTwoWeekHigh - price) / fiftyTwoWeekHigh;
  if (drawdown <= 0.025) {
    return {
      phase: "All-Time High",
      justification: "The stock is trading within 2.5% of its 52-week high, displaying strong momentum but with potential consolidation risk near peaks."
    };
  }
  const isNearSupport = s1 && (price <= s1 * 1.05 && price >= s1 * 0.95);
  if (score >= 65 && (isNearSupport || (drawdown > 0.025 && drawdown < 0.10))) {
    return {
      phase: "Buy Zone",
      justification: "The stock is trading near solid support levels with a high composite rating, representing an optimal low-risk entry zone."
    };
  }
  if (drawdown >= 0.10 && drawdown <= 0.20) {
    return {
      phase: "Correction Phase",
      justification: "The stock has experienced a healthy 10-20% correction from its peak, presenting selective accumulation opportunities near major supports."
    };
  }
  if (drawdown > 0.20) {
    return {
      phase: "Bearish Correction Phase",
      justification: "The stock is in a deeper correction phase (down >20% from peak), trading below standard levels. Risk mitigation is highly advised."
    };
  }
  return {
    phase: "Consolidation Zone",
    justification: "The stock is consolidating between its peak and core support. Wait for breakout or pullback to buy zone."
  };
};

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
  pnl: number; // raw DB value (may be direction-unaware, use computePnl() instead)
  execution_hash?: string;
  slippage?: number;
  setup_logic?: string;
  stop_loss?: number;
  take_profit?: number;
  is_trailing?: boolean;
  trailing_offset?: number;
  is_user_adjusted?: boolean;
}

// Compute correct directional P&L regardless of the DB generated column formula
const computePnl = (t: Trade): number => {
  if (t.status !== 'CLOSED' || t.exit_price == null) return 0;
  const delta = t.direction === 'BUY'
    ? Number(t.exit_price) - Number(t.entry_price)
    : Number(t.entry_price) - Number(t.exit_price);
  return delta * Number(t.quantity);
};

// Helper to parse SL/TP from setup_logic metadata
const parseSlTpFromLogic = (setupLogic: string) => {
  if (!setupLogic) return null;
  const match = setupLogic.match(/\[SL:\s*([0-9.]+)\s*\|\s*TP:\s*([0-9.]+)\]/);
  if (match) {
    return { sl: parseFloat(match[1]), tp: parseFloat(match[2]) };
  }
  return null;
};

// Forex & Indian Currency Formatters
const formatCurrency = (val: number, env: 'INDIAN' | 'FOREX' | 'SWING', decimals: number = 2) => {
  const isUSD = env === 'FOREX';
  const prefix = isUSD ? '$' : '₹';
  const locale = isUSD ? 'en-US' : 'en-IN';
  return `${prefix}${Number(val).toLocaleString(locale, { 
    minimumFractionDigits: decimals, 
    maximumFractionDigits: decimals 
  })}`;
};

const formatCurrencyCompact = (val: number, env: 'INDIAN' | 'FOREX' | 'SWING') => {
  const isUSD = env === 'FOREX';
  const prefix = isUSD ? '$' : '₹';
  const locale = isUSD ? 'en-US' : 'en-IN';
  return `${prefix}${Number(val).toLocaleString(locale, { 
    maximumFractionDigits: 0 
  })}`;
};

const formatPrice = (val: number, env: 'INDIAN' | 'FOREX' | 'SWING') => {
  const decimals = env === 'FOREX' ? 4 : 2;
  return formatCurrency(val, env, decimals);
};

const isExitTimeToday = (exitTimeStr: string | null): boolean => {
  if (!exitTimeStr) return false;
  try {
    const exitDate = new Date(exitTimeStr);
    const today = new Date();
    return exitDate.getDate() === today.getDate() &&
           exitDate.getMonth() === today.getMonth() &&
           exitDate.getFullYear() === today.getFullYear();
  } catch (e) {
    return false;
  }
};

const getStandardLotSize = (assetVal: string, env: 'INDIAN' | 'FOREX'): string => {
  if (env === 'INDIAN') {
    if (assetVal === '^NSEI') return '65 (NIFTY 50)';
    if (assetVal === '^NSEBANK') return '30 (BANK NIFTY)';
    if (assetVal === '^BSESN') return '20 (SENSEX)';
    if (assetVal.includes('RELIANCE')) return '250';
    if (assetVal.includes('TCS')) return '175';
    if (assetVal.includes('HDFCBANK')) return '550';
    if (assetVal.includes('INFY')) return '400';
    return '25 (Default)';
  } else {
    if (['EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X', 'USDCAD=X'].includes(assetVal)) {
      return '100,000 Units (1.0 Lot)';
    }
    if (assetVal === 'GC=F') return '100 oz (1 Contract)';
    if (assetVal === 'BTC-USD') return '1 BTC';
    return 'Dynamic (1% Risk)';
  }
};

const formatActiveQty = (qty: number, symbol: string, env: 'INDIAN' | 'FOREX'): string => {
  if (env === 'INDIAN') {
    return `${qty.toLocaleString('en-IN')} Units`;
  }
  
  // Forex / Crypto / Commodities formatting
  const upperSymbol = symbol.toUpperCase();
  if (upperSymbol === 'GC=F' || upperSymbol.includes('GOLD')) {
    const contracts = qty / 100;
    return `${qty.toLocaleString('en-US')} oz (${contracts.toFixed(2)} Lots)`;
  }
  if (upperSymbol === 'BTC-USD' || upperSymbol.includes('BTC')) {
    return `${qty.toFixed(3)} BTC`;
  }
  if (['EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X', 'USDCAD=X'].some(s => upperSymbol.includes(s.replace('=X', ''))) || upperSymbol.endsWith('=X')) {
    const lots = qty / 100000;
    return `${qty.toLocaleString('en-US')} Units (${lots.toFixed(2)} Lots)`;
  }
  return `${qty.toLocaleString('en-US')} Units`;
};

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
const FOREX_ASSETS = [
  { value: 'EURUSD=X', label: 'EUR / USD', category: 'Forex' },
  { value: 'GBPUSD=X', label: 'GBP / USD', category: 'Forex' },
  { value: 'USDJPY=X', label: 'USD / JPY', category: 'Forex' },
  { value: 'AUDUSD=X', label: 'AUD / USD', category: 'Forex' },
  { value: 'USDCAD=X', label: 'USD / CAD', category: 'Forex' },
  { value: 'GC=F', label: 'Gold Spot', category: 'Commodities' },
  { value: 'BTC-USD', label: 'Bitcoin USD', category: 'Crypto' },
];

const INDIAN_ASSETS = [
  { value: '^NSEI', label: 'NIFTY 50', category: 'Indian Indices' },
  { value: '^NSEBANK', label: 'BANK NIFTY', category: 'Indian Indices' },
  { value: '^BSESN', label: 'SENSEX', category: 'Indian Indices' },
  
  // Indian Option Stocks
  { value: 'AARTIIND.NS', label: 'AARTI INDUSTRIES', category: 'Indian Option Stocks' },
  { value: 'ABB.NS', label: 'ABB INDIA', category: 'Indian Option Stocks' },
  { value: 'ABFRL.NS', label: 'ADITYA BIRLA FASHION', category: 'Indian Option Stocks' },
  { value: 'ACC.NS', label: 'ACC LIMITED', category: 'Indian Option Stocks' },
  { value: 'ADANIENT.NS', label: 'ADANI ENTERPRISES', category: 'Indian Option Stocks' },
  { value: 'ADANIPORTS.NS', label: 'ADANI PORTS', category: 'Indian Option Stocks' },
  { value: 'ALKEM.NS', label: 'ALKEM LABS', category: 'Indian Option Stocks' },
  { value: 'AMBUJACEM.NS', label: 'AMBUJA CEMENTS', category: 'Indian Option Stocks' },
  { value: 'APOLLOHOSP.NS', label: 'APOLLO HOSPITALS', category: 'Indian Option Stocks' },
  { value: 'APOLLOTYRE.NS', label: 'APOLLO TYRES', category: 'Indian Option Stocks' },
  { value: 'ASHOKLEY.NS', label: 'ASHOK LEYLAND', category: 'Indian Option Stocks' },
  { value: 'ASIANPAINT.NS', label: 'ASIAN PAINTS', category: 'Indian Option Stocks' },
  { value: 'ASTRAL.NS', label: 'ASTRAL LIMITED', category: 'Indian Option Stocks' },
  { value: 'ATUL.NS', label: 'ATUL LIMITED', category: 'Indian Option Stocks' },
  { value: 'AUBANK.NS', label: 'AU SMALL FINANCE BANK', category: 'Indian Option Stocks' },
  { value: 'AUROPHARMA.NS', label: 'AUROBINDO PHARMA', category: 'Indian Option Stocks' },
  { value: 'AXISBANK.NS', label: 'AXIS BANK', category: 'Indian Option Stocks' },
  { value: 'BAJAJ-AUTO.NS', label: 'BAJAJ AUTO', category: 'Indian Option Stocks' },
  { value: 'BAJFINANCE.NS', label: 'BAJAJ FINANCE', category: 'Indian Option Stocks' },
  { value: 'BAJAJFINSV.NS', label: 'BAJAJ FINSERV', category: 'Indian Option Stocks' },
  { value: 'BALKRISIND.NS', label: 'BALKRISHNA IND', category: 'Indian Option Stocks' },
  { value: 'BANDHANBNK.NS', label: 'BANDHAN BANK', category: 'Indian Option Stocks' },
  { value: 'BANKBARODA.NS', label: 'BANK OF BARODA', category: 'Indian Option Stocks' },
  { value: 'BEL.NS', label: 'BHARAT ELECTRONICS', category: 'Indian Option Stocks' },
  { value: 'BERGERPAINT.NS', label: 'BERGER PAINTS', category: 'Indian Option Stocks' },
  { value: 'BHARTIARTL.NS', label: 'BHARTI AIRTEL', category: 'Indian Option Stocks' },
  { value: 'BHEL.NS', label: 'BHEL', category: 'Indian Option Stocks' },
  { value: 'BIOCON.NS', label: 'BIOCON', category: 'Indian Option Stocks' },
  { value: 'BOSCHLTD.NS', label: 'BOSCH', category: 'Indian Option Stocks' },
  { value: 'BPCL.NS', label: 'BPCL', category: 'Indian Option Stocks' },
  { value: 'BRITANNIA.NS', label: 'BRITANNIA', category: 'Indian Option Stocks' },
  { value: 'CANBK.NS', label: 'CANARA BANK', category: 'Indian Option Stocks' },
  { value: 'CHOLAFIN.NS', label: 'CHOLAMANDALAM FIN', category: 'Indian Option Stocks' },
  { value: 'CIPLA.NS', label: 'CIPLA', category: 'Indian Option Stocks' },
  { value: 'COALINDIA.NS', label: 'COAL INDIA', category: 'Indian Option Stocks' },
  { value: 'COFORGE.NS', label: 'COFORGE', category: 'Indian Option Stocks' },
  { value: 'CONCOR.NS', label: 'CONCOR', category: 'Indian Option Stocks' },
  { value: 'CUMMINSIND.NS', label: 'CUMMINS INDIA', category: 'Indian Option Stocks' },
  { value: 'DABUR.NS', label: 'DABUR', category: 'Indian Option Stocks' },
  { value: 'DEEPAKNTR.NS', label: 'DEEPAK NITRITE', category: 'Indian Option Stocks' },
  { value: 'DIVISLAB.NS', label: 'DIVIS LABS', category: 'Indian Option Stocks' },
  { value: 'DLF.NS', label: 'DLF', category: 'Indian Option Stocks' },
  { value: 'DRREDDY.NS', label: 'DR REDDYS LABS', category: 'Indian Option Stocks' },
  { value: 'EICHERMOT.NS', label: 'EICHER MOTORS', category: 'Indian Option Stocks' },
  { value: 'ESCORTS.NS', label: 'ESCORTS KUBOTA', category: 'Indian Option Stocks' },
  { value: 'FEDERALBNK.NS', label: 'FEDERAL BANK', category: 'Indian Option Stocks' },
  { value: 'GAIL.NS', label: 'GAIL', category: 'Indian Option Stocks' },
  { value: 'GLENMARK.NS', label: 'GLENMARK PHARMA', category: 'Indian Option Stocks' },
  { value: 'GMRINFRA.NS', label: 'GMR INFRA', category: 'Indian Option Stocks' },
  { value: 'GODREJPROP.NS', label: 'GODREJ PROPERTIES', category: 'Indian Option Stocks' },
  { value: 'GRASIM.NS', label: 'GRASIM INDUSTRIES', category: 'Indian Option Stocks' },
  { value: 'HAL.NS', label: 'HINDUSTAN AERONAUTICS', category: 'Indian Option Stocks' },
  { value: 'HCLTECH.NS', label: 'HCL TECH', category: 'Indian Option Stocks' },
  { value: 'HDFCBANK.NS', label: 'HDFC BANK', category: 'Indian Option Stocks' },
  { value: 'HDFCLIFE.NS', label: 'HDFC LIFE', category: 'Indian Option Stocks' },
  { value: 'HEROMOTOCO.NS', label: 'HERO MOTOCORP', category: 'Indian Option Stocks' },
  { value: 'HINDALCO.NS', label: 'HINDALCO', category: 'Indian Option Stocks' },
  { value: 'HINDCOPPER.NS', label: 'HINDUSTAN COPPER', category: 'Indian Option Stocks' },
  { value: 'HINDUNILVR.NS', label: 'HINDUSTAN UNILEVER', category: 'Indian Option Stocks' },
  { value: 'ICICIBANK.NS', label: 'ICICI BANK', category: 'Indian Option Stocks' },
  { value: 'ICICIPRULI.NS', label: 'ICICI PRU LIFE', category: 'Indian Option Stocks' },
  { value: 'IDEA.NS', label: 'VODAFONE IDEA', category: 'Indian Option Stocks' },
  { value: 'IEX.NS', label: 'IEX', category: 'Indian Option Stocks' },
  { value: 'IGL.NS', label: 'IGL', category: 'Indian Option Stocks' },
  { value: 'INDHOTEL.NS', label: 'INDIAN HOTELS', category: 'Indian Option Stocks' },
  { value: 'INDUSINDBK.NS', label: 'INDUSIND BANK', category: 'Indian Option Stocks' },
  { value: 'INFY.NS', label: 'INFOSYS', category: 'Indian Option Stocks' },
  { value: 'IOC.NS', label: 'IOC', category: 'Indian Option Stocks' },
  { value: 'IPCALAB.NS', label: 'IPCA LABS', category: 'Indian Option Stocks' },
  { value: 'IRCTC.NS', label: 'IRCTC', category: 'Indian Option Stocks' },
  { value: 'ITC.NS', label: 'ITC', category: 'Indian Option Stocks' },
  { value: 'JINDALSTEL.NS', label: 'JINDAL STEEL', category: 'Indian Option Stocks' },
  { value: 'JSWSTEEL.NS', label: 'JSW STEEL', category: 'Indian Option Stocks' },
  { value: 'JUBLFOOD.NS', label: 'JUBILANT FOODWORKS', category: 'Indian Option Stocks' },
  { value: 'KOTAKBANK.NS', label: 'KOTAK BANK', category: 'Indian Option Stocks' },
  { value: 'LALPATHLAB.NS', label: 'DR LAL PATHLABS', category: 'Indian Option Stocks' },
  { value: 'LICHSGFIN.NS', label: 'LIC HOUSING FINANCE', category: 'Indian Option Stocks' },
  { value: 'LT.NS', label: 'L&T', category: 'Indian Option Stocks' },
  { value: 'LTIM.NS', label: 'LTIMINDTREE', category: 'Indian Option Stocks' },
  { value: 'M&M.NS', label: 'M&M', category: 'Indian Option Stocks' },
  { value: 'MARUTI.NS', label: 'MARUTI SUZUKI', category: 'Indian Option Stocks' },
  { value: 'MCX.NS', label: 'MCX', category: 'Indian Option Stocks' },
  { value: 'METROPOLIS.NS', label: 'METROPOLIS', category: 'Indian Option Stocks' },
  { value: 'MRF.NS', label: 'MRF TYRES', category: 'Indian Option Stocks' },
  { value: 'MUTHOOTFIN.NS', label: 'MUTHOOT FINANCE', category: 'Indian Option Stocks' },
  { value: 'NATIONALUM.NS', label: 'NATIONAL ALUMINIUM', category: 'Indian Option Stocks' },
  { value: 'NESTLEIND.NS', label: 'NESTLE INDIA', category: 'Indian Option Stocks' },
  { value: 'NMDC.NS', label: 'NMDC', category: 'Indian Option Stocks' },
  { value: 'NTPC.NS', label: 'NTPC', category: 'Indian Option Stocks' },
  { value: 'OBEROIRLTY.NS', label: 'OBEROI REALTY', category: 'Indian Option Stocks' },
  { value: 'ONGC.NS', label: 'ONGC', category: 'Indian Option Stocks' },
  { value: 'PAGEIND.NS', label: 'PAGE INDUSTRIES', category: 'Indian Option Stocks' },
  { value: 'PERSISTENT.NS', label: 'PERSISTENT SYSTEMS', category: 'Indian Option Stocks' },
  { value: 'PETRONET.NS', label: 'PETRONET LNG', category: 'Indian Option Stocks' },
  { value: 'PFC.NS', label: 'PFC', category: 'Indian Option Stocks' },
  { value: 'PIDILITIND.NS', label: 'PIDILITE IND', category: 'Indian Option Stocks' },
  { value: 'PIIND.NS', label: 'PI INDUSTRIES', category: 'Indian Option Stocks' },
  { value: 'PNB.NS', label: 'PNB', category: 'Indian Option Stocks' },
  { value: 'POWERGRID.NS', label: 'POWER GRID', category: 'Indian Option Stocks' },
  { value: 'RBLBANK.NS', label: 'RBL BANK', category: 'Indian Option Stocks' },
  { value: 'RECLTD.NS', label: 'REC LIMITED', category: 'Indian Option Stocks' },
  { value: 'RELIANCE.NS', label: 'RELIANCE', category: 'Indian Option Stocks' },
  { value: 'SAIL.NS', label: 'SAIL', category: 'Indian Option Stocks' },
  { value: 'SBICARD.NS', label: 'SBI CARDS', category: 'Indian Option Stocks' },
  { value: 'SBILIFE.NS', label: 'SBI LIFE', category: 'Indian Option Stocks' },
  { value: 'SBIN.NS', label: 'SBIN', category: 'Indian Option Stocks' },
  { value: 'SHRIRAMFIN.NS', label: 'SHRIRAM FINANCE', category: 'Indian Option Stocks' },
  { value: 'SIEMENS.NS', label: 'SIEMENS', category: 'Indian Option Stocks' },
  { value: 'SRF.NS', label: 'SRF LIMITED', category: 'Indian Option Stocks' },
  { value: 'SUNPHARMA.NS', label: 'SUN PHARMA', category: 'Indian Option Stocks' },
  { value: 'SYNGENE.NS', label: 'SYNGENE', category: 'Indian Option Stocks' },
  { value: 'TATACHEM.NS', label: 'TATA CHEMICALS', category: 'Indian Option Stocks' },
  { value: 'TATACONSUM.NS', label: 'TATA CONSUMER', category: 'Indian Option Stocks' },
  { value: 'TATAMOTORS.NS', label: 'TATA MOTORS', category: 'Indian Option Stocks' },
  { value: 'TATAPOWER.NS', label: 'TATA POWER', category: 'Indian Option Stocks' },
  { value: 'TATASTEEL.NS', label: 'TATA STEEL', category: 'Indian Option Stocks' },
  { value: 'TCS.NS', label: 'TCS', category: 'Indian Option Stocks' },
  { value: 'TECHM.NS', label: 'TECH MAHINDRA', category: 'Indian Option Stocks' },
  { value: 'TITAN.NS', label: 'TITAN COMPANY', category: 'Indian Option Stocks' },
  { value: 'TORNTPHARM.NS', label: 'TORRENT PHARMA', category: 'Indian Option Stocks' },
  { value: 'TRENT.NS', label: 'TRENT', category: 'Indian Option Stocks' },
  { value: 'TVSMOTOR.NS', label: 'TVS MOTOR', category: 'Indian Option Stocks' },
  { value: 'ULTRACEMCO.NS', label: 'ULTRATECH CEMENT', category: 'Indian Option Stocks' },
  { value: 'UPL.NS', label: 'UPL LIMITED', category: 'Indian Option Stocks' },
  { value: 'VOLTAS.NS', label: 'VOLTAS', category: 'Indian Option Stocks' },
  { value: 'WIPRO.NS', label: 'WIPRO', category: 'Indian Option Stocks' },
  { value: 'ZEEL.NS', label: 'ZEEL', category: 'Indian Option Stocks' },
  
  // Global Indices
  { value: '^GSPC', label: 'S&P 500 (US)', category: 'Global Indices' },
  { value: '^DJI', label: 'Dow Jones (US)', category: 'Global Indices' },
  { value: '^IXIC', label: 'Nasdaq (US)', category: 'Global Indices' },
  { value: '^GDAXI', label: 'DAX (Germany)', category: 'Global Indices' },
  { value: '^FTSE', label: 'FTSE 100 (UK)', category: 'Global Indices' },
  { value: '^FCHI', label: 'CAC 40 (France)', category: 'Global Indices' },
];

// Map between chart ticker values and DB symbol names
const SYMBOL_MAP: Record<string, string[]> = {
  '^NSEI':    ['NIFTY 50', 'NIFTY50', 'NSE:NIFTY50-INDEX'],
  '^NSEBANK': ['BANK NIFTY', 'BANKNIFTY', 'NSE:NIFTYBANK-INDEX'],
  '^BSESN':   ['SENSEX', 'BSE:SENSEX'],
  'EURUSD=X': ['EURUSD=X', 'EUR/USD', 'EURUSD'],
  'GBPUSD=X': ['GBPUSD=X', 'GBP/USD', 'GBPUSD'],
  'USDJPY=X': ['USDJPY=X', 'USD/JPY', 'USDJPY'],
  'AUDUSD=X': ['AUDUSD=X', 'AUD/USD', 'AUDUSD'],
  'USDCAD=X': ['USDCAD=X', 'USD/CAD', 'USDCAD'],
  'GC=F':     ['GC=F', 'GOLD', 'Gold Spot', 'XAU/USD', 'XAUUSD'],
  'BTC-USD':  ['BTC-USD', 'BTC/USD', 'BTCUSD', 'Bitcoin USD', 'Bitcoin'],
};

const isAssetMatch = (assetVal: string, symbol: string) => {
  if (!assetVal || !symbol) return false;
  
  const upperSymbol = symbol.toUpperCase();
  const upperAsset = assetVal.toUpperCase();

  // Check direct map first (handles ^NSEI <-> "NIFTY 50" etc.)
  const mapped = SYMBOL_MAP[assetVal];
  if (mapped) {
    if (mapped.some(m => m.toUpperCase() === upperSymbol)) return true;
  }
  
  const clean = (s: string) => s.replace(/\.(NS|BO)$/i, '').replace(/^(NSE:|BSE:|MCX:|CDS:)/, '').toUpperCase();
  const cleanSymbol = clean(symbol);
  
  // Custom prefix/partial match logic for indices:
  if (assetVal === '^NSEI') {
    // If the symbol starts with "NIFTY" and doesn't contain "BANK", it's Nifty
    if (cleanSymbol.startsWith('NIFTY') && !cleanSymbol.includes('BANK')) return true;
  }
  if (assetVal === '^NSEBANK') {
    // If the symbol starts with "BANK" or contains "BANKNIFTY" or "BANK NIFTY", it's Bank Nifty
    if (cleanSymbol.startsWith('BANK') || cleanSymbol.includes('BANKNIFTY') || cleanSymbol.includes('BANK NIFTY')) return true;
  }
  if (assetVal === '^BSESN') {
    // If the symbol contains "SENSEX", it's Sensex
    if (cleanSymbol.includes('SENSEX')) return true;
  }
  
  // Reverse map: if symbol is in any map value, check if assetVal matches the key
  for (const [key, vals] of Object.entries(SYMBOL_MAP)) {
    if (vals.some(v => clean(v) === cleanSymbol)) {
      return key === assetVal;
    }
  }
  // Fallback: strip exchange prefixes and compare
  return clean(assetVal) === cleanSymbol || assetVal === symbol;
};

// NSE Trading Holidays 2026 (format: 'YYYY-MM-DD')
const NSE_HOLIDAYS_2026 = new Set([
  '2026-01-26', // Republic Day
  '2026-02-26', // Maha Shivratri
  '2026-03-20', // Holi
  '2026-04-02', // Ram Navami
  '2026-04-14', // Dr. Ambedkar Jayanti / Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-05-01', // Maharashtra Day
  '2026-05-28', // Buddha Purnima ← TODAY
  '2026-06-17', // Eid al-Adha (Bakri Eid)
  '2026-08-15', // Independence Day
  '2026-09-04', // Ganesh Chaturthi
  '2026-10-02', // Gandhi Jayanti / Dussehra
  '2026-10-22', // Diwali - Laxmi Puja
  '2026-10-23', // Diwali - Balipratipada
  '2026-11-05', // Guru Nanak Jayanti
  '2026-12-25', // Christmas
]);

const isNSEHoliday = (): boolean => {
  const now = new Date();
  const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const yyyy = istTime.getFullYear();
  const mm   = String(istTime.getMonth() + 1).padStart(2, '0');
  const dd   = String(istTime.getDate()).padStart(2, '0');
  return NSE_HOLIDAYS_2026.has(`${yyyy}-${mm}-${dd}`);
};

const getMarketStatusForAsset = (assetVal: string, assetsList: typeof INDIAN_ASSETS): 'OPEN' | 'CLOSED' => {
  const now = new Date();
  const asset = assetsList.find(a => a.value === assetVal);
  const category = asset ? asset.category : '';
  
  if (category === 'Crypto') {
    return 'OPEN'; // Crypto never closes
  }
  if (category === 'Commodities') {
    // Gold futures follow similar hours to Forex (nearly 24/5)
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    if (day === 6) return 'CLOSED';
    if (day === 5 && hour >= 22) return 'CLOSED';
    if (day === 0 && hour < 22) return 'CLOSED';
    return 'OPEN';
  }
  if (category === 'Forex') {
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    if (day === 6) return 'CLOSED'; // Saturday
    if (day === 5 && hour >= 22) return 'CLOSED'; // Friday night
    if (day === 0 && hour < 22) return 'CLOSED'; // Sunday morning
    return 'OPEN';
  }
  if (category === 'Global Indices') {
    if (['^GDAXI', '^FTSE', '^FCHI'].includes(assetVal)) {
      const cetTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
      const day = cetTime.getDay();
      const hour = cetTime.getHours();
      const minute = cetTime.getMinutes();
      if (day === 0 || day === 6) return 'CLOSED';
      const totalMinutes = hour * 60 + minute;
      return (totalMinutes >= 9 * 60 && totalMinutes <= 17 * 60 + 30) ? 'OPEN' : 'CLOSED';
    } else {
      const estTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const day = estTime.getDay();
      const hour = estTime.getHours();
      const minute = estTime.getMinutes();
      if (day === 0 || day === 6) return 'CLOSED';
      const totalMinutes = hour * 60 + minute;
      return (totalMinutes >= 9 * 60 + 30 && totalMinutes <= 16 * 60) ? 'OPEN' : 'CLOSED';
    }
  }
  // ── Indian Indices & Stocks (Asia/Kolkata) ───────────────────────────────────
  // Check NSE exchange holidays first
  if (isNSEHoliday()) return 'CLOSED';

  const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = istTime.getDay();
  const hour = istTime.getHours();
  const minute = istTime.getMinutes();
  if (day === 0 || day === 6) return 'CLOSED'; // Weekend
  const totalMinutes = hour * 60 + minute;
  return (totalMinutes >= 9 * 60 + 15 && totalMinutes <= 15 * 60 + 30) ? 'OPEN' : 'CLOSED'; // 09:15–15:30 IST
};

const calculateProfitFactor = (tradesList: Trade[]) => {
  const closed = tradesList.filter(t => t.status === 'CLOSED');
  const profit = closed.filter(t => computePnl(t) > 0).reduce((acc, t) => acc + computePnl(t), 0);
  const loss = Math.abs(closed.filter(t => computePnl(t) <= 0).reduce((acc, t) => acc + computePnl(t), 0));
  return loss === 0 ? profit : profit / loss;
};

const calculateAvgWinLoss = (tradesList: Trade[]) => {
  const closed = tradesList.filter(t => t.status === 'CLOSED');
  const wins = closed.filter(t => computePnl(t) > 0);
  const losses = closed.filter(t => computePnl(t) <= 0);
  const avgWin = wins.length > 0 ? wins.reduce((acc, t) => acc + computePnl(t), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((acc, t) => acc + computePnl(t), 0)) / losses.length : 0;
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
    .reduce((acc, t) => acc + computePnl(t), 0);
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
    const pnl = computePnl(t);
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

const PremiumUpgradeBlocker = ({ feature, onRequestUpgrade }: { feature: string; onRequestUpgrade: () => void }) => {
  return (
    <div className="border border-slate-800 bg-[#070b15]/95 rounded-2xl p-8 shadow-2xl text-center font-mono max-w-2xl mx-auto my-12 animate-fadeIn">
      <div className="h-16 w-16 bg-gradient-to-tr from-amber-500/20 to-orange-500/20 border border-orange-500/30 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-6 shadow-inner animate-pulse">
        👑
      </div>
      <h2 className="text-base font-black text-slate-100 uppercase tracking-widest mb-3">
        {feature} is locked
      </h2>
      <p className="text-xs text-slate-400 mb-8 leading-relaxed max-w-md mx-auto">
        Your free tier token quota has expired. Accessing the premium swing scanner, advanced multi-asset option ledger, and real-time WhatsApp signal dispatches requires a premium upgrade.
      </p>
      
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8 text-left max-w-lg mx-auto bg-slate-950/40 p-4 rounded-xl border border-slate-900">
        <div className="flex flex-col gap-1">
          <span className="text-cyan-400 font-bold text-[10px] uppercase">Swing Engine</span>
          <span className="text-slate-500 text-[9px] leading-snug">Elite stock picks, technical scoring, and portfolio tracking.</span>
        </div>
        <div className="flex flex-col gap-1 border-t sm:border-t-0 sm:border-l border-slate-900 pt-3 sm:pt-0 sm:pl-4">
          <span className="text-cyan-400 font-bold text-[10px] uppercase">AI Assistant</span>
          <span className="text-slate-500 text-[9px] leading-snug">Unlimited context-aware terminal AI chat queries.</span>
        </div>
        <div className="flex flex-col gap-1 border-t sm:border-t-0 sm:border-l border-slate-900 pt-3 sm:pt-0 sm:pl-4">
          <span className="text-cyan-400 font-bold text-[10px] uppercase">Risk Controls</span>
          <span className="text-slate-500 text-[9px] leading-snug">Live mode activation, custom position sizing, and single-click flatten.</span>
        </div>
      </div>

      <button
        onClick={onRequestUpgrade}
        className="bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-slate-950 text-xs font-black tracking-widest px-8 py-3 rounded-xl uppercase transition-all shadow-lg shadow-orange-500/20 active:scale-95 cursor-pointer"
      >
        REQUEST PREMIUM ACCESS
      </button>
    </div>
  );
};

const InlinePremiumUpgradeBlocker = ({ feature, onRequestUpgrade }: { feature: string; onRequestUpgrade: () => void }) => {
  return (
    <div className="flex flex-col items-center justify-center p-6 text-center bg-slate-950/20 border border-slate-800/60 rounded-xl font-mono">
      <span className="text-2xl mb-2">🛡️</span>
      <h3 className="text-[10px] font-black text-rose-400 uppercase tracking-widest mb-1.5">{feature} Restricted</h3>
      <p className="text-[9px] text-slate-500 mb-4 leading-relaxed max-w-[200px]">
        Upgrade to Premium for unlimited stock scans, live alerts, and advanced dashboard integrations.
      </p>
      <button
        onClick={onRequestUpgrade}
        className="bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-slate-950 text-[9px] font-black tracking-widest px-4 py-1.5 rounded-lg uppercase transition-all active:scale-95 cursor-pointer"
      >
        UPGRADE
      </button>
    </div>
  );
};

export default function Dashboard() {
  const [mounted, setMounted] = useState(false);
  const [marketEnv, setMarketEnv] = useState<'INDIAN' | 'FOREX' | 'SWING'>('INDIAN');
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
  const [ledgerFilter, setLedgerFilter] = useState<'TODAY' | 'WEEKLY' | 'MONTHLY' | 'ALL'>('TODAY');
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [activeChartTab, setActiveChartTab] = useState<'PRICE' | 'EQUITY' | 'PERFORMANCE'>('PRICE');
  const [expandedTradeId, setExpandedTradeId] = useState<string | null>(null);

  const [isLive, setIsLive] = useState(false);
  const [marketState, setMarketState] = useState<'OPEN' | 'CLOSED'>('CLOSED');
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [currentTimeStr, setCurrentTimeStr] = useState<string>("");
  const [liveSpotPrice, setLiveSpotPrice] = useState<number>(22660.00);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [resolution, setResolution] = useState<string>('15m');
  const [selectedAsset, setSelectedAsset] = useState<string>('^NSEI');
  const [selectedAssetLabel, setSelectedAssetLabel] = useState<string>('NIFTY 50');

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const equityChartContainerRef = useRef<HTMLDivElement>(null);
  const resolutionRef = useRef('15m');
  const assetRef = useRef('^NSEI');

  // Phase 3 States: Custom Scanner
  const [customScanTicker, setCustomScanTicker] = useState('');
  const [customScanResult, setCustomScanResult] = useState<any>(null);
  const [customScanLoading, setCustomScanLoading] = useState(false);

  // Phase 3 States: AI Assistant
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<Array<{ sender: 'user' | 'ai'; text: string; timestamp: Date }>>([
    {
      sender: 'ai',
      text: "Hello! I am your **Bifrost AI Assistant**. Ask me about trades, metrics, engine health, or try *'Scan RELIANCE'*.",
      timestamp: new Date()
    }
  ]);
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // AI Assistant auto-scroll effect
  useEffect(() => {
    if (isChatOpen) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isChatOpen]);

  const ASSETS = marketEnv === 'FOREX' ? FOREX_ASSETS : INDIAN_ASSETS;
  // Updated: Forex capital = $100,000 | Indian = ₹1,00,000
  const startingCapital = 100000.00;
  // Daily loss risk threshold: $5,000 for Forex | ₹2,000 for Indian
  const dailyLossThreshold = marketEnv === 'FOREX' ? -5000.0 : -2000.0;

  // Auth state for Google Sign-In
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [isAdminModalOpen, setIsAdminModalOpen] = useState(false);
  const [adminInsights, setAdminInsights] = useState<any>(null);
  const [adminInsightsLoading, setAdminInsightsLoading] = useState(false);
  const [userProfilesList, setUserProfilesList] = useState<any[]>([]);

  // BIFROST Phase 5 States & Helpers
  const [tradeMode, setTradeMode] = useState<'MOCK' | 'LIVE'>('MOCK');

  const isTokenExpired = userProfile && 
    userProfile.role !== 'admin' && 
    userProfile.subscription_status !== 'active' && 
    (userProfile.token_balance === undefined || userProfile.token_balance <= 0);

  const requestPremiumUpgrade = async () => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${BACKEND_URL}/api/subscription/request`, {
        method: 'POST',
        headers
      });
      if (res.ok) {
        alert("Subscription request sent to admin email successfully!");
        const { data: profileData } = await supabase.from('user_profiles').select('*').eq('id', user.id).single();
        if (profileData) setUserProfile(profileData);
      } else {
        alert("Failed to request subscription.");
      }
    } catch (err) {
      console.error(err);
    }
  };

  const downloadCSV = () => {
    if (ledgerFilteredTrades.length === 0) return;
    const headers = ['id', 'symbol', 'direction', 'entry_price', 'exit_price', 'quantity', 'entry_time', 'exit_time', 'status', 'pnl', 'setup_logic'];
    const csvContent = [
      headers.join(','),
      ...ledgerFilteredTrades.map(t => [
        t.id,
        t.symbol,
        `"${t.direction}"`,
        t.entry_price,
        t.exit_price || '',
        t.quantity,
        t.entry_time,
        t.exit_time || '',
        `"${t.status}"`,
        computePnl(t).toFixed(2),
        `"${(t.setup_logic || '').replace(/"/g, '""')}"`
      ].join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `BIFROST_trades_${ledgerFilter.toLowerCase()}_${marketEnv.toLowerCase()}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadJSON = () => {
    if (ledgerFilteredTrades.length === 0) return;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(ledgerFilteredTrades, null, 2));
    const link = document.createElement("a");
    link.setAttribute("href", dataStr);
    link.setAttribute("download", `BIFROST_trades_${ledgerFilter.toLowerCase()}_${marketEnv.toLowerCase()}.json`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const calculateSharpeRatio = (tradesList: Trade[]) => {
    const closed = tradesList.filter(t => t.status === 'CLOSED');
    if (closed.length < 2) return 0.0;
    const returns = closed.map(t => {
      const entry = Number(t.entry_price);
      const exit = Number(t.exit_price) || entry;
      const pct = entry > 0 ? ((exit - entry) / entry) * 100 : 0.0;
      return t.direction === 'BUY' ? pct : -pct;
    });
    const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);
    return stdDev === 0 ? 0.0 : avg / stdDev;
  };

  const calculateMaxDrawdown = (tradesList: Trade[]) => {
    const closed = tradesList.filter(t => t.status === 'CLOSED');
    if (closed.length === 0) return 0.0;
    let peak = 100000.0;
    let currentEquity = 100000.0;
    let maxDrawdown = 0.0;
    const sortedClosed = [...closed].sort((a, b) => new Date(a.exit_time || '').getTime() - new Date(b.exit_time || '').getTime());
    for (const t of sortedClosed) {
      const pnl = computePnl(t);
      currentEquity += pnl;
      if (currentEquity > peak) peak = currentEquity;
      const dd = peak > 0 ? ((peak - currentEquity) / peak) * 100 : 0.0;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
    return maxDrawdown;
  };

  const triggerKillAll = async () => {
    if (!confirm(`Are you sure you want to FLATTEN ALL open positions in the ${marketEnv} environment?`)) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${BACKEND_URL}/api/trade/kill-all`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'X-Trade-Mode': tradeMode
        },
        body: JSON.stringify({ market_type: marketEnv })
      });
      if (res.ok) {
        const data = await res.json();
        alert(`Successfully closed ${data.closed_count} positions.`);
        loadData();
      } else {
        alert("Failed to kill positions.");
      }
    } catch (err) {
      console.error(err);
    }
  };

  // API Configuration settings states
  const [settingsGeminiKey, setSettingsGeminiKey] = useState('');
  const [settingsWhatsAppKey, setSettingsWhatsAppKey] = useState('');
  const [settingsFyersId, setSettingsFyersId] = useState('');
  const [settingsFyersPin, setSettingsFyersPin] = useState('');
  const [settingsFyersTotpKey, setSettingsFyersTotpKey] = useState('');
  const [settingsLoading, setSettingsLoading] = useState(false);

  // Swing Trading States
  const [swingWatchlist, setSwingWatchlist] = useState<any[]>([]);
  const [swingSignals, setSwingSignals] = useState<any[]>([]);
  const [swingHoldings, setSwingHoldings] = useState<any[]>([]);
  const [swingPerformance, setSwingPerformance] = useState<any[]>([]);
  const [swingActiveTab, setSwingActiveTab] = useState<'WATCHLIST' | 'PICKS' | 'PORTFOLIO' | 'SCREENER' | 'BACKTESTER' | 'PERFORMANCE'>('WATCHLIST');
  const [selectedSwingSymbol, setSelectedSwingSymbol] = useState<string>('RELIANCE.NS');
  const [selectedSwingName, setSelectedSwingName] = useState<string>('Reliance Industries');
  const [selectedSwingSector, setSelectedSwingSector] = useState<string>('Energy');
  
  const [swingWeights, setSwingWeights] = useState({
    fundamental: 25,
    technical: 30,
    momentum: 20,
    sentiment: 10,
    institutional: 15
  });

  const [swingAnalysis, setSwingAnalysis] = useState<any>(null);
  const [swingAnalysisLoading, setSwingAnalysisLoading] = useState(false);

  // Backtester states
  const [btThreshold, setBtThreshold] = useState<number>(65);
  const [btHoldingPeriod, setBtHoldingPeriod] = useState<number>(30);
  const [btLookback, setBtLookback] = useState<number>(365);
  const [btResults, setBtResults] = useState<any>(null);
  const [btLoading, setBtLoading] = useState<boolean>(false);

  // Screener states
  const [screenSector, setScreenSector] = useState<string>('ALL');
  const [screenCap, setScreenCap] = useState<string>('ALL');
  const [screenRating, setScreenRating] = useState<string>('ALL');
  const [screenerResults, setScreenerResults] = useState<any[]>([]);
  
  // Watchlist edit inputs (admin only)
  const [newWatchlistSymbol, setNewWatchlistSymbol] = useState<string>('');
  const [newWatchlistName, setNewWatchlistName] = useState<string>('');
  const [newWatchlistSector, setNewWatchlistSector] = useState<string>('Energy');

  // Manual SL/TP Adjust states
  const [expandedActiveTradeId, setExpandedActiveTradeId] = useState<string | null>(null);
  const [adjustSl, setAdjustSl] = useState<Record<string, string>>({});
  const [adjustTp, setAdjustTp] = useState<Record<string, string>>({});
  const [adjustIsTrailing, setAdjustIsTrailing] = useState<Record<string, boolean>>({});
  const [adjustOffset, setAdjustOffset] = useState<Record<string, string>>({});
  const [adjustLoading, setAdjustLoading] = useState<Record<string, boolean>>({});

  // Swing Holdings Input Form states
  const [newHoldingSymbol, setNewHoldingSymbol] = useState('');
  const [newHoldingPrice, setNewHoldingPrice] = useState('');
  const [newHoldingQty, setNewHoldingQty] = useState('');

  // Proportional Weights Slider Adjuster
  const handleWeightChange = (key: string, val: number) => {
    const otherKeys = Object.keys(swingWeights).filter(k => k !== key);
    const otherSum = otherKeys.reduce((s, k) => s + (swingWeights as any)[k], 0);
    const remaining = 100 - val;
    if (otherSum === 0) {
      const newVal = Math.round(remaining / otherKeys.length);
      const updated = { ...swingWeights, [key]: val };
      otherKeys.forEach(k => { (updated as any)[k] = newVal; });
      setSwingWeights(updated);
    } else {
      const updated = { ...swingWeights, [key]: val };
      let currentOtherSum = 0;
      otherKeys.forEach((k, idx) => {
        if (idx === otherKeys.length - 1) {
          (updated as any)[k] = 100 - val - currentOtherSum;
        } else {
          const share = Math.round(((swingWeights as any)[k] / otherSum) * remaining);
          (updated as any)[k] = share;
          currentOtherSum += share;
        }
      });
      setSwingWeights(updated);
    }
  };

  // Swing Data Loader
  const loadSwingData = async () => {
    try {
      const headers = await getAuthHeaders();
      const [wlRes, sigRes, holdRes, perfRes] = await Promise.all([
        fetch(`${BACKEND_URL}/api/swing/watchlist`, { headers }),
        fetch(`${BACKEND_URL}/api/swing/signals`, { headers }),
        fetch(`${BACKEND_URL}/api/swing/holdings`, { headers }),
        fetch(`${BACKEND_URL}/api/swing/performance`, { headers }),
      ]);

      if (wlRes.ok) setSwingWatchlist(await wlRes.json());
      if (sigRes.ok) setSwingSignals(await sigRes.json());
      if (holdRes.ok) setSwingHoldings(await holdRes.json());
      if (perfRes.ok) setSwingPerformance(await perfRes.json());
    } catch (err) {
      console.error("Error loading swing data:", err);
    }
  };

  // Manual Risk Parameters Adjustment submission
  const handleAdjustSubmit = async (tradeId: string, marketType: string) => {
    setAdjustLoading(prev => ({ ...prev, [tradeId]: true }));
    try {
      const headers = await getAuthHeaders();
      const sl = parseFloat(adjustSl[tradeId]);
      const tp = parseFloat(adjustTp[tradeId]);
      const isTrailing = !!adjustIsTrailing[tradeId];
      const offset = parseFloat(adjustOffset[tradeId] || '0');

      if (isNaN(sl) || isNaN(tp)) {
        alert("Please enter valid Stop Loss and Take Profit prices.");
        return;
      }

      const res = await fetch(`${BACKEND_URL}/api/trade/adjust`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          trade_id: tradeId,
          market_type: marketType,
          stop_loss: sl,
          take_profit: tp,
          is_trailing: isTrailing,
          trailing_offset: offset
        })
      });

      if (res.ok) {
        setExpandedActiveTradeId(null);
        loadData();
      } else {
        const err = await res.json();
        alert(`Failed to update trade: ${err.detail || 'Server error'}`);
      }
    } catch (e) {
      console.error(e);
      alert("Error adjusting trade parameters.");
    } finally {
      setAdjustLoading(prev => ({ ...prev, [tradeId]: false }));
    }
  };

  // Toggle active trade details pre-populator
  const toggleActiveTradeExpand = (t: Trade) => {
    if (expandedActiveTradeId === t.id) {
      setExpandedActiveTradeId(null);
    } else {
      const parsed = parseSlTpFromLogic(t.setup_logic || "");
      const currentSl = t.stop_loss || (parsed ? parsed.sl : 0);
      const currentTp = t.take_profit || (parsed ? parsed.tp : 0);
      const isTrailing = !!t.is_trailing;
      const offset = t.trailing_offset || 0;

      setAdjustSl(prev => ({ ...prev, [t.id]: String(currentSl) }));
      setAdjustTp(prev => ({ ...prev, [t.id]: String(currentTp) }));
      setAdjustIsTrailing(prev => ({ ...prev, [t.id]: isTrailing }));
      setAdjustOffset(prev => ({ ...prev, [t.id]: String(offset) }));
      setExpandedActiveTradeId(t.id);
    }
  };

  // Load API Keys Settings
  const loadSettings = async () => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${BACKEND_URL}/api/settings`, { headers });
      if (res.ok) {
        const data = await res.json();
        setSettingsGeminiKey(data.gemini_api_key || '');
        setSettingsWhatsAppKey(data.whatsapp_apikey || '');
        setSettingsFyersId(data.fyers_id || '');
        setSettingsFyersPin(data.fyers_pin || '');
        setSettingsFyersTotpKey(data.fyers_totp_key || '');
      }
    } catch (err) {
      console.error("Error loading settings:", err);
    }
  };

  // Save API Keys Settings
  const handleSaveSettings = async () => {
    setSettingsLoading(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${BACKEND_URL}/api/settings/update`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          gemini_api_key: settingsGeminiKey,
          whatsapp_apikey: settingsWhatsAppKey,
          fyers_id: settingsFyersId,
          fyers_pin: settingsFyersPin,
          fyers_totp_key: settingsFyersTotpKey
        })
      });
      if (res.ok) {
        alert("API & Fyers Settings updated successfully!");
        loadSettings();
      } else {
        const err = await res.json();
        alert(`Failed to update settings: ${err.detail || 'Server error'}`);
      }
    } catch (err) {
      console.error("Error saving settings:", err);
      alert("Error saving settings.");
    } finally {
      setSettingsLoading(false);
    }
  };

  // Load Admin dashboard stats
  const loadAdminInsights = async () => {
    setAdminInsightsLoading(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${BACKEND_URL}/api/admin/insights`, { headers });
      if (res.ok) {
        const data = await res.json();
        setAdminInsights(data);
        setUserProfilesList(data.user_profiles || []);
        loadSettings();
      } else {
        console.error("Failed to load admin insights:", res.statusText);
      }
    } catch (err) {
      console.error("Error loading admin insights:", err);
    } finally {
      setAdminInsightsLoading(false);
    }
  };

  // Update user subscription level & tokens
  const handleUpdateUserProfile = async (userId: string, newStatus: string, tokens: number) => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${BACKEND_URL}/api/admin/user/update`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          user_id: userId,
          subscription_status: newStatus,
          token_balance: tokens
        })
      });
      if (res.ok) {
        loadAdminInsights();
      } else {
        const err = await res.json();
        alert(`Failed to update user profile: ${err.detail || 'Server error'}`);
      }
    } catch (err) {
      console.error("Error updating user profile:", err);
    }
  };

  const [bannersDismissed, setBannersDismissed] = useState<Record<string, boolean>>({});

  // Safety timeout to guarantee the loading screen gets dismissed in case of deadlocks
  useEffect(() => {
    const timer = setTimeout(() => {
      setAuthLoading(false);
    }, 4000);
    return () => clearTimeout(timer);
  }, []);

  // Auto-switch default asset on environment change
  useEffect(() => {
    if (marketEnv === 'FOREX') {
      setSelectedAsset('EURUSD=X');
      setSelectedAssetLabel('EUR / USD');
      setResolution('5m');
    } else {
      setSelectedAsset('^NSEI');
      setSelectedAssetLabel('NIFTY 50');
      setResolution('15m');
    }
  }, [marketEnv]);

  // Get active open trades
  const activeTrades = trades.filter(t => t.status === 'OPEN');

  // Get filtered closed trades for the Interactive Ledger history (filtered by selected index/asset)
  const ledgerFilteredTrades = (() => {
    const now = new Date();
    
    // Start of today in local time
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Start of week (7 days ago)
    const weeklyStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    weeklyStart.setHours(0, 0, 0, 0);

    // Start of month (30 days ago)
    const monthlyStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    monthlyStart.setHours(0, 0, 0, 0);

    return trades.filter(t => {
      if (t.status !== 'CLOSED' || !isAssetMatch(selectedAsset, t.symbol)) {
        return false;
      }
      
      const entryTime = new Date(t.entry_time);
      if (ledgerFilter === 'TODAY') {
        return entryTime >= todayStart;
      } else if (ledgerFilter === 'WEEKLY') {
        return entryTime >= weeklyStart;
      } else if (ledgerFilter === 'MONTHLY') {
        return entryTime >= monthlyStart;
      }
      return true; // 'ALL'
    });
  })();

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
  const activeEntryLineRef = useRef<any>(null);
  const activeSlLineRef = useRef<any>(null);
  const activeTpLineRef = useRef<any>(null);

  // ── Google Sign-In via Supabase Auth ──────────────────────────────────────
  useEffect(() => {
    const initAuth = async () => {
      console.log("🔍 [BIFROST AUTH] initAuth started");
      
      // Safety 3-second timeout to prevent indefinite locks or storage deadlocks
      const timeoutPromise = new Promise<{ data: { session: null }; timeout: boolean }>((resolve) => {
        setTimeout(() => resolve({ data: { session: null }, timeout: true }), 3000);
      });

      try {
        console.log("🔍 [BIFROST AUTH] calling getSession with 3s timeout race");
        const result = await Promise.race([
          supabase.auth.getSession().then(res => ({ ...res, timeout: false })),
          timeoutPromise
        ]);

        if (result.timeout) {
          console.warn("🔍 [BIFROST AUTH] getSession timed out. Falling back to unauthenticated.");
          setUser(null);
        } else {
          const session = result.data?.session;
          console.log("🔍 [BIFROST AUTH] getSession resolved. Session present:", !!session);
          setUser(session?.user ?? null);
        }
      } catch (err) {
        console.error("🔍 [BIFROST AUTH] getSession failed with error:", err);
        setUser(null);
      } finally {
        console.log("🔍 [BIFROST AUTH] setting authLoading to false");
        setAuthLoading(false);
      }
    };

    try {
      initAuth();
    } catch (err) {
      console.error("🔍 [BIFROST AUTH] synchronous error inside initAuth call:", err);
      setAuthLoading(false);
    }

    let authSubscription: any = null;
    try {
      console.log("🔍 [BIFROST AUTH] setting up onAuthStateChange listener (non-async event handler to prevent deadlocks)");
      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        console.log(`🔍 [BIFROST AUTH] onAuthStateChange event: ${event}, user: ${session?.user?.email || 'none'}`);
        setUser(session?.user ?? null);
        
        if (event === 'SIGNED_IN' && session?.user) {
          // Offload async db call to the next tick of the event loop to prevent lock contention
          setTimeout(async () => {
            console.log("🔍 [BIFROST AUTH] logged in. Offloaded access log update running...");
            try {
              const { error: logErr } = await supabase.from('access_logs').insert({
                email: session.user.email,
                user_id: session.user.id,
                accessed_at: new Date().toISOString(),
                user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
                provider: session.user.app_metadata?.provider || 'google',
              });
              if (logErr) {
                console.warn("🔍 [BIFROST AUTH] access log insert warning:", logErr);
              } else {
                console.log("🔍 [BIFROST AUTH] access log successfully recorded.");
              }
            } catch (insertErr) {
              console.warn("🔍 [BIFROST AUTH] access log catch warning:", insertErr);
            }
          }, 0);
        }
      });
      authSubscription = data?.subscription;
    } catch (err) {
      console.error("🔍 [BIFROST AUTH] failed to subscribe to onAuthStateChange:", err);
    }

    return () => {
      try {
        if (authSubscription) {
          console.log("🔍 [BIFROST AUTH] cleaning up auth listener");
          authSubscription.unsubscribe();
        }
      } catch (err) {
        console.error("🔍 [BIFROST AUTH] clean up subscription unsubscribe error:", err);
      }
    };
  }, []);

  // ── Load and Subscribe to User Profile ─────────────────────────────────────
  useEffect(() => {
    if (!user) {
      setUserProfile(null);
      return;
    }

    const loadProfile = async () => {
      try {
        const { data, error } = await supabase
          .from('user_profiles')
          .select('*')
          .eq('id', user.id)
          .single();
        if (data) {
          setUserProfile(data);
        } else if (error) {
          console.warn("User profile fetch failed, the backend trigger will auto-provision it shortly.", error);
        }
      } catch (err) {
        console.error("Error loading user profile:", err);
      }
    };

    loadProfile();

    // Set up Real-Time subscription for this user's profile changes
    const profileChannel = supabase
      .channel(`profile-channel-${user.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'user_profiles', filter: `id=eq.${user.id}` },
        (payload) => {
          console.log("👤 [BIFROST AUTH] profile updated in real-time:", payload.new);
          setUserProfile(payload.new);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(profileChannel);
    };
  }, [user]);

  // Initialize clock and mount state
  useEffect(() => {
    setMounted(true);
    const updateTime = () => {
      const asset = ASSETS.find(a => a.value === assetRef.current);
      const cat = asset?.category || '';
      let tz = 'Asia/Kolkata';
      let label = 'IST';
      if (cat === 'Global Indices') {
        if (['^GDAXI', '^FTSE', '^FCHI'].includes(assetRef.current)) {
          tz = 'Europe/Berlin'; label = 'CET';
        } else {
          tz = 'America/New_York'; label = 'EST';
        }
      } else if (cat === 'Forex') {
        tz = 'America/New_York'; label = 'EST';
      } else if (cat === 'Crypto' || cat === 'Commodities') {
        tz = 'UTC'; label = 'UTC';
      }
      const options: Intl.DateTimeFormatOptions = {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      };
      setCurrentTimeStr(new Date().toLocaleTimeString('en-US', options) + ` ${label}`);
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Fetch all dashboard data from Supabase and FastAPI
  const loadData = async () => {
    try {
      const prefix = tradeMode === 'LIVE' ? 'production_' : '';
      const summaryTable = marketEnv === 'FOREX' ? `${prefix}forex_account_summary` : `${prefix}account_summary`;
      const tradesTable = marketEnv === 'FOREX' ? `${prefix}forex_trades` : `${prefix}trades`;

      // 1. Fetch metrics from Supabase
      const { data: summaryData, error: summaryError } = await supabase
        .from(summaryTable)
        .select('*')
        .eq('id', 1)
        .single();
      if (summaryError) {
        console.error(`Supabase metrics query error from ${summaryTable}:`, summaryError);
      }

      // 2. Fetch trades from Supabase
      const { data: tradesData, error: tradesError } = await supabase
        .from(tradesTable)
        .select('*')
        .order('entry_time', { ascending: false });
      if (tradesError) {
        console.error(`Supabase trades query error from ${tradesTable}:`, tradesError);
      }

      const resolvedTrades = tradesData || [];
      setTrades(resolvedTrades);

      // Fetch live prices for active symbols
      const activeSymbols = Array.from(new Set(resolvedTrades.filter(t => t.status === 'OPEN').map(t => t.symbol)));
      const newLivePrices: Record<string, number> = {};
      if (activeSymbols.length > 0) {
        try {
          const logsTable = marketEnv === 'FOREX' ? 'forex_execution_logs' : 'execution_logs';
          const { data: logsData } = await supabase
            .from(logsTable)
            .select('contract_targeted, asset_price, timestamp')
            .in('contract_targeted', activeSymbols)
            .order('timestamp', { ascending: false });

          if (logsData) {
            logsData.forEach(log => {
              const sym = log.contract_targeted;
              if (sym && newLivePrices[sym] === undefined) {
                newLivePrices[sym] = Number(log.asset_price);
              }
            });
          }
        } catch (logErr) {
          console.error("Error fetching live prices from execution logs:", logErr);
        }
      }
      setLivePrices(prev => ({ ...prev, ...newLivePrices }));
      
      // Calculate Win Rate using direction-aware P&L
      const closed = resolvedTrades.filter(t => t.status === 'CLOSED');
      const wins = closed.filter(t => computePnl(t as Trade) > 0);
      const calculatedWinRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0.0;
      const active = resolvedTrades.filter(t => t.status === 'OPEN').length;
      const realizedPnl = closed.reduce((acc, curr) => acc + computePnl(curr as Trade), 0);
      
      if (summaryData) {
        setMetrics({
          account_capital: Number(summaryData.net_equity),
          win_rate: Number(calculatedWinRate.toFixed(2)),
          net_profit: realizedPnl,
          active_allocations: active,
          safety_state: (marketEnv === 'FOREX' ? realizedPnl <= -5000.0 : realizedPnl <= -2000.0) ? "DAILY_LOSS_HALT" : "SAFE",
          daily_realized_pnl: Number(summaryData.daily_realized_pnl),
          total_trades: resolvedTrades.length
        });
      } else {
        // Setup metrics directly from trades
        setMetrics({
          account_capital: startingCapital + realizedPnl,
          win_rate: Number(calculatedWinRate.toFixed(2)),
          net_profit: realizedPnl,
          active_allocations: active,
          safety_state: (marketEnv === 'FOREX' ? realizedPnl <= -200.0 : realizedPnl <= -2000.0) ? "DAILY_LOSS_HALT" : "SAFE",
          daily_realized_pnl: realizedPnl,
          total_trades: resolvedTrades.length
        });
      }

      // Update live spot price from open trade if exists
      const openTrade = resolvedTrades.find(t => t.status === 'OPEN' && isAssetMatch(assetRef.current, t.symbol));
      if (openTrade) {
        setLiveSpotPrice(Number(openTrade.entry_price));
      }

      // Automatically fetch Swing Trading data if marketEnv is SWING
      if (marketEnv === 'SWING') {
        loadSwingData();
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

        // Apply buy & sell markers
        const markers: any[] = [];
        candles.forEach((c: any) => {
          if (c.long_signal === true) {
            markers.push({
              time: c.time,
              position: 'belowBar' as const,
              color: '#10b981',
              shape: 'arrowUp' as const,
              text: 'SMC BUY'
            });
          } else if (c.short_signal === true) {
            markers.push({
              time: c.time,
              position: 'aboveBar' as const,
              color: '#f43f5e',
              shape: 'arrowDown' as const,
              text: 'SMC SELL'
            });
          }
        });
        if (candleMarkersRef.current) {
          candleMarkersRef.current.setMarkers(markers);
        }
        setIsLive(true);
        
        // Update live spot price from latest candle close
        if (candles.length > 0) {
          const ltp = Number(candles[candles.length - 1].close);
          setLiveSpotPrice(ltp);
          setLivePrices(prev => ({ ...prev, [assetVal]: ltp }));
        }
      }
    } catch (e) {
      console.warn("Backend API not reachable. Generating simulated chart data locally.");
      setIsLive(false);
      generateLocalSimulatedData(resVal, assetVal);
    }
  };

  // Check market hours status locally / backend — use ref to avoid stale closure
  const checkMarketState = () => {
    setMarketState(getMarketStatusForAsset(assetRef.current, ASSETS));
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
    else if (assetVal.includes('USDJPY')) basePrice = 157.50;
    else if (assetVal.includes('AUDUSD')) basePrice = 0.6550;
    else if (assetVal.includes('USDCAD')) basePrice = 1.3620;
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
      // Use percentage-based volatility so Forex (1.08) and BTC (68000) look correct
      const volatility = basePrice * 0.0015; // 0.15% range per candle
      const open = basePrice;
      const move = (Math.random() - 0.5) * volatility * 2;
      const close = open + move;
      const high = Math.max(open, close) + Math.random() * volatility * 0.5;
      const low  = Math.min(open, close) - Math.random() * volatility * 0.5;

      
      mockCandles.push({ time: time as any, open, high, low, close });
      
      // Seed EMA
      const ema = basePrice * (0.999 + (i * 0.00003));
      mockEma.push({ time: time as any, value: ema });
      
      // FVG zones (proportional to price)
      if (i % 25 === 0) {
        const isBuy = (i / 25) % 2 === 0;
        const fvgOffset = basePrice * 0.002;
        mockFvgTop.push({ time: time as any, value: high + (isBuy ? fvgOffset : -fvgOffset * 0.5) });
        mockFvgBottom.push({ time: time as any, value: low + (isBuy ? -fvgOffset * 0.5 : fvgOffset) });

        mockMarkers.push({
          time: time as any,
          position: isBuy ? 'belowBar' as const : 'aboveBar' as const,
          color: isBuy ? '#10b981' : '#f43f5e',
          shape: isBuy ? 'arrowUp' as const : 'arrowDown' as const,
          text: isBuy ? 'SMC BUY' : 'SMC SELL'
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
    const baselineTime = Math.floor((Date.now() - 3600 * 24 * 7 * 1000) / 1000);
    const equityCurveData: { time: any; value: number }[] = [
      { time: baselineTime as any, value: startingEquity }
    ];

    if (closed.length > 0) {
      closed.forEach(t => {
        startingEquity += computePnl(t);
        equityCurveData.push({
          time: Math.floor(new Date(t.exit_time || "").getTime() / 1000) as any,
          value: startingEquity
        });
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const lastPoint = equityCurveData[equityCurveData.length - 1];
    if (lastPoint.time < now) {
      equityCurveData.push({ time: now as any, value: startingEquity });
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

    const prefix = tradeMode === 'LIVE' ? 'production_' : '';
    const tradesTable = marketEnv === 'FOREX' ? `${prefix}forex_trades` : `${prefix}trades`;
    const summaryTable = marketEnv === 'FOREX' ? `${prefix}forex_account_summary` : `${prefix}account_summary`;

    // 3. Supabase Real-Time Subscriptions (Utilizing unique channel names to prevent crossover conflicts)
    const tradesChannel = supabase
      .channel(`trades-realtime-channel-${marketEnv}-${tradeMode}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: tradesTable },
        (payload) => {
          console.log('🔔 Real-time Trade Event:', payload);
          loadData();
        }
      )
      .subscribe();

    const metricsChannel = supabase
      .channel(`metrics-realtime-channel-${marketEnv}-${tradeMode}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: summaryTable },
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
  }, [mounted, marketEnv, tradeMode]);

  // Reactive resolution/asset updates
  useEffect(() => {
    if (mounted) {
      loadChartAndState(resolution, selectedAsset);
      checkMarketState();
    }
  }, [resolution, selectedAsset]);

  // Reactive Equity Curve Rebuild — use ALL trades for portfolio equity
  useEffect(() => {
    if (mounted && trades) {
      updateEquityCurveChart(trades);
    }
  }, [trades, mounted]);

  // Reactive Active Trade Price Lines Overlay
  useEffect(() => {
    if (mounted && candleSeriesRef.current) {
      const openPosition = trades.find(t => t.status === 'OPEN' && isAssetMatch(selectedAsset, t.symbol));
      
      // Clean up previous lines
      if (activeEntryLineRef.current) {
        try { candleSeriesRef.current.removePriceLine(activeEntryLineRef.current); } catch(e){}
        activeEntryLineRef.current = null;
      }
      if (activeSlLineRef.current) {
        try { candleSeriesRef.current.removePriceLine(activeSlLineRef.current); } catch(e){}
        activeSlLineRef.current = null;
      }
      if (activeTpLineRef.current) {
        try { candleSeriesRef.current.removePriceLine(activeTpLineRef.current); } catch(e){}
        activeTpLineRef.current = null;
      }
      
      // Draw new lines if there is an active trade
      if (openPosition) {
        const parsed = parseSlTpFromLogic(openPosition.setup_logic || "");
        const slVal = parsed ? parsed.sl : (openPosition.direction === 'BUY' ? Number(openPosition.entry_price) * 0.99 : Number(openPosition.entry_price) * 1.01);
        const tpVal = parsed ? parsed.tp : (openPosition.direction === 'BUY' ? Number(openPosition.entry_price) * 1.02 : Number(openPosition.entry_price) * 0.98);
        
        try {
          activeEntryLineRef.current = candleSeriesRef.current.createPriceLine({
            price: Number(openPosition.entry_price),
            color: '#06b6d4', // cyan-500
            lineWidth: 1.5,
            lineStyle: 2, // dashed
            axisLabelVisible: true,
            title: `ENTRY: ${formatPrice(Number(openPosition.entry_price), marketEnv)}`,
          });
          
          activeSlLineRef.current = candleSeriesRef.current.createPriceLine({
            price: slVal,
            color: '#f43f5e', // rose-500
            lineWidth: 2,
            lineStyle: 2, // dashed
            axisLabelVisible: true,
            title: `SL: ${formatPrice(slVal, marketEnv)}`,
          });
          
          activeTpLineRef.current = candleSeriesRef.current.createPriceLine({
            price: tpVal,
            color: '#10b981', // emerald-500
            lineWidth: 2,
            lineStyle: 2, // dashed
            axisLabelVisible: true,
            title: `TP: ${formatPrice(tpVal, marketEnv)}`,
          });
        } catch (e) {
          console.error("Error drawing active trade price lines on chart:", e);
        }
      }
    }
  }, [trades, selectedAsset, mounted, marketEnv]);

  const copyToClipboard = (hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  // Strictly match open position to current selected asset only
  const openPosition = trades.find(t => t.status === 'OPEN' && isAssetMatch(selectedAsset, t.symbol)) ?? null;
  // Any other open position on a different asset
  const otherOpenPosition = trades.find(t => t.status === 'OPEN' && !isAssetMatch(selectedAsset, t.symbol)) ?? null;

  // Helper: alias-aware live price lookup — fixes BANK NIFTY always showing $0
  const getLivePrice = (symbol: string, fallback: number): number => {
    if (livePrices[symbol] !== undefined) return livePrices[symbol];
    const aliasEntry = Object.entries(livePrices).find(
      ([k]) => isAssetMatch(k, symbol) || isAssetMatch(symbol, k)
    );
    return aliasEntry ? aliasEntry[1] : fallback;
  };
  
  // Calculate portfolio-wide live unrealized pnl (all open positions combined)
  const portfolioUnrealizedPnl = trades
    .filter(t => t.status === 'OPEN')
    .reduce((acc, t) => {
      const livePrice = getLivePrice(t.symbol, Number(t.entry_price));
      const delta = t.direction === 'BUY'
        ? livePrice - Number(t.entry_price)
        : Number(t.entry_price) - livePrice;
      return acc + (delta * Number(t.quantity));
    }, 0);

  // Calculate live unrealized pnl for selected asset only
  let liveUnrealizedPnl = 0.00;
  if (openPosition) {
    const livePrice = getLivePrice(openPosition.symbol, liveSpotPrice);
    const delta = openPosition.direction === 'BUY' 
      ? livePrice - Number(openPosition.entry_price)
      : Number(openPosition.entry_price) - livePrice;
    liveUnrealizedPnl = delta * openPosition.quantity;
  }

  // Portfolio-wide metrics (all trades, all indices) — uses direction-aware P&L
  const allClosed = trades.filter(t => t.status === 'CLOSED');
  const allWins = allClosed.filter(t => computePnl(t) > 0);
  const portfolioWinRate = allClosed.length > 0 ? Number(((allWins.length / allClosed.length) * 100).toFixed(2)) : 0.0;
  const portfolioRealizedPnl = allClosed.reduce((acc, curr) => acc + computePnl(curr), 0);

  // Per-asset filtered trades — for the chart tab & performance tab
  const filteredTrades = trades.filter(t => isAssetMatch(selectedAsset, t.symbol));
  const filteredClosed = filteredTrades.filter(t => t.status === 'CLOSED');
  const filteredWins = filteredClosed.filter(t => computePnl(t) > 0);
  const filteredWinRate = filteredClosed.length > 0 ? Number(((filteredWins.length / filteredClosed.length) * 100).toFixed(2)) : 0.0;
  const filteredRealizedPnl = filteredClosed.reduce((acc, curr) => acc + computePnl(curr), 0);

  // Selected Asset stats computations (used for Context-Aware header stats)
  const assetTrades = trades.filter((t) => isAssetMatch(selectedAsset, t.symbol));
  const assetOpenTrades = assetTrades.filter((t) => t.status === 'OPEN');
  const assetClosedTrades = assetTrades.filter((t) => t.status === 'CLOSED');

  const assetUnrealized = assetOpenTrades.reduce((sum, t) => {
    const entry = Number(t.entry_price);
    const current = getLivePrice(t.symbol, isAssetMatch(selectedAsset, t.symbol) ? liveSpotPrice : entry);
    const delta = t.direction === 'BUY' ? current - entry : entry - current;
    return sum + (delta * Number(t.quantity));
  }, 0);

  const assetTodayRealized = assetClosedTrades
    .filter((t) => isExitTimeToday(t.exit_time))
    .reduce((sum, t) => sum + computePnl(t), 0);
  const assetTodayPnl = assetTodayRealized + assetUnrealized;

  const assetOverallRealized = assetClosedTrades.reduce((sum, t) => sum + computePnl(t), 0);
  const assetOverallPnl = assetOverallRealized + assetUnrealized;

  // ── Today's trade count (IST) for daily limit banner ──────────────────────
  const todayStartIST = (() => {
    const d = new Date();
    const ist = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    ist.setHours(0, 0, 0, 0);
    const offset = d.getTime() - new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getTime();
    return new Date(ist.getTime() + offset);
  })();
  const todayTradeCount = trades.filter(t => new Date(t.entry_time) >= todayStartIST).length;
  const dailyLimitReached = todayTradeCount >= 2;
  const dailyLossRisk = metrics.daily_realized_pnl <= dailyLossThreshold;

  // ── Excel Download (Custom Specific Columns) ──────────────────────────────────
  const downloadExcel = async () => {
    const wb = XLSX.utils.book_new();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // 1. Fetch Indian Option Trades
    let indianOptionTradesList = [];
    try {
      const prefix = tradeMode === 'LIVE' ? 'production_' : '';
      const { data } = await supabase
        .from(`${prefix}trades`)
        .select('*')
        .order('entry_time', { ascending: false });
      if (data) indianOptionTradesList = data;
    } catch (e) {
      console.warn("Failed to fetch Indian trades for Excel export:", e);
      if (marketEnv === 'INDIAN') indianOptionTradesList = trades;
    }

    // 2. Fetch Forex Trades
    let forexTradesList = [];
    try {
      const prefix = tradeMode === 'LIVE' ? 'production_' : '';
      const { data } = await supabase
        .from(`${prefix}forex_trades`)
        .select('*')
        .order('entry_time', { ascending: false });
      if (data) forexTradesList = data;
    } catch (e) {
      console.warn("Failed to fetch Forex trades for Excel export:", e);
      if (marketEnv === 'FOREX') forexTradesList = trades;
    }

    // Filter closed ones
    const closedIndian = indianOptionTradesList.filter(t => t.status === 'CLOSED');
    const closedForex = forexTradesList.filter(t => t.status === 'CLOSED');

    // Helper to parse option details
    const parseOptionDetails = (setup: string) => {
      const strikeMatch = setup.match(/Strike:\s*([0-9.]+)/i);
      const typeMatch = setup.match(/Option\s*Type:\s*(CE|PE)/i);
      const spotMatch = setup.match(/Spot:\s*([0-9.]+)/i);
      const slMatch = setup.match(/SL:\s*([0-9.]+)/i);
      const tpMatch = setup.match(/TP:\s*([0-9.]+)/i);
      return {
        strike: strikeMatch ? Number(strikeMatch[1]) : '',
        type: typeMatch ? typeMatch[1] : '',
        spot: spotMatch ? Number(spotMatch[1]) : '',
        sl: slMatch ? Number(slMatch[1]) : '',
        tp: tpMatch ? Number(tpMatch[1]) : '',
      };
    };

    // Format Indian option trades sheet
    const indianRows = closedIndian.map(t => {
      const opt = parseOptionDetails(t.setup_logic || '');
      const pnlVal = computePnl(t);
      return {
        'Date': new Date(t.entry_time).toLocaleDateString('en-IN'),
        'Option Symbol': t.symbol,
        'Underlying': t.symbol.includes('BANK') ? 'BANK NIFTY' : (t.symbol.includes('SENSEX') ? 'SENSEX' : 'NIFTY 50'),
        'Option Type': opt.type || (t.symbol.endsWith('CE') ? 'CE' : (t.symbol.endsWith('PE') ? 'PE' : 'CE/PE')),
        'Strike Price': opt.strike,
        'Entry Premium (Price)': Number(t.entry_price),
        'Exit Premium (Price)': Number(t.exit_price) || '',
        'Quantity': t.quantity,
        'Stop Loss Premium': opt.sl,
        'Take Profit Premium': opt.tp,
        'Net P&L (INR)': pnlVal.toFixed(2),
        'Outcome': pnlVal >= 0 ? 'PROFIT' : 'LOSS',
        'Underlying Spot': opt.spot,
        'Entry Time': t.entry_time,
        'Exit Time': t.exit_time || '',
      };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(indianRows), 'Indian Option Trades');

    // Format Forex trades sheet
    const forexRows = closedForex.map(t => {
      const pnlVal = computePnl(t);
      return {
        'Date': new Date(t.entry_time).toLocaleDateString('en-IN'),
        'Pair / Asset': t.symbol,
        'Position Type': t.direction === 'BUY' ? 'LONG' : 'SHORT',
        'Entry Price': Number(t.entry_price),
        'Exit Price': Number(t.exit_price) || '',
        'Quantity (Units)': t.quantity,
        'Net P&L (USD)': pnlVal.toFixed(2),
        'Outcome': pnlVal >= 0 ? 'PROFIT' : 'LOSS',
        'Setup Trigger': (t.setup_logic || '').slice(0, 100),
        'Entry Time': t.entry_time,
        'Exit Time': t.exit_time || '',
      };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(forexRows), 'Forex Trades');

    // Format Swing Portfolio Holdings sheet
    const swingHoldingRows = swingHoldings.map(h => {
      const cost = Number(h.average_buy_price) * Number(h.quantity);
      return {
        'Symbol': h.symbol,
        'Avg Buy Price (INR)': Number(h.average_buy_price),
        'Quantity (Shares)': h.quantity,
        'Cost Basis (INR)': cost.toFixed(2),
        'Last Synced At': h.last_synced_at || '',
      };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(swingHoldingRows), 'Swing Portfolio');

    // Format Swing Signals & Picks sheet
    const swingSignalRows = swingSignals.map(s => {
      return {
        'Date': new Date(s.signal_date).toLocaleDateString('en-IN'),
        'Symbol': s.symbol,
        'Entry Price (INR)': Number(s.entry_price),
        'Target Price (INR)': Number(s.target_price),
        'Stop Loss (INR)': Number(s.stop_loss),
        'Score / Rating': s.composite_score || '',
        'Status': s.status,
        'Exit Price': s.exit_price || '',
        'Exit Date': s.exit_date || '',
        'Exit Rule': s.exit_rule || '',
      };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(swingSignalRows), 'Swing Picks & Signals');

    const monthStr = now.toLocaleString('en-IN', { year: 'numeric', month: 'short' }).replace(' ', '-');
    XLSX.writeFile(wb, `BIFROST_All_Environments_Trades_${monthStr}.xlsx`);
  };

  // ── Performance Metrics Excel Download ──────────────────────────────────────
  const downloadPerformanceMetricsExcel = () => {
    const wb = XLSX.utils.book_new();
    const assetTrades = trades.filter(t => isAssetMatch(selectedAsset, t.symbol));
    const closed = assetTrades.filter(t => t.status === 'CLOSED');
    const wins = closed.filter(t => computePnl(t) > 0);
    const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0.0;
    const profitFactor = calculateProfitFactor(assetTrades);
    const avgStats = calculateAvgWinLoss(assetTrades);
    const netPnl = closed.reduce((acc, curr) => acc + computePnl(curr), 0);
    const weeklyReturn = calculatePeriodReturn(assetTrades, 'weekly');
    const monthlyReturn = calculatePeriodReturn(assetTrades, 'monthly');

    const summaryData = [
      { 'Metric': 'Target Asset / Ticker', 'Value': selectedAssetLabel + ` (${selectedAsset})` },
      { 'Metric': 'Market Environment', 'Value': marketEnv },
      { 'Metric': 'Total Trades Created', 'Value': assetTrades.length },
      { 'Metric': 'Completed Trades', 'Value': closed.length },
      { 'Metric': 'Winning Trades', 'Value': wins.length },
      { 'Metric': 'Losing Trades', 'Value': closed.length - wins.length },
      { 'Metric': 'Win Ratio', 'Value': winRate.toFixed(2) + '%' },
      { 'Metric': 'Profit Factor', 'Value': profitFactor.toFixed(2) },
      { 'Metric': 'Average Win', 'Value': avgStats.avgWin.toFixed(2) },
      { 'Metric': 'Average Loss', 'Value': avgStats.avgLoss.toFixed(2) },
      { 'Metric': 'Weekly Net Return', 'Value': weeklyReturn.toFixed(2) },
      { 'Metric': 'Monthly Net Return', 'Value': monthlyReturn.toFixed(2) },
      { 'Metric': 'All-Time Net Realized P&L', 'Value': netPnl.toFixed(2) }
    ];

    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryData), 'KPI Summary');

    const tradeRows = closed.map(t => ({
      'Date': new Date(t.entry_time).toLocaleDateString('en-IN'),
      'Symbol': t.symbol,
      'Direction': t.direction,
      'Type': t.direction === 'BUY' ? 'LONG/CE' : 'SHORT/PE',
      'Entry Price': Number(t.entry_price),
      'Exit Price': Number(t.exit_price) || '',
      'Quantity': t.quantity,
      'P&L': computePnl(t).toFixed(2),
      'Outcome': computePnl(t) >= 0 ? 'PROFIT' : 'LOSS',
      'Setup': t.setup_logic || '',
      'Entry Time': t.entry_time,
      'Exit Time': t.exit_time || ''
    }));

    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tradeRows), 'Completed Trades');

    XLSX.writeFile(wb, `BIFROST_Performance_${selectedAsset.replace('=X', '')}.xlsx`);
  };

  // ── Custom Stock Scanner Trigger ──────────────────────────────────────────
  const runCustomScan = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!customScanTicker.trim()) return;
    setCustomScanLoading(true);
    setCustomScanResult(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${BACKEND_URL}/api/scan-asset?ticker=${encodeURIComponent(customScanTicker.trim())}&resolution=15m`, {
        headers
      });
      const data = await res.json();
      setCustomScanResult(data);
    } catch (err) {
      console.error(err);
      setCustomScanResult({ status: 'error', message: 'Scan request failed. Check server connection.' });
    } finally {
      setCustomScanLoading(false);
    }
  };

  // ── AI Assistant Communication ──────────────────────────────────────────────
  const sendChatMessage = async (e?: React.FormEvent, customMsg?: string) => {
    if (e) e.preventDefault();
    const textToSend = customMsg || chatInput;
    if (!textToSend.trim()) return;

    const userMsg = { sender: 'user' as const, text: textToSend, timestamp: new Date() };
    setChatMessages(prev => [...prev, userMsg]);
    if (!customMsg) setChatInput('');
    setChatLoading(true);

    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${BACKEND_URL}/api/ai/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: textToSend,
          market_env: marketEnv,
          selected_asset: selectedAsset
        })
      });
      const data = await res.json();
      
      const aiMsg = {
        sender: 'ai' as const,
        text: data.response || 'Sorry, I encountered an error compiling response.',
        timestamp: new Date()
      };
      setChatMessages(prev => [...prev, aiMsg]);
      
      if (data.action_taken === 'SCAN' && data.data?.status === 'success') {
        setCustomScanTicker(data.data.ticker);
        setCustomScanResult(data.data);
      }
    } catch (err) {
      console.error(err);
      setChatMessages(prev => [...prev, {
        sender: 'ai',
        text: '❌ Communication failure with BIFROST API server on AWS EC2.',
        timestamp: new Date()
      }]);
    } finally {
      setChatLoading(false);
      setTimeout(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 80);
    }
  };

  // Auth loading state
  if (authLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#02050f] text-cyan-400 font-mono">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-cyan-500 mx-auto mb-4"></div>
          <div className="tracking-widest uppercase text-xs">AUTHENTICATING...</div>
        </div>
      </div>
    );
  }

  // Login screen (Google Sign-In gate)
  if (!user) {
    return (
      <div className="min-h-screen bg-[#02050f] flex items-center justify-center p-4">
        <div className="relative border border-slate-800 bg-[#070b15]/95 backdrop-blur-md rounded-3xl p-10 shadow-2xl max-w-md w-full text-center overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-96 h-32 bg-cyan-500/10 rounded-full blur-3xl -z-10" />
          <div className="flex items-center justify-center mb-6">
            <div className="relative flex items-center justify-center h-16 w-16 rounded-2xl bg-gradient-to-tr from-cyan-600 to-indigo-700 shadow-lg shadow-cyan-900/40">
              <span className="text-3xl font-black text-white">B</span>
              <div className="absolute inset-0 rounded-2xl border border-cyan-400/30 animate-pulse" />
            </div>
          </div>
          <h1 className="text-2xl font-black tracking-wider bg-gradient-to-r from-slate-100 via-cyan-100 to-cyan-400 bg-clip-text text-transparent mb-2">
            BIFROST // QUANT_ENGINE
          </h1>
          <p className="text-slate-500 text-xs font-mono tracking-widest uppercase mb-2">Algorithmic Trading Intelligence</p>
          <div className="my-6 border-t border-slate-800" />
          <p className="text-slate-400 text-sm mb-6">Sign in to access your real-time trading dashboard</p>
          <button
            id="google-signin-btn"
            onClick={() => supabase.auth.signInWithOAuth({
              provider: 'google',
              options: { redirectTo: typeof window !== 'undefined' ? window.location.origin : '' }
            })}
            className="w-full flex items-center justify-center gap-3 bg-white hover:bg-slate-100 text-slate-900 font-bold rounded-xl py-3 px-6 transition-all duration-200 shadow-lg hover:shadow-xl hover:scale-[1.02] active:scale-[0.98]"
          >
            <svg width="20" height="20" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Continue with Google
          </button>
          <p className="text-slate-600 text-[10px] font-mono mt-4">Access is logged and monitored. Authorised personnel only.</p>
        </div>
      </div>
    );
  }

  // ── Swing Trading Dashboard Layout Component ──
  const SwingTradingDashboard = () => {
    // Watchlist add states (for form inputs)
    const [wlSymbol, setWlSymbol] = useState('');
    const [wlName, setWlName] = useState('');
    const [wlSector, setWlSector] = useState('Energy');
    const [wlPrice, setWlPrice] = useState('');
    const [wlTarget1, setWlTarget1] = useState('');
    const [wlTarget2, setWlTarget2] = useState('');
    const [wlStopLoss, setWlStopLoss] = useState('');
    const [wlSaving, setWlSaving] = useState(false);

    // Smart Picks states
    const [picksSearch, setPicksSearch] = useState('');

    const handleAddWatchlist = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!wlSymbol.trim()) return;
      setWlSaving(true);
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${BACKEND_URL}/api/swing/watchlist/add`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            symbol: wlSymbol.trim().toUpperCase(),
            name: wlName.trim() || wlSymbol.trim().toUpperCase(),
            sector: wlSector,
            market: "IN"
          })
        });
        if (res.ok) {
          // Add manually if DB updated
          const payload = {
            symbol: wlSymbol.trim().toUpperCase(),
            name: wlName.trim() || wlSymbol.trim().toUpperCase(),
            sector: wlSector,
            price: wlPrice ? parseFloat(wlPrice) : null,
            target_1: wlTarget1 ? parseFloat(wlTarget1) : null,
            target_2: wlTarget2 ? parseFloat(wlTarget2) : null,
            stop_loss: wlStopLoss ? parseFloat(wlStopLoss) : null,
            status: "ACTIVE"
          };
          
          // Upsert in Supabase recommendations directly to also store targets
          const { error } = await supabase.from('recommendations').upsert(payload, { onConflict: 'symbol' });
          if (error) console.error("Error upserting targets in recommendations:", error);

          setWlSymbol('');
          setWlName('');
          setWlPrice('');
          setWlTarget1('');
          setWlTarget2('');
          setWlStopLoss('');
          loadSwingData();
        } else {
          const err = await res.json();
          alert(`Failed to add watchlist item: ${err.detail || 'Server error'}`);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setWlSaving(false);
      }
    };

    const handleRemoveWatchlist = async (symbol: string) => {
      if (!confirm(`Are you sure you want to remove ${symbol} from the watchlist?`)) return;
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${BACKEND_URL}/api/swing/watchlist/remove`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ symbol })
        });
        if (res.ok) {
          loadSwingData();
        }
      } catch (err) {
        console.error(err);
      }
    };

    const handleAddHolding = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!newHoldingSymbol.trim() || !newHoldingPrice || !newHoldingQty) return;
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${BACKEND_URL}/api/swing/holdings/update`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            symbol: newHoldingSymbol.trim().toUpperCase(),
            average_buy_price: parseFloat(newHoldingPrice),
            quantity: parseInt(newHoldingQty)
          })
        });
        if (res.ok) {
          setNewHoldingSymbol('');
          setNewHoldingPrice('');
          setNewHoldingQty('');
          loadSwingData();
        } else {
          const err = await res.json();
          alert(`Failed to update holding: ${err.detail || 'Server error'}`);
        }
      } catch (err) {
        console.error(err);
      }
    };

    const handleTriggerSignal = async (item: any, comps: any) => {
      const setup = calcTradeSetup(item.price || 100, {}, { atr: (item.price || 100) * 0.02 });
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${BACKEND_URL}/api/swing/signal/create`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            symbol: item.symbol,
            entry_price: item.price || 100,
            target_price: setup.target2,
            stop_loss: setup.stopLoss,
            composite_score: comps.total,
            status: "ACTIVE"
          })
        });
        if (res.ok) {
          alert(`Trade signal successfully triggered for ${item.symbol}!`);
          loadSwingData();
        } else {
          const err = await res.json();
          alert(`Failed to trigger signal: ${err.detail || 'Server error'}`);
        }
      } catch (err) {
        console.error(err);
      }
    };

    // Filter screener list
    const filteredScreener = swingWatchlist.filter(item => {
      const comps = getComponentsForSymbol(item.symbol);
      const ratingRes = compositeScore(comps.fund, comps.tech, comps.mom, comps.sent, comps.inst, item.price || 100, 100, swingWeights);
      
      const matchSector = screenSector === 'ALL' || item.sector?.toUpperCase() === screenSector.toUpperCase();
      const matchRating = screenRating === 'ALL' || ratingRes.ratingClass.toUpperCase() === screenRating.toUpperCase();
      
      // Determine market cap using symbol index
      let cap = 'Large Cap';
      if (item.symbol.charCodeAt(0) % 3 === 1) cap = 'Mid Cap';
      else if (item.symbol.charCodeAt(0) % 3 === 2) cap = 'Small Cap';
      const matchCap = screenCap === 'ALL' || cap.toUpperCase() === screenCap.toUpperCase();

      return matchSector && matchRating && matchCap;
    });

    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 font-mono text-xs">
        {/* Left Column: Sliders */}
        <div className="lg:col-span-1 border border-slate-800 bg-[#070b15]/95 rounded-2xl p-5 shadow-2xl flex flex-col gap-5">
          <div className="border-b border-slate-850 pb-3 flex justify-between items-center">
            <h2 className="text-xs font-black tracking-widest text-slate-400 uppercase">COMPOSITE SCORING WEIGHTS</h2>
            <div className="px-2 py-0.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/25 text-[10px] font-black animate-pulse">
              SUM: 100%
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <div className="flex justify-between font-bold mb-1">
                <span className="text-slate-400">Fundamental Weight</span>
                <span className="text-cyan-400">{swingWeights.fundamental}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={swingWeights.fundamental}
                onChange={(e) => handleWeightChange('fundamental', parseInt(e.target.value))}
                className="w-full h-1 bg-slate-900 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
            </div>

            <div>
              <div className="flex justify-between font-bold mb-1">
                <span className="text-slate-400">Technical Weight</span>
                <span className="text-cyan-400">{swingWeights.technical}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={swingWeights.technical}
                onChange={(e) => handleWeightChange('technical', parseInt(e.target.value))}
                className="w-full h-1 bg-slate-900 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
            </div>

            <div>
              <div className="flex justify-between font-bold mb-1">
                <span className="text-slate-400">Momentum Weight</span>
                <span className="text-cyan-400">{swingWeights.momentum}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={swingWeights.momentum}
                onChange={(e) => handleWeightChange('momentum', parseInt(e.target.value))}
                className="w-full h-1 bg-slate-900 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
            </div>

            <div>
              <div className="flex justify-between font-bold mb-1">
                <span className="text-slate-400">Sentiment Weight</span>
                <span className="text-cyan-400">{swingWeights.sentiment}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={swingWeights.sentiment}
                onChange={(e) => handleWeightChange('sentiment', parseInt(e.target.value))}
                className="w-full h-1 bg-slate-900 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
            </div>

            <div>
              <div className="flex justify-between font-bold mb-1">
                <span className="text-slate-400">Institutional Weight</span>
                <span className="text-cyan-400">{swingWeights.institutional}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={swingWeights.institutional}
                onChange={(e) => handleWeightChange('institutional', parseInt(e.target.value))}
                className="w-full h-1 bg-slate-900 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
            </div>
          </div>

          <div className="bg-slate-900/30 border border-slate-850 rounded-xl p-3 text-[10px] text-slate-500 leading-relaxed">
            💡 Changing weights dynamically recalculates composite scores and buy recommendations for all watchlist symbols instantly.
          </div>
        </div>

        {/* Right Column: Content Area */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          <div className="border border-slate-800 bg-[#070b15]/95 rounded-2xl p-4 shadow-2xl">
            {/* Tabs Selector */}
            <div className="flex gap-4 border-b border-slate-850 pb-2 mb-4">
              {['WATCHLIST', 'PICKS', 'PORTFOLIO', 'SCREENER', 'BACKTESTER', 'PERFORMANCE'].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setSwingActiveTab(tab as any)}
                  className={`font-bold tracking-widest text-[10px] pb-1 border-b-2 transition-colors cursor-pointer ${
                    swingActiveTab === tab ? 'border-amber-500 text-amber-400 font-extrabold' : 'border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            {/* Sub-tab: Watchlist */}
            {swingActiveTab === 'WATCHLIST' && (
              <div className="space-y-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-[10px]">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-500 uppercase tracking-widest text-[8px]">
                        <th className="py-2 px-1">Symbol</th>
                        <th className="py-2 px-1">Name</th>
                        <th className="py-2 px-1">Sector</th>
                        <th className="py-2 px-1">Price</th>
                        <th className="py-2 px-1">Target 1</th>
                        <th className="py-2 px-1">Target 2</th>
                        <th className="py-2 px-1">Stop Loss</th>
                        <th className="py-2 px-1 text-center">Score</th>
                        {userProfile?.role === 'admin' && <th className="py-2 px-1 text-right">Actions</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {swingWatchlist.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="text-center py-6 text-slate-500">
                            No symbols found. Add symbols to scan.
                          </td>
                        </tr>
                      ) : (
                        swingWatchlist.map((item) => {
                          const comps = getComponentsForSymbol(item.symbol);
                          const ratingRes = compositeScore(comps.fund, comps.tech, comps.mom, comps.sent, comps.inst, item.price || 100, 100, swingWeights);
                          const isSelected = selectedSwingSymbol === item.symbol;
                          return (
                            <tr
                              key={item.id}
                              onClick={() => {
                                setSelectedSwingSymbol(item.symbol);
                                setSelectedSwingName(item.name || item.symbol);
                                setSelectedSwingSector(item.sector || 'Unknown');
                              }}
                              className={`border-b border-slate-850 hover:bg-slate-900/30 cursor-pointer transition-colors ${
                                isSelected ? 'bg-amber-500/[0.02] border-l-2 border-l-amber-500' : ''
                              }`}
                            >
                              <td className="py-2.5 px-1 font-bold text-slate-200">{item.symbol}</td>
                              <td className="py-2.5 px-1 text-slate-400 truncate max-w-[100px]">{item.name}</td>
                              <td className="py-2.5 px-1 text-slate-400">{item.sector}</td>
                              <td className="py-2.5 px-1 text-slate-350">{item.price ? `₹${Number(item.price).toFixed(2)}` : '—'}</td>
                              <td className="py-2.5 px-1 text-emerald-500">{item.target_1 ? `₹${Number(item.target_1).toFixed(2)}` : '—'}</td>
                              <td className="py-2.5 px-1 text-emerald-400">{item.target_2 ? `₹${Number(item.target_2).toFixed(2)}` : '—'}</td>
                              <td className="py-2.5 px-1 text-rose-400">{item.stop_loss ? `₹${Number(item.stop_loss).toFixed(2)}` : '—'}</td>
                              <td className="py-2.5 px-1 text-center font-black">
                                <span className={`px-1 py-0.5 rounded ${
                                  ratingRes.total >= 80 ? 'bg-emerald-500/10 text-emerald-400' : ratingRes.total >= 65 ? 'bg-cyan-500/10 text-cyan-400' : 'bg-slate-500/10 text-slate-400'
                                }`}>
                                  {ratingRes.total}
                                </span>
                              </td>
                              {userProfile?.role === 'admin' && (
                                <td className="py-2.5 px-1 text-right">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleRemoveWatchlist(item.symbol);
                                    }}
                                    className="text-[8px] bg-rose-500/15 text-rose-400 hover:bg-rose-500/25 px-1 py-0.5 rounded cursor-pointer"
                                  >
                                    REMOVE
                                  </button>
                                </td>
                              )}
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Admin Add Form */}
                {userProfile?.role === 'admin' && (
                  <form onSubmit={handleAddWatchlist} className="bg-slate-900/30 p-4 border border-slate-850 rounded-xl space-y-3">
                    <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">ADD WATCHLIST ASSET TARGETS</h3>
                    <div className="grid grid-cols-3 gap-3">
                      <input
                        type="text"
                        placeholder="Symbol (e.g. INFOSYS)"
                        value={wlSymbol}
                        onChange={(e) => setWlSymbol(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded p-2 text-slate-200 focus:outline-none focus:border-amber-500 text-xs"
                      />
                      <input
                        type="text"
                        placeholder="Name (e.g. Infosys Ltd)"
                        value={wlName}
                        onChange={(e) => setWlName(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded p-2 text-slate-200 focus:outline-none focus:border-amber-500 text-xs"
                      />
                      <select
                        value={wlSector}
                        onChange={(e) => setWlSector(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded p-2 text-slate-400 focus:outline-none focus:border-amber-500 text-xs"
                      >
                        <option value="Energy">Energy</option>
                        <option value="Technology">Technology</option>
                        <option value="Finance">Finance</option>
                        <option value="Consumer">Consumer</option>
                        <option value="Healthcare">Healthcare</option>
                        <option value="Automobile">Automobile</option>
                      </select>
                      <input
                        type="number"
                        step="0.01"
                        placeholder="Price"
                        value={wlPrice}
                        onChange={(e) => setWlPrice(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded p-2 text-slate-200 focus:outline-none focus:border-amber-500 text-xs"
                      />
                      <input
                        type="number"
                        step="0.01"
                        placeholder="Target 1"
                        value={wlTarget1}
                        onChange={(e) => setWlTarget1(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded p-2 text-slate-200 focus:outline-none focus:border-amber-500 text-xs"
                      />
                      <input
                        type="number"
                        step="0.01"
                        placeholder="Target 2"
                        value={wlTarget2}
                        onChange={(e) => setWlTarget2(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded p-2 text-slate-200 focus:outline-none focus:border-amber-500 text-xs"
                      />
                      <input
                        type="number"
                        step="0.01"
                        placeholder="Stop Loss"
                        value={wlStopLoss}
                        onChange={(e) => setWlStopLoss(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded p-2 text-slate-200 focus:outline-none focus:border-amber-500 text-xs"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={wlSaving}
                      className="bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold px-4 py-2 rounded-lg transition-all active:scale-95 disabled:opacity-50 cursor-pointer text-xs"
                    >
                      {wlSaving ? 'ADDING...' : 'ADD ASSET TARGETS'}
                    </button>
                  </form>
                )}
              </div>
            )}

            {/* Sub-tab: Smart Picks */}
            {swingActiveTab === 'PICKS' && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="text"
                    placeholder="Search smart picks..."
                    value={picksSearch}
                    onChange={(e) => setPicksSearch(e.target.value)}
                    className="bg-slate-900 border border-slate-850 rounded px-2 py-1.5 focus:outline-none text-[11px] text-slate-200 focus:border-amber-500 w-full font-bold placeholder:text-slate-600"
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {swingWatchlist
                    .map(item => {
                      const comps = getComponentsForSymbol(item.symbol);
                      const ratingRes = compositeScore(comps.fund, comps.tech, comps.mom, comps.sent, comps.inst, item.price || 100, 100, swingWeights);
                      return { item, comps, ratingRes };
                    })
                    .filter(res => res.ratingRes.total >= 65 && res.item.symbol.includes(picksSearch.toUpperCase()))
                    .sort((a, b) => b.ratingRes.total - a.ratingRes.total)
                    .map(({ item, comps, ratingRes }) => {
                      const setup = calcTradeSetup(item.price || 100, {}, { atr: (item.price || 100) * 0.02 });
                      return (
                        <div key={item.id} className="border border-slate-850 bg-slate-900/10 p-4 rounded-xl space-y-3 hover:border-amber-500/25 transition-all">
                          <div className="flex justify-between items-start">
                            <div>
                              <span className="text-slate-100 font-bold text-sm block">{item.symbol}</span>
                              <span className="text-slate-500 text-[9px] font-bold uppercase">{item.name} | {item.sector}</span>
                            </div>
                            <span className={`px-2 py-0.5 rounded text-[9px] font-black ${
                              ratingRes.total >= 80 ? 'bg-emerald-500/15 text-emerald-400' : 'bg-cyan-500/15 text-cyan-400'
                            }`}>
                              {ratingRes.rating.toUpperCase()} ({ratingRes.total})
                            </span>
                          </div>

                          <div className="grid grid-cols-3 gap-2 bg-slate-950/40 p-2.5 border border-slate-850/50 rounded-lg text-[9px]">
                            <div>
                              <span className="text-slate-500 uppercase tracking-widest block mb-0.5">Stop Loss</span>
                              <span className="text-rose-400 font-bold font-mono">₹{setup.stopLoss}</span>
                            </div>
                            <div>
                              <span className="text-slate-500 uppercase tracking-widest block mb-0.5">Target 1</span>
                              <span className="text-emerald-400 font-bold font-mono">₹{setup.target1}</span>
                            </div>
                            <div>
                              <span className="text-slate-500 uppercase tracking-widest block mb-0.5">Risk/Reward</span>
                              <span className="text-slate-300 font-bold font-mono">{setup.riskReward}:1</span>
                            </div>
                          </div>

                          {userProfile?.role === 'admin' && (
                            <button
                              onClick={() => handleTriggerSignal(item, ratingRes)}
                              className="w-full bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold py-1.5 rounded-lg text-[10px] active:scale-95 transition-all cursor-pointer font-bold"
                            >
                              ⚡ TRIGGER ALGO TRADE SIGNAL
                            </button>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            {/* Sub-tab: Portfolio */}
            {swingActiveTab === 'PORTFOLIO' && (
              <div className="space-y-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-[10px]">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-500 uppercase tracking-widest text-[8px]">
                        <th className="py-2 px-1">Symbol</th>
                        <th className="py-2 px-1">Avg Price</th>
                        <th className="py-2 px-1">Quantity</th>
                        <th className="py-2 px-1">Invested Value</th>
                        <th className="py-2 px-1">Current Price</th>
                        <th className="py-2 px-1 text-right">P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {swingHoldings.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="text-center py-6 text-slate-500">
                            No holdings in portfolio. Add your mock or live trade details.
                          </td>
                        </tr>
                      ) : (
                        swingHoldings.map((hold) => {
                          const avg = Number(hold.average_buy_price);
                          const qty = Number(hold.quantity);
                          const current = livePrices[hold.symbol] || avg;
                          const invested = avg * qty;
                          const currentVal = current * qty;
                          const pnlVal = currentVal - invested;
                          return (
                            <tr key={hold.id} className="border-b border-slate-850 hover:bg-slate-900/20">
                              <td className="py-2.5 px-1 font-bold text-slate-200">{hold.symbol}</td>
                              <td className="py-2.5 px-1 text-slate-350">₹{avg.toFixed(2)}</td>
                              <td className="py-2.5 px-1 text-slate-350">{qty}</td>
                              <td className="py-2.5 px-1 text-slate-350">₹{invested.toFixed(2)}</td>
                              <td className="py-2.5 px-1 text-cyan-400 font-bold">₹{current.toFixed(2)}</td>
                              <td className={`py-2.5 px-1 text-right font-black ${pnlVal >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {pnlVal >= 0 ? '+' : ''}₹{pnlVal.toFixed(2)}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                <form onSubmit={handleAddHolding} className="bg-slate-900/30 p-4 border border-slate-850 rounded-xl space-y-3">
                  <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">RECORD / UPDATE CUSTOM HOLDING</h3>
                  <div className="grid grid-cols-3 gap-3">
                    <input
                      type="text"
                      placeholder="Symbol (e.g. RELIANCE.NS)"
                      value={newHoldingSymbol}
                      onChange={(e) => setNewHoldingSymbol(e.target.value)}
                      className="bg-slate-950 border border-slate-800 rounded p-2 text-slate-200 focus:outline-none focus:border-amber-500 text-xs"
                    />
                    <input
                      type="number"
                      step="0.01"
                      placeholder="Average Buy Price"
                      value={newHoldingPrice}
                      onChange={(e) => setNewHoldingPrice(e.target.value)}
                      className="bg-slate-950 border border-slate-800 rounded p-2 text-slate-200 focus:outline-none focus:border-amber-500 text-xs"
                    />
                    <input
                      type="number"
                      placeholder="Quantity"
                      value={newHoldingQty}
                      onChange={(e) => setNewHoldingQty(e.target.value)}
                      className="bg-slate-950 border border-slate-800 rounded p-2 text-slate-200 focus:outline-none focus:border-amber-500 text-xs"
                    />
                  </div>
                  <button
                    type="submit"
                    className="bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold px-4 py-2 rounded-lg transition-all active:scale-95 cursor-pointer text-xs"
                  >
                    SYNC HOLDING
                  </button>
                </form>
              </div>
            )}

            {/* Sub-tab: Screener */}
            {swingActiveTab === 'SCREENER' && (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3 bg-slate-900/40 p-3.5 border border-slate-850 rounded-xl">
                  <div>
                    <label className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block mb-1">Sector</label>
                    <select
                      value={screenSector}
                      onChange={(e) => setScreenSector(e.target.value)}
                      className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 focus:outline-none text-[11px] text-slate-400 focus:border-amber-500 w-full"
                    >
                      <option value="ALL">ALL SECTORS</option>
                      <option value="Energy">Energy</option>
                      <option value="Technology">Technology</option>
                      <option value="Finance">Finance</option>
                      <option value="Consumer">Consumer</option>
                      <option value="Healthcare">Healthcare</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block mb-1">Market Cap</label>
                    <select
                      value={screenCap}
                      onChange={(e) => setScreenCap(e.target.value)}
                      className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 focus:outline-none text-[11px] text-slate-400 focus:border-amber-500 w-full"
                    >
                      <option value="ALL">ALL CAP CLASSIFICATIONS</option>
                      <option value="LARGE CAP">LARGE CAP</option>
                      <option value="MID CAP">MID CAP</option>
                      <option value="SMALL CAP">SMALL CAP</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block mb-1">Algo Rating</label>
                    <select
                      value={screenRating}
                      onChange={(e) => setScreenRating(e.target.value)}
                      className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 focus:outline-none text-[11px] text-slate-400 focus:border-amber-500 w-full"
                    >
                      <option value="ALL">ALL RATINGS</option>
                      <option value="STRONG-BUY">STRONG BUY</option>
                      <option value="BUY">BUY</option>
                      <option value="WATCH">WATCH</option>
                      <option value="AVOID">AVOID</option>
                    </select>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-[10px]">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-500 uppercase tracking-widest text-[8px]">
                        <th className="py-2 px-1">Symbol</th>
                        <th className="py-2 px-1">Sector</th>
                        <th className="py-2 px-1">Market Cap Class</th>
                        <th className="py-2 px-1">Current Price</th>
                        <th className="py-2 px-1 text-center">Score</th>
                        <th className="py-2 px-1 text-right">Rating</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredScreener.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="text-center py-6 text-slate-500">
                            No assets match the current screening parameters.
                          </td>
                        </tr>
                      ) : (
                        filteredScreener.map((item) => {
                          const comps = getComponentsForSymbol(item.symbol);
                          const ratingRes = compositeScore(comps.fund, comps.tech, comps.mom, comps.sent, comps.inst, item.price || 100, 100, swingWeights);
                          let cap = 'Large Cap';
                          if (item.symbol.charCodeAt(0) % 3 === 1) cap = 'Mid Cap';
                          else if (item.symbol.charCodeAt(0) % 3 === 2) cap = 'Small Cap';
                          return (
                            <tr key={item.id} className="border-b border-slate-850 hover:bg-slate-900/20">
                              <td className="py-2.5 px-1 font-bold text-slate-200">{item.symbol}</td>
                              <td className="py-2.5 px-1 text-slate-400">{item.sector}</td>
                              <td className="py-2.5 px-1 text-slate-400">{cap}</td>
                              <td className="py-2.5 px-1 text-slate-300">₹{item.price ? Number(item.price).toFixed(2) : '—'}</td>
                              <td className="py-2.5 px-1 text-center font-bold text-cyan-400">{ratingRes.total}</td>
                              <td className="py-2.5 px-1 text-right font-black">
                                <span className={`text-[9px] ${
                                  ratingRes.total >= 80 ? 'text-emerald-400' : ratingRes.total >= 65 ? 'text-cyan-400' : 'text-slate-500'
                                }`}>
                                  {ratingRes.rating.toUpperCase()}
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
            )}

            {/* Sub-tab: Backtester */}
            {swingActiveTab === 'BACKTESTER' && (
              <div className="space-y-4">
                <div className="bg-slate-900/40 p-4 border border-slate-850 rounded-xl space-y-4 font-mono text-[11px]">
                  <div className="border-b border-slate-800 pb-2 flex justify-between">
                    <span className="font-bold text-slate-300">Run Strategy Simulation: {selectedSwingSymbol}</span>
                    <span className="text-[10px] text-slate-500">Historical yfinance analysis</span>
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block mb-1">Score Entry Cutoff</label>
                      <input
                        type="number"
                        min="50"
                        max="95"
                        value={btThreshold}
                        onChange={(e) => setBtThreshold(parseInt(e.target.value))}
                        className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 focus:outline-none text-[11px] text-slate-200 focus:border-amber-500 w-full"
                      />
                    </div>
                    <div>
                      <label className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block mb-1">Holding Period (days)</label>
                      <input
                        type="number"
                        min="5"
                        max="90"
                        value={btHoldingPeriod}
                        onChange={(e) => setBtHoldingPeriod(parseInt(e.target.value))}
                        className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 focus:outline-none text-[11px] text-slate-200 focus:border-amber-500 w-full"
                      />
                    </div>
                    <div>
                      <label className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block mb-1">Lookback (days)</label>
                      <input
                        type="number"
                        min="30"
                        max="730"
                        value={btLookback}
                        onChange={(e) => setBtLookback(parseInt(e.target.value))}
                        className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 focus:outline-none text-[11px] text-slate-200 focus:border-amber-500 w-full"
                      />
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={runSwingBacktest}
                    disabled={btLoading || !selectedSwingSymbol}
                    className="w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-slate-950 font-black py-2.5 rounded-lg active:scale-95 transition-all shadow-md cursor-pointer"
                  >
                    {btLoading ? 'COMPILING CANDLE DATA & RUNNING SIMULATION...' : 'RUN BACKTEST SIMULATION'}
                  </button>
                </div>

                {btResults && (
                  <div className="bg-slate-950/80 p-4 border border-slate-850 rounded-xl space-y-4 font-mono animate-fadeIn text-[11px]">
                    <div className="border-b border-slate-850 pb-2 flex justify-between items-center">
                      <span className="font-bold text-slate-200">Backtest Report: {btResults.symbol}</span>
                      <span className="text-[9px] text-emerald-400 font-bold border border-emerald-500/20 bg-emerald-500/5 px-2 py-0.5 rounded">COMPLETED</span>
                    </div>

                    <div className="grid grid-cols-4 gap-3 text-center">
                      <div className="bg-slate-900/40 p-2.5 border border-slate-850 rounded-lg">
                        <span className="text-[8px] text-slate-500 block mb-1">WIN RATE</span>
                        <span className="text-base font-black text-emerald-400">{btResults.winRate}%</span>
                      </div>
                      <div className="bg-slate-900/40 p-2.5 border border-slate-850 rounded-lg">
                        <span className="text-[8px] text-slate-500 block mb-1">TOTAL SIGNALS</span>
                        <span className="text-base font-black text-slate-200">{btResults.totalTrades}</span>
                      </div>
                      <div className="bg-slate-900/40 p-2.5 border border-slate-850 rounded-lg">
                        <span className="text-[8px] text-slate-500 block mb-1">AVG RETURN</span>
                        <span className="text-base font-black text-cyan-400">+{btResults.avgReturn}%</span>
                      </div>
                      <div className="bg-slate-900/40 p-2.5 border border-slate-850 rounded-lg">
                        <span className="text-[8px] text-slate-500 block mb-1">ALPHA VS NIFTY</span>
                        <span className={`text-base font-black ${btResults.alpha >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {btResults.alpha >= 0 ? '+' : ''}{btResults.alpha}%
                        </span>
                      </div>
                    </div>

                    {/* Historical Backtester Logs */}
                    <div className="border-t border-slate-850 pt-3">
                      <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block mb-2">Simulated Signal Logs</span>
                      <div className="overflow-y-auto max-h-40 overflow-x-auto text-[10px]">
                        <table className="w-full text-left border-collapse">
                          <thead>
                            <tr className="border-b border-slate-800 text-slate-500 uppercase tracking-widest text-[8px]">
                              <th className="py-1.5 px-1">Entry Date</th>
                              <th className="py-1.5 px-1">Entry Price</th>
                              <th className="py-1.5 px-1">Exit Date</th>
                              <th className="py-1.5 px-1">Exit Price</th>
                              <th className="py-1.5 px-1">Exit Reason</th>
                              <th className="py-1.5 px-1 text-right">Return</th>
                            </tr>
                          </thead>
                          <tbody>
                            {btResults.trades.map((t: any, idx: number) => (
                              <tr key={idx} className="border-b border-slate-850 hover:bg-slate-900/20">
                                <td className="py-2 px-1 text-slate-350">{t.entryDate}</td>
                                <td className="py-2 px-1 text-slate-300">₹{t.entryPrice.toFixed(2)}</td>
                                <td className="py-2 px-1 text-slate-350">{t.exitDate}</td>
                                <td className="py-2 px-1 text-slate-300">₹{t.exitPrice.toFixed(2)}</td>
                                <td className="py-2 px-1 text-slate-400">{t.reason}</td>
                                <td className={`py-2 px-1 text-right font-black ${t.returnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                  {t.returnPct >= 0 ? '+' : ''}{t.returnPct.toFixed(2)}%
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Sub-tab: Performance Reports */}
            {swingActiveTab === 'PERFORMANCE' && (
              <div className="space-y-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-[10px]">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-500 uppercase tracking-widest text-[8px]">
                        <th className="py-2 px-1">Asset Symbol</th>
                        <th className="py-2 px-1">Win Rate</th>
                        <th className="py-2 px-1">Avg return</th>
                        <th className="py-2 px-1">Total Trades</th>
                        <th className="py-2 px-1">Alpha</th>
                        <th className="py-2 px-1">Benchmark</th>
                        <th className="py-2 px-1">Run Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {swingPerformance.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="text-center py-6 text-slate-500">
                            No performance reports generated yet. Run a strategy simulation to generate a report.
                          </td>
                        </tr>
                      ) : (
                        swingPerformance.map((rep) => (
                          <tr key={rep.id} className="border-b border-slate-850 hover:bg-slate-900/20">
                            <td className="py-2.5 px-1 font-bold text-slate-200">{rep.symbol}</td>
                            <td className="py-2.5 px-1 text-emerald-400 font-bold">{rep.win_rate}%</td>
                            <td className="py-2.5 px-1 text-cyan-400">+{rep.avg_return}%</td>
                            <td className="py-2.5 px-1 text-slate-350">{rep.total_trades}</td>
                            <td className={`py-2.5 px-1 font-bold ${rep.alpha >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{rep.alpha >= 0 ? '+' : ''}{rep.alpha}%</td>
                            <td className="py-2.5 px-1 text-slate-350">{rep.benchmark_return}%</td>
                            <td className="py-2.5 px-1 text-slate-500">{new Date(rep.created_at).toLocaleDateString()}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    );
  };

  const runSwingBacktest = async () => {
    if (!selectedSwingSymbol) return;
    setBtLoading(true);
    setBtResults(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/chart-data?ticker=${selectedSwingSymbol}&resolution=1d`);
      if (!res.ok) {
        throw new Error("Failed to fetch daily candles for backtester");
      }
      const data = await res.json();
      if (!data || !data.candles || data.candles.length < 50) {
        throw new Error("Insufficient historical data for backtesting");
      }

      const candles: CandleData[] = data.candles.map((c: any) => ({
        time: typeof c.time === 'number' ? c.time : new Date(c.time).getTime() / 1000,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      }));

      const closes = candles.map(c => c.close);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);

      const rsi = calcRSI(closes, 14);
      const ema50 = calcEMA(closes, 50);
      const ema200 = calcEMA(closes, 200);
      const macd = calcMACD(closes);
      const atr = calcATR(highs, lows, closes, 14);

      let tradesList: any[] = [];
      let totalPnl = 0;
      let wins = 0;
      let losses = 0;

      // Simulate trading loop
      for (let i = 50; i < candles.length - btHoldingPeriod; i++) {
        const price = closes[i];
        const currentRsi = rsi[i] || 50;
        const currentEma50 = ema50[i];
        const currentEma200 = ema200[i];
        const currentAtr = atr[i] || price * 0.02;

        // Formulate scoring components
        const fundScore = 18; // base fundamental score
        const setupScore = currentEma50 && price > currentEma50 ? 15 : 5;
        const momScore = currentRsi > 50 ? 15 : 5;
        const sentScore = 10;
        const instScore = 12;

        const scoreRes = compositeScore(fundScore, setupScore, momScore, sentScore, instScore, price, currentEma200, swingWeights);
        
        if (scoreRes.total >= btThreshold) {
          // Trigger entry
          const entryPrice = price;
          const sl = entryPrice - 1.5 * currentAtr;
          const tp = entryPrice + 3.0 * currentAtr;

          let exitPrice = closes[i + btHoldingPeriod];
          let exitDay = i + btHoldingPeriod;
          let exitReason = 'HOLDING_PERIOD';

          // Check if SL or TP hit during holding period
          for (let j = i + 1; j <= i + btHoldingPeriod; j++) {
            if (candles[j].low <= sl) {
              exitPrice = sl;
              exitDay = j;
              exitReason = 'STOP_LOSS';
              break;
            }
            if (candles[j].high >= tp) {
              exitPrice = tp;
              exitDay = j;
              exitReason = 'TAKE_PROFIT';
              break;
            }
          }

          const ret = ((exitPrice - entryPrice) / entryPrice) * 100;
          tradesList.push({
            entryDate: new Date(candles[i].time * 1000).toLocaleDateString(),
            entryPrice,
            exitDate: new Date(candles[exitDay].time * 1000).toLocaleDateString(),
            exitPrice,
            returnPct: ret,
            reason: exitReason
          });

          if (ret > 0) wins++;
          else losses++;

          totalPnl += ret;

          // Skip past the holding period to avoid overlapping trades of same symbol
          i = exitDay;
        }
      }

      const totalTrades = tradesList.length;
      const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
      const avgReturn = totalTrades > 0 ? totalPnl / totalTrades : 0;
      
      // Calculate Benchmark Return
      const startPrice = closes[0];
      const endPrice = closes[closes.length - 1];
      const benchmarkReturn = ((endPrice - startPrice) / startPrice) * 100;
      const alpha = avgReturn - (benchmarkReturn / (totalTrades || 1));

      const results = {
        symbol: selectedSwingSymbol,
        winRate: parseFloat(winRate.toFixed(2)),
        avgReturn: parseFloat(avgReturn.toFixed(2)),
        totalTrades,
        alpha: parseFloat(alpha.toFixed(2)),
        benchmarkReturn: parseFloat(benchmarkReturn.toFixed(2)),
        trades: tradesList
      };

      setBtResults(results);

      // Save performance report to DB
      const headers = await getAuthHeaders();
      await fetch(`${BACKEND_URL}/api/swing/performance/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          symbol: selectedSwingSymbol,
          win_rate: results.winRate,
          avg_return: results.avgReturn,
          total_trades: results.totalTrades,
          alpha: results.alpha,
          benchmark_return: results.benchmarkReturn,
          parameters: `Threshold: ${btThreshold} | Holding: ${btHoldingPeriod}d | Lookback: ${btLookback}d`
        })
      });

      // Reload performance records
      loadSwingData();
    } catch (err: any) {
      console.error(err);
      alert(err.message || "Failed running backtest.");
    } finally {
      setBtLoading(false);
    }
  };

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
          {/* Market Environment Toggle */}
          <div className="flex items-center gap-1 border border-slate-800 bg-[#070b15] p-1 rounded-xl">
            <button
              onClick={() => setMarketEnv('INDIAN')}
              className={`px-3 py-1 rounded-lg text-[10px] font-bold tracking-wider transition-all cursor-pointer ${
                marketEnv === 'INDIAN'
                  ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 shadow-lg shadow-cyan-950/20'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              INDIAN
            </button>
            <button
              onClick={() => setMarketEnv('FOREX')}
              className={`px-3 py-1 rounded-lg text-[10px] font-bold tracking-wider transition-all cursor-pointer ${
                marketEnv === 'FOREX'
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 shadow-lg shadow-emerald-950/20'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              FOREX
            </button>
            <button
              onClick={() => setMarketEnv('SWING')}
              className={`px-3 py-1 rounded-lg text-[10px] font-bold tracking-wider transition-all cursor-pointer ${
                marketEnv === 'SWING'
                  ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30 shadow-lg shadow-amber-950/20'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              SWING
            </button>
          </div>

          {/* SaaS Token Display for normal users / Upgrade Request button */}
          {userProfile && (
            <div className="flex items-center gap-1.5 border border-slate-800 bg-[#070b15] px-3 py-1.5 rounded-xl text-[10px] font-mono">
              <span className="text-slate-500">TOKENS:</span>
              <span className="text-cyan-400 font-bold">
                {userProfile.subscription_status === 'active' || userProfile.role === 'admin' ? 'UNLIMITED' : `${userProfile.token_balance} FREE`}
              </span>
              {userProfile.subscription_status === 'free' && (
                <button
                  onClick={async () => {
                    try {
                      const headers = await getAuthHeaders();
                      const res = await fetch(`${BACKEND_URL}/api/subscription/request`, {
                        method: 'POST',
                        headers
                      });
                      if (res.ok) {
                        alert("Subscription request sent to admin email successfully!");
                        const profileRes = await supabase.from('user_profiles').select('*').eq('id', user.id).single();
                        if (profileRes.data) setUserProfile(profileRes.data);
                      } else {
                        alert("Failed to request subscription.");
                      }
                    } catch (err) {
                      console.error(err);
                    }
                  }}
                  className="ml-1.5 border border-cyan-500/30 bg-cyan-500/5 hover:bg-cyan-500/15 text-cyan-300 px-2 py-0.5 rounded text-[8px] font-bold cursor-pointer"
                >
                  UPGRADE
                </button>
              )}
              {userProfile.subscription_status === 'pending_approval' && (
                <span className="ml-1.5 text-[8px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1 py-0.5 rounded font-black animate-pulse">PENDING</span>
              )}
            </div>
          )}

          {/* Admin Panel button (only for jitheeshjames27@gmail.com) */}
          {user?.email === 'jitheeshjames27@gmail.com' && (
            <button
              onClick={() => {
                setIsAdminModalOpen(true);
                loadAdminInsights();
              }}
              className="flex items-center gap-1.5 border border-purple-500/30 bg-purple-500/8 hover:bg-purple-500/15 text-purple-400 hover:text-purple-300 px-3 py-1.5 rounded-xl text-[10px] font-mono font-bold tracking-wider transition-all cursor-pointer"
            >
              🛡️ ADMIN CONTROL
            </button>
          )}

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

          {/* Excel Download Button */}
          <button
            id="download-excel-btn"
            onClick={downloadExcel}
            title="Download Monthly Trade Report (Excel)"
            className="flex items-center gap-1.5 border border-emerald-500/30 bg-emerald-500/8 hover:bg-emerald-500/15 text-emerald-400 hover:text-emerald-300 px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold tracking-wider transition-all cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            EXPORT
          </button>

          {/* Global Kill Switch Button */}
          <button
            onClick={triggerKillAll}
            title="EMERGENCY EXIT: Close All Positions"
            className="flex items-center gap-1.5 border border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold tracking-wider transition-all cursor-pointer animate-pulse"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            KILL SWITCH
          </button>

          {/* User Avatar + Sign Out */}
          {user && (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 border border-slate-800 bg-slate-900/40 px-2 py-1 rounded-lg">
                {user.user_metadata?.avatar_url ? (
                  <img src={user.user_metadata.avatar_url} alt="avatar" className="h-5 w-5 rounded-full object-cover" />
                ) : (
                  <div className="h-5 w-5 rounded-full bg-gradient-to-tr from-cyan-600 to-indigo-700 flex items-center justify-center text-[9px] font-black text-white">
                    {(user.email || 'U')[0].toUpperCase()}
                  </div>
                )}
                <span className="text-[9px] text-slate-400 font-mono max-w-[80px] truncate hidden sm:block">
                  {user.user_metadata?.full_name || user.email?.split('@')[0] || 'User'}
                </span>
              </div>
              <button
                id="sign-out-btn"
                onClick={() => supabase.auth.signOut()}
                className="border border-slate-700 hover:border-rose-500/40 text-slate-500 hover:text-rose-400 px-2 py-1 rounded-lg text-[9px] font-mono font-bold tracking-wider transition-all cursor-pointer"
                title="Sign Out"
              >
                SIGN OUT
              </button>
            </div>
          )}
        </div>
      </header>

      {/* 2. Top-Line Metrics Grid */}
      <section className="grid grid-cols-2 lg:grid-cols-7 gap-3 mb-6">
        {/* Net Equity */}
        <div className="relative border border-slate-800 bg-[#070b15]/80 rounded-2xl p-4 shadow-xl">
          <span className="text-slate-500 font-mono text-[9px] uppercase tracking-wider block mb-1">Net Equity</span>
          <span className="text-xl md:text-2xl font-black text-slate-100 font-mono">
            {formatCurrency(metrics.account_capital, marketEnv)}
          </span>
          <div className="text-[10px] text-slate-500 mt-1 font-mono">
            Base: {formatCurrency(startingCapital, marketEnv)}
          </div>
        </div>

        {/* Overall Account P&L */}
        <div className="relative border border-slate-800 bg-[#070b15]/80 rounded-2xl p-4 shadow-xl">
          <span className="text-slate-500 font-mono text-[9px] uppercase tracking-wider block mb-1">Overall P&L</span>
          <span className={`text-xl md:text-2xl font-black font-mono ${metrics.account_capital - startingCapital >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {metrics.account_capital - startingCapital >= 0 ? "+" : ""}
            {formatCurrency(metrics.account_capital - startingCapital, marketEnv)}
          </span>
          <div className="text-[10px] text-slate-500 mt-1 font-mono">Realized + Float PnL</div>
        </div>

        {/* Today's Realized P&L */}
        <div className="relative border border-slate-800 bg-[#070b15]/80 rounded-2xl p-4 shadow-xl">
          <span className="text-slate-500 font-mono text-[9px] uppercase tracking-wider block mb-1">Today's P&L</span>
          <span className={`text-xl md:text-2xl font-black font-mono ${Number(metrics.daily_realized_pnl) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {Number(metrics.daily_realized_pnl) >= 0 ? "+" : ""}
            {formatCurrency(Number(metrics.daily_realized_pnl), marketEnv)}
          </span>
          <div className="text-[10px] text-slate-500 mt-1 font-mono">Today's Net Return</div>
        </div>

        {/* Unrealized P&L */}
        <div className="relative border border-slate-800 bg-[#070b15]/80 rounded-2xl p-4 shadow-xl">
          <div className="absolute top-3 right-3">
            <span className="text-[9px] font-bold font-mono px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/25 animate-pulse">LIVE</span>
          </div>
          <span className="text-slate-500 font-mono text-[9px] uppercase tracking-wider block mb-1">Unrealized P&L</span>
          <span className={`text-xl md:text-2xl font-black font-mono ${portfolioUnrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {portfolioUnrealizedPnl >= 0 ? "+" : ""}
            {formatCurrency(portfolioUnrealizedPnl, marketEnv)}
          </span>
          <div className="text-[10px] text-slate-500 mt-1 font-mono">Active position float</div>
        </div>

        {/* Today's Trades — split card */}
        <div className={`relative border rounded-2xl p-4 shadow-xl ${
          dailyLimitReached ? 'border-amber-500/40 bg-amber-500/5' : 'border-slate-800 bg-[#070b15]/80'
        }`}>
          {dailyLimitReached && (
            <div className="absolute top-2 right-2">
              <span className="text-[8px] font-bold font-mono px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/25 animate-pulse">LIMIT</span>
            </div>
          )}
          <span className="text-slate-500 font-mono text-[9px] uppercase tracking-wider block mb-1">Today's Trades</span>
          <span className={`text-xl md:text-2xl font-black font-mono ${dailyLimitReached ? 'text-amber-400' : 'text-slate-100'}`}>
            {todayTradeCount}
          </span>
          <div className="text-[10px] mt-1 font-mono flex items-center justify-between">
            <span className="text-slate-500">/ 2 daily limit</span>
            <span className={`font-semibold ${dailyLimitReached ? 'text-amber-400' : 'text-emerald-400'}`}>
              {dailyLimitReached ? 'MAXED' : 'OK'}
            </span>
          </div>
        </div>

        {/* Total Trades (all-time) */}
        <div className="relative border border-slate-800 bg-[#070b15]/80 rounded-2xl p-4 shadow-xl">
          <span className="text-slate-500 font-mono text-[9px] uppercase tracking-wider block mb-1">Total Trades</span>
          <span className="text-xl md:text-2xl font-black text-slate-100 font-mono">
            {trades.length}
          </span>
          <div className="text-[10px] text-slate-500 mt-1 font-mono flex items-center justify-between">
            <span>All-Time Count</span>
            <span className="text-cyan-400 font-semibold">{portfolioWinRate}% Win</span>
          </div>
        </div>

        {/* Market Exposure */}
        <div className="relative border border-slate-800 bg-[#070b15]/80 rounded-2xl p-4 shadow-xl">
          <span className="text-slate-500 font-mono text-[9px] uppercase tracking-wider block mb-1">Exposure</span>
          <span className="text-xl md:text-2xl font-black text-slate-100 font-mono">
            {activeTrades.length}
          </span>
          <div className="text-[10px] mt-1 font-mono flex items-center justify-between">
            <span className="text-slate-500">Active</span>
            <span className={metrics.safety_state === 'SAFE' ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-black animate-pulse'}>
              {metrics.safety_state}
            </span>
          </div>
        </div>
      </section>

      {/* Daily Limit Reached Banner */}
      {dailyLimitReached && !bannersDismissed['dailyLimit'] && (
        <div className="border border-amber-400/30 bg-amber-500/5 backdrop-blur-md rounded-2xl p-4 mb-4 flex items-center justify-between shadow-lg">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-amber-500/20 border border-amber-400/30 text-lg animate-pulse">🚫</div>
            <div>
              <div className="text-sm font-black text-amber-300 tracking-wider">
                DAILY TRADE LIMIT REACHED — {todayTradeCount}/2 TRADES EXECUTED
              </div>
              <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                Maximum 2 trades per session. Engine will not place further orders today.
              </div>
            </div>
          </div>
          <button
            onClick={() => setBannersDismissed(p => ({ ...p, dailyLimit: true }))}
            className="ml-4 text-slate-500 hover:text-slate-300 text-xs font-mono px-2 py-1 rounded border border-slate-700 hover:border-slate-500 transition-colors cursor-pointer"
          >DISMISS</button>
        </div>
      )}

      {/* Daily Loss Risk Banner */}
      {dailyLossRisk && !bannersDismissed['dailyLoss'] && (
        <div className="border border-rose-500/30 bg-rose-500/5 backdrop-blur-md rounded-2xl p-4 mb-4 flex items-center justify-between shadow-lg">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-rose-500/20 border border-rose-500/30 text-lg animate-pulse">🔴</div>
            <div>
              <div className="text-sm font-black text-rose-400 tracking-wider animate-pulse">
                ⚡ DAILY LOSS RISK THRESHOLD HIT — {formatCurrency(metrics.daily_realized_pnl, marketEnv)} TODAY
              </div>
              <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                Loss limit: {marketEnv === 'FOREX' ? '$5,000' : '₹2,000'}. Review and consider pausing trading.
              </div>
            </div>
          </div>
          <button
            onClick={() => setBannersDismissed(p => ({ ...p, dailyLoss: true }))}
            className="ml-4 text-slate-500 hover:text-slate-300 text-xs font-mono px-2 py-1 rounded border border-slate-700 hover:border-slate-500 transition-colors cursor-pointer"
          >DISMISS</button>
        </div>
      )}

      {/* Cross-Asset Position Warning Banner */}
      {otherOpenPosition && (
        <div className="border border-amber-500/20 bg-amber-500/5 backdrop-blur-md rounded-2xl p-4 mb-4 flex flex-col md:flex-row items-center justify-between shadow-lg shadow-amber-950/15">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-amber-500/15 border border-amber-500/20 text-amber-400 font-bold">
              ⚠️
            </div>
            <div>
              <div className="text-xs font-bold text-slate-200">
                ACTIVE POSITION RUNNING ON {otherOpenPosition.symbol.toUpperCase()}
              </div>
              <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                Direction: <span className={otherOpenPosition.direction === 'BUY' ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>{otherOpenPosition.direction}</span> | 
                Entry: {formatPrice(Number(otherOpenPosition.entry_price), marketEnv)} | 
                Qty: {otherOpenPosition.quantity}
              </div>
            </div>
          </div>
          <button
            onClick={() => {
              const match = (marketEnv === 'FOREX' ? FOREX_ASSETS : INDIAN_ASSETS).find(a => isAssetMatch(a.value, otherOpenPosition.symbol));
              if (match) {
                setSelectedAsset(match.value);
                setSelectedAssetLabel(match.label);
              } else {
                setSelectedAsset(otherOpenPosition.symbol);
                setSelectedAssetLabel(otherOpenPosition.symbol);
              }
            }}
            className="mt-3 md:mt-0 px-4 py-1.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/35 text-amber-300 text-xs font-mono font-bold tracking-wider transition-all cursor-pointer"
          >
            SWITCH TO {otherOpenPosition.symbol.toUpperCase()}
          </button>
        </div>
      )}

      {/* 3. Split Screen Brokerage Layout */}
      {marketEnv === 'SWING' ? (
        isTokenExpired ? (
          <PremiumUpgradeBlocker feature="Swing Trading Dashboard" onRequestUpgrade={requestPremiumUpgrade} />
        ) : (
          <SwingTradingDashboard />
        )
      ) : (
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

            {/* Selected Asset Stats Info Bar (SEBI Compliant Info) */}
            {activeChartTab === 'PRICE' && (
              <div className="flex flex-wrap items-center justify-between gap-4 bg-slate-950/40 p-3 rounded-xl border border-slate-850/60 mb-4 font-mono text-[10px] text-slate-400 animate-fadeIn">
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-500 uppercase tracking-wider">Asset Focus:</span>
                  <span className="text-cyan-400 font-bold">{selectedAssetLabel} ({selectedAsset})</span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-slate-500">STD LOT / SEBI SIZE: <span className="text-slate-200 font-bold">{getStandardLotSize(selectedAsset, marketEnv)}</span></span>
                  <span className="text-slate-800">|</span>
                  <span className="text-slate-500">TODAY P&L: <span className={`${assetTodayPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'} font-bold`}>{assetTodayPnl >= 0 ? '+' : ''}{formatCurrency(assetTodayPnl, marketEnv)}</span></span>
                  <span className="text-slate-800">|</span>
                  <span className="text-slate-500">OVERALL P&L: <span className={`${assetOverallPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'} font-bold`}>{assetOverallPnl >= 0 ? '+' : ''}{formatCurrency(assetOverallPnl, marketEnv)}</span></span>
                </div>
              </div>
            )}

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
                  <div className="flex items-center justify-between border-b border-slate-800/80 pb-2 mb-2 font-mono">
                    <h3 className="text-slate-400 font-bold tracking-wider text-[11px] uppercase">
                      Key Performance Metrics
                    </h3>
                    <button
                      onClick={downloadPerformanceMetricsExcel}
                      className="flex items-center gap-1 border border-emerald-500/30 bg-emerald-500/8 hover:bg-emerald-500/15 text-emerald-400 hover:text-emerald-300 px-2 py-1 rounded text-[9px] font-bold transition-all cursor-pointer"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      EXPORT
                    </button>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-850">
                      <span className="text-slate-500 text-[9px] uppercase tracking-wider block mb-1">Profit Factor</span>
                      <span className="text-lg font-black text-cyan-400">
                        {calculateProfitFactor(filteredTrades).toFixed(2)}
                      </span>
                    </div>
                    
                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-850">
                      <span className="text-slate-500 text-[9px] uppercase tracking-wider block mb-1">Win Ratio</span>
                      <span className="text-lg font-black text-emerald-400">
                        {filteredWinRate}%
                      </span>
                    </div>

                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-850">
                      <span className="text-slate-500 text-[9px] uppercase tracking-wider block mb-1">Sharpe Ratio</span>
                      <span className="text-lg font-black text-amber-400">
                        {calculateSharpeRatio(filteredTrades).toFixed(2)}
                      </span>
                    </div>

                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-850">
                      <span className="text-slate-500 text-[9px] uppercase tracking-wider block mb-1">Max Drawdown</span>
                      <span className="text-lg font-black text-rose-400">
                        {calculateMaxDrawdown(filteredTrades).toFixed(1)}%
                      </span>
                    </div>

                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-850">
                      <span className="text-slate-500 text-[9px] uppercase tracking-wider block mb-1">Avg Win</span>
                      <span className="text-xs font-bold text-emerald-400">
                        {formatCurrencyCompact(calculateAvgWinLoss(filteredTrades).avgWin, marketEnv)}
                      </span>
                    </div>

                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-850">
                      <span className="text-slate-500 text-[9px] uppercase tracking-wider block mb-1">Avg Loss</span>
                      <span className="text-xs font-bold text-rose-400">
                        {formatCurrencyCompact(calculateAvgWinLoss(filteredTrades).avgLoss, marketEnv)}
                      </span>
                    </div>
                  </div>

                  <div className="bg-slate-900/40 p-4 rounded-xl border border-slate-850/60 mt-2">
                    <div className="flex justify-between mb-2">
                      <span className="text-slate-400 uppercase tracking-widest text-[9px]">Winning Trades</span>
                      <span className="text-emerald-400 font-bold">
                        {filteredTrades.filter(t => t.status === 'CLOSED' && computePnl(t as Trade) > 0).length}
                      </span>
                    </div>
                    <div className="flex justify-between mb-2">
                      <span className="text-slate-400 uppercase tracking-widest text-[9px]">Losing Trades</span>
                      <span className="text-rose-400 font-bold">
                        {filteredTrades.filter(t => t.status === 'CLOSED' && computePnl(t as Trade) <= 0).length}
                      </span>
                    </div>
                    <div className="flex justify-between border-t border-slate-800 pt-2">
                      <span className="text-slate-400 uppercase tracking-widest text-[9px]">Total Completed</span>
                      <span className="text-slate-200 font-bold">
                        {filteredClosed.length}
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
                        <span className={`text-sm font-black ${calculatePeriodReturn(filteredTrades, 'weekly') >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {formatCurrencyCompact(calculatePeriodReturn(filteredTrades, 'weekly'), marketEnv)}
                        </span>
                      </div>
                      <div className="bg-slate-900/30 p-3 rounded-lg border border-slate-850">
                        <span className="text-slate-500 text-[8px] uppercase tracking-wider block mb-1">Monthly Return</span>
                        <span className={`text-sm font-black ${calculatePeriodReturn(filteredTrades, 'monthly') >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {formatCurrencyCompact(calculatePeriodReturn(filteredTrades, 'monthly'), marketEnv)}
                        </span>
                      </div>
                      <div className="bg-slate-900/30 p-3 rounded-lg border border-slate-850">
                        <span className="text-slate-500 text-[8px] uppercase tracking-wider block mb-1">All-Time Net PnL</span>
                        <span className={`text-sm font-black ${filteredRealizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {formatCurrencyCompact(filteredRealizedPnl, marketEnv)}
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
                          {calculateDailyBreakdown(filteredTrades).map((day, idx) => (
                            <tr key={idx} className="border-b border-slate-850/50 hover:bg-slate-900/20">
                              <td className="py-2 px-1 text-slate-300 font-bold">{day.date}</td>
                              <td className="py-2 px-1 text-slate-400 text-center font-bold">{day.count}</td>
                              <td className="py-2 px-1 text-emerald-500 text-center font-bold">{day.wins}</td>
                              <td className="py-2 px-1 text-slate-300 text-center">{day.winRate}%</td>
                              <td className={`py-2 px-1 text-right font-black ${day.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {day.pnl >= 0 ? '+' : ''}{formatCurrency(day.pnl, marketEnv)}
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

            {activeTrades.length === 0 ? (
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
                    {activeTrades.map((op) => {
                      const entry = Number(op.entry_price);
                      // Use alias-aware getLivePrice() — fixes BANK NIFTY showing $0 P&L
                      const current = getLivePrice(op.symbol, isAssetMatch(selectedAsset, op.symbol) ? liveSpotPrice : entry);
                      const isBuy = op.direction === 'BUY';
                      const opUnrealized = isBuy ? (current - entry) * op.quantity : (entry - current) * op.quantity;
                      
                      // Find matched asset label if any
                      const matchedAsset = (marketEnv === 'FOREX' ? FOREX_ASSETS : INDIAN_ASSETS).find(a => isAssetMatch(a.value, op.symbol));
                      const label = matchedAsset ? matchedAsset.label : op.symbol;
                      
                      const isExpanded = expandedActiveTradeId === op.id;
                      
                      return (
                        <>
                          <tr 
                            key={op.id}
                            className={`border-b border-slate-850 hover:bg-slate-900/30 cursor-pointer transition-colors ${
                              isAssetMatch(selectedAsset, op.symbol) ? 'bg-cyan-500/[0.02] border-l-2 border-l-cyan-500' : ''
                            }`}
                          >
                            <td className="py-3 px-2 font-bold text-slate-200">
                              <div className="flex items-center gap-1.5">
                                <span onClick={() => {
                                  setSelectedAsset(matchedAsset ? matchedAsset.value : op.symbol);
                                  setSelectedAssetLabel(label);
                                }}>
                                  {label}
                                </span>
                                {op.is_user_adjusted && (
                                  <span className="px-1 py-0.5 rounded text-[7px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">ADJUSTED</span>
                                )}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleActiveTradeExpand(op);
                                  }}
                                  className="text-[9px] font-bold text-cyan-400 hover:text-cyan-300 border border-cyan-500/20 bg-cyan-500/5 hover:bg-cyan-500/15 px-1 py-0.5 rounded cursor-pointer transition-colors"
                                >
                                  {isExpanded ? 'CLOSE' : 'RISK'}
                                </button>
                              </div>
                            </td>
                            <td className="py-3 px-2">
                              <span className={`px-1.5 py-0.5 rounded font-bold text-[9px] ${isBuy ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}`}>
                                {op.direction}
                              </span>
                            </td>
                            <td className="py-3 px-2 text-slate-300 font-bold">{formatActiveQty(op.quantity, op.symbol, marketEnv)}</td>
                            <td className="py-3 px-2 text-slate-300">{formatPrice(entry, marketEnv)}</td>
                            <td className="py-3 px-2 text-cyan-400 font-bold animate-pulse">{formatPrice(current, marketEnv)}</td>
                            <td className={`py-3 px-2 text-right font-black ${opUnrealized >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {opUnrealized >= 0 ? '+' : ''}{formatCurrency(opUnrealized, marketEnv)}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-slate-950/45 border-b border-slate-850">
                              <td colSpan={6} className="p-3">
                                <div className="flex flex-wrap gap-4 items-center justify-between font-mono text-[10px] text-slate-400">
                                  <div className="flex flex-wrap gap-3 items-center">
                                    <div>
                                      <span className="block text-[8px] text-slate-500 uppercase tracking-widest mb-1">Stop Loss</span>
                                      <input
                                        type="number"
                                        step="0.01"
                                        value={adjustSl[op.id] || ''}
                                        onChange={(e) => setAdjustSl(prev => ({ ...prev, [op.id]: e.target.value }))}
                                        className="bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 text-xs w-24 focus:outline-none focus:border-cyan-500"
                                      />
                                    </div>
                                    <div>
                                      <span className="block text-[8px] text-slate-500 uppercase tracking-widest mb-1">Take Profit</span>
                                      <input
                                        type="number"
                                        step="0.01"
                                        value={adjustTp[op.id] || ''}
                                        onChange={(e) => setAdjustTp(prev => ({ ...prev, [op.id]: e.target.value }))}
                                        className="bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 text-xs w-24 focus:outline-none focus:border-cyan-500"
                                      />
                                    </div>
                                    <div className="flex items-center gap-1.5 mt-4">
                                      <input
                                        type="checkbox"
                                        id={`trailing-${op.id}`}
                                        checked={!!adjustIsTrailing[op.id]}
                                        onChange={(e) => setAdjustIsTrailing(prev => ({ ...prev, [op.id]: e.target.checked }))}
                                        className="rounded bg-slate-900 border-slate-800 text-cyan-500 focus:ring-0 cursor-pointer"
                                      />
                                      <label htmlFor={`trailing-${op.id}`} className="text-slate-400 font-bold cursor-pointer">TRAILING</label>
                                    </div>
                                    {adjustIsTrailing[op.id] && (
                                      <div>
                                        <span className="block text-[8px] text-slate-500 uppercase tracking-widest mb-1">Offset</span>
                                        <input
                                          type="number"
                                          step="0.01"
                                          value={adjustOffset[op.id] || ''}
                                          onChange={(e) => setAdjustOffset(prev => ({ ...prev, [op.id]: e.target.value }))}
                                          className="bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 text-xs w-16 focus:outline-none focus:border-cyan-500"
                                        />
                                      </div>
                                    )}
                                  </div>
                                  <button
                                    onClick={() => handleAdjustSubmit(op.id, marketEnv)}
                                    disabled={adjustLoading[op.id]}
                                    className="bg-cyan-500 hover:bg-cyan-600 text-slate-950 font-bold px-3 py-1.5 rounded-lg text-[10px] transition-all shadow active:scale-95 disabled:opacity-50 cursor-pointer"
                                  >
                                    {adjustLoading[op.id] ? 'SAVING...' : 'SAVE RISK'}
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: Interactive Ledger (1/3 width) */}
        <div className="flex flex-col gap-4 w-full">

          {/* CUSTOM STOCK SCANNER */}
          <div className="border border-slate-800 bg-[#070b15]/95 rounded-2xl p-4 shadow-2xl h-fit">
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-3 mb-4">
              <div className="flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded-full bg-cyan-500" />
                <h2 className="text-xs font-bold font-mono tracking-widest text-slate-400 uppercase">FAST STOCK SCANNER</h2>
              </div>
              <span className="text-[10px] text-slate-500 font-mono">SMC Engine</span>
            </div>

            {isTokenExpired ? (
              <InlinePremiumUpgradeBlocker feature="Custom Stock Scanner" onRequestUpgrade={requestPremiumUpgrade} />
            ) : (
              <>
                <form onSubmit={runCustomScan} className="flex gap-2 mb-4 font-mono">
                  <input
                    type="text"
                    placeholder="e.g. SBIN.NS, TCS.NS, GC=F"
                    value={customScanTicker}
                    onChange={(e) => setCustomScanTicker(e.target.value)}
                    className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs font-bold text-slate-200 focus:outline-none focus:border-cyan-500 placeholder:text-slate-600 transition-colors"
                  />
                  <button
                    type="submit"
                    disabled={customScanLoading}
                    className="bg-cyan-500 hover:bg-cyan-600 text-slate-950 font-bold px-4 py-2 rounded-xl text-xs flex items-center gap-1.5 transition-all shadow-lg hover:shadow-cyan-500/20 active:scale-95 disabled:opacity-50 cursor-pointer"
                  >
                    {customScanLoading ? (
                      <div className="h-3.5 w-3.5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                    ) : 'SCAN'}
                  </button>
                </form>

                {customScanResult && (
                  <div className="bg-slate-900/60 p-3 rounded-xl border border-slate-850 font-mono text-[11px] animate-fadeIn relative">
                    <button
                      type="button"
                      onClick={() => setCustomScanResult(null)}
                      className="absolute top-2 right-2 text-slate-500 hover:text-rose-450 transition-colors font-bold text-[8px] tracking-wider uppercase bg-slate-950/40 hover:bg-rose-500/10 px-1.5 py-0.5 rounded cursor-pointer"
                    >
                      Clear
                    </button>
                    {customScanResult.status === 'success' ? (
                      <div className="space-y-2">
                        <div className="flex justify-between items-center pb-1 border-b border-slate-800/50">
                          <span className="font-bold text-slate-200">{customScanResult.ticker}</span>
                          <span className="text-[10px] text-slate-500">{customScanResult.timestamp}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-[10px]">
                          <div>
                            <span className="text-slate-500 uppercase tracking-wider block">Price</span>
                            <span className="text-slate-200 font-bold">₹{customScanResult.current_price.toFixed(2)}</span>
                          </div>
                          <div>
                            <span className="text-slate-500 uppercase tracking-wider block">Trend</span>
                            <span className={`font-bold ${customScanResult.trend === 'BULLISH' ? 'text-emerald-400' : 'text-rose-400'}`}>{customScanResult.trend}</span>
                          </div>
                          <div>
                            <span className="text-slate-500 uppercase tracking-wider block">Structure</span>
                            <span className="text-slate-300 font-semibold">{customScanResult.structure}</span>
                          </div>
                          <div>
                            <span className="text-slate-500 uppercase tracking-wider block">SMC Signal</span>
                            <span className={`font-black ${customScanResult.signal === 'BUY' ? 'text-emerald-400' : (customScanResult.signal === 'SELL' ? 'text-rose-400' : 'text-slate-400')}`}>
                              {customScanResult.signal}
                            </span>
                          </div>
                        </div>
                        {customScanResult.bullish_fvg !== 'None' && (
                          <div className="bg-emerald-950/20 p-2 rounded border border-emerald-900/30 text-[10px]">
                            <span className="text-emerald-400/80 font-bold block mb-0.5">Bullish FVG Zone</span>
                            <span className="text-emerald-300 font-bold">{customScanResult.bullish_fvg}</span>
                          </div>
                        )}
                        {customScanResult.bearish_fvg !== 'None' && (
                          <div className="bg-rose-950/20 p-2 rounded border border-rose-900/30 text-[10px]">
                            <span className="text-rose-400/80 font-bold block mb-0.5">Bearish FVG Zone</span>
                            <span className="text-rose-300 font-bold">{customScanResult.bearish_fvg}</span>
                          </div>
                        )}
                        <p className="text-[10px] text-slate-400 border-t border-slate-800/40 pt-2 leading-relaxed">
                          {customScanResult.explanation}
                        </p>
                      </div>
                    ) : (
                      <div className="text-rose-400 text-center py-2 flex items-center justify-center gap-1.5">
                        <span>⚠️</span>
                        <span>{customScanResult.message}</span>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          
          {/* ACTIVE TRADES (Current Ledger) - Always visible, fully expanded by default */}
          <div className="border border-slate-800 bg-[#070b15]/95 rounded-2xl p-4 shadow-2xl h-fit">
            <div className="flex flex-col gap-2.5 border-b border-slate-800/80 pb-3 mb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-full bg-emerald-500 animate-pulse" />
                  <h2 className="text-xs font-bold font-mono tracking-widest text-slate-400 uppercase">ACTIVE LEDGER ({activeTrades.length})</h2>
                </div>
                {/* TRADING MODE TOGGLE */}
                <div className="flex items-center gap-1 bg-slate-900/60 p-0.5 rounded-md border border-slate-800 font-mono text-[9px] font-bold">
                  <button 
                    onClick={() => setTradeMode('MOCK')} 
                    className={`px-1.5 py-0.5 rounded cursor-pointer transition-all ${tradeMode === 'MOCK' ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' : 'text-slate-500'}`}
                  >
                    MOCK
                  </button>
                  <button 
                    onClick={() => setTradeMode('LIVE')} 
                    className={`px-1.5 py-0.5 rounded cursor-pointer transition-all ${tradeMode === 'LIVE' ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30' : 'text-slate-500'}`}
                  >
                    LIVE
                  </button>
                </div>
              </div>
              
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-slate-500 font-mono uppercase tracking-widest">
                  mode: <span className={tradeMode === 'LIVE' ? 'text-rose-400' : 'text-cyan-400'}>{tradeMode}</span>
                </span>
                
                {/* KILL SWITCH BUTTON */}
                <button
                  onClick={triggerKillAll}
                  disabled={activeTrades.length === 0}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded text-[9px] font-bold font-mono tracking-widest transition-all ${
                    activeTrades.length > 0 
                      ? 'bg-rose-600/20 hover:bg-rose-600/40 text-rose-400 hover:text-rose-300 border border-rose-500/30 cursor-pointer animate-pulse'
                      : 'bg-slate-900/40 text-slate-600 border border-slate-800/40 cursor-not-allowed'
                  }`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                  FLATTEN ALL
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-3 max-h-[350px] overflow-y-auto pr-1 scrollbar-thin">
              {activeTrades.length === 0 ? (
                <div className="text-center py-10 text-slate-500 font-mono text-[11px] border border-dashed border-slate-850 rounded-xl bg-slate-900/10">
                  NO ACTIVE OPEN TRADES.
                </div>
              ) : (
                activeTrades.map((t) => {
                  const formattedTime = new Date(t.entry_time).toLocaleTimeString('en-US', {
                    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
                  });
                  const isCurrentAsset = isAssetMatch(selectedAsset, t.symbol);

                  // Selected asset match - show real-time progress slider
                  const entry = Number(t.entry_price);
                  const current = livePrices[t.symbol] || (isCurrentAsset ? liveSpotPrice : entry);
                  const isBuy = t.direction === 'BUY';
                  
                  const parsed = parseSlTpFromLogic(t.setup_logic || "");
                  const slVal = parsed ? parsed.sl : (t.direction === 'BUY' ? Number(t.entry_price - 150) : Number(t.entry_price + 150));
                  const tpVal = parsed ? parsed.tp : (t.direction === 'BUY' ? Number(t.entry_price + 300) : Number(t.entry_price - 300));
                  
                  let progressPercent = 50;
                  if (isBuy) {
                    if (tpVal > slVal) {
                      progressPercent = ((current - slVal) / (tpVal - slVal)) * 100;
                    }
                  } else {
                    if (slVal > tpVal) {
                      progressPercent = ((slVal - current) / (slVal - tpVal)) * 100;
                    }
                  }
                  const clampedPercent = Math.max(0, Math.min(100, progressPercent));
                  const currentUnrealized = isBuy ? (current - entry) * t.quantity : (entry - current) * t.quantity;

                  return (
                    <div 
                      key={t.id}
                      className="border border-cyan-500/35 bg-[#090d16]/80 rounded-xl p-3.5 shadow-md shadow-cyan-950/5"
                    >
                      {/* Header */}
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[9px] font-bold font-mono px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/25 animate-pulse">
                          ACTIVE RISK
                        </span>
                        <span className="text-[10px] text-slate-500 font-mono">{formattedTime}</span>
                      </div>

                      {/* Body */}
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs font-bold text-slate-200">{t.symbol} {marketEnv === 'FOREX' ? (t.direction === 'BUY' ? 'LONG' : 'SHORT') : (t.direction === 'BUY' ? 'ATM CE' : 'ATM PE')}</span>
                        <span className="text-xs font-bold font-mono text-slate-300">
                          {formatPrice(Number(t.entry_price), marketEnv)}
                        </span>
                      </div>

                      {/* Expanded Active Details */}
                      <div className="pt-2 border-t border-slate-850/80 font-mono text-[10px] text-slate-400 space-y-2.5">
                        <div>
                          <span className="text-slate-500 uppercase tracking-widest text-[8px] block mb-0.5">Setup Logic</span>
                          <span className="text-slate-300 font-semibold block bg-slate-900/50 p-1.5 rounded border border-slate-850/50 leading-relaxed">
                            {t.setup_logic || "Algorithm alignment trigger."}
                          </span>
                        </div>

                        {/* Trade SL & TP Targets Display */}
                        <div className="space-y-2">
                          <div className="grid grid-cols-2 gap-3 bg-slate-950/60 p-2 rounded-lg border border-slate-850/50">
                            <div>
                              <span className="text-slate-500 uppercase tracking-widest text-[8px] block mb-0.5">STOP LOSS</span>
                              <span className="text-rose-400 font-bold font-mono text-[11px]">{formatPrice(slVal, marketEnv)}</span>
                            </div>
                            <div>
                              <span className="text-slate-500 uppercase tracking-widest text-[8px] block mb-0.5 text-right">TAKE PROFIT</span>
                              <span className="text-emerald-400 font-bold font-mono text-[11px] block text-right">{formatPrice(tpVal, marketEnv)}</span>
                            </div>
                          </div>

                          {/* Progress bar */}
                          <div className="bg-slate-950/50 p-2 rounded-lg border border-slate-850/30">
                            <div className="flex justify-between text-[8px] text-slate-500 font-mono mb-1">
                              <span>SL</span>
                              <span>ENTRY ({formatPrice(entry, marketEnv)})</span>
                              <span>TP</span>
                            </div>
                            <div className="relative h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                              <div 
                                className="absolute top-0 bottom-0 bg-emerald-500/20"
                                style={{ left: isBuy ? '50%' : '0%', right: isBuy ? '0%' : '50%' }}
                              />
                              <div 
                                className="absolute top-0 bottom-0 bg-rose-500/20"
                                style={{ left: isBuy ? '0%' : '50%', right: isBuy ? '50%' : '0%' }}
                              />
                              <div 
                                className="absolute top-0 bottom-0 w-1.5 bg-cyan-400 shadow-md shadow-cyan-400/80 rounded-full transition-all duration-300"
                                style={{ left: `calc(${clampedPercent}% - 3px)` }}
                              />
                            </div>
                            <div className="flex justify-between text-[8px] text-slate-400 font-mono mt-1">
                              <span>{formatPrice(slVal, marketEnv)}</span>
                              <span className="text-cyan-400 font-bold animate-pulse">LTP: {formatPrice(current, marketEnv)}</span>
                              <span>{formatPrice(tpVal, marketEnv)}</span>
                            </div>
                          </div>

                          {/* Live P&L outcome */}
                          <div className="pt-2 border-t border-slate-850/30 flex items-center justify-between">
                            <span className="text-slate-500 uppercase tracking-widest text-[8px]">Floating Return</span>
                            <span className={`text-xs font-black ${currentUnrealized >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                              {currentUnrealized >= 0 ? '+' : ''}{formatCurrency(currentUnrealized, marketEnv)}
                            </span>
                          </div>
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
                            <span className="text-slate-500 uppercase tracking-widest text-[8px] block mb-0.5 text-right">Lot Quantity</span>
                            <span className="text-slate-300 font-bold block text-right mt-0.5">
                              {formatActiveQty(t.quantity, t.symbol, marketEnv)}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* HISTORICAL TRADES - Collapsible by default */}
          <div className="border border-slate-800 bg-[#070b15]/95 rounded-2xl p-4 shadow-2xl h-fit">
            <button 
              onClick={() => setIsHistoryOpen(!isHistoryOpen)}
              className="w-full flex items-center justify-between border-b border-slate-800/80 pb-3 cursor-pointer group bg-transparent border-0 text-left"
            >
              <div className="flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded-full bg-slate-600 transition-colors group-hover:bg-slate-400" />
                <h2 className="text-xs font-bold font-mono tracking-widest text-slate-400 uppercase group-hover:text-slate-200 transition-colors">
                  PAST TRADES ({trades.filter(t => t.status === 'CLOSED' && isAssetMatch(selectedAsset, t.symbol)).length})
                </h2>
              </div>
              <div className="flex items-center gap-2 font-mono text-[10px] text-slate-500 group-hover:text-slate-300 transition-colors">
                <span>{isHistoryOpen ? 'COLLAPSE' : 'EXPAND'}</span>
                <span className="transform transition-transform duration-200" style={{ transform: isHistoryOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
              </div>
            </button>

            {isHistoryOpen && (
              <div className="mt-4 space-y-4 animate-fadeIn">
                <div className="flex items-center justify-between gap-2">
                  {/* History Filter Tabs */}
                  <div className="grid grid-cols-4 gap-1 bg-slate-900/60 p-1 rounded-lg border border-slate-800/50 font-mono text-[9px] flex-grow">
                    {(['TODAY', 'WEEKLY', 'MONTHLY', 'ALL'] as const).map((filter) => (
                      <button
                        key={filter}
                        onClick={() => setLedgerFilter(filter)}
                        className={`py-1.5 px-0.5 rounded-md font-bold text-center cursor-pointer transition-all ${
                          ledgerFilter === filter
                            ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30'
                            : 'text-slate-500 hover:text-slate-300 border border-transparent'
                        }`}
                      >
                        {filter}
                      </button>
                    ))}
                  </div>

                  {/* CSV / JSON Downloads */}
                  <div className="flex gap-1 shrink-0 font-mono text-[8px] font-bold">
                    <button
                      onClick={downloadCSV}
                      disabled={ledgerFilteredTrades.length === 0}
                      className="border border-slate-800 bg-slate-900/60 hover:text-cyan-400 disabled:opacity-50 hover:border-cyan-500/30 px-2 py-2 rounded-lg cursor-pointer transition-all uppercase"
                      title="Download CSV report"
                    >
                      CSV
                    </button>
                    <button
                      onClick={downloadJSON}
                      disabled={ledgerFilteredTrades.length === 0}
                      className="border border-slate-800 bg-slate-900/60 hover:text-cyan-400 disabled:opacity-50 hover:border-cyan-500/30 px-2 py-2 rounded-lg cursor-pointer transition-all uppercase"
                      title="Download JSON report"
                    >
                      JSON
                    </button>
                  </div>
                </div>

                {/* Ledger scrollable container */}
                <div className="flex flex-col gap-3 max-h-[400px] overflow-y-auto pr-1 scrollbar-thin">
                  {ledgerFilteredTrades.length === 0 ? (
                    <div className="text-center py-10 text-slate-500 font-mono text-xs border border-dashed border-slate-850 rounded-xl bg-slate-900/10">
                      {ledgerFilter === 'TODAY' && "NO TRADES EXECUTED TODAY."}
                      {ledgerFilter === 'WEEKLY' && "NO TRADES EXECUTED THIS WEEK."}
                      {ledgerFilter === 'MONTHLY' && "NO TRADES EXECUTED THIS MONTH."}
                      {ledgerFilter === 'ALL' && "NO TRADES FOUND IN SYSTEM LEDGER."}
                    </div>
                  ) : (
                    ledgerFilteredTrades.map((t) => {
                      const isExpanded = expandedTradeId === t.id;
                      const formattedTime = new Date(t.entry_time).toLocaleTimeString('en-US', {
                        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
                      });

                      // Determine badge style
                      let badgeText = "CLOSED";
                      let badgeClass = "bg-slate-500/10 text-slate-400 border border-slate-500/25";
                      
                      const closedPnl = computePnl(t);
                      if (closedPnl < 0) {
                        badgeText = "STOP LOSS";
                        badgeClass = "bg-rose-500/10 text-rose-400 border border-rose-500/25";
                      } else {
                        badgeText = "TAKE PROFIT";
                        badgeClass = "bg-emerald-500/10 text-emerald-400 border border-emerald-500/25";
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
                            <span className="text-xs font-bold text-slate-200">{t.symbol} {marketEnv === 'FOREX' ? (t.direction === 'BUY' ? 'LONG' : 'SHORT') : (t.direction === 'BUY' ? 'ATM CE' : 'ATM PE')}</span>
                            <span className="text-xs font-bold font-mono text-slate-300">
                              {formatPrice(Number(t.entry_price), marketEnv)}
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

                              {/* Trade SL & TP Targets Display */}
                              {(() => {
                                const parsed = parseSlTpFromLogic(t.setup_logic || "");
                                const slVal = parsed ? parsed.sl : (t.direction === 'BUY' ? Number(t.entry_price - 150) : Number(t.entry_price + 150));
                                const tpVal = parsed ? parsed.tp : (t.direction === 'BUY' ? Number(t.entry_price + 300) : Number(t.entry_price - 300));
                                return (
                                  <div className="grid grid-cols-2 gap-3 bg-slate-950/60 p-2 rounded-lg border border-slate-850/50">
                                    <div>
                                      <span className="text-slate-500 uppercase tracking-widest text-[8px] block mb-0.5">STOP LOSS TARGET</span>
                                      <span className="text-rose-400 font-bold font-mono text-[11px]">{formatPrice(slVal, marketEnv)}</span>
                                    </div>
                                    <div>
                                      <span className="text-slate-500 uppercase tracking-widest text-[8px] block mb-0.5 text-right">TAKE PROFIT TARGET</span>
                                      <span className="text-emerald-400 font-bold font-mono text-[11px] block text-right">{formatPrice(tpVal, marketEnv)}</span>
                                    </div>
                                  </div>
                                );
                              })()}

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
                                    {t.slippage ? `${formatPrice(Number(t.slippage), marketEnv)} pts` : '—'}
                                  </span>
                                </div>
                              </div>

                              <div className="pt-2 border-t border-slate-850/30 flex items-center justify-between">
                                <span className="text-slate-500 uppercase tracking-widest text-[8px]">PnL Outcome</span>
                                <span className={`text-xs font-black ${closedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                                  {closedPnl >= 0 ? '+' : ''}{formatCurrency(closedPnl, marketEnv)}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

        </div>

      </div>
      )}

      {/* ── Floating AI Assistant Drawer ── */}
      <div className="fixed bottom-6 right-6 z-50 font-mono">
        {/* Floating Chat Button */}
        <button
          onClick={() => setIsChatOpen(!isChatOpen)}
          className="relative flex items-center justify-center h-14 w-14 rounded-full bg-gradient-to-tr from-cyan-600 to-indigo-700 hover:from-cyan-500 hover:to-indigo-600 text-white shadow-2xl transition-all hover:scale-105 active:scale-95 cursor-pointer group"
          title="Open Bifrost AI Assistant"
        >
          {isChatOpen ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          )}
          <span className="absolute -top-1 -right-1 flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-cyan-500"></span>
          </span>
        </button>

        {/* Collapsible Chat Window */}
        {isChatOpen && (
          <div className="absolute bottom-16 right-0 w-80 md:w-96 h-[480px] border border-slate-800 bg-[#070b15]/95 backdrop-blur-md rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-slideUp">
            {/* Chat Header */}
            <div className="p-4 border-b border-slate-800/80 bg-slate-950/40 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-xs font-bold tracking-wider bg-gradient-to-r from-slate-100 to-cyan-400 bg-clip-text text-transparent">BIFROST // QUANT_AI</span>
              </div>
              <button 
                onClick={() => setChatMessages([])} 
                className="text-[9px] text-slate-500 hover:text-slate-350 font-bold uppercase tracking-wider bg-transparent border-0 cursor-pointer"
              >
                Clear
              </button>
            </div>

            {isTokenExpired ? (
              <div className="flex-grow flex items-center justify-center p-4">
                <InlinePremiumUpgradeBlocker feature="AI Chat Assistant" onRequestUpgrade={requestPremiumUpgrade} />
              </div>
            ) : (
              <>
                {/* Suggestions Quick Buttons */}
                <div className="p-2 border-b border-slate-800/40 bg-slate-900/10 flex gap-1.5 overflow-x-auto scrollbar-none text-[9px] font-bold text-slate-400 shrink-0">
                  <button 
                    onClick={(e) => sendChatMessage(e, "scan RELIANCE")} 
                    className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/60 hover:text-cyan-400 hover:border-cyan-500/30 transition-all whitespace-nowrap cursor-pointer"
                  >
                    🔍 Scan RELIANCE
                  </button>
                  <button 
                    onClick={(e) => sendChatMessage(e, "show recent trades")} 
                    className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/60 hover:text-cyan-400 hover:border-cyan-500/30 transition-all whitespace-nowrap cursor-pointer"
                  >
                    📊 Show Trades
                  </button>
                  <button 
                    onClick={(e) => sendChatMessage(e, "check engine status")} 
                    className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/60 hover:text-cyan-400 hover:border-cyan-500/30 transition-all whitespace-nowrap cursor-pointer"
                  >
                    🔌 Engine Health
                  </button>
                </div>

                {/* Messages Body */}
                <div className="flex-1 p-4 overflow-y-auto space-y-4 text-xs scrollbar-thin">
                  {chatMessages.map((msg, i) => (
                    <div key={i} className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}>
                      <div className={`max-w-[85%] rounded-xl p-3 leading-relaxed ${
                        msg.sender === 'user' 
                          ? 'bg-cyan-500/10 text-cyan-200 border border-cyan-500/25 rounded-tr-none' 
                          : 'bg-slate-900/80 text-slate-350 border border-slate-850/60 rounded-tl-none'
                      }`}>
                        {msg.text.split('\n').map((line, idx) => {
                          if (line.startsWith('### ')) {
                            return <h4 key={idx} className="font-bold text-slate-200 mb-1.5 border-b border-slate-800/50 pb-0.5">{line.replace('### ', '')}</h4>;
                          }
                          if (line.startsWith('* ')) {
                            return <div key={idx} className="pl-3 relative before:content-['•'] before:absolute before:left-0 before:text-cyan-400 mb-1">{line.replace('* ', '')}</div>;
                          }
                          let processed = line;
                          if (processed.includes('**')) {
                            const parts = processed.split('**');
                            return (
                              <div key={idx} className="mb-0.5">
                                {parts.map((p, pIdx) => pIdx % 2 === 1 ? <strong key={pIdx} className="text-cyan-400 font-bold">{p}</strong> : p)}
                              </div>
                            );
                          }
                          return <p key={idx} className="mb-0.5">{processed}</p>;
                        })}
                      </div>
                      <span className="text-[8px] text-slate-500 mt-1 uppercase tracking-wider">
                        {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                      </span>
                    </div>
                  ))}
                  {chatLoading && (
                    <div className="flex flex-col items-start animate-pulse">
                      <div className="bg-slate-900/80 border border-slate-850/60 rounded-xl rounded-tl-none p-3 flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="h-1.5 w-1.5 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="h-1.5 w-1.5 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Input Form */}
                <form onSubmit={sendChatMessage} className="p-3 border-t border-slate-800/80 bg-slate-950/40 flex gap-2 shrink-0">
                  <input
                    type="text"
                    placeholder="Ask Bifrost AI..."
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 placeholder:text-slate-600 transition-colors font-bold"
                  />
                  <button
                    type="submit"
                    disabled={chatLoading}
                    className="bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 text-slate-950 font-black px-4 py-2 rounded-xl text-xs transition-all active:scale-95 cursor-pointer font-bold"
                  >
                    SEND
                  </button>
                </form>
              </>
            )}
          </div>
        )}
      </div>

      {/* Admin Command Center Modal */}
      {isAdminModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 font-mono">
          <div className="bg-[#070b15] border border-slate-800 rounded-3xl p-6 max-w-4xl w-full max-h-[85vh] overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-6">
              <h2 className="text-sm font-bold text-slate-200">🛡️ BIFROST ADMIN COMMAND CENTER</h2>
              <button 
                onClick={() => setIsAdminModalOpen(false)}
                className="text-slate-500 hover:text-slate-300 text-xs font-bold border border-slate-850 px-2 py-1 rounded cursor-pointer"
              >
                CLOSE
              </button>
            </div>

            {adminInsightsLoading ? (
              <div className="flex h-40 items-center justify-center text-cyan-400">
                <span className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-cyan-500 mr-2" />
                LOADING COMMAND METRICS...
              </div>
            ) : adminInsights ? (
              <div className="space-y-6 text-xs text-slate-400">
                {/* Stats row */}
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-slate-900/50 p-4 border border-slate-850 rounded-2xl">
                    <span className="text-[9px] uppercase tracking-widest text-slate-500">Total Scans & Chats</span>
                    <span className="block text-2xl font-black text-slate-100 mt-1">{adminInsights.total_queries}</span>
                  </div>
                  <div className="bg-slate-900/50 p-4 border border-slate-850 rounded-2xl">
                    <span className="text-[9px] uppercase tracking-widest text-slate-500">SMC Stock Scans</span>
                    <span className="block text-2xl font-black text-cyan-400 mt-1">{adminInsights.total_scans}</span>
                  </div>
                  <div className="bg-slate-900/50 p-4 border border-slate-850 rounded-2xl">
                    <span className="text-[9px] uppercase tracking-widest text-slate-500">AI Chat Sessions</span>
                    <span className="block text-2xl font-black text-purple-400 mt-1">{adminInsights.total_chats}</span>
                  </div>
                </div>

                {/* Top users and symbols */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-900/30 p-4 border border-slate-850 rounded-2xl">
                    <span className="text-[9px] uppercase tracking-widest text-slate-500 block mb-2">Most Active Users</span>
                    <ul className="space-y-1.5 font-bold">
                      {adminInsights.top_users?.map((u: any, idx: number) => (
                        <li key={idx} className="flex justify-between border-b border-slate-850/50 pb-1">
                          <span>{u.email}</span>
                          <span className="text-cyan-400">{u.queries} hits</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="bg-slate-900/30 p-4 border border-slate-850 rounded-2xl">
                    <span className="text-[9px] uppercase tracking-widest text-slate-500 block mb-2">Trending Queries</span>
                    <ul className="space-y-1.5 font-bold">
                      {adminInsights.top_symbols?.map((s: any, idx: number) => (
                        <li key={idx} className="flex justify-between border-b border-slate-850/50 pb-1">
                          <span>{s.symbol}</span>
                          <span className="text-amber-400">{s.count} scans</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* Users List & Access Control */}
                <div className="bg-slate-900/30 p-4 border border-slate-850 rounded-2xl">
                  <span className="text-[9px] uppercase tracking-widest text-slate-500 block mb-3">User Profiles & Subscriptions</span>
                  <div className="overflow-x-auto max-h-60 overflow-y-auto">
                    <table className="w-full text-left border-collapse text-[10px]">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-500 uppercase tracking-widest text-[8px]">
                          <th className="py-2 px-2">User Email</th>
                          <th className="py-2 px-2">Role</th>
                          <th className="py-2 px-2">Status</th>
                          <th className="py-2 px-2">Tokens Remaining</th>
                          <th className="py-2 px-2 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {userProfilesList.map((p: any) => (
                          <tr key={p.id} className="border-b border-slate-850/50 hover:bg-slate-900/20">
                            <td className="py-2 px-2 text-slate-200 font-bold">{p.email}</td>
                            <td className="py-2 px-2 text-slate-400">{p.role}</td>
                            <td className="py-2 px-2">
                              <span className={`px-1.5 py-0.5 rounded font-black ${
                                p.subscription_status === 'active' 
                                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                                  : p.subscription_status === 'pending_approval' 
                                  ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse'
                                  : 'bg-slate-500/10 text-slate-400 border border-slate-500/20'
                              }`}>
                                {p.subscription_status}
                              </span>
                            </td>
                            <td className="py-2 px-2 text-slate-300">{p.token_balance}</td>
                            <td className="py-2 px-2 text-right space-x-1.5">
                              {p.subscription_status !== 'active' && (
                                <button
                                  type="button"
                                  onClick={() => handleUpdateUserProfile(p.id, 'active', 999999)}
                                  className="bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 px-1.5 py-0.5 rounded text-[8px] font-bold cursor-pointer"
                                >
                                  APPROVE
                                </button>
                              )}
                              {p.subscription_status === 'active' && (
                                <button
                                  type="button"
                                  onClick={() => handleUpdateUserProfile(p.id, 'free', 100)}
                                  className="bg-rose-500/15 text-rose-400 border border-rose-500/30 hover:bg-rose-500/25 px-1.5 py-0.5 rounded text-[8px] font-bold cursor-pointer"
                                >
                                  REVOKE
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  const tokensStr = prompt("Set token balance:", String(p.token_balance));
                                  if (tokensStr !== null) {
                                    const tokens = parseInt(tokensStr);
                                    if (!isNaN(tokens)) {
                                      handleUpdateUserProfile(p.id, p.subscription_status, tokens);
                                    }
                                  }
                                }}
                                className="bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/25 px-1.5 py-0.5 rounded text-[8px] font-bold cursor-pointer"
                              >
                                EDIT TOKENS
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Recent scan logs */}
                <div className="bg-slate-900/30 p-4 border border-slate-850 rounded-2xl">
                  <span className="text-[9px] uppercase tracking-widest text-slate-500 block mb-2">Recent Queries Logs</span>
                  <div className="overflow-y-auto max-h-40 font-mono text-[9px] space-y-1 bg-slate-950 p-3 rounded-xl border border-slate-850">
                    {adminInsights.recent_logs?.map((l: any, idx: number) => (
                      <div key={idx} className="border-b border-slate-900 pb-1 flex justify-between">
                        <span className="text-slate-400">[{l.query_type}] {l.email}: {l.query_text}</span>
                        <span className="text-slate-600">{new Date(l.created_at).toLocaleTimeString()}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* API & Bot Configuration Settings */}
                <div className="bg-slate-900/30 p-4 border border-slate-850 rounded-2xl space-y-4">
                  <span className="text-[9px] uppercase tracking-widest text-slate-500 block">🔑 API & Bot Configuration Settings</span>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[9px] text-slate-400 block mb-1">GEMINI API KEY</label>
                      <input
                        type="password"
                        placeholder="Enter Gemini API Key (e.g. AIzaSy...)"
                        value={settingsGeminiKey}
                        onChange={(e) => setSettingsGeminiKey(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-purple-500 transition-colors"
                      />
                      <span className="text-[8px] text-slate-500 mt-1 block">Used for the BIFROST AI chatbot assistant queries. Get a free key at aistudio.google.com</span>
                    </div>
                    <div>
                      <label className="text-[9px] text-slate-400 block mb-1">WHATSAPP CALLMEBOT APIKEY</label>
                      <input
                        type="password"
                        placeholder="Enter CallMeBot API Key"
                        value={settingsWhatsAppKey}
                        onChange={(e) => setSettingsWhatsAppKey(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-emerald-500 transition-colors"
                      />
                      <span className="text-[8px] text-slate-500 mt-1 block">Used to deliver real-time trade signals and hourly logs to +91 9846278548.</span>
                    </div>
                    <div>
                      <label className="text-[9px] text-slate-400 block mb-1">FYERS CLIENT ID (ID)</label>
                      <input
                        type="text"
                        placeholder="e.g. FAJ77193"
                        value={settingsFyersId}
                        onChange={(e) => setSettingsFyersId(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-cyan-500 transition-colors"
                      />
                      <span className="text-[8px] text-slate-500 mt-1 block">Your Fyers login ID. Required for token generation.</span>
                    </div>
                    <div>
                      <label className="text-[9px] text-slate-400 block mb-1">FYERS LOGIN PIN (4 DIGIT)</label>
                      <input
                        type="password"
                        placeholder="Enter 4-digit PIN"
                        value={settingsFyersPin}
                        onChange={(e) => setSettingsFyersPin(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-cyan-500 transition-colors"
                      />
                      <span className="text-[8px] text-slate-500 mt-1 block">Your Fyers 4-digit security PIN.</span>
                    </div>
                    <div className="col-span-2">
                      <label className="text-[9px] text-slate-400 block mb-1">FYERS TOTP KEY (SECRET KEY)</label>
                      <input
                        type="password"
                        placeholder="Enter 32-character TOTP secret key"
                        value={settingsFyersTotpKey}
                        onChange={(e) => setSettingsFyersTotpKey(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-cyan-500 transition-colors"
                      />
                      <span className="text-[8px] text-slate-500 mt-1 block">The base32 TOTP secret key from Fyers 2FA configuration to refresh tokens automatically.</span>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      disabled={settingsLoading}
                      onClick={handleSaveSettings}
                      className="bg-purple-650 hover:bg-purple-600 border border-purple-500/30 hover:border-purple-500 text-white font-bold px-4 py-2 rounded-xl text-[10px] cursor-pointer transition-all flex items-center gap-1.5"
                    >
                      {settingsLoading ? 'SAVING...' : '💾 SAVE API SETTINGS'}
                    </button>
                  </div>
                </div>

              </div>
            ) : (
              <div className="text-center text-rose-400 py-10">
                Failed to retrieve admin insights from the backend.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
