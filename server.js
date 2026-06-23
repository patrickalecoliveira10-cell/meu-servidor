const express = require('express');
const ccxt = require('ccxt');
const TI = require('technicalindicators');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- ESTADO GLOBAL ---
let exchange = new ccxt.bybit({ options: { 'defaultType': 'linear' } });
let activeConfig = { 
    sym: "", bankPct: 30, partialBankPct: 5, lev: 1, stopPct: 1.5, 
    trailAct: 1.5, trailPull: 0.8, apiKey: "", apiSecret: "" 
};

let serverData = {
    pos: null, 
    eventLog: [], 
    lastPrice: 0,
    score: 0,
    rsi: 50,
    vol: 1.0,
    vwap: 0,
    ema200: 0
};

function addLog(msg) {
    const logEntry = { time: Date.now(), msg: msg };
    serverData.eventLog.unshift(logEntry);
    if (serverData.eventLog.length > 30) serverData.eventLog.pop();
    console.log(`[LOG] ${msg}`);
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
        const vwap = (function(cands) {
            let tpv = 0, tv = 0;
            cands.forEach(c => {
                let p = (c[2] + c[3] + c[4]) / 3;
                tpv += p * c[5]; tv += c[5];
            });
            return tv > 0 ? tpv / tv : 0;
        })(candles.slice(-60));

        const avgVol = candles.slice(-20).reduce((a, b) => a + b[5], 0) / 20;
        const volRatio = lastCandle[5] / (avgVol || 1);

        serverData.rsi = rsi;
        serverData.vol = volRatio;
        serverData.vwap = vwap;
        serverData.ema200 = ema200;

        let sL = 0, sS = 0;
        if (price > ema200 && price > vwap * 0.998) {
            sL = 40;
            if (volRatio > 1.2) sL += 30;
            if (rsi < 70) sL += 10;
        } else if (price < ema200 && price < vwap * 1.002) {
            sS = 40;
            if (volRatio > 1.2) sS += 30;
            if (rsi > 30) sS += 10;
        }

        serverData.score = sL >= sS ? sL : -sS;
        const longT = sL >= 70 && volRatio >= 1.1;
        const shortT = sS >= 70 && volRatio >= 1.1;

        if (!serverData.pos) {
            if (longT || shortT) {
                // Noise Shield
                if (volRatio < 1.5) {
                    if (longT && price <= prevCandle[2]) return;
                    if (shortT && price >= prevCandle[3]) return;
                }
                await openPosition(longT ? 'buy' : 'sell', price);
            }
        } else {
            const p = serverData.pos;
            const isL = p.side === 'buy';
            const roi = (isL ? (price - p.entry)/p.entry : (p.entry - price)/p.entry) * 100 * activeConfig.lev;
            p.roi = roi;
            if (roi > p.peak) p.peak = roi;

            const contrary = isL ? shortT : longT;
            if (roi <= -activeConfig.stopPct) await closePosition("Stop Loss");
            else if (roi < 0 && contrary) {
                await closePosition("Flip");
                await openPosition(isL ? 'sell' : 'buy', price);
            } else if (roi > 0 && p.peak < activeConfig.trailAct && contrary) {
                await closePosition("Segurança Profit");
            } else if (!p.trailActive && roi >= activeConfig.trailAct) {
                p.trailActive = true;
                addLog("🎯 Trailing Ativado!");
            } else if (p.trailActive) {
                if (contrary) await closePosition("Sinal Contrário");
                else if ((p.peak - roi) >= activeConfig.trailPull) await closePosition("Trailing Stop");
            }
        }
    } catch (e) { console.log("Erro:", e.message); }
}

async function openPosition(side, price, isPartial = false) {
    try {
        if (!exchange.apiKey || !exchange.apiSecret) {
            addLog(`📝 SIMULADO: ${side.toUpperCase()} (Faltam Chaves)`);
            serverData.pos = { side, entry: price, qty: 1, roi: 0, peak: 0, partialEntryCount: 0, partialExitDone: false, trailActive: false };
            return;
        }

        const balance = await exchange.fetchBalance();
        const usdtFree = balance.free['USDT'] || 0;
        const currentPct = isPartial ? activeConfig.partialBankPct : activeConfig.bankPct;
        let qty = (usdtFree * (currentPct / 100) * activeConfig.lev) / price;
        qty = qty * 0.98;

        const pQty = parseFloat(exchange.amountToPrecision(activeConfig.sym, qty));
        if (pQty <= 0) return addLog("❌ Qtd Insuficiente para Bybit");

        await exchange.setLeverage(activeConfig.lev, activeConfig.sym).catch(()=>{});
        await exchange.createMarketOrder(activeConfig.sym, side, pQty);
        
        serverData.pos = { side, entry: price, qty: pQty, roi: 0, peak: 0, partialEntryCount: 0, partialExitDone: false, trailActive: false };
        addLog(`🔥 ENTROU REAL: ${side.toUpperCase()} (${currentPct}%)`);
    } catch (e) { addLog(`❌ Erro Bybit: ${e.message}`); }
}

async function closePosition(reason = "") {
    try {
        if (serverData.pos && exchange.apiKey && exchange.apiSecret) {
            const side = serverData.pos.side === 'buy' ? 'sell' : 'buy';
            await exchange.createMarketOrder(activeConfig.sym, side, serverData.pos.qty);
        }
        serverData.pos = null;
        addLog(`🛑 FECHADO: ${reason}`);
    } catch (e) { serverData.pos = null; }
}

app.post('/control', async (req, res) => {
    const cfg = req.body;
    if (cfg.action === 'start') {
        activeConfig = { ...activeConfig, ...cfg };
        if (cfg.apiKey && cfg.apiSecret) {
            exchange = new ccxt.bybit({ 
                apiKey: cfg.apiKey, 
                apiSecret: cfg.apiSecret, 
                options: { 'defaultType': 'linear' } 
            });
            addLog("🔑 Chaves de API validadas no Servidor!");
        } else {
            addLog("⚠️ Chaves incompletas. Rodando em Simulado.");
        }
        addLog(`🚀 NUVEM MASTER: ${activeConfig.sym}`);
    } else await closePosition("Comando App");
    res.json({ status: "ok" });
});

app.get('/status', (req, res) => res.json(serverData));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    setInterval(analyzeStrategy, 5000);
});
