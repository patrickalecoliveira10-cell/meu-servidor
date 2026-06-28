const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Estado Global do Monitor
let MONITOR = {
    active: false,
    symbol: null,
    config: { 
        stopPct: 1.5, 
        trailAct: 1.5, 
        trailPull: 0.5, 
        lev: 1, 
        orderQty: 0.1,
        partialInPct: 5,
        partialOutPct: 50
    }, 
    position: null,
    indicators: { scoreL: 0, scoreS: 0, volRatio: 0, price: 0 },
    logs: []
};

function addLog(msg, type = 'info') {
    const ts = new Date().toLocaleTimeString('pt-BR');
    const logEntry = { time: Date.now(), msg: `[${ts}] ${msg}`, type };
    MONITOR.logs.unshift(logEntry);
    if (MONITOR.logs.length > 50) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

async function bybitRequest(method, endpoint, data = {}) {
    const key = process.env.BYBIT_API_KEY;
    const secret = process.env.BYBIT_API_SECRET;
    const timestamp = Date.now().toString();
    const baseUrl = process.env.USE_TESTNET === 'true' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    let parameters = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
    const sign = crypto.createHmac('sha256', secret).update(timestamp + key + '5000' + parameters).digest('hex');
    try {
        const res = await axios({
            method,
            url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: { 'X-BAPI-API-KEY': key, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': '5000' },
            data: method !== 'GET' ? data : undefined,
            timeout: 8000
        });
        return res.data;
    } catch (e) { return { error: e.message }; }
}

async function placeOrder(side, qty, isReduce = false) {
    if (!MONITOR.symbol) return null;
    let finalQty = qty;
    if (!isReduce) {
        try {
            const info = await bybitRequest('GET', '/v5/market/instruments-info', { category: 'linear', symbol: MONITOR.symbol });
            if (info.result && info.result.list && info.result.list[0]) {
                const instr = info.result.list[0];
                const limits = instr.lotSizeFilter;
                const minQty = parseFloat(limits.minOrderQty);
                const step = parseFloat(limits.qtyStep);
                const currentPrice = MONITOR.indicators.price || 0;
                
                // TRAVA DE 5.2 USDT PARA BANCA PEQUENA
                if (currentPrice > 0) {
                    const minNotional = 5.2; 
                    const qtyForMinVal = minNotional / currentPrice;
                    if (finalQty < qtyForMinVal) finalQty = qtyForMinVal;
                }
                
                if (finalQty < minQty) finalQty = minQty;
                const precision = Math.max(0, Math.round(-Math.log10(step)));
                finalQty = parseFloat(finalQty.toFixed(precision));
            }
        } catch (e) { console.error("Erro limites:", e); }
    }
    const bybitSide = side.toLowerCase() === 'long' ? 'Buy' : 'Sell';
    const orderData = { category: "linear", symbol: MONITOR.symbol, side: bybitSide, orderType: "Market", qty: finalQty.toString(), timeInForce: "GTC", reduceOnly: isReduce };
    addLog(`📡 Ordem Enviada: ${bybitSide} ${finalQty} ${MONITOR.symbol}`, 'info');
    const res = await bybitRequest('POST', '/v5/order/create', orderData);
    if (res.retCode === 0) return finalQty;
    addLog(`❌ Erro Bybit: ${res.retMsg}`, 'err');
    return null;
}

function calcEMA(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
    return ema;
}

async function engineScoring() {
    if (!MONITOR.symbol) return null;
    const kRes = await bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '201' });
    if (!kRes.result || !kRes.result.list) return null;
    const list = kRes.result.list.reverse();
    const prices = list.map(k => parseFloat(k[4]));
    const curP = prices[prices.length - 1];
    const ema200 = calcEMA(prices, 200);
    let sL = (curP > ema200) ? 40 : 0;
    let sS = (curP < ema200) ? 40 : 0;
    let vwapSum = 0, volSum = 0;
    list.slice(-50).forEach(k => {
        const p = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
        const v = parseFloat(k[5]);
        vwapSum += p * v; volSum += v;
    });
    const vwap = volSum > 0 ? vwapSum / volSum : curP;
    sL += (curP > vwap) ? 30 : 0;
    sS += (curP < vwap) ? 30 : 0;
    const oiRes = await bybitRequest('GET', '/v5/market/open-interest', { category: 'linear', symbol: MONITOR.symbol, intervalTime: '5min', limit: '2' });
    if (oiRes.result && oiRes.result.list.length >= 2) {
        const growing = parseFloat(oiRes.result.list[0].openInterest) > parseFloat(oiRes.result.list[1].openInterest);
        if (growing) {
            if (curP > prices[prices.length - 2]) sL += 30;
            else if (curP < prices[prices.length - 2]) sS += 30;
        }
    }
    const avgVol = list.slice(-20).reduce((a, b) => a + parseFloat(b[5]), 0) / 20;
    const vRat = parseFloat(list[list.length - 1][5]) / avgVol;
    MONITOR.indicators = { scoreL: sL, scoreS: sS, volRatio: vRat, price: curP };
    return MONITOR.indicators;
}

setInterval(async () => {
    if (!MONITOR.active || !MONITOR.symbol) return;
    const data = await engineScoring();
    if (!data) return;
    const { scoreL, scoreS, volRatio, price } = data;
    const longTrig = scoreL >= 70 && volRatio >= 1.1;
    const shortTrig = scoreS >= 70 && volRatio >= 1.1;

    // --- 1. LÓGICA DE ENTRADA (ANTI-CONFLITO) ---
    if (!MONITOR.position) {
        if (longTrig && shortTrig) return; // Se der os dois ao mesmo tempo, não entra.
        if (longTrig) {
            const qty = await placeOrder('long', MONITOR.config.orderQty);
            if (qty) MONITOR.position = { side: 'long', entry: price, qty: qty, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price };
        } else if (shortTrig) {
            const qty = await placeOrder('short', MONITOR.config.orderQty);
            if (qty) MONITOR.position = { side: 'short', entry: price, qty: qty, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price };
        }
        return;
    }

    // --- 2. GESTÃO DE POSIÇÃO ATIVA ---
    const pos = MONITOR.position;
    const isL = pos.side === 'long';
    const roi = (isL ? (price - pos.entry) / pos.entry : (pos.entry - price) / pos.entry) * 100 * (MONITOR.config.lev || 1);
    const contraryTrig = isL ? shortTrig : longTrig;
    const favorTrig = isL ? longTrig : shortTrig;

    // A. STOP LOSS
    if (roi <= -MONITOR.config.stopPct) {
        await placeOrder(isL ? 'short' : 'long', pos.qty, true);
        MONITOR.position = null; addLog(`❌ STOP LOSS EXECUTADO`, 'err'); return;
    }

    // B. VIRADA (FLIP) OU SEGURANÇA NO LUCRO
    if (contraryTrig) {
        if (roi < 0) {
            // VIRADA: No prejuízo e sinal inverteu -> Fecha e abre contrária
            addLog(`🔄 VIRADA (FLIP): ROI ${roi.toFixed(2)}%`, 'warn');
            await placeOrder(isL ? 'short' : 'long', pos.qty, true);
            const newSide = isL ? 'short' : 'long';
            const qty = await placeOrder(newSide, MONITOR.config.orderQty);
            if (qty) MONITOR.position = { side: newSide, entry: price, qty: qty, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price };
            return;
        } else if (!pos.trailActive) {
            // SEGURANÇA: No lucro mas sinal inverteu antes do Trailing -> Fecha e garante lucro
            addLog(`💰 SEGURANÇA: Fechando lucro de ${roi.toFixed(2)}% por sinal contrário`, 'ok');
            await placeOrder(isL ? 'short' : 'long', pos.qty, true);
            MONITOR.position = null; return;
        }
    }

    // C. APORTES (ENTRADAS PARCIAIS) - MÁXIMO 2
    if (favorTrig && roi > 0.5 && pos.partialCount < 2) {
        if (Math.abs(price - pos.lastAportePrice) / pos.lastAportePrice * 100 >= 0.3) {
            const baseAporteQty = MONITOR.config.orderQty * (MONITOR.config.partialInPct / 30);
            const qty = await placeOrder(pos.side, baseAporteQty);
            if (qty) {
                pos.partialCount++;
                pos.qty += qty;
                pos.lastAportePrice = price;
                addLog(`📥 APORTE #${pos.partialCount} EXECUTADO`, 'info');
            }
        }
    }

    // D. ATIVAÇÃO DO TRAILING
    if (!pos.trailActive && roi >= MONITOR.config.trailAct) {
        pos.trailActive = true;
        addLog(`🎯 TRAILING ATIVADO`, 'ok');
    }

    // E. GESTÃO DE SAÍDA NO TRAILING
    if (pos.trailActive) {
        // Sinal contrário durante o Trailing: 1ª vez (Parcial 50%) | 2ª vez (Fecha tudo)
        if (contraryTrig) {
            if (!pos.partialExitDone) {
                const exitQty = pos.qty * (MONITOR.config.partialOutPct / 100);
                const q = await placeOrder(isL ? 'short' : 'long', exitQty, true);
                if (q) {
                    pos.qty -= q;
                    pos.partialExitDone = true;
                    addLog(`📤 PARCIAL DE SAÍDA: 50% da posição reduzida`, 'info');
                }
            } else {
                addLog(`🏁 FINALIZADO: Segundo sinal contrário no Trailing`, 'ok');
                await placeOrder(isL ? 'short' : 'long', pos.qty, true);
                MONITOR.position = null; return;
            }
        }

        // Recuo do Topo (Pullback)
        if (isL && price > pos.peak) pos.peak = price;
        if (!isL && price < pos.peak) pos.peak = price;
        const pb = isL ? (pos.peak - price) / pos.peak * 100 : (price - pos.peak) / pos.peak * 100;
        if (pb * (MONITOR.config.lev || 1) >= MONITOR.config.trailPull) {
            await placeOrder(isL ? 'short' : 'long', pos.qty, true);
            MONITOR.position = null; addLog(`🏁 RECUO TRAILING EXECUTADO`, 'ok');
        }
    }
}, 5000);

app.get('/status', (req, res) => res.json(MONITOR));
app.post('/sync-par', (req, res) => {
    const { symbol, active, config, position, forceEntry } = req.body;
    if (active) {
        MONITOR.active = true;
        MONITOR.symbol = symbol || MONITOR.symbol;
        if (config) {
            MONITOR.config = {
                ...MONITOR.config,
                ...config,
                stopPct: parseFloat(config.stopPct) || 1.5,
                trailAct: parseFloat(config.trailAct) || 1.5,
                trailPull: parseFloat(config.trailPull) || 0.5,
                lev: parseInt(config.lev) || 1,
                orderQty: parseFloat(config.orderQty) || 0.1,
                partialInPct: parseFloat(config.partialInPct) || 5,
                partialOutPct: parseFloat(config.partialOutPct) || 50
            };
        }
        if (position) {
            MONITOR.position = {
                ...position,
                side: position.side.toLowerCase(),
                qty: parseFloat(position.qty),
                entry: parseFloat(position.entry),
                peak: parseFloat(position.peak || position.entry),
                trailActive: !!position.trailActive,
                partialCount: 0,
                lastAportePrice: parseFloat(position.entry)
            };
        }
        if (forceEntry) {
            placeOrder(forceEntry.side, MONITOR.config.orderQty).then(q => {
                if(q) MONITOR.position = { side: forceEntry.side.toLowerCase(), entry: MONITOR.indicators.price, qty: q, peak: 0, trailActive: false, partialCount: 0, lastAportePrice: 0 };
            });
        }
    } else {
        MONITOR.active = false;
        MONITOR.position = null;
    }
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Scanner Pro v9.5 ONLINE na porta ${PORT}`));
