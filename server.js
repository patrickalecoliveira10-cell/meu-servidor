// ╔══════════════════════════════════════════════════════════════════════╗
// ║   BYBIT SCANNER PRO — SERVER v9.8 (ROI & USDT REAL SYNC + HISTÓRICO) ║
// ║   Correções: Sincronia de PnL, ROI, Valor Nocional real e HISTÓRICO    ║
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
        volRatio: 1.2, scoreMin: 50, volMin: 1.0,
        bankPct: 30 // NOVO: Porcentagem da banca para calcular tamanho da posição
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
    trades: [], // NOVO: Histórico de operações fechadas
    balance: 0 // NOVO: Saldo atual para cálculo de posição parcial
};

// ─── Log ──────────────────────────────────────────────────────────────────────

function addLog(msg, type = 'info') {
    const ts = new Date().toLocaleTimeString('pt-BR');
    MONITOR.logs.unshift({ time: Date.now(), msg: `[${ts}] ${msg}`, type });
    if (MONITOR.logs.length > 100) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ─── Registro de Trades (NOVO) ─────────────────────────────────────────────────

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
        score: MONITOR.indicators.scoreL > MONITOR.indicators.scoreS 
            ? MONITOR.indicators.scoreL 
            : MONITOR.indicators.scoreS
    };
    
    MONITOR.trades.unshift(trade);
    if (MONITOR.trades.length > 50) MONITOR.trades.pop(); // Mantém últimos 50 trades
    
    addLog(`📊 Trade registrado: ${trade.symbol} ${trade.side.toUpperCase()} PnL: ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)} USDT (${reason})`, trade.pnl >= 0 ? 'ok' : 'err');
}

// ─── Credenciais ──────────────────────────────────────────────────────────────

function checkCredentials() {
    if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET) {
        addLog('🚨 CRÍTICO: API Keys não configuradas!', 'err');
        return false;
    }
    return true;
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
    } catch (e) {
        return { error: e.message };
    }
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
        const sym = MONITOR.symbol;
        if (!MONITOR.symbolBlacklist.includes(sym)) MONITOR.symbolBlacklist.push(sym);
        addLog(`🚫 ${sym} exige acordo. Bloqueada.`, 'err');
        MONITOR.tradingPaused = true;
        runCoinScan().catch(()=>{});
    }
    return null;
}

// ─── Sincronização de Saldo (NOVO) ─────────────────────────────────────────────

async function syncBalance() {
    try {
        const res = await bybitRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
        if (res?.retCode === 0 && res.result?.list?.[0]) {
            const wallet = res.result.list[0];
            const usdtBalance = parseFloat(wallet.coin?.find(c => c.coin === 'USDT')?.walletBalance || 0);
            MONITOR.balance = usdtBalance;
        }
    } catch (e) {}
}

// ─── Sincronização de Posição Real (NOVO) ─────────────────────────────────────

async function syncPositionWithBybit() {
    if (!MONITOR.symbol) return;
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
                        lastAportePrice: parseFloat(bPos.avgPrice), partialExitDone: false,
                        entryTime: Date.now(), // NOVO: Registra tempo de entrada
                        maxPartials: 2 // NOVO: Limite de 2 parciais
                    };
                }
                // Atribui os dados REAIS vindos da Bybit para o App ler
                const pnl = parseFloat(bPos.unrealisedPnl);
                const value = parseFloat(bPos.positionValue);
                const lev = parseFloat(bPos.leverage) || MONITOR.config.lev;
                MONITOR.position.qty = size;
                MONITOR.position.entry = parseFloat(bPos.avgPrice);
                MONITOR.position.curPnl = pnl;
                MONITOR.position.valueUSDT = value; // USDT real da posição
                MONITOR.position.curRoi = (pnl / (value / lev)) * 100; // ROI real da Bybit
            } else if (MONITOR.position) {
                // NOVO: Registra trade quando posição fecha na corretora
                recordTrade(MONITOR.position, MONITOR.indicators.price, 'closed_bybit');
                addLog('🏁 Posição encerrada na corretora.', 'info');
                MONITOR.position = null;
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

function btSimulatePosition(candles, entryIdx, side, config) {
    const entry = candles[entryIdx].close; let pos = { peak: entry, trailActive: false };
    for (let i = entryIdx + 1; i < candles.length; i++) {
        const price = candles[i].close, roi = (side === 'long' ? (price - entry) / entry : (entry - price) / entry) * 100 * config.lev;
        if (roi <= -config.stopPct) return { result: 'stop', roi };
        if (!pos.trailActive && roi >= config.trailAct) pos.trailActive = true;
        if (pos.trailActive) {
            if (side === 'long' && price > pos.peak) pos.peak = price; else if (side === 'short' && price < pos.peak) pos.peak = price;
            if ((side === 'long' ? (pos.peak - price) / pos.peak : (price - pos.peak) / pos.peak) * 100 * config.lev >= config.trailPull) return { result: 'trail', roi };
        }
    }
    return { result: 'timeout', roi: 0 };
}

async function runCoinScan() {
    if (MONITOR.coinScan.running) return;
    MONITOR.coinScan.running = true;
    try {
        addLog('🔍 Scanner: Iniciando backtest 24h...', 'info');
        const tickRes = await bybitRequest('GET', '/v5/market/tickers', { category: 'linear' });
        const movers = (tickRes?.result?.list || []).filter(t => t.symbol.endsWith('USDT') && !MONITOR.symbolBlacklist.includes(t.symbol)).sort((a, b) => (parseFloat(b.volume24h)*parseFloat(b.lastPrice)) - (parseFloat(a.volume24h)*parseFloat(a.lastPrice))).slice(0, 15).map(m => m.symbol);
        const results = [];
        for (const sym of movers) {
            const candles = await fetchDayCandles(sym); if (candles.length < 220) continue;
            let wins = 0, trades = 0;
            for (let i = 200; i < candles.length - 1; i += 5) {
                const sc = btScoring(candles.slice(0, i + 1), MONITOR.config);
                if (sc && (sc.scoreL >= MONITOR.config.scoreMin || sc.scoreS >= MONITOR.config.scoreMin) && sc.volRatio >= MONITOR.config.volMin) {
                    const res = btSimulatePosition(candles, i, sc.scoreL >= MONITOR.config.scoreMin ? 'long' : 'short', MONITOR.config);
                    trades++; if (res.result !== 'stop') wins++;
                }
            }
            results.push({ symbol: sym, wr: trades > 0 ? wins / trades : 0 });
        }
        results.sort((a, b) => b.wr - a.wr);
        if (results.length > 0) {
            const best = results[0]; MONITOR.coinScan.bestSymbol = best.symbol; MONITOR.coinScan.bestWr = best.wr;
            if (best.wr >= 0.55 && !MONITOR.position) {
                if (MONITOR.symbol !== best.symbol) { addLog(`🔀 Scanner: Trocando para ${best.symbol} (${(best.wr*100).toFixed(0)}%)`, 'ok'); MONITOR.symbol = best.symbol; }
                MONITOR.tradingPaused = false;
            }
        }
    } finally { MONITOR.coinScan.running = false; }
}

// ─── Engine Tick ──────────────────────────────────────────────────────────────

async function engineTick() {
    if (!MONITOR.active || !MONITOR.symbol) return;
    await syncBalance(); // NOVO: Sincroniza saldo para cálculo de posição parcial
    await syncPositionWithBybit(); // SINCRONIZA ROI/USDT REAL ANTES DE TUDO
    const data = await engineScoring(); if (!data) return;
    const { scoreL, scoreS, volRatio, price } = data;
    const scoreMin = MONITOR.config.scoreMin, volMin = MONITOR.config.volMin;

    if (!MONITOR.position) {
        if (MONITOR.tradingPaused) return;
        
        // NOVO: Evita gatilhos simultâneos - só entra se UM lado der gatilho
        const longTrigger = scoreL >= scoreMin && volRatio >= volMin;
        const shortTrigger = scoreS >= scoreMin && volRatio >= volMin;
        
        if (longTrigger && shortTrigger) {
            addLog('⚠️ Gatilhos simultâneos LONG e SHORT. Aguardando confirmação unilateral.', 'warn');
            return;
        }
        
        const side = longTrigger ? 'long' : (shortTrigger ? 'short' : null);
        if (side) {
            // NOVO: Calcula tamanho da posição baseado na banca
            let qty = MONITOR.config.orderQty;
            const bankValue = MONITOR.balance * (MONITOR.config.bankPct / 100);
            const positionValue = bankValue * MONITOR.config.lev;
            
            if (positionValue > 0 && price > 0) {
                qty = positionValue / price;
            }
            
            const executedQty = await placeOrder(side, qty);
            if (executedQty) {
                MONITOR.position = { 
                    side, 
                    entry: price, 
                    qty: executedQty, 
                    peak: price, 
                    trailActive: false, 
                    partialCount: 0, 
                    lastAportePrice: price, 
                    partialExitDone: false, 
                    entryTime: Date.now(),
                    maxPartials: 2,
                    initialQty: executedQty // NOVO: Guarda quantidade inicial para cálculo de parciais
                };
                addLog(`📥 Entrada ${side.toUpperCase()}: ${executedQty.toFixed(4)} @ ${price.toFixed(4)}`, 'ok');
            }
        }
        return;
    }

    const pos = MONITOR.position, isL = pos.side === 'long';
    const roi = pos.curRoi !== undefined ? pos.curRoi : (isL ? (price - pos.entry) / pos.entry : (pos.entry - price) / pos.entry) * 100 * MONITOR.config.lev;

    // NOVO: Registra trade ao fechar por stop loss
    if (roi <= -MONITOR.config.stopPct) { 
        if (await placeOrder(isL ? 'short' : 'long', pos.qty, true)) {
            recordTrade(pos, price, 'stop_loss');
            MONITOR.position = null; 
        }
        return; 
    }

    const contraryTrig = isL ? (scoreS >= scoreMin && volRatio >= volMin) : (scoreL >= scoreMin && volRatio >= volMin);
    const sameDirTrig = isL ? (scoreL >= scoreMin && volRatio >= volMin) : (scoreS >= scoreMin && volRatio >= volMin);

    if (contraryTrig) {
        if (roi < 0) { // Flip
            if (await placeOrder(isL ? 'short' : 'long', pos.qty, true)) {
                recordTrade(pos, price, 'flip');
                MONITOR.position = null; 
                const q = await placeOrder(isL ? 'short' : 'long', MONITOR.config.orderQty);
                if (q) MONITOR.position = { side: isL ? 'short' : 'long', entry: price, qty: q, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price, partialExitDone: false, entryTime: Date.now(), maxPartials: 2, initialQty: q };
            }
        } else if (!pos.trailActive) { 
            // NOVO: Se posição positiva e gatilho contrário, fecha posição
            if (await placeOrder(isL ? 'short' : 'long', pos.qty, true)) {
                recordTrade(pos, price, 'contrary_signal');
                MONITOR.position = null; 
            }
        } else if (pos.trailActive) {
            // NOVO: Se trailing ativo e gatilho contrário, fecha 50% parcial
            if (!pos.partialExitDone) {
                const partialQty = pos.qty * 0.5;
                if (await placeOrder(isL ? 'short' : 'long', partialQty, true)) {
                    pos.qty -= partialQty;
                    pos.partialExitDone = true;
                    addLog(`📤 Saída parcial 50%: ${partialQty.toFixed(4)} @ ${price.toFixed(4)}`, 'info');
                }
            } else {
                // NOVO: Se já fechou 50% e outro gatilho contrário, fecha o restante
                if (await placeOrder(isL ? 'short' : 'long', pos.qty, true)) {
                    recordTrade(pos, price, 'trailing_partial_exit');
                    MONITOR.position = null;
                }
            }
        }
    }

    // NOVO: Entrada parcial se gatilho na mesma direção e posição positiva
    if (sameDirTrig && roi > 0 && pos.partialCount < pos.maxPartials) {
        let partialQty = MONITOR.config.orderQty;
        const bankValue = MONITOR.balance * (MONITOR.config.partialInPct / 100);
        const positionValue = bankValue * MONITOR.config.lev;
        
        if (positionValue > 0 && price > 0) {
            partialQty = positionValue / price;
        }
        
        // Se banca pequena, usa mínimo exigido
        const minNotional = 5.2;
        if (partialQty * price < minNotional) {
            partialQty = minNotional / price;
        }
        
        const executedQty = await placeOrder(pos.side, partialQty);
        if (executedQty) {
            pos.qty += executedQty;
            pos.partialCount++;
            addLog(`📈 Entrada parcial ${pos.partialCount}/${pos.maxPartials}: +${executedQty.toFixed(4)} @ ${price.toFixed(4)}`, 'ok');
        }
    }

    if (!pos.trailActive && roi >= MONITOR.config.trailAct) { 
        pos.trailActive = true; 
        pos.peak = price; 
        addLog(`🚀 Trailing ativado @ ${price.toFixed(4)}`, 'ok');
    }
    
    if (pos.trailActive) {
        if (isL && price > pos.peak) pos.peak = price; else if (!isL && price < pos.peak) pos.peak = price;
        if ((isL ? (pos.peak - price) / pos.peak : (price - pos.peak) / pos.peak) * 100 * MONITOR.config.lev >= MONITOR.config.trailPull) { 
            if (await placeOrder(isL ? 'short' : 'long', pos.qty, true)) {
                recordTrade(pos, price, 'trailing_stop');
                MONITOR.position = null; 
            }
        }
    }
}

// ─── Loops & Rotas ────────────────────────────────────────────────────────────

setInterval(async () => {
    if (MONITOR.tradeLock) return; MONITOR.tradeLock = true;
    const hadPos = !!MONITOR.position; try { await engineTick(); if (hadPos && !MONITOR.position && MONITOR.active) runCoinScan(); } catch (e) {} finally { MONITOR.tradeLock = false; }
}, 5000);

setInterval(() => { if (MONITOR.active && !MONITOR.position) runCoinScan(); }, 10 * 60 * 1000);

app.get('/status', (req, res) => res.json(MONITOR));
app.post('/sync-par', (req, res) => {
    const { symbol, active, config, position } = req.body;
    if (active) {
        MONITOR.active = true; if (symbol) MONITOR.symbol = symbol;
        if (config) MONITOR.config = { ...MONITOR.config, ...config };
        if (position) MONITOR.position = { ...position, lastAportePrice: position.entry, partialExitDone: false, partialCount: 0, entryTime: Date.now(), maxPartials: 2, initialQty: position.qty };
        runCoinScan();
    } else MONITOR.active = false;
    res.json({ success: true });
});

app.listen(PORT, () => { console.log(`Scanner Pro v9.8 (ROI REAL + HISTÓRICO) na porta ${PORT}`); checkCredentials(); });
