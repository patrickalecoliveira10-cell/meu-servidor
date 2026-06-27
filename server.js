const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BYBIT_KEY = process.env.BYBIT_API_KEY; 
const BYBIT_SECRET = process.env.BYBIT_API_SECRET;
const IS_TESTNET = process.env.USE_TESTNET === 'true';

// --- ESTADO GLOBAL DO ROBÔ ---
let MONITOR = {
    active: false,
    symbol: null,
    config: { 
        bankPct: 30,        // 30% da banca
        partialInPct: 5,    // 5% aporte
        partialOutPct: 50,  // 50% saída parcial
        stopPct: 1.5,       // 1.5% ROI
        trailAct: 1.5,      // 1.5% Ativação
        trailPull: 0.8,     // 0.8% Recuo
        lev: 10 
    },
    position: null,
    logs: [],
    lastCloseTime: 0,
    realBalance: 15,
    currentScore: 0
};

function serverLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('pt-BR');
    MONITOR.logs.unshift({ time, msg, type });
    if (MONITOR.logs.length > 50) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${time} - ${msg}`);
}

// --- INDICADORES TÉCNICOS ---
function calcEMA(v, p) { 
    if (v.length < p) return null; 
    const k = 2/(p+1); 
    let ema = v.slice(0,p).reduce((a,b)=>a+b)/p;
    for(let i=p; i<v.length; i++) ema = v[i]*k + ema*(1-k);
    return ema;
}

function calcVWAP(c) {
    let t=0, v=0;
    c.forEach(i=>{ t += ((i.high+i.low+i.close)/3)*i.vol; v += i.vol; });
    return v > 0 ? t/v : null;
}

// --- CÁLCULO DE SCORE SNIPER V8 (EMA 200 + VWAP + OI + VOLUME) ---
function analyzeSniperScore(price, candles, oiGrowing) {
    const closes = candles.map(c => c.close);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    const ema200 = calcEMA(closes, 200);
    const vwap = calcVWAP(candles);
    const vols = candles.slice(-20).map(c => c.vol || 0);
    const avgVol = vols.reduce((a,b) => a+b, 0) / (vols.length || 1);
    const volRatio = last.vol / (avgVol || 1);

    // Proteção contra reversão (Contrary Force)
    const contraryForce = (last.close > last.open)
        ? (prev.close < prev.open && prev.vol > last.vol * 1.5)
        : (prev.close > prev.open && prev.vol > last.vol * 1.5);

    let score = 0;
    let side = null;

    if (ema200 && vwap && !contraryForce) {
        if (price > ema200) { // Lógica LONG
            side = 'LONG';
            score = 40; 
            if (price > vwap) score += 20;
            if (oiGrowing) score += 25;
            if (volRatio >= 1.1) score += 15;
        } else if (price < ema200) { // Lógica SHORT
            side = 'SHORT';
            score = 40;
            if (price < vwap) score += 20;
            if (oiGrowing) score += 25;
            if (volRatio >= 1.1) score += 15;
        }
    }
    return { side, score, volRatio };
}

// --- API BYBIT ---
async function bybitRequest(method, endpoint, data = {}) {
    const timestamp = Date.now().toString();
    const baseUrl = IS_TESTNET ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    const parameters = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
    const sign = crypto.createHmac('sha256', BYBIT_SECRET).update(timestamp + BYBIT_KEY + '5000' + parameters).digest('hex');
    try {
        const res = await axios({
            method, url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: { 'X-BAPI-API-KEY': BYBIT_KEY, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': '5000', 'Content-Type': 'application/json' },
            data: method !== 'GET' ? data : undefined, timeout: 8000
        });
        return res.data;
    } catch (e) { return { error: e.message }; }
}

async function checkActualPosition(symbol) {
    const res = await bybitRequest('GET', '/v5/position/list', { category: 'linear', symbol });
    if (res.result && res.result.list) {
        const pos = res.result.list.find(p => parseFloat(p.size) > 0);
        return pos ? { side: pos.side === 'Buy' ? 'LONG' : 'SHORT', entry: parseFloat(pos.avgPrice), qty: parseFloat(pos.size) } : null;
    }
    return null;
}

async function executeTrade(side, qty, type = 'open') {
    const symbol = MONITOR.symbol;
    const ticker = await bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol });
    const price = parseFloat(ticker.result.list[0].lastPrice);
    
    let qVal = parseFloat(qty);
    // Margem de segurança para saldo baixo: Mínimo $7.5 de contrato
    if (qVal * price < 7.0) qVal = 7.5 / price; 

    const integerSyms = ['AGLD', 'DOGE', 'SHIB', 'PEPE', '1000PEPE', 'BONK'];
    const q = integerSyms.some(s => symbol.includes(s)) ? Math.floor(qVal).toString() : qVal.toFixed(1);
    const bSide = type === 'open' ? (side === 'LONG' ? 'Buy' : 'Sell') : (side === 'LONG' ? 'Sell' : 'Buy');
    
    if (type === 'open') {
        serverLog(`🚀 ENTRADA ${side} | Qty: ${q}`, 'ok');
        await bybitRequest('POST', '/v5/position/set-leverage', { category: 'linear', symbol, buyLeverage: MONITOR.config.lev.toString(), sellLeverage: MONITOR.config.lev.toString() });
    }

    return await bybitRequest('POST', '/v5/order/create', { category: 'linear', symbol, side: bSide, orderType: 'Market', qty: q });
}

// --- CICLO PRINCIPAL (A CADA 10s) ---
async function serverCycle() {
    if (!MONITOR.active || !MONITOR.symbol) return;
    
    try {
        const realPos = await checkActualPosition(MONITOR.symbol);
        if (!realPos && MONITOR.position) {
            serverLog("⚠️ Posição fechada na Bybit. Resetando...", "info");
            MONITOR.position = null; MONITOR.lastCloseTime = Date.now();
        }

        const [k, t, o, b] = await Promise.all([
            bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '210' }),
            bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol: MONITOR.symbol }),
            bybitRequest('GET', '/v5/market/open-interest', { category: 'linear', symbol: MONITOR.symbol, intervalTime: '5min', limit: '2' }),
            bybitRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' })
        ]);

        if (!k.result || !t.result) return;
        if (b.result) MONITOR.realBalance = parseFloat(b.result.list[0].totalAvailableBalance || 15);

        const candles = k.result.list.map(i=>({ high:parseFloat(i[2]), low:parseFloat(i[3]), close:parseFloat(i[4]), vol:parseFloat(i[5]), open:parseFloat(i[1]) })).reverse();
        const price = parseFloat(t.result.list[0].lastPrice);
        const oiGrow = o.result && parseFloat(o.result.list[0].openInterest) > parseFloat(o.result.list[1].openInterest);

        const analysis = analyzeSniperScore(price, candles, oiGrow);
        MONITOR.currentScore = analysis.score;

        if (MONITOR.position) {
            const pos = MONITOR.position;
            const isLong = pos.side === 'LONG';
            const roi = (isLong ? (price-pos.entry)/pos.entry : (pos.entry-price)/pos.entry) * 100 * MONITOR.config.lev;
            if (isLong && price > pos.peak) pos.peak = price;
            if (!isLong && (price < pos.peak || pos.peak === 0)) pos.peak = price;

            // Stop Loss
            if (roi <= -MONITOR.config.stopPct) {
                serverLog("🔴 STOP LOSS", "err");
                await executeTrade(pos.side, pos.qty, 'close');
                MONITOR.position = null; MONITOR.lastCloseTime = Date.now();
            } 
            // Trailing Stop
            else if (pos.trailActive) {
                const recuo = (isLong ? (pos.peak-price)/pos.peak : (price-pos.peak)/pos.peak) * 100 * MONITOR.config.lev;
                if (recuo >= MONITOR.config.trailPull) {
                    serverLog("🏁 TRAILING STOP", "ok");
                    await executeTrade(pos.side, pos.qty, 'close');
                    MONITOR.position = null; MONITOR.lastCloseTime = Date.now();
                }
            } else if (roi >= MONITOR.config.trailAct) {
                pos.trailActive = true;
                serverLog("🎯 TRAILING ATIVADO", "ok");
            }
        } 
        else {
            const trigger = (analysis.score >= 70 && analysis.volRatio >= 1.1);
            const cooldown = (Date.now() - MONITOR.lastCloseTime < 60000); // 1 minuto de trava

            if (trigger && !cooldown) {
                const margin = (MONITOR.config.bankPct / 100) * MONITOR.realBalance * 0.85;
                const qty = (margin * MONITOR.config.lev) / price;
                const res = await executeTrade(analysis.side, qty, 'open');
                if (res.retCode === 0) MONITOR.position = { side: analysis.side, entry: price, qty, peak: price, trailActive: false };
            }
        }
    } catch (e) { console.error("Erro Ciclo"); }
}

// --- ENDPOINTS ---
app.get('/status', (req, res) => res.json(MONITOR));
app.post('/sync-par', async (req, res) => {
    const { active, symbol, config, position } = req.body;

    if (active === false) {
        if (MONITOR.position) await executeTrade(MONITOR.position.side, MONITOR.position.qty, 'close');
        MONITOR.active = false; MONITOR.position = null; MONITOR.symbol = null;
        MONITOR.lastCloseTime = Date.now();
        return res.json({ success: true });
    }

    MONITOR.active = true;
    MONITOR.symbol = symbol;
    if (config) MONITOR.config = config;
    if (position && position.side && !MONITOR.position) {
        MONITOR.position = { ...position, side: position.side.toUpperCase() };
    }
    res.json({ success: true });
});

setInterval(serverCycle, 10000);
app.listen(PORT, () => console.log(`Sniper V8 Master Cloud Rodando - Saldo: ${MONITOR.realBalance} USDT`));
