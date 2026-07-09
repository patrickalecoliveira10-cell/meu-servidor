// ╔══════════════════════════════════════════════════════════════════════╗
// ║   BYBIT SCANNER PRO — SERVER v9.7 (CORRIGIDO)                        ║
// ║   Correções: retCode 110126 (lista negra automática),                 ║
// ║              log "🟢 SERVIDOR OPERANDO" após scan,                    ║
// ║              símbolo ativo no status periódico                        ║
// ╚══════════════════════════════════════════════════════════════════════╝

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const cors    = require('cors');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 10000;
app.use(cors());
app.use(express.json());

// ─── Estado global ────────────────────────────────────────────────────────────

let MONITOR = {
    active: false,
    symbol: null,
    engineRunning: false,
    tradeLock: false,
    config: {
        stopPct: 1.5, trailAct: 1.5, trailPull: 0.5,
        lev: 1, orderQty: 0.1, partialInPct: 5, partialOutPct: 50,
        emaScore: 40, vwapScore: 30, oiScore: 20,
        volRatio: 1.2, scoreMin: 50, volMin: 1.0
    },
    position: null,
    indicators: { scoreL: 0, scoreS: 0, volRatio: 0, price: 0 },
    logs: [],
    tradingPaused: false,
    // Lista negra: símbolos com retCode 110126 (acordo não assinado na Bybit)
    symbolBlacklist: [],
    logCounter: 0,
    coinScan: {
        running: false, lastScanAt: 0,
        results: [], bestSymbol: null, bestWr: 0
    }
};

// ─── Log ──────────────────────────────────────────────────────────────────────

function addLog(msg, type = 'info') {
    const ts = new Date().toLocaleTimeString('pt-BR');
    MONITOR.logs.unshift({ time: Date.now(), msg: `[${ts}] ${msg}`, type });
    if (MONITOR.logs.length > 100) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ─── Credenciais ──────────────────────────────────────────────────────────────

function checkCredentials() {
    if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET) {
        addLog('🚨 CRÍTICO: BYBIT_API_KEY e/ou BYBIT_API_SECRET não configuradas! Configure em Environment Variables.', 'err');
        return false;
    }
    return true;
}

// ─── Bybit API ────────────────────────────────────────────────────────────────

async function bybitRequest(method, endpoint, data = {}) {
    try {
        const key    = process.env.BYBIT_API_KEY;
        const secret = process.env.BYBIT_API_SECRET;
        if (!key || !secret) {
            addLog(`🚨 Bybit (${endpoint}) abortada: credenciais ausentes.`, 'err');
            return { error: 'missing_credentials' };
        }
        const timestamp  = Date.now().toString();
        const baseUrl    = process.env.USE_TESTNET === 'true'
            ? 'https://api-testnet.bybit.com'
            : 'https://api.bybit.com';
        const parameters = method === 'GET'
            ? new URLSearchParams(data).toString()
            : JSON.stringify(data);
        const sign = crypto.createHmac('sha256', secret)
            .update(timestamp + key + '5000' + parameters).digest('hex');
        const res = await axios({
            method,
            url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: {
                'X-BAPI-API-KEY': key, 'X-BAPI-SIGN': sign,
                'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': '5000',
                ...(method !== 'GET' && { 'Content-Type': 'application/json' }),
            },
            data: method !== 'GET' ? parameters : undefined,
            timeout: 8000,
        });
        return res.data;
    } catch (e) {
        const msg = (e.response && e.response.data)
            ? JSON.stringify(e.response.data)
            : (e.message || String(e));
        addLog(`⚠️ Erro HTTP Bybit (${endpoint}): ${msg}`, 'err');
        return { error: msg };
    }
}

// ─── Ordem ────────────────────────────────────────────────────────────────────

async function placeOrder(side, qty, isReduce = false) {
    if (!MONITOR.symbol) { addLog('❌ placeOrder: symbol não definido', 'err'); return null; }

    let finalQty = qty;

    const info = await bybitRequest('GET', '/v5/market/instruments-info', { category: 'linear', symbol: MONITOR.symbol });
    if (info && info.result && info.result.list && info.result.list[0]) {
        const limits    = info.result.list[0].lotSizeFilter;
        const minQty    = parseFloat(limits.minOrderQty);
        const step      = parseFloat(limits.qtyStep);
        const precision = Math.max(0, Math.round(-Math.log10(step)));
        const currentPrice = MONITOR.indicators.price || 0;

        if (!isReduce) {
            if (currentPrice > 0) {
                const minQtyForNotional = Math.ceil((5.2 / currentPrice) / step) * step;
                if (finalQty < minQtyForNotional) {
                    addLog(`📐 Qty ${finalQty} → ${minQtyForNotional} (nocional mín. ${(minQtyForNotional * currentPrice).toFixed(2)} USDT)`, 'info');
                    finalQty = minQtyForNotional;
                }
            }
            if (finalQty < minQty) finalQty = minQty;
        }
        finalQty = Math.floor(finalQty / step) * step;
        finalQty = parseFloat(finalQty.toFixed(precision));

        if (isReduce && finalQty <= 0) {
            addLog(`⚠️ Qty de redução ${finalQty} <= 0 após step. Abortando.`, 'warn');
            return null;
        }
        if (!isReduce && currentPrice > 0 && finalQty * currentPrice < 4.99) {
            addLog(`❌ Nocional (${(finalQty * currentPrice).toFixed(2)} USDT) abaixo mínimo Bybit. Abortando.`, 'err');
            return null;
        }
    } else {
        addLog(`⚠️ Sem info de instrumento para ${MONITOR.symbol}. Usando qty original.`, 'warn');
    }

    const bybitSide = side.toLowerCase() === 'long' ? 'Buy' : 'Sell';
    addLog(`📡 Enviando ordem: ${bybitSide} ${finalQty} ${MONITOR.symbol} (reduceOnly=${isReduce})`, 'info');

    const res = await bybitRequest('POST', '/v5/order/create', {
        category: 'linear', symbol: MONITOR.symbol, side: bybitSide,
        orderType: 'Market', qty: finalQty.toString(), timeInForce: 'GTC', reduceOnly: isReduce,
    });

    if (res && res.retCode === 0) {
        addLog(`✅ Ordem aceita: ${(res.result && res.result.orderId) || 'sem ID'}`, 'ok');
        return finalQty;
    }

    if (res && res.error) {
        addLog(`❌ Falha de comunicação com a Bybit: ${res.error}`, 'err');
    } else {
        addLog(`❌ Erro Bybit (retCode=${res ? res.retCode : '?'}): ${res ? res.retMsg : ''}`, 'err');
        if (res) {
            if (res.retCode === 110126) {
                // ── CORREÇÃO: lista negra automática para acordo não assinado ──
                const sym = MONITOR.symbol || '';
                if (!MONITOR.symbolBlacklist.includes(sym)) MONITOR.symbolBlacklist.push(sym);
                addLog(
                    `🚫 ${sym} exige acordo não assinado na Bybit (retCode 110126). ` +
                    `Acesse bybit.com → Contratos → assine o acordo para ${sym}. ` +
                    `Símbolo bloqueado automaticamente.`, 'err'
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
                    addLog(`🔀 Trocando automaticamente: ${prev} (bloqueado) → ${nextBest.symbol} (eficácia ${(nextBest.wr * 100).toFixed(0)}%)`, 'ok');
                } else {
                    addLog('⏸️ Nenhuma alternativa disponível. Trading pausado até novo backtest.', 'warn');
                }
                runCoinScan().catch(e => addLog(`⚠️ Erro ao buscar nova moeda: ${e.message}`, 'warn'));
            } else if (res.retCode === 10001) addLog('💡 API Key sem permissão de Trading (Contratos).', 'err');
            else if (res.retCode === 10003) addLog('💡 API Key inválida ou incorreta.', 'err');
            else if (res.retCode === 10004) addLog('💡 Assinatura inválida — confira o Secret (sem espaços).', 'err');
            else if (res.retCode === 10005) addLog('💡 Permissão negada — confira as permissões da API Key.', 'err');
            else if (res.retCode === 10016) addLog('💡 Saldo insuficiente.', 'err');
            else if (res.retCode === 10018) addLog('💡 Quantidade inválida ou abaixo do mínimo.', 'err');
            else if (res.retCode === 110007) addLog('💡 Margem insuficiente para essa alavancagem.', 'err');
        }
    }
    return null;
}

// ─── EMA ──────────────────────────────────────────────────────────────────────

function calcEMA(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
    return ema;
}

// ─── Scoring ao vivo ──────────────────────────────────────────────────────────

async function engineScoring() {
    if (!MONITOR.symbol) return null;
    const kRes = await bybitRequest('GET', '/v5/market/kline',
        { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '201' });
    if (!kRes || !kRes.result || !kRes.result.list || !kRes.result.list.length) {
        if (kRes && kRes.error) addLog(`⚠️ Sem candles (${MONITOR.symbol}): ${kRes.error}`, 'warn');
        return null;
    }
    const list  = [...kRes.result.list].reverse();
    const prices = list.map(k => parseFloat(k[4]));
    const curP  = prices[prices.length - 1];
    const prevP = prices[prices.length - 2];
    if (!isFinite(curP) || !isFinite(prevP)) return null;

    const ema200    = calcEMA(prices, 200);
    const emaScore  = MONITOR.config.emaScore  || 40;
    const vwapScore = MONITOR.config.vwapScore || 30;
    const oiScore   = MONITOR.config.oiScore   || 20;

    let sL = curP > ema200 ? emaScore : 0;
    let sS = curP < ema200 ? emaScore : 0;

    let vwapSum = 0, volSum = 0;
    list.slice(-50).forEach(k => {
        const p = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
        vwapSum += p * parseFloat(k[5]); volSum += parseFloat(k[5]);
    });
    const vwap = volSum > 0 ? vwapSum / volSum : curP;
    sL += curP > vwap ? vwapScore : 0;
    sS += curP < vwap ? vwapScore : 0;

    const oiRes = await bybitRequest('GET', '/v5/market/open-interest',
        { category: 'linear', symbol: MONITOR.symbol, intervalTime: '5min', limit: '2' });
    if (oiRes && oiRes.result && oiRes.result.list && oiRes.result.list.length >= 2) {
        const growing = parseFloat(oiRes.result.list[0].openInterest) > parseFloat(oiRes.result.list[1].openInterest);
        if (growing) {
            if (curP > prevP) sL += oiScore;
            else if (curP < prevP) sS += oiScore;
        }
    }

    const recent20 = list.slice(-21, -1);
    const avgVol   = recent20.length ? recent20.reduce((a, b) => a + parseFloat(b[5]), 0) / recent20.length : 0;
    const lastVol  = parseFloat(list[list.length - 1][5]);
    const vRat     = avgVol > 0 ? lastVol / avgVol : 0;

    MONITOR.indicators = { scoreL: sL, scoreS: sS, volRatio: vRat, price: curP };
    return MONITOR.indicators;
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

async function fetchDayCandles(symbol) {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let all = [], endTime = Date.now();
    for (let page = 0; page < 3; page++) {
        const kRes = await bybitRequest('GET', '/v5/market/kline',
            { category: 'linear', symbol, interval: '1', end: String(endTime), limit: '1000' });
        if (!kRes || !kRes.result || !kRes.result.list || !kRes.result.list.length) break;
        const batch = kRes.result.list;
        all = all.concat(batch);
        const oldestTs = parseFloat(batch[batch.length - 1][0]);
        if (oldestTs <= oneDayAgo || batch.length < 1000) break;
        endTime = oldestTs - 1;
    }
    if (!all.length) return null;
    const map = new Map();
    all.forEach(k => map.set(k[0], k));
    return [...map.values()]
        .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
        .filter(k => parseFloat(k[0]) >= oneDayAgo)
        .map(k => ({
            time: parseFloat(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
            low:  parseFloat(k[3]), close: parseFloat(k[4]), vol: parseFloat(k[5])
        }));
}

function btScoring(candles, config) {
    if (!candles || candles.length < 200) return null;
    const closes = candles.map(c => c.close);
    const curP   = closes[closes.length - 1];
    const prevP  = closes[closes.length - 2];
    if (!isFinite(curP) || !isFinite(prevP)) return null;

    const ema200    = calcEMA(closes, 200);
    const emaScore  = config.emaScore  || 40;
    const vwapScore = config.vwapScore || 30;
    const oiScore   = config.oiScore   || 20;

    let sL = curP > ema200 ? emaScore : 0;
    let sS = curP < ema200 ? emaScore : 0;

    let vwapSum = 0, volSum = 0;
    candles.slice(-50).forEach(c => {
        const p = (c.high + c.low + c.close) / 3;
        vwapSum += p * c.vol; volSum += c.vol;
    });
    const vwap = volSum > 0 ? vwapSum / volSum : curP;
    sL += curP > vwap ? vwapScore : 0;
    sS += curP < vwap ? vwapScore : 0;

    const recent5 = candles.slice(-5);
    if (recent5.length >= 2) {
        const lastVol   = candles[candles.length - 1].vol;
        const volChange = (lastVol - recent5[0].vol) / (recent5[0].vol || 1);
        const volTrend  = volChange > 0.3 ? oiScore : volChange > 0.1 ? oiScore * 0.5 : 0;
        sL += volTrend; sS += volTrend;
    }

    const recent20 = candles.slice(-21, -1);
    const avgVol   = recent20.length ? recent20.reduce((a, b) => a + b.vol, 0) / recent20.length : 0;
    const lastVol  = candles[candles.length - 1].vol;
    const vRat     = avgVol > 0 ? lastVol / avgVol : 0;

    return { scoreL: sL, scoreS: sS, volRatio: vRat, price: curP };
}

function btSimulatePosition(candles, entryIdx, side, config) {
    const entry    = candles[entryIdx].close;
    const stopPct  = config.stopPct  || 1.5;
    const trailAct = config.trailAct || 1.5;
    const trailPull= config.trailPull|| 0.5;
    const lev      = config.lev      || 1;
    const isL      = side === 'long';
    let pos = { peak: entry, trailActive: false, partialExitDone: false };
    let lastRoi = 0;

    for (let i = entryIdx + 1; i < candles.length; i++) {
        const price = candles[i].close;
        const roi   = (isL ? (price - entry) / entry : (entry - price) / entry) * 100 * lev;
        lastRoi = roi;
        if (roi <= -stopPct) return { result: 'stop', roi };

        const sc = btScoring(candles.slice(0, i + 1), config);
        if (!sc) continue;
        const longTrig    = sc.scoreL >= config.scoreMin && sc.volRatio >= config.volMin;
        const shortTrig   = sc.scoreS >= config.scoreMin && sc.volRatio >= config.volMin;
        const contraryTrig = isL ? shortTrig : longTrig;

        if (contraryTrig && roi >= 0 && !pos.trailActive) return { result: 'safety', roi };
        if (!pos.trailActive && roi >= trailAct) { pos.trailActive = true; pos.peak = price; }

        if (pos.trailActive) {
            if (isL && price > pos.peak) pos.peak = price;
            if (!isL && price < pos.peak) pos.peak = price;
            const pb = (isL ? (pos.peak - price) / pos.peak : (price - pos.peak) / pos.peak) * 100 * lev;
            if (contraryTrig) {
                if (!pos.partialExitDone) { pos.partialExitDone = true; continue; }
                return { result: 'trail_exit', roi };
            }
            if (pb >= trailPull) return { result: 'trail_exit', roi };
        }
    }
    return { result: 'timeout', roi: lastRoi };
}

async function backtestSymbol(symbol, config) {
    const candles = await fetchDayCandles(symbol);
    if (!candles || candles.length < 220) return { symbol, wr: 0, trades: 0, pnl: 0 };
    const { scoreMin, volMin } = config;
    let wins = 0, trades = 0, totalPnl = 0;

    for (let i = 200; i < candles.length - 1; i++) {
        const sc = btScoring(candles.slice(0, i + 1), config);
        if (!sc) continue;
        const longTrig  = sc.scoreL >= scoreMin && sc.volRatio >= volMin;
        const shortTrig = sc.scoreS >= scoreMin && sc.volRatio >= volMin;
        if (longTrig === shortTrig) continue;
        const side   = longTrig ? 'long' : 'short';
        const result = btSimulatePosition(candles, i, side, config);
        trades++; totalPnl += result.roi;
        if (result.result !== 'stop' && result.result !== 'timeout') wins++;
    }
    return { symbol, wr: trades > 0 ? wins / trades : 0, trades, pnl: totalPnl };
}

async function getTopMovers(limit = 20) {
    const [instRes, tickRes] = await Promise.all([
        bybitRequest('GET', '/v5/market/instruments-info', { category: 'linear' }),
        bybitRequest('GET', '/v5/market/tickers', { category: 'linear' })
    ]);
    const instruments = (instRes && instRes.result && instRes.result.list) || [];
    const tickers     = (tickRes && tickRes.result && tickRes.result.list) || [];
    const instSet = new Set();
    instruments.forEach(i => { if (i.quoteCoin === 'USDT' && i.status === 'Trading') instSet.add(i.symbol); });
    return tickers
        .filter(t => t.symbol.endsWith('USDT') && instSet.has(t.symbol))
        .map(t => ({ symbol: t.symbol, volUSD: (parseFloat(t.volume24h) || 0) * (parseFloat(t.lastPrice) || 0) }))
        .filter(t => t.volUSD >= 20000)
        .sort((a, b) => b.volUSD - a.volUSD)
        .slice(0, limit)
        .map(t => t.symbol);
}

// ─── Seleção de moeda por backtest ────────────────────────────────────────────

async function runCoinScan() {
    if (MONITOR.coinScan.running) return;
    MONITOR.coinScan.running = true;
    try {
        addLog('🔍 Backtest de seleção de moeda iniciado (últimas 24h, config vigente)...', 'info');
        const config = MONITOR.config;
        const movers = await getTopMovers(20);
        const candidates = new Set(movers);
        if (MONITOR.symbol) candidates.add(MONITOR.symbol);

        // Remove moedas da lista negra (acordo não assinado na Bybit)
        const blacklisted = new Set(MONITOR.symbolBlacklist);
        const filteredCandidates = [...candidates].filter(sym => !blacklisted.has(sym));
        if (blacklisted.size > 0)
            addLog(`⛔ Excluindo da lista negra: ${[...blacklisted].join(', ')}`, 'warn');

        const results = [];
        for (const sym of filteredCandidates) {
            try {
                const r = await backtestSymbol(sym, config);
                results.push(r);
                addLog(`📊 Backtest ${sym}: eficácia=${(r.wr * 100).toFixed(0)}% trades=${r.trades}`, 'info');
            } catch (e) {
                addLog(`⚠️ Backtest falhou para ${sym}: ${e.message}`, 'warn');
            }
        }

        results.sort((a, b) => (b.wr - a.wr) || (b.trades - a.trades));
        MONITOR.coinScan.results  = results;
        MONITOR.coinScan.lastScanAt = Date.now();

        if (!results.length) {
            addLog('⚠️ Backtest sem resultados. Mantendo moeda atual.', 'warn');
            return;
        }

        const best = results[0];
        MONITOR.coinScan.bestSymbol = best.symbol;
        MONITOR.coinScan.bestWr     = best.wr;

        if (MONITOR.position) {
            addLog('ℹ️ Posição aberta — troca de moeda será aplicada após fechamento.', 'info');
            return;
        }

        if (best.wr < 0.6) {
            MONITOR.tradingPaused = true;
            addLog(`⏸️ Nenhuma moeda com eficácia >= 60% (melhor: ${best.symbol} ${(best.wr * 100).toFixed(0)}%). Servidor NÃO vai operar.`, 'warn');
            return;
        }

        MONITOR.tradingPaused = false;
        const currentResult     = results.find(r => r.symbol === MONITOR.symbol);
        const currentIsStillBest = currentResult && currentResult.wr >= 0.6 && currentResult.wr >= best.wr - 1e-9;

        if (currentIsStillBest) {
            addLog(`✅ Moeda atual (${MONITOR.symbol}) continua com maior eficácia (${(currentResult.wr * 100).toFixed(0)}%). Mantendo.`, 'ok');
            // ← NOVO: confirma explicitamente qual moeda vai operar
            addLog(`🟢 SERVIDOR OPERANDO: ${MONITOR.symbol} | Eficácia: ${(currentResult.wr * 100).toFixed(0)}% | Trades (24h): ${currentResult.trades}`, 'ok');
        } else {
            const prevSymbol  = MONITOR.symbol;
            MONITOR.symbol    = best.symbol;
            addLog(`🔀 Trocando moeda: ${prevSymbol || '—'} → ${best.symbol} (eficácia ${(best.wr * 100).toFixed(0)}% > atual).`, 'ok');
            // ← NOVO: confirma explicitamente qual moeda vai operar
            addLog(`🟢 SERVIDOR OPERANDO: ${best.symbol} | Eficácia: ${(best.wr * 100).toFixed(0)}% | Trades (24h): ${best.trades}`, 'ok');
        }
    } finally {
        MONITOR.coinScan.running = false;
    }
}

// ─── Engine tick ──────────────────────────────────────────────────────────────

async function engineTick() {
    if (!MONITOR.active || !MONITOR.symbol) return;
    const data = await engineScoring();
    if (!data) return;
    const { scoreL, scoreS, volRatio, price } = data;
    const scoreMin = MONITOR.config.scoreMin || 50;
    const volMin   = MONITOR.config.volMin   || 1.0;
    const longTrig  = scoreL >= scoreMin && volRatio >= volMin;
    const shortTrig = scoreS >= scoreMin && volRatio >= volMin;

    if (longTrig || shortTrig)
        addLog(`🎯 GATILHO: scoreL=${scoreL.toFixed(0)} scoreS=${scoreS.toFixed(0)} volRatio=${volRatio.toFixed(2)} min=${scoreMin}/${volMin}`, 'info');

    if (!MONITOR.logCounter) MONITOR.logCounter = 0;
    MONITOR.logCounter++;
    if (MONITOR.logCounter % 60 === 0)
        // ← NOVO: símbolo ativo aparece no status periódico
        addLog(`📊 [${MONITOR.symbol}] scoreL=${scoreL.toFixed(0)}/${scoreMin} scoreS=${scoreS.toFixed(0)}/${scoreMin} volRatio=${volRatio.toFixed(2)}/${volMin} price=${price}`, 'info');

    // ─── Sem posição: entrada ─────────────────────────────────────────────────
    if (!MONITOR.position) {
        if (MONITOR.tradingPaused) return;
        if (longTrig && shortTrig) { addLog('⚖️ Conflito LONG/SHORT. Ignorando.', 'warn'); return; }
        if (longTrig) {
            addLog(`🚀 GATILHO LONG: scoreL=${scoreL.toFixed(0)} >= ${scoreMin}, volRatio=${volRatio.toFixed(2)} >= ${volMin}`, 'info');
            const qty = await placeOrder('long', MONITOR.config.orderQty);
            if (qty) {
                MONITOR.position = { side: 'long', entry: price, qty, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price, partialExitDone: false };
                addLog(`✅ ENTRADA LONG: qty=${qty} @ ${price}`, 'ok');
            } else addLog('❌ FALHA LONG: veja erro acima.', 'err');
        } else if (shortTrig) {
            addLog(`🚀 GATILHO SHORT: scoreS=${scoreS.toFixed(0)} >= ${scoreMin}, volRatio=${volRatio.toFixed(2)} >= ${volMin}`, 'info');
            const qty = await placeOrder('short', MONITOR.config.orderQty);
            if (qty) {
                MONITOR.position = { side: 'short', entry: price, qty, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price, partialExitDone: false };
                addLog(`✅ ENTRADA SHORT: qty=${qty} @ ${price}`, 'ok');
            } else addLog('❌ FALHA SHORT: veja erro acima.', 'err');
        }
        return;
    }

    // ─── Com posição: gestão ──────────────────────────────────────────────────
    const pos          = MONITOR.position;
    const isL          = pos.side === 'long';
    const roi          = (isL ? (price - pos.entry) / pos.entry : (pos.entry - price) / pos.entry) * 100 * (MONITOR.config.lev || 1);
    const contraryTrig = isL ? shortTrig : longTrig;
    const favorTrig    = isL ? longTrig  : shortTrig;

    // 1. Stop loss
    if (roi <= -MONITOR.config.stopPct) {
        const q = await placeOrder(isL ? 'short' : 'long', pos.qty, true);
        if (q !== null) { MONITOR.position = null; addLog(`❌ STOP LOSS em ${roi.toFixed(2)}%`, 'err'); }
        else addLog('⚠️ Stop Loss rejeitado. Tenta no próximo tick.', 'err');
        return;
    }

    // 2. Flip / segurança
    if (contraryTrig) {
        if (roi < 0) {
            addLog(`🔄 FLIP: ROI ${roi.toFixed(2)}%. Invertendo...`, 'warn');
            const closeQ = await placeOrder(isL ? 'short' : 'long', pos.qty, true);
            if (closeQ === null) { addLog('⚠️ FLIP: falha ao fechar. Aguarda próximo tick.', 'err'); return; }
            MONITOR.position = null;
            const newSide = isL ? 'short' : 'long';
            const qty = await placeOrder(newSide, MONITOR.config.orderQty);
            if (qty) {
                MONITOR.position = { side: newSide, entry: price, qty, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price, partialExitDone: false };
                addLog(`✅ NOVA POSIÇÃO ${newSide.toUpperCase()} @ ${price}`, 'ok');
            } else addLog('⚠️ FLIP: fechou mas falhou ao abrir nova. Flat.', 'warn');
            return;
        } else if (!pos.trailActive) {
            addLog(`💰 SEGURANÇA: Lucro ${roi.toFixed(2)}%. Fechando.`, 'ok');
            const q = await placeOrder(isL ? 'short' : 'long', pos.qty, true);
            if (q !== null) MONITOR.position = null;
            else addLog('⚠️ Segurança rejeitada. Tenta no próximo tick.', 'err');
            return;
        }
    }

    // 3. Aportes (scale-in, máx. 2)
    if (favorTrig && roi > 0.5 && pos.partialCount < 2) {
        const dist = Math.abs(price - pos.lastAportePrice) / pos.lastAportePrice * 100;
        if (dist >= 0.3) {
            const aporteQty = MONITOR.config.orderQty * (MONITOR.config.partialInPct / 100);
            const qty = await placeOrder(pos.side, aporteQty);
            if (qty) {
                pos.partialCount++; pos.qty += qty; pos.lastAportePrice = price;
                addLog(`📥 APORTE #${pos.partialCount} @ ${price} | +${qty} | Total: ${pos.qty.toFixed(6)}`, 'info');
            }
        }
    }

    // 4. Ativa trailing
    if (!pos.trailActive && roi >= MONITOR.config.trailAct) {
        pos.trailActive = true; pos.peak = price;
        addLog(`🎯 TRAILING ATIVADO em ${roi.toFixed(2)}% ROI`, 'ok');
    }

    // 5. Gestão de saída no trailing
    if (pos.trailActive) {
        if (contraryTrig) {
            if (!pos.partialExitDone) {
                const exitQty = pos.qty * (MONITOR.config.partialOutPct / 100);
                const q = await placeOrder(isL ? 'short' : 'long', exitQty, true);
                if (q) {
                    pos.qty -= q; pos.partialExitDone = true;
                    addLog(`📤 PARCIAL TRAILING: -${MONITOR.config.partialOutPct}% | Restante: ${pos.qty.toFixed(6)}`, 'info');
                } else addLog('⚠️ Parcial trailing rejeitada. Tenta no próximo tick.', 'err');
            } else {
                addLog('🏁 FECHAMENTO TRAILING: 2º sinal contrário.', 'ok');
                const q = await placeOrder(isL ? 'short' : 'long', pos.qty, true);
                if (q !== null) MONITOR.position = null;
                else addLog('⚠️ Fechamento final rejeitado. Tenta no próximo tick.', 'err');
                return;
            }
        }
        if (isL && price > pos.peak) pos.peak = price;
        if (!isL && price < pos.peak) pos.peak = price;
        const pb = (isL ? (pos.peak - price) / pos.peak : (price - pos.peak) / pos.peak) * 100;
        if (pb * (MONITOR.config.lev || 1) >= MONITOR.config.trailPull) {
            addLog(`🏁 RECUO TRAILING: ${pb.toFixed(2)}% do topo. Encerrando.`, 'ok');
            const q = await placeOrder(isL ? 'short' : 'long', pos.qty, true);
            if (q !== null) MONITOR.position = null;
            else addLog('⚠️ Fechamento por recuo rejeitado. Tenta no próximo tick.', 'err');
        }
    }
}

// ─── Trade lock ───────────────────────────────────────────────────────────────

async function withTradeLock(fn) {
    if (MONITOR.tradeLock) throw new Error('Engine ocupado. Tente novamente em instantes.');
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
            addLog('📊 Posição fechada. Reavaliando melhor moeda...', 'info');
            runCoinScan().catch(e => addLog(`⚠️ Erro backtest pós-fechamento: ${e.message}`, 'warn'));
        }
    } catch (e) {
        addLog(`💥 ERRO NO ENGINE: ${e.message}`, 'err');
    } finally {
        MONITOR.tradeLock = false;
    }
}, 5000);

// ─── Backtest periódico (10 min) ──────────────────────────────────────────────

setInterval(() => {
    if (MONITOR.active && !MONITOR.position && !MONITOR.coinScan.running) {
        addLog('⏱️ Backtest periódico (10 min)...', 'info');
        runCoinScan().catch(e => addLog(`⚠️ Erro backtest periódico: ${e.message}`, 'warn'));
    }
}, 10 * 60 * 1000);

// ─── Rede de segurança global ─────────────────────────────────────────────────

process.on('unhandledRejection', reason => {
    addLog(`💥 REJEIÇÃO NÃO TRATADA: ${reason && reason.message ? reason.message : String(reason)}`, 'err');
});
process.on('uncaughtException', err => {
    addLog(`💥 EXCEÇÃO NÃO CAPTURADA: ${err.message}`, 'err');
});

// ─── Auth opcional ────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
    const token = process.env.MONITOR_TOKEN;
    if (!token) return next();
    if (req.headers['x-monitor-token'] === token) return next();
    addLog('🔒 Acesso negado: token inválido.', 'warn');
    return res.status(401).json({ success: false, error: 'Não autorizado. Envie x-monitor-token.' });
}

// ─── Rotas ────────────────────────────────────────────────────────────────────

app.get('/status',    (req, res) => res.json(MONITOR));
app.get('/heartbeat', (req, res) => res.send('OK'));
app.get('/healthz',   (req, res) => res.json({ status: 'ok' }));

app.post('/sync-par', requireAuth, (req, res) => {
    const { symbol, active, config, position, forceEntry } = req.body || {};

    if (active) {
        const wasInactive = !MONITOR.active;
        MONITOR.active = true;
        MONITOR.symbol = symbol || MONITOR.symbol;

        if (config) {
            MONITOR.config = {
                stopPct:      parseFloat(config.stopPct)      || 1.5,
                trailAct:     parseFloat(config.trailAct)     || 1.5,
                trailPull:    parseFloat(config.trailPull)    || 0.5,
                lev:          parseInt(config.lev)            || 1,
                orderQty:     parseFloat(config.orderQty)     || 0.1,
                partialInPct: parseFloat(config.partialInPct) || 5,
                partialOutPct:parseFloat(config.partialOutPct)|| 50,
                emaScore:     parseFloat(config.emaScore)     || 40,
                vwapScore:    parseFloat(config.vwapScore)    || 30,
                oiScore:      parseFloat(config.oiScore)      || 20,
                volRatio:     parseFloat(config.volRatio)     || 1.2,
                scoreMin:     parseFloat(config.scoreMin)     || 50,
                volMin:       parseFloat(config.volMin)       || 1.0
            };
            addLog(`⚙️ CONFIG: scoreMin=${MONITOR.config.scoreMin} volMin=${MONITOR.config.volMin} lev=${MONITOR.config.lev}x qty=${MONITOR.config.orderQty}`, 'info');
        }

        if (position) {
            const entry = parseFloat(position.entry);
            const qty   = parseFloat(position.qty);
            const side  = (position.side || '').toLowerCase();
            if ((side !== 'long' && side !== 'short') || !isFinite(entry) || entry <= 0 || !isFinite(qty) || qty <= 0) {
                addLog(`⚠️ Posição inválida (side=${position.side}, entry=${position.entry}, qty=${position.qty}). Ignorando.`, 'warn');
            } else {
                MONITOR.position = { side, entry, qty, peak: parseFloat(position.peak) || entry, trailActive: !!position.trailActive, partialCount: 0, lastAportePrice: entry, partialExitDone: false };
                addLog(`📊 POSIÇÃO RESTAURADA: ${MONITOR.position.side.toUpperCase()} @ ${entry}, qty=${qty}`, 'info');
            }
        }

        checkCredentials();

        if (wasInactive || !MONITOR.coinScan.lastScanAt) {
            addLog('🔍 Iniciando backtest de seleção de moeda...', 'info');
            runCoinScan().catch(e => addLog(`⚠️ Erro backtest inicial: ${e.message}`, 'warn'));
        }

        if (forceEntry) {
            const feSide = (forceEntry.side || '').toLowerCase();
            if (feSide !== 'long' && feSide !== 'short') {
                addLog(`❌ ENTRADA FORÇADA: side inválido "${forceEntry.side}". Use "long" ou "short".`, 'err');
                return res.json({ success: true });
            }
            addLog(`⚡ FORÇAR ENTRADA: ${feSide.toUpperCase()}`, 'warn');
            placeOrder(feSide, MONITOR.config.orderQty).then(q => {
                if (q) {
                    MONITOR.position = { side: feSide, entry: MONITOR.indicators.price, qty: q, peak: MONITOR.indicators.price, trailActive: false, partialCount: 0, lastAportePrice: MONITOR.indicators.price, partialExitDone: false };
                    addLog(`✅ ENTRADA FORÇADA: ${feSide.toUpperCase()} qty=${q}`, 'ok');
                } else addLog('❌ FALHA NA ENTRADA FORÇADA.', 'err');
            }).catch(e => addLog(`💥 Erro entrada forçada: ${e.message}`, 'err'));
        }

        addLog(`🚀 MONITORAMENTO INICIADO: ${MONITOR.symbol}`, 'ok');
    } else {
        MONITOR.active = false;
        addLog('⏹️ MONITORAMENTO ENCERRADO', 'warn');
        if (MONITOR.position) {
            const pos = MONITOR.position;
            addLog('⏹️ Fechando posição aberta...', 'warn');
            withTradeLock(() => placeOrder(pos.side === 'long' ? 'short' : 'long', pos.qty, true))
                .then(q => {
                    if (q !== null) { MONITOR.position = null; addLog('✅ Posição fechada.', 'ok'); }
                    else addLog('🚨 CRÍTICO: falha ao fechar! Feche MANUALMENTE na Bybit e use POST /close-position.', 'err');
                })
                .catch(e => addLog(`⚠️ Fechamento adiado: ${e.message}`, 'warn'));
        }
    }
    res.json({ success: true });
});

app.post('/close-position', requireAuth, async (req, res) => {
    if (!MONITOR.position)
        return res.status(400).json({ success: false, error: 'Nenhuma posição aberta.' });
    try {
        const result = await withTradeLock(async () => {
            const pos = MONITOR.position;
            addLog(`📲 FECHAMENTO MANUAL: ${pos.side.toUpperCase()} ${pos.qty}`, 'warn');
            const q = await placeOrder(pos.side === 'long' ? 'short' : 'long', pos.qty, true);
            if (q !== null) { MONITOR.position = null; addLog(`✅ Fechado manualmente. Qty: ${q}`, 'ok'); }
            return q;
        });
        if (result !== null) return res.json({ success: true, closedQty: result });
        return res.status(500).json({ success: false, error: 'Falha ao fechar. Veja os logs.' });
    } catch (e) {
        return res.status(409).json({ success: false, error: e.message });
    }
});

// NOVA rota: limpa a lista negra de moedas bloqueadas (retCode 110126)
app.post('/clear-blacklist', requireAuth, (req, res) => {
    const cleared = [...MONITOR.symbolBlacklist];
    MONITOR.symbolBlacklist = [];
    addLog(`🔓 Lista negra limpa. Removidos: ${cleared.join(', ') || 'nenhum'}`, 'info');
    res.json({ success: true, cleared });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`Scanner Pro v9.7 CORRIGIDO na porta ${PORT}`);
    checkCredentials();
});
