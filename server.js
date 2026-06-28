const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

let MONITOR = {
    active: false,
    symbol: null,
    config: { stopPct: 2.5, trailAct: 2, trailPull: 1, lev: 5 },
    position: null, // { side, entry, qty, peak, trailActive, partialCount, partialExitDone, lastAportePrice }
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

// Funções Técnicas
function calcEMA(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
    return ema;
}

async function bybitRequest(method, endpoint, data = {}) {
    const key = process.env.BYBIT_KEY;
    const secret = process.env.BYBIT_SECRET;
    const timestamp = Date.now().toString();
    const baseUrl = process.env.USE_TESTNET === 'true' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    let parameters = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
    const sign = crypto.createHmac('sha256', secret).update(timestamp + key + '5000' + parameters).digest('hex');
    try {
        const res = await axios({
            method, url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: { 'X-BAPI-API-KEY': key, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': '5000' },
            data: method !== 'GET' ? data : undefined, timeout: 8000
        });
        return res.data;
    } catch (e) { return { error: e.message }; }
}

async function engineScoring() {
    if (!MONITOR.symbol) return null;
    const kRes = await bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '201' });
    if (!kRes.result || !kRes.result.list) return null;

    const list = kRes.result.list.reverse();
    const prices = list.map(k => parseFloat(k[4]));
    const curP = prices[prices.length - 1];

    // 1. EMA 200 (40%)
    const ema200 = calcEMA(prices, 200);
    let sL = (curP > ema200) ? 40 : 0;
    let sS = (curP < ema200) ? 40 : 0;

    // 2. VWAP (30%)
    let vwapSum = 0, volSum = 0;
    list.slice(-50).forEach(k => {
        const p = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
        const v = parseFloat(k[5]);
        vwapSum += p * v; volSum += v;
    });
    const vwap = volSum > 0 ? vwapSum / volSum : curP;
    sL += (curP > vwap) ? 30 : 0;
    sS += (curP < vwap) ? 30 : 0;

    // 3. OI Trend (30%)
    const oiRes = await bybitRequest('GET', '/v5/market/open-interest', { category: 'linear', symbol: MONITOR.symbol, intervalTime: '5min', limit: '2' });
    if (oiRes.result && oiRes.result.list.length >= 2) {
        const growing = parseFloat(oiRes.result.list[0].openInterest) > parseFloat(oiRes.result.list[1].openInterest);
        if (growing) {
            if (curP > prices[prices.length - 2]) sL += 30;
            else if (curP < prices[prices.length - 2]) sS += 30;
        }
    }

    // Volume Ratio
    const avgVol = list.slice(-20).reduce((a, b) => a + parseFloat(b[5]), 0) / 20;
    const vRat = parseFloat(list[list.length - 1][5]) / avgVol;

    MONITOR.indicators = { scoreL: sL, scoreS: sS, volRatio: vRat, price: curP };
    return MONITOR.indicators;
}

// LOOP DE DECISÃO V9.5
setInterval(async () => {
    if (!MONITOR.active || !MONITOR.symbol) return;
    const data = await engineScoring();
    if (!data) return;

    const { scoreL, scoreS, volRatio, price } = data;
    const longTrig = scoreL >= 70 && volRatio >= 1.1;
    const shortTrig = scoreS >= 70 && volRatio >= 1.1;

    // A. ENTRADA (SEM POSIÇÃO)
    if (!MONITOR.position) {
        if (longTrig && shortTrig) return; // BLOQUEIO DE CONFLITO
        if (longTrig) {
            addLog(`🚀 OPEN LONG | Score: ${scoreL} | Vol: ${volRatio.toFixed(2)}`, 'ok');
            MONITOR.position = { side: 'long', entry: price, qty: 1, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price };
        } else if (shortTrig) {
            addLog(`🚀 OPEN SHORT | Score: ${scoreS} | Vol: ${volRatio.toFixed(2)}`, 'ok');
            MONITOR.position = { side: 'short', entry: price, qty: 1, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price };
        }
        return;
    }

    // B. GESTÃO DE POSIÇÃO ATIVA
    const pos = MONITOR.position;
    const isL = pos.side === 'long';
    const roi = (isL ? (price - pos.entry)/pos.entry : (pos.entry - price)/pos.entry) * 100 * MONITOR.config.lev;
    const contrary = isL ? shortTrig : longTrig;
    const favor = isL ? longTrig : shortTrig;

    // 1. VIRADA (FLIP): Negativo + Sinal Contrário
    if (roi < 0 && contrary) {
        addLog(`🔄 FLIP: Virando mão para ${isL ? 'SHORT' : 'LONG'}`, 'warn');
        MONITOR.position = { side: isL ? 'short' : 'long', entry: price, qty: 1, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price };
        return;
    }

    // 2. FECHAMENTO SEGURANÇA: Positivo + Sinal Contrário (Antes do Trailing)
    if (roi > 0 && !pos.trailActive && contrary) {
        addLog(`💰 SEGURANÇA: Fechando lucro antes do recuo por sinal contrário`, 'ok');
        MONITOR.position = null;
        return;
    }

    // 3. APORTES (SCALE-IN): Positivo + Sinal Favor + Espaçamento de Preço
    if (roi > 0 && favor && pos.partialCount < 2) {
        const dist = Math.abs(price - pos.lastAportePrice) / pos.lastAportePrice * 100;
        if (dist > 0.3) { // Só aporta se o preço moveu 0.3% desde o último
            pos.partialCount++;
            pos.qty *= 1.3;
            pos.lastAportePrice = price;
            addLog(`📥 APORTE #${pos.partialCount} realizado`, 'info');
        }
    }

    // 4. TRAILING STOP
    if (!pos.trailActive && roi >= MONITOR.config.trailAct) {
        pos.trailActive = true;
        addLog(`🎯 TRAILING ATIVADO`, 'ok');
    }

    if (pos.trailActive) {
        // Sinal contrário no Trailing -> 50% na primeira, Out no segundo
        if (contrary) {
            if (!pos.partialExitDone) {
                addLog(`📤 TRAILING: Saída 50% por sinal contrário`, 'info');
                pos.qty *= 0.5;
                pos.partialExitDone = true;
            } else {
                addLog(`🏁 TRAILING: Fechamento total por segundo sinal contrário`, 'ok');
                MONITOR.position = null;
                return;
            }
        }

        // Pullback físico
        if (isL && price > pos.peak) pos.peak = price;
        if (!isL && price < pos.peak) pos.peak = price;
        const pb = isL ? (pos.peak - price)/pos.peak*100 : (price - pos.peak)/pos.peak*100;
        if (pb * MONITOR.config.lev >= MONITOR.config.trailPull) {
            addLog(`🏁 TRAILING STOP batido pelo recuo`, 'ok');
            MONITOR.position = null;
        }
    }
}, 8000);

app.get('/status', (req, res) => res.json(MONITOR));
app.post('/sync-par', (req, res) => {
    const { symbol, active, config, forceEntry } = req.body;
    if (active) {
        MONITOR.active = true;
        MONITOR.symbol = symbol || MONITOR.symbol;
        if (config) MONITOR.config = { ...MONITOR.config, ...config };
        if (forceEntry) MONITOR.position = { side: forceEntry.side.toLowerCase(), entry: 0, qty: 1, peak: 0, trailActive: false, partialCount: 0 };
    } else MONITOR.active = false;
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Scanner V9.5 Cloud Online`));
