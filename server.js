const express = require('express');
const axios = require('axios');const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- CONFIGURAÇÃO DE CHAVES (RENDER) ---
const BYBIT_KEY = process.env.BYBIT_API_KEY; 
const BYBIT_SECRET = process.env.BYBIT_API_SECRET;
const IS_TESTNET = process.env.USE_TESTNET === 'true';

console.log("🚀 Sniper Cloud Iniciado. Chave API presente:", !!BYBIT_KEY);

// ESTADO GLOBAL DO SERVIDOR
let MONITOR = {
    active: false,
    symbol: null,
    config: { stopPct: 2.5, trailAct: 2, trailPull: 1, lev: 5 },
    position: null, // { side, entry, qty, peak, trailActive, partialEntryCount, partialExitDone }
    logs: []
};

// Funções de Log para o App ler
function serverLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const entry = { time, msg, type };
    MONITOR.logs.unshift(entry);
    if (MONITOR.logs.length > 25) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// --- INDICADORES TÉCNICOS ---
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

// --- COMUNICAÇÃO BYBIT V5 ---
function getSignature(parameters, secret, timestamp) {
    return crypto.createHmac('sha256', secret).update(timestamp + BYBIT_KEY + '5000' + parameters).digest('hex');
}

async function bybitRequest(method, endpoint, data = {}) {
    const timestamp = Date.now().toString();
    const baseUrl = IS_TESTNET ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    const parameters = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
    const sign = getSignature(parameters, BYBIT_SECRET, timestamp);

    try {
        const res = await axios({
            method,
            url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: { 
                'X-BAPI-API-KEY': BYBIT_KEY, 
                'X-BAPI-SIGN': sign, 
                'X-BAPI-TIMESTAMP': timestamp, 
                'X-BAPI-RECV-WINDOW': '5000', 
                'Content-Type': 'application/json' 
            },
            data: method !== 'GET' ? data : undefined,
            timeout: 5000
        });
        return res.data;
    } catch (e) { 
        serverLog(`Falha API: ${e.message}`, 'err');
        return { error: e.message }; 
    }
}

// --- EXECUÇÃO DE ORDENS ---
async function openOrder(side, symbol, lev, qty) {
    serverLog(`[EXEC] Abrindo ${side} em ${symbol} (Qty: ${qty})`, 'warn');
    await bybitRequest('POST', '/v5/position/set-leverage', { category: 'linear', symbol, buyLeverage: lev.toString(), sellLeverage: lev.toString() });
    
    const resp = await bybitRequest('POST', '/v5/order/create', {
        category: 'linear', symbol, side: side === 'LONG' ? 'Buy' : 'Sell',
        orderType: 'Market', qty: qty.toString(), timeInForce: 'GTC'
    });
    
    if (resp.retCode !== 0) serverLog(`Erro Ordem: ${resp.retMsg}`, 'err');
    return resp;
}

async function closeOrder(symbol, side, qty) {
    serverLog(`[EXEC] Fechando ${side} em ${symbol}`, 'warn');
    return await bybitRequest('POST', '/v5/order/create', {
        category: 'linear', symbol, side: side === 'LONG' ? 'Sell' : 'Buy',
        orderType: 'Market', qty: qty.toString(), timeInForce: 'GTC'
    });
}

// --- CICLO AUTÔNOMO DE MONITORAMENTO ---
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

        // Indicadores Sniper
        const ema200 = parEMA(closes, 200);
        const vwap = parVWAP(candles);
        const lastVol = candles[candles.length - 1].vol;
        const avgVol = candles.slice(-20).reduce((a, b) => a + b.vol, 0) / 20;
        const volRatio = lastVol / avgVol;
        const oiGrowing = parseFloat(oi.result?.list[0]?.openInterest) > parseFloat(oi.result?.list[1]?.openInterest);

        let longScore = (ema200 && price > ema200 && vwap && price > vwap) ? 50 : 0;
        if (oiGrowing) longScore += 30;
        if (volRatio > 1.1) longScore += 20;

        let shortScore = (ema200 && price < ema200 && vwap && price < vwap) ? 50 : 0;
        if (oiGrowing) shortScore += 30;
        if (volRatio > 1.1) shortScore += 20;

        const longTrigger = longScore >= 70 && volRatio >= 1.1;
        const shortTrigger = shortScore >= 70 && volRatio >= 1.1;

        if (MONITOR.position) {
            const pos = MONITOR.position;
            const isLong = pos.side === 'LONG';
            const roi = (isLong ? (price - pos.entry) / pos.entry : (pos.entry - price) / pos.entry) * 100 * MONITOR.config.lev;

            // 1. Stop Loss
            if (roi <= -MONITOR.config.stopPct) {
                await closeOrder(MONITOR.symbol, pos.side, pos.qty);
                MONITOR.position = null;
                serverLog("🔴 Stop Loss Atingido", "err");
            }
            // 2. Virada Sniper (Flip)
            else if (roi < 0 && (isLong ? shortTrigger : longTrigger)) {
                await closeOrder(MONITOR.symbol, pos.side, pos.qty);
                const res = await openOrder(isLong ? 'SHORT' : 'LONG', MONITOR.symbol, MONITOR.config.lev, pos.qty);
                if (res.retCode === 0) {
                    MONITOR.position = { ...pos, side: isLong ? 'SHORT' : 'LONG', entry: price, peak: price };
                    serverLog("🔄 Virada de Mão (Flip)", "warn");
                }
            }
            // 3. Trailing Check (Simplificado)
            else {
                if (isLong && price > pos.peak) pos.peak = price;
                if (!isLong && (price < pos.peak || pos.peak === 0)) pos.peak = price;
            }
        } 
        // Entrada Nova
        else if (longTrigger || shortTrigger) {
            if (longTrigger && shortTrigger) return; // Conflito

            const side = longTrigger ? 'LONG' : 'SHORT';
            // Cálculo de Qty para ~$6.00 USD (Mínimo Bybit)
            const tradeQty = (6.5 / price).toFixed(MONITOR.symbol.includes('BTC') ? 3 : MONITOR.symbol.includes('ETH') ? 2 : 1);
            
            const res = await openOrder(side, MONITOR.symbol, MONITOR.config.lev, tradeQty);
            if (res.retCode === 0) {
                MONITOR.position = { side, entry: price, qty: tradeQty, peak: price, trailActive: false, partialEntryCount: 0 };
                serverLog(`🔥 Entrada Sniper: ${side} em ${price}`, 'ok');
            }
        }
    } catch (e) {
        console.error("Erro no ciclo:", e.message);
    }
}

// --- ROTAS DO SERVIDOR ---
app.get('/status', (req, res) => res.json(MONITOR));

app.post('/sync-par', (req, res) => {
    const { symbol, active, config } = req.body;
    MONITOR.active = active;
    if (active) {
        MONITOR.symbol = symbol;
        MONITOR.config = config;
        serverLog(`Sniper Cloud: Ativado para ${symbol}`, 'info');
    } else {
        MONITOR.position = null;
        serverLog(`Sniper Cloud: Desativado`, 'warn');
    }
    res.json({ success: true });
});

setInterval(serverCycle, 8000);

app.listen(PORT, () => console.log(`Servidor Sniper Ativo na Porta ${PORT}`));
