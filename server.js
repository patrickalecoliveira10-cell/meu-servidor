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

let MONITOR = {
    active: false,
    symbol: null,
    config: { bankPct: 10, stopPct: 2.5, trailAct: 2, trailPull: 1, lev: 5 },
    position: null, // { side, entry, qty, peak, trailActive, partialIn: 0, partialOutDone: false }
    logs: [],
    lastErrorAt: 0
};

function serverLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    MONITOR.logs.unshift({ time, msg, type });
    if (MONITOR.logs.length > 30) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// --- INDICADORES ---
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

function roundQty(symbol, qty) {
    const integerSyms = ['DOGE', 'SHIB', 'PEPE', '1000PEPE', 'BONK', 'GALA', 'LUNC'];
    if (integerSyms.some(s => symbol.includes(s))) return Math.floor(qty).toString();
    return symbol.includes('BTC') ? qty.toFixed(3) : (symbol.includes('ETH') ? qty.toFixed(2) : qty.toFixed(1));
}

// --- API BYBIT ---
async function bybitRequest(method, endpoint, data = {}) {
    if (Date.now() - MONITOR.lastErrorAt < 1500) return { error: "Limit Cool" };
    const timestamp = Date.now().toString();
    const parameters = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
    const sign = crypto.createHmac('sha256', BYBIT_SECRET).update(timestamp + BYBIT_KEY + '5000' + parameters).digest('hex');

    try {
        const res = await axios({
            method,
            url: (IS_TESTNET ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com') + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: { 'X-BAPI-API-KEY': BYBIT_KEY, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': '5000', 'Content-Type': 'application/json' },
            data: method !== 'GET' ? data : undefined, timeout: 5000
        });
        if (res.data.retCode !== 0 && res.data.retCode !== 110043) {
            if (res.data.retCode === 10002) MONITOR.lastErrorAt = Date.now();
            serverLog(`Bybit: ${res.data.retMsg}`, 'err');
        }
        return res.data;
    } catch (e) { return { error: e.message }; }
}

async function executeTrade(side, qty, type = 'open') {
    const q = roundQty(MONITOR.symbol, qty);
    const bybitSide = type === 'open' ? (side === 'LONG' ? 'Buy' : 'Sell') : (side === 'LONG' ? 'Sell' : 'Buy');
    
    if (type === 'open') {
        await bybitRequest('POST', '/v5/position/set-leverage', { category: 'linear', symbol: MONITOR.symbol, buyLeverage: MONITOR.config.lev.toString(), sellLeverage: MONITOR.config.lev.toString() });
    }

    return await bybitRequest('POST', '/v5/order/create', {
        category: 'linear', symbol: MONITOR.symbol, side: bybitSide,
        orderType: 'Market', qty: q, timeInForce: 'GTC'
    });
}

// --- CÉREBRO SNIPER V8 ---
async function serverCycle() {
    if (!MONITOR.active || !MONITOR.symbol) return;

    try {
        const [kline, tickers, oi] = await Promise.all([
            bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '210' }),
            bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol: MONITOR.symbol }),
            bybitRequest('GET', '/v5/market/open-interest', { category: 'linear', symbol: MONITOR.symbol, intervalTime: '5min', limit: '2' })
        ]);

        if (!kline.result || !tickers.result) return;

        const candles = kline.result.list.map(k => ({ close: parseFloat(k[4]), vol: parseFloat(k[5]), high: parseFloat(k[2]), low: parseFloat(k[3]) })).reverse();
        const price = parseFloat(tickers.result.list[0].lastPrice);
        const closes = candles.map(c => c.close);

        const ema200 = parEMA(closes, 200);
        const vwap = parVWAP(candles);
        const volRatio = candles[candles.length-1].vol / (candles.slice(-20).reduce((a,b)=>a+b.vol,0)/20);
        const oiGrowing = oi.result && parseFloat(oi.result.list[0].openInterest) > parseFloat(oi.result.list[1].openInterest);

        // Gatilhos de Inteligência
        const longTrigger = (ema200 && price > ema200 && vwap && price > vwap && volRatio >= 1.1 && oiGrowing);
        const shortTrigger = (ema200 && price < ema200 && vwap && price < vwap && volRatio >= 1.1 && oiGrowing);

        if (MONITOR.position) {
            const pos = MONITOR.position;
            const isLong = pos.side === 'LONG';
            const contrary = isLong ? shortTrigger : longTrigger;
            const favor = isLong ? longTrigger : shortTrigger;
            const roi = (isLong ? (price - pos.entry) / pos.entry : (pos.entry - price) / pos.entry) * 100 * MONITOR.config.lev;

            // 1. ATUALIZA PICO
            if (isLong && price > pos.peak) pos.peak = price;
            if (!isLong && (price < pos.peak || pos.peak === 0)) pos.peak = price;

            // 2. STOP LOSS OU VIRADA (FLIP)
            if (roi <= -MONITOR.config.stopPct) {
                if (contrary) {
                    serverLog("🔄 FLIP: Negativo + Gatilho Contrário. Virando mão...", "warn");
                    await executeTrade(pos.side, pos.qty, 'close');
                    const res = await executeTrade(isLong ? 'SHORT' : 'LONG', pos.qty, 'open');
                    if (res.retCode === 0) MONITOR.position = { side: isLong ? 'SHORT' : 'LONG', entry: price, qty: pos.qty, peak: price, trailActive: false, partialIn: 0 };
                } else {
                    serverLog("🔴 STOP LOSS atingido.", "err");
                    await executeTrade(pos.side, pos.qty, 'close');
                    MONITOR.position = null;
                }
                return;
            }

            // 3. APORTES A FAVOR (SCALE-IN) - Limite de 2
            if (roi > 0 && favor && (pos.partialIn || 0) < 2) {
                serverLog(`📥 APORTE (#${(pos.partialIn||0)+1}) a favor da tendência.`, "info");
                const addQty = pos.qty * 0.5; // Adiciona 50% da mão inicial
                const res = await executeTrade(pos.side, addQty, 'open');
                if (res.retCode === 0) {
                    pos.qty = parseFloat(pos.qty) + addQty;
                    pos.partialIn = (pos.partialIn || 0) + 1;
                }
            }

            // 4. FECHAMENTO DE SEGURANÇA (Lucro baixo + Sinal contrário)
            if (roi > 0 && !pos.trailActive && contrary) {
                serverLog("💰 SEGURANÇA: Sinal contrário no lucro. Fechando.", "ok");
                await executeTrade(pos.side, pos.qty, 'close');
                MONITOR.position = null;
                return;
            }

            // 5. TRAILING STOP
            if (!pos.trailActive && roi >= MONITOR.config.trailAct) {
                pos.trailActive = true;
                serverLog("🎯 Trailing Ativado!", "ok");
            }

            if (pos.trailActive) {
                // Se gatilho contrário no Trailing -> Saída Parcial de 50%
                if (contrary) {
                    if (!pos.partialOutDone) {
                        serverLog("📤 PARCIAL: Sinal contrário no Trailing. Reduzindo 50%.", "info");
                        const outQty = pos.qty * 0.5;
                        const res = await executeTrade(pos.side, outQty, 'close');
                        if (res.retCode === 0) { pos.qty -= outQty; pos.partialOutDone = true; }
                    } else {
                        serverLog("🏁 FECHAMENTO: Segundo sinal contrário após parcial.", "ok");
                        await executeTrade(pos.side, pos.qty, 'close');
                        MONITOR.position = null;
                        return;
                    }
                }
                // Recuo do Trailing
                const recuo = (isLong ? (pos.peak - price)/pos.peak : (price - pos.peak)/pos.peak) * 100 * MONITOR.config.lev;
                if (recuo >= MONITOR.config.trailPull) {
                    serverLog(`🏁 Trailing batido por recuo (${recuo.toFixed(2)}% ROI).`, "ok");
                    await executeTrade(pos.side, pos.qty, 'close');
                    MONITOR.position = null;
                }
            }
        } 
        // 6. ENTRADA (Apenas se houver 1 gatilho exclusivo)
        else if (longTrigger ^ shortTrigger) {
            const side = longTrigger ? 'LONG' : 'SHORT';
            const qty = (MONITOR.config.bankPct / 100 * 100) / price; // Exemplo: $100 de margem
            const res = await executeTrade(side, qty, 'open');
            if (res.retCode === 0) {
                MONITOR.position = { side, entry: price, qty, peak: price, trailActive: false, partialIn: 0, partialOutDone: false };
                serverLog(`🔥 ENTRADA SNIPER: ${side} em ${price}`, "ok");
            }
        }
    } catch (e) { console.error("Erro ciclo:", e.message); }
}

app.get('/status', (req, res) => res.json(MONITOR));
app.post('/sync-par', async (req, res) => {
    const { symbol, active, config, position } = req.body;
    MONITOR.active = active;
    if (active) {
        MONITOR.symbol = symbol;
        MONITOR.config = config;
        if (position && position.side && !MONITOR.position) {
            MONITOR.position = { ...position, side: position.side.toUpperCase(), partialIn: 0 };
            serverLog(`☁️ Controle assumido: ${symbol}`, 'ok');
        }
    } else {
        if (MONITOR.position) await executeTrade(MONITOR.position.side, MONITOR.position.qty, 'close');
        MONITOR.position = null;
    }
    res.json({ success: true });
});

setInterval(serverCycle, 10000);
app.listen(PORT, () => console.log(`Sniper V8 Cloud Autônomo Ativo`));
