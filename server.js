const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Estado Global do Motor (Persistente no Render)
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

function calcEMA(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
    return ema;
}

// Requisições Bybit com Nomes de API do seu Render
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
            headers: {
                'X-BAPI-API-KEY': key,
                'X-BAPI-SIGN': sign,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': '5000'
            },
            data: method !== 'GET' ? data : undefined,
            timeout: 8000
        });
        return res.data;
    } catch (e) { return { error: e.message }; }
}

// Motor Scoring 40/30/30
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

    let vSum = 0, volSum = 0;
    list.slice(-50).forEach(k => {
        const p = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
        const v = parseFloat(k[5]);
        vSum += p * v; volSum += v;
    });
    const vwap = volSum > 0 ? vSum / volSum : curP;
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

// Loop de Decisão v9.5
setInterval(async () => {
    if (!MONITOR.active || !MONITOR.symbol) return;
    const data = await engineScoring();
    if (!data) return;

    const { scoreL, scoreS, volRatio, price } = data;
    const longTrig = scoreL >= 70 && volRatio >= 1.1;
    const shortTrig = scoreS >= 70 && volRatio >= 1.1;

    // A. ENTRADA
    if (!MONITOR.position) {
        if (longTrig && shortTrig) return; // Trava de conflito
        if (longTrig) {
            addLog(`🚀 ENTRADA LONG | Score: ${scoreL}`, 'ok');
            MONITOR.position = { side: 'long', entry: price, qty: 1, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price };
        } else if (shortTrig) {
            addLog(`🚀 ENTRADA SHORT | Score: ${scoreS}`, 'ok');
            MONITOR.position = { side: 'short', entry: price, qty: 1, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price };
        }
        return;
    }

    const pos = MONITOR.position;
    const isL = pos.side === 'long';
    const roi = (isL ? (price - pos.entry) / pos.entry : (pos.entry - price) / pos.entry) * 100 * (MONITOR.config.lev || 5);
    const contrary = isL ? shortTrig : longTrig;
    const favor = isL ? longTrig : shortTrig;

    // 1. VIRADA (FLIP) - PRIORIDADE ABSOLUTA SE ROI NEGATIVO
    if (roi < 0 && contrary) {
        const newSide = isL ? 'short' : 'long';
        addLog(`🔄 FLIP: Invertendo para ${newSide.toUpperCase()} (ROI: ${roi.toFixed(2)}%)`, 'warn');
        MONITOR.position = { side: newSide, entry: price, qty: 1, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price };
        return;
    }

    // 2. FECHAMENTO SEGURANÇA (LUCRO + SINAL CONTRÁRIO)
    if (roi > 0 && !pos.trailActive && contrary) {
        addLog(`💰 SEGURANÇA: Sinal contrário no lucro. Fechando posição.`, 'ok');
        MONITOR.position = null;
        return;
    }

    // 3. APORTES (SCALE-IN) - MÁXIMO 2
    if (roi > 0.5 && favor && pos.partialCount < 2) {
        const dist = Math.abs(price - pos.lastAportePrice) / pos.lastAportePrice * 100;
        if (dist >= 0.3) {
            pos.partialCount++;
            pos.qty *= 1.3;
            pos.lastAportePrice = price;
            addLog(`📥 APORTE #${pos.partialCount}: Confirmando tendência.`, 'info');
        }
    }

    // 4. TRAILING STOP
    if (!pos.trailActive && roi >= MONITOR.config.trailAct) {
        pos.trailActive = true;
        addLog(`🎯 TRAILING ATIVADO`, 'ok');
    }

    if (pos.trailActive) {
        if (contrary) {
            if (!pos.partialExitDone) {
                addLog(`📤 TRAILING: Parcial 50% por sinal contrário.`, 'info');
                pos.qty *= 0.5;
                pos.partialExitDone = true;
            } else {
                addLog(`🏁 TRAILING: Fechamento por 2º sinal contrário.`, 'ok');
                MONITOR.position = null;
                return;
            }
        }
        if (isL && price > pos.peak) pos.peak = price;
        if (!isL && price < pos.peak) pos.peak = price;
        const pb = isL ? (pos.peak - price) / pos.peak * 100 : (price - pos.peak) / pos.peak * 100;
        if (pb * (MONITOR.config.lev || 5) >= MONITOR.config.trailPull) {
            addLog(`🏁 TRAILING STOP: Recuo batido.`, 'ok');
            MONITOR.position = null;
        }
    }
}, 5000);

app.get('/status', (req, res) => res.json(MONITOR));
app.get('/heartbeat', (req, res) => res.send('OK'));
app.post('/sync-par', (req, res) => {
    const { symbol, active, config, position, forceEntry } = req.body;
    if (active) {
        MONITOR.active = true;
        MONITOR.symbol = symbol || MONITOR.symbol;
        if (config) MONITOR.config = { ...MONITOR.config, ...config };
        if (position) MONITOR.position = position;
        if (forceEntry) MONITOR.position = { side: forceEntry.side.toLowerCase(), entry: 0, qty: 1, peak: 0, trailActive: false, partialCount: 0, lastAportePrice: 0 };
    } else MONITOR.active = false;
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Scanner Pro v9.5 Online na porta ${PORT}`));
