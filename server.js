const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');

const app = express();
app.use(cors());
app.use(express.json());

// --- ESTADO GLOBAL ---
let activeConfig = null;
let isLoopRunning = false;
let exchange = new ccxt.bybit({ 
    timeout: 30000, 
    enableRateLimit: true, 
    options: { 'defaultType': 'linear' } 
});

let eventLog = [];
let serverData = {
    price: 0, 
    scoreLong: 0, 
    scoreShort: 0,
    rsi: 50, 
    vol: 1.0,
    pos: { 
        side: null, entry: 0, qty: 0, roi: 0, 
        partialsEntry: 0,      // Conta quantos aportes extras foram feitos (máx 2)
        partialExitDone: false, // Controla se já tirou 50% no trailing
        trail: "Inativo", peak: 0 
    }
};

// --- FUNÇÕES AUXILIARES ---
function addLog(msg) {
    const time = Date.now();
    console.log(`[${new Date(time).toLocaleTimeString()}] ${msg}`);
    eventLog.push({ msg, time });
    if (eventLog.length > 40) eventLog.shift();
}

function calculateEMA(data, period) {
    if (data.length < period) return null;
    const k = 2 / (period + 1);
    let ema = data[0];
    for (let i = 1; i < data.length; i++) ema = (data[i] * k) + (ema * (1 - k));
    return ema;
}

function calculateVWAP(ohlcv) {
    let sumTPV = 0, sumVol = 0;
    ohlcv.forEach(c => {
        const tp = (c[2] + c[3] + c[4]) / 3;
        const v = c[5];
        sumTPV += tp * v;
        sumVol += v;
    });
    return sumVol > 0 ? sumTPV / sumVol : null;
}

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        let diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    return 100 - (100 / (1 + (gains / (losses || 1))));
}

async function getOIGrowing(sym) {
    try {
        const oi = await exchange.publicGetV5MarketOpenInterest({ category: 'linear', symbol: sym, interval: '5min', limit: 2 });
        return parseFloat(oi.result.list[0].openInterest) > parseFloat(oi.result.list[1].openInterest);
    } catch (e) { return false; }
}

// --- MOTOR DE TRADING ---
async function runTradingLoop() {
    if (isLoopRunning) return;
    isLoopRunning = true;

    while (activeConfig) {
        try {
            const sym = activeConfig.sym;
            const ohlcv = await exchange.fetchOHLCV(sym, '1m', undefined, 250);
            const ticker = await exchange.fetchTicker(sym);
            const price = ticker.last;
            const closes = ohlcv.map(c => c[4]);
            const volumes = ohlcv.map(c => c[5]);

            const ema200 = calculateEMA(closes, 200);
            const vwap = calculateVWAP(ohlcv.slice(-30));
            const rsi = calculateRSI(closes, 14);
            const oiGrowing = await getOIGrowing(sym);
            const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
            const volRatio = volumes[volumes.length - 1] / (avgVol || 1);

            // CÁLCULO DE SCORES (LONG E SHORT)
            let sL = 0, sS = 0;
            if (ema200 && vwap) {
                if (price > ema200 && price > vwap * 0.998) {
                    sL = 40; if (oiGrowing) sL += 30; if (volRatio > 1.1) sL += 20; if (rsi < 70) sL += 10;
                }
                if (price < ema200 && price < vwap * 1.002) {
                    sS = 40; if (oiGrowing) sS += 30; if (volRatio > 1.1) sS += 20; if (rsi > 30) sS += 10;
                }
            }

            serverData.price = price;
            serverData.scoreLong = sL;
            serverData.scoreShort = sS;
            serverData.rsi = rsi;
            serverData.vol = volRatio;

            if (serverData.pos.side) {
                await manageAdvancedPosition(price, sL, sS, ema200, volRatio);
            } else {
                // ENTRADA: Apenas se um lado der gatilho e o outro não
                const triggerL = (sL >= 70 && volRatio >= 1.1);
                const triggerS = (sS >= 70 && volRatio >= 1.1);

                if (triggerL && !triggerS) await openPosition('buy', price);
                else if (triggerS && !triggerL) await openPosition('sell', price);
            }

            await new Promise(r => setTimeout(r, 4000));
        } catch (e) {
            console.error("Erro no Loop:", e.message);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    isLoopRunning = false;
    addLog("💤 Motor desligado.");
}

// --- GESTÃO DA POSIÇÃO (A LÓGICA QUE VOCÊ PEDIU) ---
async function manageAdvancedPosition(price, sL, sS, ema200, volRatio) {
    const p = serverData.pos;
    const cfg = activeConfig;
    const isL = p.side === 'buy';
    
    // Atualiza ROI (Simulando 10x)
    p.roi = isL ? ((price - p.entry)/p.entry)*100*10 : ((p.entry - price)/p.entry)*100*10;

    const signalOpposite = isL ? (sS >= 70) : (sL >= 70);
    const signalSame = isL ? (sL >= 70) : (sS >= 70);

    // 1. LÓGICA DE SINAL CONTRÁRIO
    if (signalOpposite) {
        if (p.roi < 0) {
            addLog("🔄 VIRADA (FLIP): ROI Negativo + Sinal Contrário.");
            await closePosition("FLIP", p.roi);
            await openPosition(isL ? 'sell' : 'buy', price);
            return;
        } 
        else if (p.roi > 0 && p.trail === "Inativo") {
            addLog("💰 FECHAMENTO: Sinal Contrário com Lucro antes do Trailing.");
            await closePosition("SINAL CONTRÁRIO", p.roi);
            return;
        }
        else if (p.trail === "ATIVO" && !p.partialExitDone) {
            addLog("⚠️ SAÍDA PARCIAL: Sinal Contrário no Trailing. Vendendo 50%...");
            await executePartialExit();
        }
        else if (p.trail === "ATIVO" && p.partialExitDone) {
            addLog("🏁 FECHAMENTO TOTAL: Segundo sinal contrário após parcial.");
            await closePosition("SAÍDA FINAL", p.roi);
            return;
        }
    }

    // 2. LÓGICA DE SINAL A FAVOR (APORTES PARCIAIS)
    if (signalSame && p.roi > 0.5 && p.partialsEntry < 2) {
        addLog(`➕ APORTE (${p.partialsEntry + 1}/2): Sinal a favor detectado.`);
        await executePartialEntry();
    }

    // 3. STOP LOSS
    if (p.roi <= -cfg.stopPct) return await closePosition("STOP LOSS", p.roi);

    // 4. TRAILING STOP
    if (p.trail === "Inativo" && p.roi >= cfg.trailAct) {
        p.trail = "ATIVO"; p.peak = price;
        addLog("🎯 TRAILING ATIVADO");
    }
    if (p.trail === "ATIVO") {
        if (isL && price > p.peak) p.peak = price;
        if (!isL && price < p.peak) p.peak = price;
        const pullback = isL ? ((p.peak - price)/p.peak)*1000 : ((price - p.peak)/p.peak)*1000;
        if (pullback >= cfg.trailPull * 10) await closePosition("TRAILING PULBACK", p.roi);
    }
}

// --- FUNÇÕES DE EXECUÇÃO REAL ---
async function openPosition(side, price) {
    try {
        const qty = activeConfig.bankPct;
        if (exchange.apiKey) await exchange.createMarketOrder(activeConfig.sym, side, qty);
        serverData.pos = { side, entry: price, qty: qty, roi: 0, partialsEntry: 0, partialExitDone: false, trail: "Inativo", peak: price };
        addLog(`🚀 ENTRADA REAL: ${side.toUpperCase()} em ${price}`);
    } catch (e) { addLog(`❌ ERRO ENTRADA: ${e.message}`); }
}

async function executePartialEntry() {
    try {
        const extraQty = serverData.pos.qty * 0.5;
        if (exchange.apiKey) await exchange.createMarketOrder(activeConfig.sym, serverData.pos.side, extraQty);
        serverData.pos.qty += extraQty;
        serverData.pos.partialsEntry += 1;
        addLog(`✅ APORTE REALIZADO. Nova Qtd: ${serverData.pos.qty}`);
    } catch (e) { addLog(`❌ ERRO APORTE: ${e.message}`); }
}

async function executePartialExit() {
    try {
        const closeQty = serverData.pos.qty / 2;
        const exitSide = serverData.pos.side === 'buy' ? 'sell' : 'buy';
        if (exchange.apiKey) await exchange.createMarketOrder(activeConfig.sym, exitSide, closeQty);
        serverData.pos.qty -= closeQty;
        serverData.pos.partialExitDone = true;
    } catch (e) { addLog(`❌ ERRO SAÍDA PARCIAL: ${e.message}`); }
}

async function closePosition(reason, roi) {
    try {
        if (exchange.apiKey && serverData.pos.side) {
            const side = serverData.pos.side === 'buy' ? 'sell' : 'buy';
            await exchange.createMarketOrder(activeConfig.sym, side, serverData.pos.qty);
        }
        addLog(`🏁 FECHADO (${reason}) | ROI: ${roi.toFixed(2)}%`);
        serverData.pos.side = null;
    } catch (e) { serverData.pos.side = null; }
}

// --- ROTAS DA API ---
app.post('/control', (req, res) => {
    const { action } = req.body;
    if (action === 'start') {
        activeConfig = req.body;
        if (activeConfig.apiKey) { exchange.apiKey = activeConfig.apiKey; exchange.secret = activeConfig.apiSecret; }
        runTradingLoop();
        res.json({ status: "ok" });
    } else if (action === 'stop') {
        activeConfig = null; // Encerra o loop
        serverData.pos.side = null;
        res.json({ status: "stopped" });
    } else if (action === 'close_now') {
        if (serverData.pos.side) closePosition("MANUAL", serverData.pos.roi);
        res.json({ status: "closed" });
    }
});

app.get('/status', (req, res) => res.json({ ...serverData, eventLog: eventLog.slice(-10) }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Scanner Pro Master v8 Online na Porta ${PORT}`);
});
