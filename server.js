// server.js - VERSÃO COM INTELIGÊNCIA TÉCNICA (EMA, VWAP, RSI)
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Estado do Monitoramento
let MONITOR = {
    active: false,
    symbol: null,
    config: {},   
    position: null,
    lastAnalysis: {} // Guarda os indicadores para consulta
};

// --- FUNÇÕES MATEMÁTICAS (IGUAIS AO SCANNER.HTML) ---

function calculateEMA(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b) / period;
    for (let i = period; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
    }
    return ema;
}

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        let diff = closes[i] - closes[i-1];
        if (diff > 0) gains += diff; else losses -= diff;
    }
    let avgG = gains / period, avgL = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
        let diff = closes[i] - closes[i-1];
        avgG = (avgG * (period - 1) + (diff > 0 ? diff : 0)) / period;
        avgL = (avgL * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    }
    return avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
}

function calculateVWAP(candles) {
    let totalPV = 0, totalV = 0;
    // Usa as últimas 100 velas para o VWAP de sessão curta
    candles.slice(-100).forEach(c => {
        let p = (parseFloat(c.high) + parseFloat(c.low) + parseFloat(c.close)) / 3;
        let v = parseFloat(c.vol);
        totalPV += p * v;
        totalV += v;
    });
    return totalV === 0 ? 0 : totalPV / totalV;
}

// --- UTILITÁRIOS BYBIT ---

function getSignature(parameters, secret, timestamp) {
    return crypto.createHmac('sha256', secret).update(timestamp + process.env.BYBIT_KEY + '5000' + parameters).digest('hex');
}

async function bybitRequest(method, endpoint, data = {}) {
    const timestamp = Date.now().toString();
    const parameters = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
    const sign = getSignature(parameters, process.env.BYBIT_SECRET, timestamp);
    const baseUrl = process.env.USE_TESTNET === 'true' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';

    try {
        const res = await axios({
            method,
            url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: {
                'X-BAPI-API-KEY': process.env.BYBIT_KEY,
                'X-BAPI-SIGN': sign,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': '5000',
                'Content-Type': 'application/json'
            },
            data: method !== 'GET' ? data : undefined,
            timeout: 8000
        });
        return res.data;
    } catch (e) { return null; }
}

// --- LÓGICA DE MONITORAMENTO "NORMAL" (IGUAL AO APP) ---

async function runServerMonitor() {
    if (!MONITOR.active || !MONITOR.symbol) return;

    try {
        const { symbol, config, position } = MONITOR;

        // 1. Busca Velas (Igual parGetCandles no app)
        const resp = await bybitRequest('GET', '/v5/market/kline', {
            category: 'linear', symbol, interval: '1', limit: '210'
        });

        if (!resp || !resp.result || !resp.result.list.length) return;

        const candles = resp.result.list.map(k => ({
            time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
            low: parseFloat(k[3]), close: parseFloat(k[4]), vol: parseFloat(k[5])
        })).reverse();

        const price = candles[candles.length - 1].close;
        const closes = candles.map(c => c.close);

        // 2. Calcula Indicadores
        const ema200 = calculateEMA(closes, 200);
        const vwap = calculateVWAP(candles);
        const rsi = calculateRSI(closes, 14);

        // 3. Define Score de Tendência
        let masterScore = 0;
        let trendUp = ema200 && price > ema200 && price > vwap;
        let trendDown = ema200 && price < ema200 && price < vwap;

        if (trendUp) masterScore = 70; 
        if (trendDown) masterScore = 70;

        MONITOR.lastAnalysis = { price, ema200, vwap, rsi, masterScore };

        console.log(`[${symbol}] Preço: ${price} | RSI: ${rsi.toFixed(1)} | Score: ${masterScore}`);

        // 4. Gestão de Posição (Trailing/Stop)
        if (position && position.side) {
            const isLong = position.side.toLowerCase() === 'long';
            const pVar = isLong ? (price - position.entry)/position.entry : (position.entry - price)/position.entry;
            const roi = pVar * 100 * config.lev;

            // Stop Loss
            if (roi <= -config.stopPct) {
                console.log("❌ STOP LOSS");
                await closePosition();
                return;
            }

            // Trailing
            if (!position.trailActive && roi >= config.trailAct) {
                position.trailActive = true;
                position.peak = price;
                console.log("🎯 TRAILING ATIVADO");
            }

            if (position.trailActive) {
                if ((isLong && price > position.peak) || (!isLong && price < position.peak)) position.peak = price;
                const pull = isLong ? (position.peak - price)/position.peak*100 : (price - position.peak)/position.peak*100;
                if ((pull * config.lev) >= config.trailPull) {
                    console.log("🏁 TRAILING FINALIZADO");
                    await closePosition();
                }
            }
        }
    } catch (e) {
        console.error("Erro no ciclo:", e.message);
    }
}

async function closePosition() {
    const side = MONITOR.position.side.toLowerCase() === 'long' ? 'Sell' : 'Buy';
    await bybitRequest('POST', '/v5/order/create', {
        category: 'linear', symbol: MONITOR.symbol, side,
        orderType: 'Market', qty: MONITOR.position.qty.toString(), reduceOnly: true
    });
    MONITOR.active = false;
}

// --- API ---

app.post('/sync-par', (req, res) => {
    const { symbol, active, config, position } = req.body;
    if (active) {
        MONITOR = { 
            active: true, symbol, 
            config: config || {}, 
            position: position || null,
            lastAnalysis: {}
        };
        console.log(`🚀 Monitoramento Servidor iniciado para ${symbol}`);
    } else {
        MONITOR.active = false;
    }
    res.json({ success: true });
});

app.get('/status', (req, res) => res.json(MONITOR));

setInterval(runServerMonitor, 5000);

app.listen(PORT, () => console.log(`Servidor Inteligente rodando na porta ${PORT}`));
