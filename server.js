// ╔══════════════════════════════════════════════════════════════════════╗
// ║   BYBIT SCANNER PRO — SERVER v9.9 (LÓGICA DE OPERAÇÃO CORRIGIDA)      ║
// ║   Correções: Segurança/Aportes só antes do trailing, Saídas parciais  ║
// ║   em 2 etapas após o trailing, Backtest com a mesma lógica do robô,   ║
// ║   Scanner sempre adota a moeda mais eficiente (sem piso de WR),       ║
// ║   Re-scan automático toda vez que uma posição é fechada.              ║
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
        // Gatilhos (Sincronizados com a aba "Gatilhos" do App)
        emaScore: 40, 
        vwapScore: 30, 
        oiScore: 20,
        scoreMin: 70, // vindo do entrySc do App
        volMin: 1.5,  // vindo do volRatio do App
        
        // Operação (Sincronizados com "Configurar Par" e "Configurações")
        stopPct: 1.5, 
        trailAct: 1.5, 
        trailPull: 0.5,
        lev: 1, 
        orderQty: 0.1, 
        partialInPct: 5, 
        partialOutPct: 50,
        bankPct: 30
    },
    position: null,
    indicators: { scoreL: 0, scoreS: 0, volRatio: 0, price: 0 },
    logs: [],
    tradingPaused: false,
    symbolBlacklist: [],
    logCounter: 0,
    coinScan: {
        running: false, lastScanAt: 0,
        results: [], bestSymbol: null, bestWr: 0
    },
    trades: [], 
    balance: 0 
};

// ─── Log ──────────────────────────────────────────────────────────────────────

function addLog(msg, type = 'info') {
    const ts = new Date().toLocaleTimeString('pt-BR');
    MONITOR.logs.unshift({ time: Date.now(), msg: `[${ts}] ${msg}`, type });
    if (MONITOR.logs.length > 100) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ─── Registro de Trades ────────────────────────────────────────────────────────

function recordTrade(position, exitPrice, reason) {
    if (!position) return;
    const trade = {
        symbol: MONITOR.symbol,
        side: position.side,
        pnl: position.curPnl || 0,
        entry: position.entry,
        exit: exitPrice,
        entryTime: position.entryTime || Date.now(),
        exitTime: Date.now(),
        reason: reason,
        score: Math.max(MONITOR.indicators.scoreL, MONITOR.indicators.scoreS)
    };
    MONITOR.trades.unshift(trade);
    if (MONITOR.trades.length > 50) MONITOR.trades.pop();
    addLog(`📊 Trade registrado: ${trade.symbol} ${trade.side.toUpperCase()} PnL: ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)} USDT (${reason})`, trade.pnl >= 0 ? 'ok' : 'err');
}

// ─── Bybit API ────────────────────────────────────────────────────────────────

async function bybitRequest(method, endpoint, data = {}) {
    try {
        const key    = process.env.BYBIT_API_KEY;
        const secret = process.env.BYBIT_API_SECRET;
        if (!key || !secret) return { error: 'missing_credentials' };
        const timestamp  = Date.now().toString();
        const baseUrl    = process.env.USE_TESTNET === 'true' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
        const parameters = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
        const sign = crypto.createHmac('sha256', secret).update(timestamp + key + '5000' + parameters).digest('hex');
        const res = await axios({
            method, url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: { 'X-BAPI-API-KEY': key, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': '5000', ...(method !== 'GET' && { 'Content-Type': 'application/json' }) },
            data: method !== 'GET' ? parameters : undefined, timeout: 8000,
        });
        return res.data;
    } catch (e) { return { error: e.message }; }
}

// ─── Ordem ────────────────────────────────────────────────────────────────────

async function placeOrder(side, qty, isReduce = false) {
    if (!MONITOR.symbol) return null;
    let finalQty = qty;
    const info = await bybitRequest('GET', '/v5/market/instruments-info', { category: 'linear', symbol: MONITOR.symbol });
    if (info?.result?.list?.[0]) {
        const limits = info.result.list[0].lotSizeFilter;
        const step = parseFloat(limits.qtyStep);
        const precision = Math.max(0, Math.round(-Math.log10(step)));
        const currentPrice = MONITOR.indicators.price || 0;
        if (!isReduce && currentPrice > 0) {
            const minQtyForNotional = Math.ceil((5.2 / currentPrice) / step) * step;
            if (finalQty < minQtyForNotional) finalQty = minQtyForNotional;
        }
        finalQty = Math.floor(finalQty / step) * step;
        finalQty = parseFloat(finalQty.toFixed(precision));
    }
    const res = await bybitRequest('POST', '/v5/order/create', {
        category: 'linear', symbol: MONITOR.symbol, side: side.toLowerCase() === 'long' ? 'Buy' : 'Sell',
        orderType: 'Market', qty: finalQty.toString(), timeInForce: 'GTC', reduceOnly: isReduce,
    });
    if (res?.retCode === 0) return finalQty;
    if (res?.retCode === 110126) {
        if (!MONITOR.symbolBlacklist.includes(MONITOR.symbol)) MONITOR.symbolBlacklist.push(MONITOR.symbol);
        addLog(`🚫 ${MONITOR.symbol} exige acordo. Bloqueada.`, 'err');
        MONITOR.tradingPaused = true;
        runCoinScan().catch(()=>{});
    }
    return null;
}

// ─── Sincronização ────────────────────────────────────────────────────────────

async function syncBalance() {
    try {
        const res = await bybitRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
        if (res?.retCode === 0 && res.result?.list?.[0]) {
            const wallet = res.result.list[0];
            MONITOR.balance = parseFloat(wallet.coin?.find(c => c.coin === 'USDT')?.walletBalance || 0);
        }
    } catch (e) {}
}

async function syncPositionWithBybit() {
    if (!MONITOR.symbol || !MONITOR.active) return;
    try {
        const res = await bybitRequest('GET', '/v5/position/list', { category: 'linear', symbol: MONITOR.symbol });
        if (res?.retCode === 0 && res.result?.list?.length > 0) {
            const bPos = res.result.list[0];
            const size = parseFloat(bPos.size);
            if (size > 0) {
                if (!MONITOR.position) {
                    MONITOR.position = {
                        side: bPos.side === 'Buy' ? 'long' : 'short', entry: parseFloat(bPos.avgPrice),
                        qty: size, peak: parseFloat(bPos.markPrice), trailActive: false, partialCount: 0,
                        lastAportePrice: parseFloat(bPos.avgPrice), partialExitDone: false, partialExitCount: 0,
                        entryTime: Date.now(), maxPartials: 2
                    };
                }
                const pnl = parseFloat(bPos.unrealisedPnl);
                const value = parseFloat(bPos.positionValue);
                const lev = parseFloat(bPos.leverage) || MONITOR.config.lev;
                MONITOR.position.qty = size;
                MONITOR.position.entry = parseFloat(bPos.avgPrice);
                MONITOR.position.curPnl = pnl;
                MONITOR.position.valueUSDT = value;
                MONITOR.position.curRoi = (pnl / (value / lev)) * 100;
            } else if (MONITOR.position) {
                recordTrade(MONITOR.position, MONITOR.indicators.price, 'closed_bybit');
                addLog('🏁 Posição encerrada na corretora.', 'info');
                MONITOR.position = null;
                runCoinScan().catch(() => {});
            }
        }
    } catch (e) {}
}

// ─── Cálculos Técnicos ────────────────────────────────────────────────────────

function calcEMA(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
    return ema;
}

async function engineScoring() {
    if (!MONITOR.symbol) return null;
    const kRes = await bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '201' });
    if (!kRes?.result?.list?.length) return null;
    const list = [...kRes.result.list].reverse();
    const prices = list.map(k => parseFloat(k[4]));
    const curP = prices[prices.length - 1];
    const ema200 = calcEMA(prices, 200);
    
    let sL = curP > ema200 ? MONITOR.config.emaScore : 0, sS = curP < ema200 ? MONITOR.config.emaScore : 0;
    let vSum = 0, volSum = 0;
    list.slice(-50).forEach(k => { vSum += ((parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3) * parseFloat(k[5]); volSum += parseFloat(k[5]); });
    const vwap = volSum > 0 ? vSum / volSum : curP;
    sL += curP > vwap ? MONITOR.config.vwapScore : 0; sS += curP < vwap ? MONITOR.config.vwapScore : 0;
    
    const oiRes = await bybitRequest('GET', '/v5/market/open-interest', { category: 'linear', symbol: MONITOR.symbol, intervalTime: '5min', limit: '2' });
    if (oiRes?.result?.list?.length >= 2) {
        if (parseFloat(oiRes.result.list[0].openInterest) > parseFloat(oiRes.result.list[1].openInterest)) {
            if (curP > prices[prices.length - 2]) sL += MONITOR.config.oiScore; else if (curP < prices[prices.length - 2]) sS += MONITOR.config.oiScore;
        }
    }
    const avgVol = list.slice(-21, -1).reduce((a, b) => a + parseFloat(b[5]), 0) / 20;
    MONITOR.indicators = { scoreL: sL, scoreS: sS, volRatio: avgVol > 0 ? parseFloat(list[list.length - 1][5]) / avgVol : 0, price: curP };
    return MONITOR.indicators;
}

// ─── Backtest Logic ───────────────────────────────────────────────────────────

async function fetchDayCandles(symbol) {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let all = [], endTime = Date.now();
    for (let page = 0; page < 3; page++) {
        const kRes = await bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol, interval: '1', end: String(endTime), limit: '1000' });
        if (!kRes?.result?.list?.length) break;
        all = all.concat(kRes.result.list);
        const oldestTs = parseFloat(kRes.result.list[kRes.result.list.length - 1][0]);
        if (oldestTs <= oneDayAgo) break;
        endTime = oldestTs - 1;
    }
    return all.reverse().map(k => ({ time: parseFloat(k[0]), close: parseFloat(k[4]), vol: parseFloat(k[5]), high: parseFloat(k[2]), low: parseFloat(k[3]) }));
}

function btScoring(candles, config) {
    if (candles.length < 200) return null;
    const closes = candles.map(c => c.close), curP = closes[closes.length - 1];
    const ema200 = calcEMA(closes, 200);
    let sL = curP > ema200 ? config.emaScore : 0, sS = curP < ema200 ? config.emaScore : 0;
    let vSum = 0, volSum = 0; candles.slice(-50).forEach(c => { vSum += ((c.high + c.low + c.close) / 3) * c.vol; volSum += c.vol; });
    const vwap = volSum > 0 ? vSum / volSum : curP;
    sL += curP > vwap ? config.vwapScore : 0; sS += curP < vwap ? config.vwapScore : 0;
    const avgVol = candles.slice(-21, -1).reduce((a, b) => a + b.vol, 0) / 20;
    return { scoreL: sL, scoreS: sS, volRatio: avgVol > 0 ? candles[candles.length - 1].vol / avgVol : 0 };
}

// Reaproveita btScoring (sem alterá-la) para calcular o score em QUALQUER índice
// do array de candles, usando uma janela final de até 250 velas (suficiente para
// estabilizar a EMA200) terminando naquele índice. Necessário para simular, vela
// a vela, a mesma lógica de gatilho contrário/favorável usada ao vivo pelo engineTick.
function btScoringAt(candles, idx, config) {
    if (idx < 200) return null;
    const start = Math.max(0, idx - 250);
    return btScoring(candles.slice(start, idx + 1), config);
}

// Simula a posição usando EXATAMENTE a mesma lógica do engineTick:
//  - Stop loss tem prioridade máxima.
//  - Antes do trailing ativar: gatilho contrário + ROI positivo fecha tudo (segurança).
//  - Antes do trailing ativar: gatilho a favor + ROI positivo faria aporte (não altera
//    a classificação de resultado do backtest, que é só win/loss).
//  - Depois do trailing ativar: recuo (pull) atingido fecha tudo (trailing stop).
//  - Depois do trailing ativar e recuo não atingido: gatilho contrário fecha 50%,
//    se repetir fecha o restante (100%).
function btSimulatePosition(candles, entryIdx, side, config) {
    const entry = candles[entryIdx].close;
    const isL = side === 'long';
    let pos = { peak: entry, trailActive: false, partialExitCount: 0 };

    const maxStep = Math.min(entryIdx + 60, candles.length); // janela de simulação (60 velas ~ suficiente)
    for (let i = entryIdx + 1; i < maxStep; i++) {
        const price = candles[i].close;
        const roi = (isL ? (price - entry) / entry : (entry - price) / entry) * 100 * config.lev;

        // Stop loss — prioridade máxima
        if (roi <= -config.stopPct) return { result: 'stop', roi: -config.stopPct };

        const sc = btScoringAt(candles, i, config);
        const lTrig = !!sc && sc.scoreL >= config.scoreMin && sc.volRatio >= config.volMin;
        const sTrig = !!sc && sc.scoreS >= config.scoreMin && sc.volRatio >= config.volMin;
        // Não considera gatilho quando os dois lados disparam ao mesmo tempo (igual ao engineTick)
        const bothTrig = lTrig && sTrig;
        const contrary = !bothTrig && (isL ? sTrig : lTrig);

        if (!pos.trailActive) {
            // Segurança: positiva + contrário + trailing ainda não ativo → fecha tudo
            if (contrary && roi >= 0) return { result: 'safety', roi };
            // Ativação do trailing
            if (roi >= config.trailAct) { pos.trailActive = true; pos.peak = price; }
            continue;
        }

        // Trailing já ativo — atualiza pico
        if (isL && price > pos.peak) pos.peak = price;
        else if (!isL && price < pos.peak) pos.peak = price;
        const pull = (isL ? (pos.peak - price) / pos.peak : (price - pos.peak) / pos.peak) * 100 * config.lev;

        // Recuo atingido → fecha o restante
        if (pull >= config.trailPull) return { result: 'trail', roi };

        // Recuo ainda não atingido, mas veio gatilho contrário → saída parcial em 2 etapas
        if (contrary) {
            pos.partialExitCount = (pos.partialExitCount || 0) + 1;
            if (pos.partialExitCount >= 2) return { result: 'contrary_partial_final', roi };
            // primeira parcial (50%): posição continua aberta com o restante
        }
    }
    return { result: 'timeout', roi: 0 };
}

async function runCoinScan() {
    if (MONITOR.coinScan.running) return;
    MONITOR.coinScan.running = true;
    // Guarda a moeda que estava selecionada/em operação ANTES deste escaneamento
    // (é a que o app escolheu no backtest dele, ou a que o servidor já vinha operando).
    const originalSymbol = MONITOR.symbol;
    try {
        const c = MONITOR.config;
        addLog(`🔍 Scanner: iniciando backtest do último dia — Gatilho EMA${c.emaScore}+VWAP${c.vwapScore}+OI${c.oiScore} | Score≥${c.scoreMin} Vol≥${c.volMin} | SL${c.stopPct}% Trail+${c.trailAct}%/-${c.trailPull}% | Lev${c.lev}x Banca${c.bankPct}% | moeda atual: ${originalSymbol || '—'}`, 'info');

        const tickRes = await bybitRequest('GET', '/v5/market/tickers', { category: 'linear' });
        const movers = (tickRes?.result?.list || [])
            .filter(t => t.symbol.endsWith('USDT') && !MONITOR.symbolBlacklist.includes(t.symbol))
            .sort((a, b) => (parseFloat(b.volume24h)*parseFloat(b.lastPrice)) - (parseFloat(a.volume24h)*parseFloat(a.lastPrice)))
            .slice(0, 15).map(m => m.symbol);
        addLog(`🔍 Scanner: ${movers.length} pares por volume selecionados para testar: ${movers.join(', ')}`, 'info');

        const results = [];
        for (const sym of movers) {
            const candles = await fetchDayCandles(sym);
            if (candles.length < 220) { addLog(`⏭️ Scanner: ${sym} sem candles suficientes do último dia — pulado`, 'info'); continue; }
            let wins = 0, total = 0;
            for (let i = 200; i < candles.length - 20; i += 5) {
                const sc = btScoring(candles.slice(0, i + 1), MONITOR.config);
                const lTrig = sc.scoreL >= MONITOR.config.scoreMin && sc.volRatio >= MONITOR.config.volMin;
                const sTrig = sc.scoreS >= MONITOR.config.scoreMin && sc.volRatio >= MONITOR.config.volMin;
                // Igual ao engineTick: se os dois lados dispararem juntos, não é considerado gatilho de entrada
                if (lTrig && sTrig) continue;
                if (lTrig || sTrig) {
                    const res = btSimulatePosition(candles, i, lTrig ? 'long' : 'short', MONITOR.config);
                    total++; if (res.result !== 'stop') wins++;
                }
            }
            if (total > 0) {
                const wr = wins / total;
                results.push({ symbol: sym, wr, n: total });
                addLog(`📊 Scanner: ${sym} → WR ${(wr*100).toFixed(1)}% (${total} trades simulados com o gatilho/lógica configurados)`, 'info');
            } else {
                addLog(`⚪ Scanner: ${sym} — nenhum gatilho de entrada válido no último dia com essa configuração`, 'info');
            }
        }
        results.sort((a, b) => b.wr - a.wr);
        MONITOR.coinScan.results = results;
        MONITOR.coinScan.lastScanAt = Date.now();

        if (results.length > 0) {
            const best = results[0];
            MONITOR.coinScan.bestSymbol = best.symbol; MONITOR.coinScan.bestWr = best.wr;
            addLog(`🏆 Scanner: moeda mais eficiente do último dia → ${best.symbol} (WR ${(best.wr*100).toFixed(1)}% em ${best.n} trades)`, 'ok');

            if (!MONITOR.position) {
                if (originalSymbol === best.symbol) {
                    addLog(`✅ Scanner: ${best.symbol} já era a moeda selecionada/operada — CONFIRMADA como a mais eficiente. Mantendo operação nela.`, 'ok');
                } else {
                    addLog(`🔀 Scanner: ${originalSymbol || 'nenhuma moeda'} NÃO é a mais eficiente → trocando para ${best.symbol} (WR ${(best.wr*100).toFixed(1)}%). Servidor assume operação nela.`, 'ok');
                    MONITOR.symbol = best.symbol;
                }
                MONITOR.tradingPaused = false;
            } else {
                addLog(`⏸️ Scanner: posição aberta em ${MONITOR.symbol} — resultado registrado, troca de moeda só ocorre com a posição fechada.`, 'info');
            }
        } else {
            addLog(`⚠️ Scanner: nenhum par com gatilho válido no último dia — mantendo ${originalSymbol || 'nenhuma moeda'} até o próximo escaneamento.`, 'warn');
        }
    } finally { MONITOR.coinScan.running = false; }
}

// ─── Engine Tick ──────────────────────────────────────────────────────────────

async function engineTick() {
    if (!MONITOR.active || !MONITOR.symbol) return;
    await syncBalance();
    await syncPositionWithBybit();
    const data = await engineScoring(); if (!data) return;
    const { scoreL, scoreS, volRatio, price } = data;
    const { scoreMin, volMin, stopPct, trailAct, trailPull, lev, bankPct } = MONITOR.config;

    if (!MONITOR.position) {
        if (MONITOR.tradingPaused) return;
        const lTrig = scoreL >= scoreMin && volRatio >= volMin;
        const sTrig = scoreS >= scoreMin && volRatio >= volMin;
        // Os dois lados dispararam ao mesmo tempo → não entra, espera só um lado confirmar
        if (lTrig && sTrig) return;

        const side = lTrig ? 'long' : (sTrig ? 'short' : null);
        if (side) {
            let qty = MONITOR.config.orderQty;
            const positionValue = (MONITOR.balance * (bankPct / 100)) * lev;
            if (positionValue > 0 && price > 0) qty = positionValue / price;

            const executedQty = await placeOrder(side, qty);
            if (executedQty) {
                MONITOR.position = {
                    side, entry: price, qty: executedQty, peak: price, trailActive: false,
                    partialCount: 0, lastAportePrice: price, partialExitDone: false, partialExitCount: 0,
                    entryTime: Date.now(), maxPartials: 2, initialQty: executedQty
                };
                addLog(`📥 Entrada ${side.toUpperCase()}: ${executedQty.toFixed(4)} @ ${price.toFixed(4)}`, 'ok');
            }
        }
        return;
    }

    const pos = MONITOR.position, isL = pos.side === 'long';
    const roi = pos.curRoi !== undefined ? pos.curRoi : (isL ? (price - pos.entry) / pos.entry : (pos.entry - price) / pos.entry) * 100 * lev;

    // ── STOP LOSS — prioridade máxima, sempre verificado primeiro ──────────────
    if (roi <= -stopPct) {
        if (await placeOrder(isL ? 'short' : 'long', pos.qty, true)) {
            recordTrade(pos, price, 'stop_loss');
            MONITOR.position = null;
            runCoinScan().catch(() => {}); // reavalia a moeda mais eficiente após fechar
        }
        return;
    }

    const lTrigNow = scoreL >= scoreMin && volRatio >= volMin;
    const sTrigNow = scoreS >= scoreMin && volRatio >= volMin;
    const bothTrigNow = lTrigNow && sTrigNow; // ambos ao mesmo tempo não conta como gatilho válido
    const contrary = !bothTrigNow && (isL ? sTrigNow : lTrigNow);
    const sameDir  = !bothTrigNow && (isL ? lTrigNow : sTrigNow);

    if (!pos.trailActive) {
        // ── SEGURANÇA: positiva + gatilho contrário + trailing ainda não ativo → fecha tudo ──
        if (contrary && roi >= 0) {
            if (await placeOrder(isL ? 'short' : 'long', pos.qty, true)) {
                recordTrade(pos, price, 'contrary_signal');
                MONITOR.position = null;
                runCoinScan().catch(() => {});
            }
            return;
        }

        // ── APORTE PARCIAL (máx. 2, só antes do trailing ativar) ────────────────
        // Respeita o % configurado na aba "Configurar Par"; se a banca for pequena,
        // ainda assim garante o notional mínimo exigido pela Bybit (5.2 USDT).
        if (sameDir && roi > 0 && pos.partialCount < 2) {
            const pVal = (MONITOR.balance * (MONITOR.config.partialInPct / 100)) * lev;
            let pQty = pVal / price;
            if (pQty * price < 5.2) pQty = 5.2 / price;
            const exe = await placeOrder(pos.side, pQty);
            if (exe) { pos.qty += exe; pos.partialCount++; addLog(`📈 Aporte ${pos.partialCount}/2: +${exe.toFixed(4)}`, 'ok'); }
        }

        // ── ATIVAÇÃO DO TRAILING ─────────────────────────────────────────────────
        if (roi >= trailAct) {
            pos.trailActive = true;
            pos.peak = price;
            addLog(`🚀 Trailing ativo @ ${price}`, 'ok');
        }
        return;
    }

    // ── TRAILING JÁ ATIVO ──────────────────────────────────────────────────────
    if (isL && price > pos.peak) pos.peak = price;
    else if (!isL && price < pos.peak) pos.peak = price;

    const pull = (isL ? (pos.peak - price) / pos.peak : (price - pos.peak) / pos.peak) * 100 * lev;

    // Recuo atingido → fecha o restante da posição (trailing stop)
    if (pull >= trailPull) {
        if (await placeOrder(isL ? 'short' : 'long', pos.qty, true)) {
            recordTrade(pos, price, 'trailing_stop');
            MONITOR.position = null;
            runCoinScan().catch(() => {});
        }
        return;
    }

    // Recuo ainda não atingido, mas apareceu gatilho contrário → saída parcial em 2 etapas
    if (contrary) {
        if ((pos.partialExitCount || 0) === 0) {
            // 1ª parcial: fecha o % configurado em "Configurar Par" (padrão 50%)
            const exitFrac = Math.min(0.95, Math.max(0.05, (MONITOR.config.partialOutPct || 50) / 100));
            const exitQty = pos.qty * exitFrac;
            const exe = await placeOrder(isL ? 'short' : 'long', exitQty, true);
            if (exe) {
                pos.qty -= exe;
                pos.partialExitCount = 1;
                addLog(`📤 Saída parcial 1/2 (${(exitFrac*100).toFixed(0)}%) por sinal contrário: -${exe.toFixed(4)}`, 'ok');
            }
        } else if (pos.partialExitCount === 1) {
            // 2ª parcial: fecha o restante (os outros 50%, ou o que sobrou)
            if (await placeOrder(isL ? 'short' : 'long', pos.qty, true)) {
                recordTrade(pos, price, 'contrary_partial_final');
                addLog(`📤 Saída parcial 2/2 (restante) por sinal contrário — posição encerrada`, 'ok');
                MONITOR.position = null;
                runCoinScan().catch(() => {});
            }
        }
    }
}

// ─── Loops & Rotas ────────────────────────────────────────────────────────────

setInterval(async () => {
    if (MONITOR.tradeLock) return; MONITOR.tradeLock = true;
    try { await engineTick(); } catch (e) {} finally { MONITOR.tradeLock = false; }
}, 5000);

setInterval(() => { if (MONITOR.active && !MONITOR.position) runCoinScan(); }, 10 * 60 * 1000);

app.get('/status', (req, res) => res.json(MONITOR));

app.post('/sync-par', (req, res) => {
    const { symbol, active, config, position } = req.body;
    if (active) {
        MONITOR.active = true; 
        if (symbol) MONITOR.symbol = symbol;
        if (config) {
            // IMPORTANTE: o app (parHandoverToServer) envia os campos como
            // `scoreMin`, `stopPct` e `volMin`/`volRatio` — não `entrySc`/`sl`.
            // Aceita os dois formatos (novo primeiro, com fallback pro nome antigo)
            // para nunca cair silenciosamente no valor padrão ignorando o que o
            // usuário configurou na aba Par → Gatilho de Entrada / Configurar Par.
            const scoreMinIn = (config.scoreMin !== undefined ? config.scoreMin : config.entrySc);
            const stopPctIn  = (config.stopPct  !== undefined ? config.stopPct  : config.sl);
            // O app tem 2 campos de volume ("Volume Ratio Mínimo" e "Volume Mínimo
            // Absoluto"); o motor só usa 1 limiar (volRatio >= volMin), então usamos
            // o mais restritivo (maior) dos dois configurados, garantindo que ambos
            // os critérios definidos pelo usuário sejam respeitados.
            const volCandidates = [config.volMin, config.volRatio].filter(v => v !== undefined && v !== null && !isNaN(v));
            const volMinIn = volCandidates.length ? Math.max(...volCandidates) : undefined;

            MONITOR.config = {
                ...MONITOR.config,
                emaScore: config.emaScore || 40,
                vwapScore: config.vwapScore || 30,
                oiScore: config.oiScore || 20,
                scoreMin: (scoreMinIn !== undefined ? scoreMinIn : 70),
                volMin: (volMinIn !== undefined ? volMinIn : 1.5),
                stopPct: (stopPctIn !== undefined ? stopPctIn : 1.5),
                trailAct: config.trailAct || 1.5,
                trailPull: config.trailPull || 0.5,
                lev: config.lev || 1,
                bankPct: config.bankPct || 30,
                partialInPct: config.partialInPct || 5,
                partialOutPct: config.partialOutPct || 50
            };
            addLog(`⚙️ Config sincronizada: Score≥${MONITOR.config.scoreMin} Vol≥${MONITOR.config.volMin} SL${MONITOR.config.stopPct}% Trail+${MONITOR.config.trailAct}%/-${MONITOR.config.trailPull}% Lev${MONITOR.config.lev}x Banca${MONITOR.config.bankPct}%`, 'info');
        }
        if (position) {
            MONITOR.position = { 
                ...position, lastAportePrice: position.entry, partialExitDone: false, 
                partialCount: 0, partialExitCount: 0, entryTime: Date.now(), maxPartials: 2, initialQty: position.qty 
            };
        }
        // Roda o backtest do servidor com a MESMA lógica configurada acima. Se a moeda
        // escolhida pelo app não for a mais eficiente encontrada, o servidor assume a
        // que for melhor (ver runCoinScan). Se for a mesma, mantém.
        runCoinScan();
    } else {
        MONITOR.active = false; MONITOR.symbol = null; MONITOR.position = null;
        addLog('🛑 Servidor desativado pelo app', 'info');
    }
    res.json({ success: true });
});

app.listen(PORT, () => { console.log(`Scanner Pro v9.9 ativo na porta ${PORT}`); });
