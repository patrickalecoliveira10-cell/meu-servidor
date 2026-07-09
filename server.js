// ╔══════════════════════════════════════════════════════════════════════╗
// ║   BYBIT SCANNER PRO — Engine (TypeScript port of server.js v9.6)     ║
// ╚══════════════════════════════════════════════════════════════════════╝

import axios from "axios";
import crypto from "crypto";
import { logger } from "../lib/logger.js";

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface LogEntry { time: number; msg: string; type: string; }
interface Position {
  side: "long" | "short"; entry: number; qty: number; peak: number;
  trailActive: boolean; partialCount: number; lastAportePrice: number; partialExitDone: boolean;
}
interface Config {
  stopPct: number; trailAct: number; trailPull: number; lev: number;
  orderQty: number; partialInPct: number; partialOutPct: number;
  emaScore: number; vwapScore: number; oiScore: number;
  volRatio: number; scoreMin: number; volMin: number;
}
interface Indicators { scoreL: number; scoreS: number; volRatio: number; price: number; }
interface CoinScanResult { symbol: string; wr: number; trades: number; pnl: number; }
interface Candle { time: number; open: number; high: number; low: number; close: number; vol: number; }

// ─── Estado global ────────────────────────────────────────────────────────────

export const MONITOR = {
  active: false,
  symbol: null as string | null,
  engineRunning: false,
  tradeLock: false,
  config: {
    stopPct: 1.5, trailAct: 1.5, trailPull: 0.5, lev: 1,
    orderQty: 0.1, partialInPct: 5, partialOutPct: 50,
    emaScore: 40, vwapScore: 30, oiScore: 20,
    volRatio: 1.2, scoreMin: 50, volMin: 1.0,
  } as Config,
  position: null as Position | null,
  indicators: { scoreL: 0, scoreS: 0, volRatio: 0, price: 0 } as Indicators,
  logs: [] as LogEntry[],
  tradingPaused: false,
  // Lista negra: símbolos com retCode 110126 (acordo não assinado na Bybit)
  symbolBlacklist: [] as string[],
  logCounter: 0,
  coinScan: {
    running: false, lastScanAt: 0,
    results: [] as CoinScanResult[],
    bestSymbol: null as string | null, bestWr: 0,
  },
};

// ─── Log ──────────────────────────────────────────────────────────────────────

export function addLog(msg: string, type = "info"): void {
  const ts = new Date().toLocaleTimeString("pt-BR");
  MONITOR.logs.unshift({ time: Date.now(), msg: `[${ts}] ${msg}`, type });
  if (MONITOR.logs.length > 100) MONITOR.logs.pop();
  logger.info({ type }, msg);
}

// ─── Credenciais ──────────────────────────────────────────────────────────────

export function checkCredentials(): boolean {
  if (!process.env["BYBIT_API_KEY"] || !process.env["BYBIT_API_SECRET"]) {
    addLog("🚨 CRÍTICO: BYBIT_API_KEY e/ou BYBIT_API_SECRET não configuradas! Configure em Secrets.", "err");
    return false;
  }
  return true;
}

// ─── Bybit API ────────────────────────────────────────────────────────────────

export async function bybitRequest(
  method: "GET" | "POST", endpoint: string, data: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  try {
    const key = process.env["BYBIT_API_KEY"];
    const secret = process.env["BYBIT_API_SECRET"];
    if (!key || !secret) {
      addLog(`🚨 Bybit (${endpoint}) abortada: credenciais ausentes.`, "err");
      return { error: "missing_credentials" };
    }
    const timestamp = Date.now().toString();
    const baseUrl = process.env["USE_TESTNET"] === "true"
      ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
    const parameters = method === "GET"
      ? new URLSearchParams(data as Record<string, string>).toString()
      : JSON.stringify(data);
    const sign = crypto.createHmac("sha256", secret)
      .update(timestamp + key + "5000" + parameters).digest("hex");
    const res = await axios({
      method,
      url: baseUrl + endpoint + (method === "GET" ? "?" + parameters : ""),
      headers: {
        "X-BAPI-API-KEY": key, "X-BAPI-SIGN": sign,
        "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": "5000",
        ...(method !== "GET" && { "Content-Type": "application/json" }),
      },
      data: method !== "GET" ? parameters : undefined,
      timeout: 8000,
    });
    return res.data as Record<string, unknown>;
  } catch (e: unknown) {
    const err = e as { response?: { data: unknown }; message?: string };
    const msg = err.response?.data ? JSON.stringify(err.response.data) : (err.message ?? String(e));
    addLog(`⚠️ Erro HTTP Bybit (${endpoint}): ${msg}`, "err");
    return { error: msg };
  }
}

// ─── Ordem ────────────────────────────────────────────────────────────────────

export async function placeOrder(
  side: "long" | "short", qty: number, isReduce = false
): Promise<number | null> {
  if (!MONITOR.symbol) { addLog("❌ placeOrder: symbol não definido", "err"); return null; }

  let finalQty = qty;
  const info = await bybitRequest("GET", "/v5/market/instruments-info", { category: "linear", symbol: MONITOR.symbol });
  const infoResult = info.result as { list: Array<{ lotSizeFilter: { minOrderQty: string; qtyStep: string } }> } | undefined;

  if (infoResult?.list?.[0]) {
    const { minOrderQty, qtyStep } = infoResult.list[0].lotSizeFilter;
    const minQty = parseFloat(minOrderQty);
    const step = parseFloat(qtyStep);
    const precision = Math.max(0, Math.round(-Math.log10(step)));
    const currentPrice = MONITOR.indicators.price || 0;

    if (!isReduce) {
      if (currentPrice > 0) {
        const minQtyForNotional = Math.ceil((5.2 / currentPrice) / step) * step;
        if (finalQty < minQtyForNotional) {
          addLog(`📐 Qty ${finalQty} → ${minQtyForNotional} (nocional mín. ${(minQtyForNotional * currentPrice).toFixed(2)} USDT)`, "info");
          finalQty = minQtyForNotional;
        }
      }
      if (finalQty < minQty) finalQty = minQty;
    }
    finalQty = parseFloat((Math.floor(finalQty / step) * step).toFixed(precision));

    if (isReduce && finalQty <= 0) {
      addLog(`⚠️ Qty de redução ${finalQty} <= 0 após step. Abortando.`, "warn"); return null;
    }
    if (!isReduce && currentPrice > 0 && finalQty * currentPrice < 4.99) {
      addLog(`❌ Nocional (${(finalQty * currentPrice).toFixed(2)} USDT) abaixo mínimo Bybit. Abortando.`, "err"); return null;
    }
  } else {
    addLog(`⚠️ Sem info de instrumento para ${MONITOR.symbol}. Usando qty original.`, "warn");
  }

  const bybitSide = side === "long" ? "Buy" : "Sell";
  addLog(`📡 Enviando ordem: ${bybitSide} ${finalQty} ${MONITOR.symbol} (reduceOnly=${isReduce})`, "info");

  const res = await bybitRequest("POST", "/v5/order/create", {
    category: "linear", symbol: MONITOR.symbol, side: bybitSide,
    orderType: "Market", qty: finalQty.toString(), timeInForce: "GTC", reduceOnly: isReduce,
  });

  if (res.retCode === 0) {
    addLog(`✅ Ordem aceita: ${(res.result as { orderId?: string } | undefined)?.orderId ?? "sem ID"}`, "ok");
    return finalQty;
  }

  if (res.error) {
    addLog(`❌ Falha de comunicação com a Bybit: ${res.error}`, "err");
  } else {
    const retCode = res.retCode as number | undefined;
    const retMsg = res.retMsg as string | undefined;
    addLog(`❌ Erro Bybit (retCode=${retCode ?? "?"}): ${retMsg ?? ""}`, "err");

    if (retCode === 110126) {
      // ── CORREÇÃO: lista negra automática para acordo não assinado ──
      const sym = MONITOR.symbol ?? "";
      if (!MONITOR.symbolBlacklist.includes(sym)) MONITOR.symbolBlacklist.push(sym);
      addLog(
        `🚫 ${sym} exige acordo não assinado (retCode 110126). ` +
        `Acesse bybit.com → Contratos → assine o acordo para ${sym}. ` +
        `Símbolo bloqueado automaticamente.`, "err"
      );
      MONITOR.tradingPaused = true;
      // Tenta trocar imediatamente para a próxima melhor moeda do último scan
      const nextBest = MONITOR.coinScan.results.find(
        r => !MONITOR.symbolBlacklist.includes(r.symbol) && r.wr >= 0.6
      );
      if (nextBest) {
        const prev = MONITOR.symbol;
        MONITOR.symbol = nextBest.symbol;
        MONITOR.tradingPaused = false;
        addLog(`🔀 Trocando automaticamente: ${prev} (bloqueado) → ${nextBest.symbol} (eficácia ${(nextBest.wr * 100).toFixed(0)}%)`, "ok");
      } else {
        addLog("⏸️ Nenhuma alternativa disponível. Trading pausado até novo backtest.", "warn");
      }
      runCoinScan().catch((e: Error) => addLog(`⚠️ Erro ao buscar nova moeda: ${e.message}`, "warn"));
    } else if (retCode === 10001) addLog("💡 API Key sem permissão de Trading (Contratos).", "err");
    else if (retCode === 10003) addLog("💡 API Key inválida ou incorreta.", "err");
    else if (retCode === 10004) addLog("💡 Assinatura inválida — confira o Secret (sem espaços).", "err");
    else if (retCode === 10005) addLog("💡 Permissão negada — confira as permissões da API Key.", "err");
    else if (retCode === 10016) addLog("💡 Saldo insuficiente.", "err");
    else if (retCode === 10018) addLog("💡 Quantidade inválida ou abaixo do mínimo.", "err");
    else if (retCode === 110007) addLog("💡 Margem insuficiente para essa alavancagem.", "err");
  }
  return null;
}

// ─── EMA ──────────────────────────────────────────────────────────────────────

function calcEMA(prices: number[], period: number): number {
  const k = 2 / (period + 1);
  let ema = prices[0] ?? 0;
  for (let i = 1; i < prices.length; i++) ema = (prices[i] ?? 0) * k + ema * (1 - k);
  return ema;
}

// ─── Scoring ao vivo ──────────────────────────────────────────────────────────

export async function engineScoring(): Promise<Indicators | null> {
  if (!MONITOR.symbol) return null;
  const kRes = await bybitRequest("GET", "/v5/market/kline",
    { category: "linear", symbol: MONITOR.symbol, interval: "1", limit: "201" });
  const kResult = kRes.result as { list: Array<[string,string,string,string,string,string]> } | undefined;
  if (!kResult?.list?.length) {
    if (kRes.error) addLog(`⚠️ Sem candles (${MONITOR.symbol}): ${kRes.error}`, "warn");
    return null;
  }
  const list = [...kResult.list].reverse();
  const prices = list.map(k => parseFloat(k[4] ?? "0"));
  const curP = prices[prices.length - 1] ?? 0;
  const prevP = prices[prices.length - 2] ?? 0;
  if (!isFinite(curP) || !isFinite(prevP)) return null;

  const ema200 = calcEMA(prices, 200);
  const { emaScore, vwapScore, oiScore } = MONITOR.config;
  let sL = curP > ema200 ? emaScore : 0;
  let sS = curP < ema200 ? emaScore : 0;

  let vwapSum = 0, volSum = 0;
  list.slice(-50).forEach(k => {
    const p = (parseFloat(k[2]??"0") + parseFloat(k[3]??"0") + parseFloat(k[4]??"0")) / 3;
    vwapSum += p * parseFloat(k[5]??"0"); volSum += parseFloat(k[5]??"0");
  });
  const vwap = volSum > 0 ? vwapSum / volSum : curP;
  sL += curP > vwap ? vwapScore : 0;
  sS += curP < vwap ? vwapScore : 0;

  const oiRes = await bybitRequest("GET", "/v5/market/open-interest",
    { category: "linear", symbol: MONITOR.symbol, intervalTime: "5min", limit: "2" });
  const oiResult = oiRes.result as { list: Array<{ openInterest: string }> } | undefined;
  if (oiResult?.list && oiResult.list.length >= 2) {
    const growing = parseFloat(oiResult.list[0]?.openInterest ?? "0") > parseFloat(oiResult.list[1]?.openInterest ?? "0");
    if (growing) { if (curP > prevP) sL += oiScore; else if (curP < prevP) sS += oiScore; }
  }

  const recent20 = list.slice(-21, -1);
  const avgVol = recent20.length ? recent20.reduce((a,b) => a + parseFloat(b[5]??"0"), 0) / recent20.length : 0;
  const lastVol = parseFloat(list[list.length - 1]?.[5] ?? "0");
  const vRat = avgVol > 0 ? lastVol / avgVol : 0;

  MONITOR.indicators = { scoreL: sL, scoreS: sS, volRatio: vRat, price: curP };
  return MONITOR.indicators;
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

async function fetchDayCandles(symbol: string): Promise<Candle[] | null> {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  let all: Array<[string,string,string,string,string,string]> = [];
  let endTime = Date.now();
  for (let page = 0; page < 3; page++) {
    const kRes = await bybitRequest("GET", "/v5/market/kline",
      { category: "linear", symbol, interval: "1", end: String(endTime), limit: "1000" });
    const kResult = kRes.result as { list: Array<[string,string,string,string,string,string]> } | undefined;
    if (!kResult?.list?.length) break;
    all = all.concat(kResult.list);
    const oldestTs = parseFloat(kResult.list[kResult.list.length - 1]?.[0] ?? "0");
    if (oldestTs <= oneDayAgo || kResult.list.length < 1000) break;
    endTime = oldestTs - 1;
  }
  if (!all.length) return null;
  const map = new Map<string, [string,string,string,string,string,string]>();
  all.forEach(k => map.set(k[0] ?? "", k));
  return [...map.values()]
    .sort((a, b) => parseFloat(a[0]??"0") - parseFloat(b[0]??"0"))
    .filter(k => parseFloat(k[0]??"0") >= oneDayAgo)
    .map(k => ({
      time: parseFloat(k[0]??"0"), open: parseFloat(k[1]??"0"), high: parseFloat(k[2]??"0"),
      low: parseFloat(k[3]??"0"), close: parseFloat(k[4]??"0"), vol: parseFloat(k[5]??"0"),
    }));
}

function btScoring(candles: Candle[], config: Config) {
  if (candles.length < 200) return null;
  const closes = candles.map(c => c.close);
  const curP = closes[closes.length - 1] ?? 0;
  const prevP = closes[closes.length - 2] ?? 0;
  if (!isFinite(curP) || !isFinite(prevP)) return null;
  const ema200 = calcEMA(closes, 200);
  const { emaScore, vwapScore, oiScore } = config;
  let sL = curP > ema200 ? emaScore : 0;
  let sS = curP < ema200 ? emaScore : 0;
  let vwapSum = 0, volSum = 0;
  candles.slice(-50).forEach(c => { const p = (c.high + c.low + c.close) / 3; vwapSum += p * c.vol; volSum += c.vol; });
  const vwap = volSum > 0 ? vwapSum / volSum : curP;
  sL += curP > vwap ? vwapScore : 0;
  sS += curP < vwap ? vwapScore : 0;
  const recent5 = candles.slice(-5);
  if (recent5.length >= 2) {
    const volChange = ((candles[candles.length-1]?.vol??0) - (recent5[0]?.vol??0)) / (recent5[0]?.vol || 1);
    const volTrend = volChange > 0.3 ? oiScore : volChange > 0.1 ? oiScore * 0.5 : 0;
    sL += volTrend; sS += volTrend;
  }
  const recent20 = candles.slice(-21, -1);
  const avgVol = recent20.length ? recent20.reduce((a,b) => a + b.vol, 0) / recent20.length : 0;
  const vRat = avgVol > 0 ? (candles[candles.length-1]?.vol??0) / avgVol : 0;
  return { scoreL: sL, scoreS: sS, volRatio: vRat, price: curP };
}

function btSimulatePosition(candles: Candle[], entryIdx: number, side: string, config: Config) {
  const entry = candles[entryIdx]?.close ?? 0;
  const { stopPct, trailAct, trailPull, scoreMin, volMin } = config;
  const lev = config.lev || 1;
  const isL = side === "long";
  const pos = { peak: entry, trailActive: false, partialExitDone: false };
  let lastRoi = 0;
  for (let i = entryIdx + 1; i < candles.length; i++) {
    const price = candles[i]?.close ?? 0;
    const roi = (isL ? (price-entry)/entry : (entry-price)/entry) * 100 * lev;
    lastRoi = roi;
    if (roi <= -stopPct) return { result: "stop", roi };
    const sc = btScoring(candles.slice(0, i+1), config);
    if (!sc) continue;
    const longTrig = sc.scoreL >= scoreMin && sc.volRatio >= volMin;
    const shortTrig = sc.scoreS >= scoreMin && sc.volRatio >= volMin;
    const contraryTrig = isL ? shortTrig : longTrig;
    if (contraryTrig && roi >= 0 && !pos.trailActive) return { result: "safety", roi };
    if (!pos.trailActive && roi >= trailAct) { pos.trailActive = true; pos.peak = price; }
    if (pos.trailActive) {
      if (isL && price > pos.peak) pos.peak = price;
      if (!isL && price < pos.peak) pos.peak = price;
      const pb = (isL ? (pos.peak-price)/pos.peak : (price-pos.peak)/pos.peak) * 100 * lev;
      if (contraryTrig) {
        if (!pos.partialExitDone) { pos.partialExitDone = true; continue; }
        return { result: "trail_exit", roi };
      }
      if (pb >= trailPull) return { result: "trail_exit", roi };
    }
  }
  return { result: "timeout", roi: lastRoi };
}

async function backtestSymbol(symbol: string, config: Config): Promise<CoinScanResult> {
  const candles = await fetchDayCandles(symbol);
  if (!candles || candles.length < 220) return { symbol, wr: 0, trades: 0, pnl: 0 };
  const { scoreMin, volMin } = config;
  let wins = 0, trades = 0, totalPnl = 0;
  for (let i = 200; i < candles.length - 1; i++) {
    const sc = btScoring(candles.slice(0, i+1), config);
    if (!sc) continue;
    const longTrig = sc.scoreL >= scoreMin && sc.volRatio >= volMin;
    const shortTrig = sc.scoreS >= scoreMin && sc.volRatio >= volMin;
    if (longTrig === shortTrig) continue; // conflito ou nenhum
    const side = longTrig ? "long" : "short";
    const result = btSimulatePosition(candles, i, side, config);
    trades++;
    totalPnl += result.roi;
    if (result.result !== "stop" && result.result !== "timeout") wins++;
  }
  return { symbol, wr: trades > 0 ? wins/trades : 0, trades, pnl: totalPnl };
}

async function getTopMovers(limit = 20): Promise<string[]> {
  const [instRes, tickRes] = await Promise.all([
    bybitRequest("GET", "/v5/market/instruments-info", { category: "linear" }),
    bybitRequest("GET", "/v5/market/tickers", { category: "linear" }),
  ]);
  const instruments = ((instRes.result as { list?: Array<{quoteCoin:string;status:string;symbol:string}> } | undefined)?.list) ?? [];
  const tickers = ((tickRes.result as { list?: Array<{symbol:string;volume24h:string;lastPrice:string}> } | undefined)?.list) ?? [];
  const instSet = new Set<string>();
  instruments.forEach(i => { if (i.quoteCoin === "USDT" && i.status === "Trading") instSet.add(i.symbol); });
  return tickers
    .filter(t => t.symbol.endsWith("USDT") && instSet.has(t.symbol))
    .map(t => ({ symbol: t.symbol, volUSD: (parseFloat(t.volume24h)||0) * (parseFloat(t.lastPrice)||0) }))
    .filter(t => t.volUSD >= 20000)
    .sort((a, b) => b.volUSD - a.volUSD)
    .slice(0, limit)
    .map(t => t.symbol);
}

// ─── Seleção de moeda por backtest ────────────────────────────────────────────

export async function runCoinScan(): Promise<void> {
  if (MONITOR.coinScan.running) return;
  MONITOR.coinScan.running = true;
  try {
    addLog("🔍 Backtest de seleção de moeda iniciado (últimas 24h, config vigente)...", "info");
    const config = MONITOR.config;
    const movers = await getTopMovers(20);
    const candidates = new Set(movers);
    if (MONITOR.symbol) candidates.add(MONITOR.symbol);

    // Remove moedas da lista negra (acordo não assinado)
    const blacklisted = new Set(MONITOR.symbolBlacklist);
    const filteredCandidates = [...candidates].filter(sym => !blacklisted.has(sym));
    if (blacklisted.size > 0)
      addLog(`⛔ Excluindo da lista negra: ${[...blacklisted].join(", ")}`, "warn");

    const results: CoinScanResult[] = [];
    for (const sym of filteredCandidates) {
      try {
        const r = await backtestSymbol(sym, config);
        results.push(r);
        addLog(`📊 Backtest ${sym}: eficácia=${(r.wr*100).toFixed(0)}% trades=${r.trades}`, "info");
      } catch (e: unknown) {
        addLog(`⚠️ Backtest falhou para ${sym}: ${(e as Error).message}`, "warn");
      }
    }

    results.sort((a, b) => b.wr - a.wr || b.trades - a.trades);
    MONITOR.coinScan.results = results;
    MONITOR.coinScan.lastScanAt = Date.now();

    if (!results.length) {
      addLog("⚠️ Backtest sem resultados. Mantendo moeda atual.", "warn");
      return;
    }

    const best = results[0]!;
    MONITOR.coinScan.bestSymbol = best.symbol;
    MONITOR.coinScan.bestWr = best.wr;

    if (MONITOR.position) {
      addLog("ℹ️ Posição aberta — troca de moeda será aplicada após fechamento.", "info");
      return;
    }

    if (best.wr < 0.6) {
      MONITOR.tradingPaused = true;
      addLog(`⏸️ Nenhuma moeda com eficácia >= 60% (melhor: ${best.symbol} ${(best.wr*100).toFixed(0)}%). Não vai operar.`, "warn");
      return;
    }

    MONITOR.tradingPaused = false;
    const currentResult = results.find(r => r.symbol === MONITOR.symbol);
    const currentIsStillBest = currentResult && currentResult.wr >= 0.6 && currentResult.wr >= best.wr - 1e-9;

    if (currentIsStillBest) {
      addLog(`✅ Moeda atual (${MONITOR.symbol}) continua com maior eficácia (${(currentResult.wr*100).toFixed(0)}%). Mantendo.`, "ok");
      // ← LOG NOVO: confirma explicitamente qual moeda vai operar
      addLog(`🟢 SERVIDOR OPERANDO: ${MONITOR.symbol} | Eficácia: ${(currentResult.wr*100).toFixed(0)}% | Trades (24h): ${currentResult.trades}`, "ok");
    } else {
      const prevSymbol = MONITOR.symbol;
      MONITOR.symbol = best.symbol;
      addLog(`🔀 Trocando moeda: ${prevSymbol ?? "—"} → ${best.symbol} (eficácia ${(best.wr*100).toFixed(0)}% > atual).`, "ok");
      // ← LOG NOVO: confirma explicitamente qual moeda vai operar
      addLog(`🟢 SERVIDOR OPERANDO: ${best.symbol} | Eficácia: ${(best.wr*100).toFixed(0)}% | Trades (24h): ${best.trades}`, "ok");
    }
  } finally {
    MONITOR.coinScan.running = false;
  }
}

// ─── Engine tick ──────────────────────────────────────────────────────────────

export async function engineTick(): Promise<void> {
  if (!MONITOR.active || !MONITOR.symbol) return;
  const data = await engineScoring();
  if (!data) return;
  const { scoreL, scoreS, volRatio, price } = data;
  const { scoreMin, volMin } = MONITOR.config;
  const longTrig = scoreL >= scoreMin && volRatio >= volMin;
  const shortTrig = scoreS >= scoreMin && volRatio >= volMin;

  if (longTrig || shortTrig)
    addLog(`🎯 GATILHO: scoreL=${scoreL.toFixed(0)} scoreS=${scoreS.toFixed(0)} volRatio=${volRatio.toFixed(2)} min=${scoreMin}/${volMin}`, "info");

  MONITOR.logCounter++;
  if (MONITOR.logCounter % 60 === 0)
    // ← LOG NOVO: inclui símbolo ativo no status periódico
    addLog(`📊 [${MONITOR.symbol}] scoreL=${scoreL.toFixed(0)}/${scoreMin} scoreS=${scoreS.toFixed(0)}/${scoreMin} volRatio=${volRatio.toFixed(2)}/${volMin} price=${price}`, "info");

  // ─── Sem posição: entrada ─────────────────────────────────────────────────
  if (!MONITOR.position) {
    if (MONITOR.tradingPaused) return;
    if (longTrig && shortTrig) { addLog("⚖️ Conflito LONG/SHORT. Ignorando.", "warn"); return; }
    if (longTrig) {
      addLog(`🚀 GATILHO LONG: scoreL=${scoreL.toFixed(0)} >= ${scoreMin}, volRatio=${volRatio.toFixed(2)} >= ${volMin}`, "info");
      const qty = await placeOrder("long", MONITOR.config.orderQty);
      if (qty) {
        MONITOR.position = { side: "long", entry: price, qty, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price, partialExitDone: false };
        addLog(`✅ ENTRADA LONG: qty=${qty} @ ${price}`, "ok");
      } else addLog("❌ FALHA LONG: veja erro acima.", "err");
    } else if (shortTrig) {
      addLog(`🚀 GATILHO SHORT: scoreS=${scoreS.toFixed(0)} >= ${scoreMin}, volRatio=${volRatio.toFixed(2)} >= ${volMin}`, "info");
      const qty = await placeOrder("short", MONITOR.config.orderQty);
      if (qty) {
        MONITOR.position = { side: "short", entry: price, qty, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price, partialExitDone: false };
        addLog(`✅ ENTRADA SHORT: qty=${qty} @ ${price}`, "ok");
      } else addLog("❌ FALHA SHORT: veja erro acima.", "err");
    }
    return;
  }

  // ─── Com posição: gestão ──────────────────────────────────────────────────
  const pos = MONITOR.position;
  const isL = pos.side === "long";
  const roi = (isL ? (price-pos.entry)/pos.entry : (pos.entry-price)/pos.entry) * 100 * (MONITOR.config.lev||1);
  const contraryTrig = isL ? shortTrig : longTrig;
  const favorTrig   = isL ? longTrig  : shortTrig;

  // 1. Stop loss
  if (roi <= -MONITOR.config.stopPct) {
    const q = await placeOrder(isL ? "short" : "long", pos.qty, true);
    if (q !== null) { MONITOR.position = null; addLog(`❌ STOP LOSS em ${roi.toFixed(2)}%`, "err"); }
    else addLog("⚠️ Stop Loss rejeitado. Tenta no próximo tick.", "err");
    return;
  }

  // 2. Flip / segurança
  if (contraryTrig) {
    if (roi < 0) {
      addLog(`🔄 FLIP: ROI ${roi.toFixed(2)}%. Invertendo...`, "warn");
      const closeQ = await placeOrder(isL ? "short" : "long", pos.qty, true);
      if (closeQ === null) { addLog("⚠️ FLIP: falha ao fechar. Aguarda.", "err"); return; }
      MONITOR.position = null;
      const newSide = isL ? "short" : "long";
      const qty = await placeOrder(newSide, MONITOR.config.orderQty);
      if (qty) {
        MONITOR.position = { side: newSide, entry: price, qty, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price, partialExitDone: false };
        addLog(`✅ NOVA POSIÇÃO ${newSide.toUpperCase()} @ ${price}`, "ok");
      } else addLog("⚠️ FLIP: fechou mas falhou ao abrir nova. Flat.", "warn");
      return;
    } else if (!pos.trailActive) {
      addLog(`💰 SEGURANÇA: Lucro ${roi.toFixed(2)}%. Fechando.`, "ok");
      const q = await placeOrder(isL ? "short" : "long", pos.qty, true);
      if (q !== null) MONITOR.position = null;
      else addLog("⚠️ Segurança rejeitada. Tenta no próximo tick.", "err");
      return;
    }
  }

  // 3. Aportes (scale-in, máx. 2)
  if (favorTrig && roi > 0.5 && pos.partialCount < 2) {
    const dist = Math.abs(price - pos.lastAportePrice) / pos.lastAportePrice * 100;
    if (dist >= 0.3) {
      const qty = await placeOrder(pos.side, MONITOR.config.orderQty * (MONITOR.config.partialInPct/100));
      if (qty) {
        pos.partialCount++; pos.qty += qty; pos.lastAportePrice = price;
        addLog(`📥 APORTE #${pos.partialCount} @ ${price} | +${qty} | Total: ${pos.qty.toFixed(6)}`, "info");
      }
    }
  }

  // 4. Ativa trailing
  if (!pos.trailActive && roi >= MONITOR.config.trailAct) {
    pos.trailActive = true; pos.peak = price;
    addLog(`🎯 TRAILING ATIVADO em ${roi.toFixed(2)}% ROI`, "ok");
  }

  // 5. Gestão de saída no trailing
  if (pos.trailActive) {
    if (contraryTrig) {
      if (!pos.partialExitDone) {
        const exitQty = pos.qty * (MONITOR.config.partialOutPct/100);
        const q = await placeOrder(isL ? "short" : "long", exitQty, true);
        if (q) { pos.qty -= q; pos.partialExitDone = true; addLog(`📤 PARCIAL TRAILING: -${MONITOR.config.partialOutPct}% | Restante: ${pos.qty.toFixed(6)}`, "info"); }
        else addLog("⚠️ Parcial trailing rejeitada. Tenta no próximo tick.", "err");
      } else {
        addLog("🏁 FECHAMENTO TRAILING: 2º sinal contrário.", "ok");
        const q = await placeOrder(isL ? "short" : "long", pos.qty, true);
        if (q !== null) MONITOR.position = null;
        else addLog("⚠️ Fechamento final rejeitado. Tenta no próximo tick.", "err");
        return;
      }
    }
    if (isL && price > pos.peak) pos.peak = price;
    if (!isL && price < pos.peak) pos.peak = price;
    const pb = (isL ? (pos.peak-price)/pos.peak : (price-pos.peak)/pos.peak) * 100;
    if (pb * (MONITOR.config.lev||1) >= MONITOR.config.trailPull) {
      addLog(`🏁 RECUO TRAILING: ${pb.toFixed(2)}% do topo. Encerrando.`, "ok");
      const q = await placeOrder(isL ? "short" : "long", pos.qty, true);
      if (q !== null) MONITOR.position = null;
      else addLog("⚠️ Fechamento por recuo rejeitado. Tenta no próximo tick.", "err");
    }
  }
}

// ─── Trade lock ───────────────────────────────────────────────────────────────

export async function withTradeLock<T>(fn: () => Promise<T>): Promise<T> {
  if (MONITOR.tradeLock) throw new Error("Engine ocupado. Tente novamente.");
  MONITOR.tradeLock = true;
  try { return await fn(); } finally { MONITOR.tradeLock = false; }
}

// ─── Loop principal (5 s) ─────────────────────────────────────────────────────

setInterval(async () => {
  if (MONITOR.tradeLock) return;
  MONITOR.tradeLock = true;
  const hadPosition = !!MONITOR.position;
  try {
    await engineTick();
    if (hadPosition && !MONITOR.position && MONITOR.active) {
      addLog("📊 Posição fechada. Reavaliando melhor moeda...", "info");
      runCoinScan().catch((e: Error) => addLog(`⚠️ Erro backtest pós-fechamento: ${e.message}`, "warn"));
    }
  } catch (e: unknown) {
    addLog(`💥 ERRO NO ENGINE: ${(e as Error).message}`, "err");
  } finally {
    MONITOR.tradeLock = false;
  }
}, 5000);

// ─── Backtest periódico (10 min) ──────────────────────────────────────────────

setInterval(() => {
  if (MONITOR.active && !MONITOR.position && !MONITOR.coinScan.running) {
    addLog("⏱️ Backtest periódico (10 min)...", "info");
    runCoinScan().catch((e: Error) => addLog(`⚠️ Erro backtest periódico: ${e.message}`, "warn"));
  }
}, 10 * 60 * 1000);

// ─── Rede de segurança global ─────────────────────────────────────────────────

process.on("unhandledRejection", (reason: unknown) => {
  addLog(`💥 REJEIÇÃO NÃO TRATADA: ${reason instanceof Error ? reason.message : String(reason)}`, "err");
});
process.on("uncaughtException", (err: Error) => {
  addLog(`💥 EXCEÇÃO NÃO CAPTURADA: ${err.message}`, "err");
});
