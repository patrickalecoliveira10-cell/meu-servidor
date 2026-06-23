const express = require('express');
const ccxt = require('ccxt');const TI = require('technicalindicators');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- ESTADO GLOBAL ---
let exchange = new ccxt.bybit({ options: { 'defaultType': 'linear' } });
let activeConfig = { 
    sym: "", 
    bankPct: 30,         // Entrada inicial (30% da banca)
    partialBankPct: 5,   // Aportes parciais (5% da banca)
    lev: 1,              // Alavancagem
    stopPct: 1.5,        // Stop Loss
    trailAct: 1.5,       // Ativação Trailing
    trailPull: 0.8,      // Recuo Trailing
    apiKey: "", 
    apiSecret: "" 
};

let serverData = {
    pos: null, 
    logs: [],
    lastPrice: 0,
    score: 0,
    rsi: 50,
    vol: 1.0
};

function addLog(msg) {
    const log = `[${new Date().toLocaleTimeString()}] ☁️ ${msg}`;
    serverData.logs.unshift(log);
    if (serverData.logs.length > 50) serverData.logs.pop();
    console.log(log);
}

// --- CÁLCULOS TÉCNICOS ---
function calculateVWAP(candles) {
    let totalPV = 0, totalV = 0;
    candles.forEach(c => {
        let p = (c[2] + c[3] + c[4]) / 3;
        totalPV += p * c[5];
        totalV += c[5];
    });
    return totalV > 0 ? totalPV / totalV : 0;
}

async function getOITrend(sym) {
    try {
        const oi = await exchange.fetchOpenInterestHistory(sym, '1h', undefined, 5);
        if (oi.length < 2) return "estável";
        return oi[oi.length-1].openInterestValue > oi[oi.length-2].openInterestValue ? "crescente" : "caindo";
    } catch (e) { return "estável"; }
}

async function analyzeStrategy() {
    if (!activeConfig.sym) return;
    try {
        const candles = await exchange.fetchOHLCV(activeConfig.sym, '1m', undefined, 210);
        const closes = candles.map(c => c[4]);
        const price = closes[closes.length - 1];
        const prevCandle = candles[candles.length - 2];
        const lastCandle = candles[candles.length - 1];
        serverData.lastPrice = price;

        const rsi = TI.RSI.calculate({ values: closes, period: 14 }).pop() || 50;
        const ema200 = TI.EMA.calculate({ values: closes, period: 200 }).pop();
        const vwap = calculateVWAP(candles.slice(-60));
        const oiTrend = await getOITrend(activeConfig.sym);
        const avgVol = candles.slice(-20).reduce((a, b) => a + b[5], 0) / 20;
        const volRatio = lastCandle[5] / (avgVol || 1);

        serverData.rsi = rsi;
        serverData.vol = volRatio;

        let sL = 0, sS = 0;
        if (price > ema200 && price > vwap * 0.998) {
            sL = 40;
            if (oiTrend === "crescente") sL += 30;
            if (volRatio > 1.2) sL += 20;
            if (rsi < 70) sL += 10;
        } else if (price < ema200 && price < vwap * 1.002) {
            sS = 40;
            if (oiTrend === "crescente") sS += 30;
            if (volRatio > 1.2) sS += 20;
            if (rsi > 30) sS += 10;
        }

        serverData.score = sL >= sS ? sL : -sS;
        const longTrigger = sL >= 70 && volRatio >= 1.1;
        const shortTrigger = sS >= 70 && volRatio >= 1.1;

        if (longTrigger && shortTrigger && !serverData.pos) return;

        if (!serverData.pos) {
            if (volRatio < 1.5) {
                if (longTrigger && price <= prevCandle[2]) return;
                if (shortTrigger && price >= prevCandle[3]) return;
            }
            if (longTrigger) await openPosition('buy', price);
            else if (shortTrigger) await openPosition('sell', price);
        } else {
            const p = serverData.pos;
            const isL = p.side === 'buy';
            const roi = (isL ? (price - p.entry)/p.entry : (p.entry - price)/p.entry) * 100 * activeConfig.lev;
            p.roi = roi;
            if (roi > p.peak) p.peak = roi;

            const contrary = isL ? shortTrigger : longTrigger;
            const favor = isL ? longTrigger : shortTrigger;

            if (roi <= -activeConfig.stopPct) return await closePosition("Stop Loss");

            if (roi < 0 && contrary) {
                addLog("🔄 FLIP MASTER");
                await closePosition();
                return await openPosition(isL ? 'sell' : 'buy', price);
            }

            if (favor && p.partialEntryCount < 2 && Math.abs((price - p.entry)/p.entry) > 0.003) {
                await openPosition(p.side, price, true); // Usa 5% para parcial
            }

            if (roi > 0 && p.peak < activeConfig.trailAct && contrary) return await closePosition("Segurança Profit");

            if (!p.trailActive && roi >= activeConfig.trailAct) p.trailActive = true;

            if (p.trailActive) {
                if (contrary) {
                    if (!p.partialExitDone) {
                        addLog("💰 PARCIAL 50% NO TRAILING");
                        await executePartial(0.5);
                        p.partialExitDone = true;
                    } else return await closePosition("Sinal contrário pós-parcial");
                }
                if ((p.peak - roi) >= activeConfig.trailPull) return await closePosition("Trailing Stop");
            }
        }
    } catch (e) { console.log("Erro:", e.message); }
}

async function openPosition(side, price, isPartial = false) {
    try {
        if (!exchange.apiKey) {
            addLog(`📝 SIMULADO: ${isPartial ? 'Parcial' : 'Entrada'} ${side}`);
            if (isPartial) { serverData.pos.partialEntryCount++; return; }
            serverData.pos = { side, entry: price, qty: 1, roi: 0, peak: 0, partialEntryCount: 0, partialExitDone: false, trailActive: false };
            return;
        }
        const balance = await exchange.fetchBalance();
        const usdtFree = balance.free['USDT'] || 0;
        
        // RESPEITA A CONFIGURAÇÃO: 30% para inicial, 5% para parcial
        const currentPct = isPartial ? activeConfig.partialBankPct : activeConfig.bankPct;
        let qty = (usdtFree * (currentPct / 100) * activeConfig.lev) / price;
        qty = qty * 0.98; // Buffer de segurança

        const pQty = parseFloat(exchange.amountToPrecision(activeConfig.sym, qty));
        if (pQty <= 0) return;

        await exchange.setLeverage(activeConfig.lev, activeConfig.sym).catch(()=>{});
        await exchange.createMarketOrder(activeConfig.sym, side, pQty);

        if (isPartial) {
            const oldQty = serverData.pos.qty;
            const oldEntry = serverData.pos.entry;
            serverData.pos.entry = (oldQty * oldEntry + pQty * price) / (oldQty + pQty);
            serverData.pos.qty += pQty;
            serverData.pos.partialEntryCount++;
        } else {
            serverData.pos = { side, entry: price, qty: pQty, roi: 0, peak: 0, partialEntryCount: 0, partialExitDone: false, trailActive: false };
        }
        addLog(`✅ ${isPartial ? 'PARCIAL' : 'ORDEM'} ${side.toUpperCase()} OK (${currentPct}%)`);
    } catch (e) { addLog("❌ Erro Ordem: " + e.message); }
}

async function closePosition(reason = "") {
    try {
        if (serverData.pos && exchange.apiKey) {
            await exchange.createMarketOrder(activeConfig.sym, serverData.pos.side === 'buy' ? 'sell' : 'buy', serverData.pos.qty);
        }
        serverData.pos = null;
        addLog(`🛑 FECHADO: ${reason}`);
    } catch (e) { serverData.pos = null; }
}

async function executePartial(pct) {
    try {
        const q = parseFloat(exchange.amountToPrecision(activeConfig.sym, serverData.pos.qty * pct));
        await exchange.createMarketOrder(activeConfig.sym, serverData.pos.side === 'buy' ? 'sell' : 'buy', q);
        serverData.pos.qty -= q;
    } catch (e) {}
}

app.post('/control', async (req, res) => {
    const cfg = req.body;
    if (cfg.action === 'start') {
        activeConfig = { ...activeConfig, ...cfg };
        if (cfg.apiKey) {
            exchange = new ccxt.bybit({ apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, options: { 'defaultType': 'linear' } });
        }
        addLog(`🚀 NUVEM MASTER LIGADA: ${activeConfig.sym} | Banca: ${activeConfig.bankPct}% | Alav: ${activeConfig.lev}x`);
    } else await closePosition("Comando App");
    res.json({ status: "ok" });
});

app.get('/status', (req, res) => res.json(serverData));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Live na porta ${PORT}`);
    setInterval(analyzeStrategy, 5000);
});
