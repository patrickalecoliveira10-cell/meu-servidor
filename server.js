const express = require('express');
const cors = require('cors');const ccxt = require('ccxt');
const app = express();

app.use(cors());
app.use(express.json());

let activeConfig = null;
let isLoopRunning = false;
let exchange = new ccxt.bybit({ timeout: 30000, enableRateLimit: true, options: { 'defaultType': 'linear' } });

let eventLog = [];
let serverData = {
    price: 0, 
    scoreLong: 0, scoreShort: 0,
    rsi: 50, vol: 1.0,
    pos: { 
        side: null, entry: 0, qty: 0, roi: 0, 
        partialsEntry: 0, 
        partialExitDone: false, 
        trail: "Inativo", peak: 0 
    }
};

function addLog(msg) {
    const time = Date.now();
    eventLog.push({ msg, time });
    if (eventLog.length > 30) eventLog.shift();
    console.log(`[${new Date(time).toLocaleTimeString()}] ${msg}`);
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
            const avgVol = (volumes.slice(-20).reduce((a, b) => a + b, 0) / 20) || 1;
            const volRatio = volumes[volumes.length - 1] / avgVol;

            let sL = 0, sS = 0;
            if (ema200 && vwap) {
                if (price > ema200 && price > vwap * 0.998) {
                    sL = 40; if (oiGrowing) sL += 30; if (volRatio >= 1.1) sL += 20; if (rsi < 70) sL += 10;
                }
                if (price < ema200 && price < vwap * 1.002) {
                    sS = 40; if (oiGrowing) sS += 30; if (volRatio >= 1.1) sS += 20; if (rsi > 30) sS += 10;
                }
            }

            serverData.price = price;
            serverData.scoreLong = sL; serverData.scoreShort = sS;
            serverData.rsi = rsi; serverData.vol = volRatio;

            if (serverData.pos.side) {
                await manageAdvancedPosition(price, sL, sS, ema200, volRatio);
            } else {
                const triggerL = (sL >= 70 && volRatio >= 1.1);
                const triggerS = (sS >= 70 && volRatio >= 1.1);
                if (triggerL && !triggerS) await openPosition('buy', price);
                else if (triggerS && !triggerL) await openPosition('sell', price);
            }
        } catch (e) { console.error("Loop Error:", e.message); }
        await new Promise(r => setTimeout(r, 4000));
    }
    isLoopRunning = false;
}

async function manageAdvancedPosition(price, sL, sS, ema200, volRatio) {
    const p = serverData.pos;
    const cfg = activeConfig;
    const isL = p.side === 'buy';
    p.roi = isL ? ((price - p.entry)/p.entry)*1000 : ((p.entry - price)/p.entry)*1000;

    const signalOpposite = isL ? (sS >= 70) : (sL >= 70);
    const signalSame = isL ? (sL >= 70) : (sS >= 70);

    if (signalOpposite) {
        if (p.roi < 0) { // VIRADA (FLIP)
            addLog("🔄 FLIP: Reversão detectada.");
            await closePosition("FLIP", p.roi);
            await openPosition(isL ? 'sell' : 'buy', price);
            return;
        } else if (p.roi > 0 && p.trail === "Inativo") { // FECHAR NO LUCRO
            await closePosition("SINAL OPOSTO", p.roi);
            return;
        } else if (p.trail === "ATIVO" && !p.partialExitDone) { // SAÍDA PARCIAL
            await executePartialExit();
        } else if (p.trail === "ATIVO" && p.partialExitDone) { // SAÍDA FINAL
            await closePosition("SAÍDA TOTAL", p.roi);
            return;
        }
    }

    if (signalSame && p.roi > 5 && p.partialsEntry < 2) await executePartialEntry();

    if (p.roi <= -cfg.stopPct * 10) await closePosition("STOP LOSS", p.roi);
    if (p.trail === "Inativo" && p.roi >= cfg.trailAct * 10) { p.trail = "ATIVO"; p.peak = price; addLog("🎯 Trailing Ativado"); }
    
    if (p.trail === "ATIVO") {
        if (isL && price > p.peak) p.peak = price;
        if (!isL && price < p.peak) p.peak = price;
        const pullback = isL ? ((p.peak-price)/p.peak)*1000 : ((price-p.peak)/p.peak)*1000;
        if (pullback >= cfg.trailPull * 10) await closePosition("TRAILING", p.roi);
    }
}

async function openPosition(side, price) {
    try {
        const qty = activeConfig.bankPct;
        if (exchange.apiKey) await exchange.createMarketOrder(activeConfig.sym, side, qty);
        serverData.pos = { side, entry: price, qty: qty, roi: 0, partialsEntry: 0, partialExitDone: false, trail: "Inativo", peak: price };
        addLog(`🚀 ENTRADA: ${side.toUpperCase()} em ${price}`);
    } catch (e) { addLog(`❌ ERRO ENTRADA: ${e.message}`); }
}

async function executePartialEntry() {
    try {
        const extraQty = serverData.pos.qty * 0.5;
        if (exchange.apiKey) await exchange.createMarketOrder(activeConfig.sym, serverData.pos.side, extraQty);
        serverData.pos.qty += extraQty; serverData.pos.partialsEntry += 1;
        addLog(`➕ APORTE REALIZADO (${serverData.pos.partialsEntry}/2)`);
    } catch (e) { addLog(`❌ ERRO APORTE: ${e.message}`); }
}

async function executePartialExit() {
    try {
        const closeQty = serverData.pos.qty / 2;
        const exitSide = serverData.pos.side === 'buy' ? 'sell' : 'buy';
        if (exchange.apiKey) await exchange.createMarketOrder(activeConfig.sym, exitSide, closeQty);
        serverData.pos.qty -= closeQty; serverData.pos.partialExitDone = true;
        addLog(`💰 SAÍDA PARCIAL 50% REALIZADA.`);
    } catch (e) { addLog(`❌ ERRO PARCIAL: ${e.message}`); }
}

async function closePosition(reason, roi) {
    try {
        if (exchange.apiKey && serverData.pos.side) {
            await exchange.createMarketOrder(activeConfig.sym, serverData.pos.side === 'buy' ? 'sell' : 'buy', serverData.pos.qty);
        }
        addLog(`🏁 FECHADO (${reason}) | ROI: ${(roi/10).toFixed(2)}%`);
        serverData.pos.side = null;
    } catch (e) { serverData.pos.side = null; }
}

app.post('/control', (req, res) => {
    const { action } = req.body;
    if (action === 'start') {
        activeConfig = req.body;
        if (activeConfig.apiKey && activeConfig.apiSecret) {
            exchange.apiKey = activeConfig.apiKey; exchange.secret = activeConfig.apiSecret;
        }
        runTradingLoop();
        res.json({ status: "ok" });
    } else if (action === 'stop') {
        activeConfig = null; serverData.pos.side = null;
        res.json({ status: "stopped" });
    } else if (action === 'close_now') {
        if (serverData.pos.side) closePosition("MANUAL", serverData.pos.roi);
        res.json({ status: "closed" });
    }
});

app.get('/status', (req, res) => res.json({ ...serverData, eventLog: eventLog.slice(-15) }));

function calculateEMA(d, p) { if (d.length < p) return null; const k = 2/(p+1); let ema = d[0]; for (let i=1; i<d.length; i++) ema = (d[i]*k)+(ema*(1-k)); return ema; }
function calculateVWAP(o) { let t=0, v=0; o.forEach(c=>{ t+=((c[2]+c[3]+c[4])/3)*c[5]; v+=c[5]; }); return v>0?t/v:null; }
function calculateRSI(c, p=14) { if (c.length<p+1) return 50; let g=0, l=0; for (let i=c.length-p; i<c.length; i++) { let d=c[i]-c[i-1]; if (d>=0) g+=d; else l-=d; } return 100-(100/(1+(g/(l||1)))); }
async function getOIGrowing(s) { try { const o=await exchange.publicGetV5MarketOpenInterest({category:'linear',symbol:s,interval:'5min',limit:2}); return parseFloat(o.result.list[0].openInterest)>parseFloat(o.result.list[1].openInterest); } catch(e){return false;} }

app.listen(process.env.PORT || 3000);
