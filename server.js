const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ESTADO GLOBAL DO SERVIDOR
let MONITOR = {
    active: false,
    symbol: null,
    config: { stopPct: 2.5, trailAct: 2, trailPull: 1, lev: 5 },
    position: null, // { side, entry, qty, peak, trailActive, partialEntryCount, partialExitDone }
    lastLog: ""
};

// --- HELPERS DE INDICADORES (IGUAL AO APP) ---

function parEMA(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b) / period;
    for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
    return ema;
}

function parVWAP(candles) {
    let sumTPV = 0, sumVol = 0;
    candles.forEach(c => {
        const tp = (c.high + c.low + c.close) / 3;
        sumTPV += tp * c.vol;
        sumVol += c.vol;
    });
    return sumVol > 0 ? sumTPV / sumVol : null;
}

function parRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) gains += d; else losses -= d;
    }
    let avgG = gains / period, avgL = losses / period;
    for (let j = period + 1; j < closes.length; j++) {
        const dj = closes[j] - closes[j - 1];
        avgG = (avgG * (period - 1) + (dj > 0 ? dj : 0)) / period;
        avgL = (avgL * (period - 1) + (dj < 0 ? -dj : 0)) / period;
    }
    return avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
}

// --- COMUNICAÇÃO BYBIT V5 ---

function getSignature(parameters, secret, timestamp) {
    return crypto.createHmac('sha256', secret).update(timestamp + process.env.BYBIT_KEY + '5000' + parameters).digest('hex');
}

async function bybitRequest(method, endpoint, data = {}) {
    const key = process.env.BYBIT_KEY;
    const secret = process.env.BYBIT_SECRET;
    const timestamp = Date.now().toString();
    const baseUrl = process.env.USE_TESTNET === 'true' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    const parameters = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
    const sign = getSignature(parameters, secret, timestamp);

    try {
        const res = await axios({
            method,
            url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: { 'X-BAPI-API-KEY': key, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': '5000', 'Content-Type': 'application/json' },
            data: method !== 'GET' ? data : undefined,
            timeout: 5000
        });
        return res.data;
    } catch (e) { return { error: e.message }; }
}

// --- LÓGICA DE EXECUÇÃO ---

async function openOrder(side, symbol, lev, qty) {
    console.log(`[EXEC] Abrindo ${side} em ${symbol}`);
    await bybitRequest('POST', '/v5/position/set-leverage', { category: 'linear', symbol, buyLeverage: lev.toString(), sellLeverage: lev.toString() });
    return await bybitRequest('POST', '/v5/order/create', {
        category: 'linear', symbol, side: side === 'LONG' ? 'Buy' : 'Sell',
        orderType: 'Market', qty: qty.toString(), timeInForce: 'GTC'
    });
}

async function closeOrder(symbol, side, qty) {
    return await bybitRequest('POST', '/v5/order/create', {
        category: 'linear', symbol, side: side === 'LONG' ? 'Sell' : 'Buy',
        orderType: 'Market', qty: qty.toString(), timeInForce: 'GTC'
    });
}

// --- ROTAS DO SERVIDOR ---

app.get('/status', (req, res) => res.json(MONITOR));

app.post('/sync-par', async (req, res) => {
    const { symbol, active, config, position, forceEntry } = req.body;
    if (active) {
        MONITOR.symbol = symbol;
        MONITOR.config = config;
        MONITOR.active = true;
        if (position) MONITOR.position = position;
        if (forceEntry) {
            const resp = await openOrder(forceEntry.side, symbol, config.lev, "0.01"); // Qty padrão teste
            if (resp.retCode === 0) {
                MONITOR.position = { side: forceEntry.side, entry: 0, qty: "0.01", peak: 0, trailActive: false, partialEntryCount: 0, partialExitDone: false };
            }
        }
    } else {
        MONITOR.active = false;
        MONITOR.position = null;
    }
    res.json({ success: true });
});

// --- LOOP PRINCIPAL DE MONITORAMENTO ---

setInterval(async () => {
    if (!MONITOR.active || !MONITOR.symbol) return;

    try {
        // 1. BUSCA DADOS
        const [kline, tickers, oi] = await Promise.all([
            bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '210' }),
            bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol: MONITOR.symbol }),
            bybitRequest('GET', '/v5/market/open-interest', { category: 'linear', symbol: MONITOR.symbol, interval: '5min', limit: '2' })
        ]);

        if (!kline.result || !tickers.result) return;

        const candles = kline.result.list.map(k => ({ time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), vol: parseFloat(k[5]) })).reverse();
        const price = parseFloat(tickers.result.list[0].lastPrice);
        const closes = candles.map(c => c.close);

        // 2. INDICADORES
        const ema200 = parEMA(closes, 200);
        const vwap = parVWAP(candles);
        const rsi = parRSI(closes);
        const lastVol = candles[candles.length - 1].vol;
        const avgVol = candles.slice(-20).reduce((a, b) => a + b.vol, 0) / 20;
        const volRatio = lastVol / avgVol;
        const oiGrowing = parseFloat(oi.result?.list[0]?.openInterest) > parseFloat(oi.result?.list[1]?.openInterest);

        // 3. SCORE MASTER
        let longScore = 0, shortScore = 0;
        if (ema200 && vwap) {
            if (price > ema200 && price > vwap * 0.998) {
                longScore = 40 + (oiGrowing ? 30 : 0) + (volRatio > 1.2 ? 20 : 0) + (rsi < 70 ? 10 : 0);
            } else if (price < ema200 && price < vwap * 1.002) {
                shortScore = 40 + (oiGrowing ? 30 : 0) + (volRatio > 1.2 ? 20 : 0) + (rsi > 30 ? 10 : 0);
            }
        }

        const longTrigger = longScore >= 70 && volRatio >= 1.1;
        const shortTrigger = shortScore >= 70 && volRatio >= 1.1;

        // 4. GERENCIAMENTO DE POSIÇÃO
        if (MONITOR.position) {
            const pos = MONITOR.position;
            const isLong = pos.side.toUpperCase() === 'LONG';
            const contrary = isLong ? shortTrigger : longTrigger;
            const favor = isLong ? longTrigger : shortTrigger;
            const pVar = isLong ? (price - pos.entry) / pos.entry : (pos.entry - price) / pos.entry;
            const roi = pVar * 100 * MONITOR.config.lev;

            // A) STOP LOSS
            if (roi <= -MONITOR.config.stopPct) {
                await closeOrder(MONITOR.symbol, pos.side, pos.qty);
                MONITOR.position = null;
            }
            // B) VIRADA (FLIP)
            else if (roi < 0 && contrary) {
                await closeOrder(MONITOR.symbol, pos.side, pos.qty);
                const resp = await openOrder(isLong ? 'SHORT' : 'LONG', MONITOR.symbol, MONITOR.config.lev, pos.qty);
                if (resp.retCode === 0) pos.side = isLong ? 'SHORT' : 'LONG';
            }
            // C) APORTES (SCALE-IN)
            else if (roi > 0 && favor && pos.partialEntryCount < 2) {
                const resp = await openOrder(pos.side, MONITOR.symbol, MONITOR.config.lev, pos.qty);
                if (resp.retCode === 0) pos.partialEntryCount++;
            }
            // D) SEGURANÇA (PROFIT CLOSE)
            else if (roi > 0 && !pos.trailActive && contrary) {
                await closeOrder(MONITOR.symbol, pos.side, pos.qty);
                MONITOR.position = null;
            }
            // E) TRAILING
            else {
                if (!pos.trailActive && roi >= MONITOR.config.trailAct) pos.trailActive = true;
                if (pos.trailActive) {
                    if (contrary) {
                        if (!pos.partialExitDone) {
                            await closeOrder(MONITOR.symbol, pos.side, parseFloat(pos.qty) / 2);
                            pos.partialExitDone = true;
                        } else {
                            await closeOrder(MONITOR.symbol, pos.side, pos.qty);
                            MONITOR.position = null;
                        }
                    }
                    // Pullback check
                    if (isLong && price > pos.peak) pos.peak = price;
                    if (!isLong && (price < pos.peak || pos.peak === 0)) pos.peak = price;
                    const pb = (isLong ? (pos.peak - price) / pos.peak : (price - pos.peak) / pos.peak) * 100 * MONITOR.config.lev;
                    if (pb >= MONITOR.config.trailPull) {
                        await closeOrder(MONITOR.symbol, pos.side, pos.qty);
                        MONITOR.position = null;
                    }
                }
            }
        } 
        // 5. ENTRADA (SE NÃO HOUVER CONFLITO)
        else {
            if (longTrigger && shortTrigger) {
                MONITOR.lastLog = "Conflito detectado, entrada evitada.";
            } else if (longTrigger) {
                const resp = await openOrder('LONG', MONITOR.symbol, MONITOR.config.lev, "0.01");
                if (resp.retCode === 0) MONITOR.position = { side: 'LONG', entry: price, qty: "0.01", peak: price, trailActive: false, partialEntryCount: 0, partialExitDone: false };
            } else if (shortTrigger) {
                const resp = await openOrder('SHORT', MONITOR.symbol, MONITOR.config.lev, "0.01");
                if (resp.retCode === 0) MONITOR.position = { side: 'SHORT', entry: price, qty: "0.01", peak: price, trailActive: false, partialEntryCount: 0, partialExitDone: false };
            }
        }
    } catch (e) { console.error("Erro Ciclo:", e.message); }
}, 8000);

app.listen(PORT, () => console.log(`Scanner Server v8 rodando na porta ${PORT}`));
