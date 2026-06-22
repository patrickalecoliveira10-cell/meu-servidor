const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const app = express();

app.use(cors());
app.use(express.json());

let activeConfig = null;
let exchange = new ccxt.bybit({ timeout: 20000, enableRateLimit: true, options: { 'defaultType': 'linear' } });
let eventLog = [];
let serverData = {
    price: 0, score: 0, rsi: 50, vol: 1.0,
    pos: { side: null, entry: 0, qty: 0, roi: 0, partials: "0/2", trail: "Inativo" }
};

// --- FUNÇÕES TÉCNICAS (IGUAL AO APP) ---

function calculateEMA(data, period) {
    if (data.length < period) return null;
    const k = 2 / (period + 1);
    let ema = data[0];
    for (let i = 1; i < data.length; i++) {
        ema = (data[i] * k) + (ema * (1 - k));
    }
    return ema;
}

function calculateVWAP(ohlcv) {
    let sumTPV = 0, sumVol = 0;
    ohlcv.forEach(c => {
        const tp = (c[2] + c[3] + c[4]) / 3; // (H+L+C)/3
        const v = c[5];
        sumTPV += tp * v;
        sumVol += v;
    });
    return sumVol > 0 ? sumTPV / sumVol : null;
}

async function getOIGrowing(sym) {
    try {
        const oi = await exchange.publicGetV5MarketOpenInterest({ category: 'linear', symbol: sym, interval: '5min', limit: 2 });
        if (oi.retCode === 0 && oi.result.list.length >= 2) {
            return parseFloat(oi.result.list[0].openInterest) > parseFloat(oi.result.list[1].openInterest);
        }
    } catch (e) {}
    return false;
}

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        let diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    let rs = gains / (losses || 1);
    return 100 - (100 / (1 + rs));
}

// --- MOTOR DE TRADING ---

async function runTradingLoop() {
    while (activeConfig) {
        try {
            const sym = activeConfig.sym;
            const ticker = await exchange.fetchTicker(sym);
            const ohlcv = await exchange.fetchOHLCV(sym, '1m', undefined, 210); // Busca 210 velas para EMA 200
            
            const price = ticker.last;
            const closes = ohlcv.map(c => c[4]);
            const volumes = ohlcv.map(c => c[5]);

            // 1. Cálculos Base
            const ema200 = calculateEMA(closes, 200);
            const vwap = calculateVWAP(ohlcv.slice(-30)); // VWAP das últimas 30 velas
            const rsi = calculateRSI(closes, 14);
            const oiGrowing = await getOIGrowing(sym);
            
            const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
            const volRatio = volumes[volumes.length - 1] / (avgVol || 1);

            // 2. LÓGICA MASTER SCORE (IDÊNTICA AO APP)
            let masterScore = 0;
            if (ema200 && vwap) {
                if (price > ema200) { // Tendência de ALTA
                    if (price > vwap * 0.998) {
                        masterScore = 40;
                        if (oiGrowing) masterScore += 30;
                        if (volRatio > 1.2) masterScore += 20;
                        if (rsi < 70) masterScore += 10;
                    }
                } else if (price < ema200) { // Tendência de QUEDA
                    if (price < vwap * 1.002) {
                        masterScore = 40;
                        if (oiGrowing) masterScore += 30;
                        if (volRatio > 1.2) masterScore += 20;
                        if (rsi > 30) masterScore += 10;
                    }
                }
            }

            // 3. Atualiza Telemetria
            serverData.price = price;
            serverData.rsi = rsi;
            serverData.vol = volRatio;
            serverData.score = masterScore;

            // 4. Gestão de Posição
            if (serverData.pos.side) {
                const p = serverData.pos;
                const isL = p.side === 'long';
                p.roi = isL ? ((price - p.entry)/p.entry)*100*10 : ((p.entry - price)/p.entry)*100*10;
                if (p.roi >= activeConfig.trailAct) p.trail = "ATIVO";
            } else if (masterScore >= 70) {
                serverData.pos = { side: (price > ema200 ? 'long' : 'short'), entry: price, qty: 1, roi: 0, partials: "0/2", trail: "Inativo" };
                addLog(`🔔 ENTRADA MASTER: ${serverData.pos.side.toUpperCase()} em ${price}`);
            }

            await new Promise(r => setTimeout(r, 5000));
        } catch (e) {
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

// --- ROTAS EXPRESS ---

app.post('/control', (req, res) => {
    if (req.body.action === 'start') {
        activeConfig = req.body;
        if (activeConfig.apiKey && activeConfig.apiSecret) {
            exchange.apiKey = activeConfig.apiKey; exchange.secret = activeConfig.apiSecret;
        }
        runTradingLoop();
        res.json({ status: "ok" });
    } else {
        activeConfig = null;
        res.json({ status: "stopped" });
    }
});

app.get('/status', (req, res) => {
    res.json({ ...serverData, eventLog: eventLog.slice(-10) });
});

function addLog(msg) {
    eventLog.push({ msg, time: Date.now() });
    if (eventLog.length > 20) eventLog.shift();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor Master Online"));
