const express = require('express');
const ccxt = require('ccxt');
const TI = require('technicalindicators');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- ESTADO GLOBAL ---
let exchange = new ccxt.bybit({ options: { 'defaultType': 'linear' } });
let activeConfig = { sym: "", bankPct: 10, lev: 10, stopPct: 2.5, trailAct: 2, trailPull: 1, apiKey: "", apiSecret: "" };
let serverData = { pos: null, logs: [], lastPrice: 0, score: 0, rsi: 50, vol: 1.0, oiStatus: "---", vwap: 0, ema200: 0 };

function addLog(msg) {
    const log = `[${new Date().toLocaleTimeString()}] ☁️ ${msg}`;
    serverData.logs.unshift(log);
    if (serverData.logs.length > 50) serverData.logs.pop();
    console.log(log);
}

// --- CÁLCULOS TÉCNICOS DO APK ---
function calculateVWAP(candles) {
    let totalPV = 0, totalV = 0;
    candles.forEach(c => {
        let p = (c[2] + c[3] + c[4]) / 3; // (High + Low + Close) / 3
        totalPV += p * c[5]; // p * volume
        totalV += c[5];
    });
    return totalV > 0 ? totalPV / totalV : 0;
}

async function getOITrend(sym) {
    try {
        const oi = await exchange.fetchOpenInterestHistory(sym, '1h', undefined, 5);
        if (oi.length < 2) return "estável";
        const last = oi[oi.length - 1].openInterestValue;
        const prev = oi[oi.length - 2].openInterestValue;
        return last > prev ? "crescente" : "caindo";
    } catch (e) { return "estável"; }
}

// --- ESTRATÉGIA MASTER ---
async function analyzeStrategy() {
    if (!activeConfig.sym) return;
    try {
        const candles = await exchange.fetchOHLCV(activeConfig.sym, '1m', undefined, 210);
        const closes = candles.map(c => c[4]);
        const volumes = candles.map(c => c[5]);
        const price = closes[closes.length - 1];
        serverData.lastPrice = price;

        // 1. Indicadores Master
        const rsi = TI.RSI.calculate({ values: closes, period: 14 }).pop() || 50;
        const ema200 = TI.EMA.calculate({ values: closes, period: 200 }).pop();
        const vwap = calculateVWAP(candles.slice(-60)); // VWAP de 1 hora
        const oiTrend = await getOITrend(activeConfig.sym);
        
        const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const volRatio = volumes[volumes.length - 1] / (avgVol || 1);

        serverData.rsi = rsi;
        serverData.vol = volRatio;
        serverData.oiStatus = oiTrend;
        serverData.vwap = vwap;
        serverData.ema200 = ema200;

        // 2. Lógica de Score do APK
        let sL = 0, sS = 0;
        const oiGrowing = oiTrend === "crescente";

        // Filtro EMA + VWAP
        if (price > ema200 && price > vwap * 0.998) {
            sL = 40;
            if (oiGrowing) sL += 30;
            if (volRatio > 1.2) sL += 20;
            if (rsi < 70) sL += 10;
        } else if (price < ema200 && price < vwap * 1.002) {
            sS = 40;
            if (oiGrowing) sS += 30;
            if (volRatio > 1.2) sS += 20;
            if (rsi > 30) sS += 10;
        }

        serverData.score = sL >= sS ? sL : -sS;

        const isLongTrigger = sL >= 70;
        const isShortTrigger = sS >= 70;

        // --- EXECUÇÃO MASTER ---
        if (isLongTrigger && isShortTrigger && !serverData.pos) return; // Proteção Conflito

        if (!serverData.pos) {
            if (isLongTrigger) await openPosition('buy', price);
            else if (isShortTrigger) await openPosition('sell', price);
        } else {
            const p = serverData.pos;
            const isL = p.side === 'buy';
            const roi = (isL ? (price - p.entry)/p.entry : (p.entry - price)/p.entry) * 100 * activeConfig.lev;
            p.roi = roi;
            if (roi > p.peak) p.peak = roi;

            const oppositeTrigger = isL ? isShortTrigger : isLongTrigger;
            const currentTrigger = isL ? isLongTrigger : isShortTrigger;

            // A. Virada (FLIP)
            if (oppositeTrigger && roi < 0) {
                addLog("🔄 FLIP MASTER: Virando posição...");
                await closePosition();
                await openPosition(isL ? 'sell' : 'buy', price);
            }
            // B. Parciais a Favor (Máximo 2)
            else if (currentTrigger && roi > 0 && p.partialEntryCount < 2) {
                addLog(`➕ ADICIONANDO PARCIAL (${p.partialEntryCount + 1}/2)`);
                await openPosition(p.side, price, true);
            }
            // C. Saída Parcial 50% no Trailing
            else if (oppositeTrigger && p.peak >= activeConfig.trailAct && !p.partialExitDone) {
                addLog("💰 SAÍDA PARCIAL 50%: Sinal contrário no Trailing.");
                await executePartial(0.5);
                p.partialExitDone = true;
            }
            // D. Fechamento Final (Sinal contrário ou Trailing)
            else if (oppositeTrigger && (roi > 0 || p.partialExitDone)) {
                addLog("🛑 FECHAMENTO: Sinal contrário detectado.");
                await closePosition();
            }
            // E. Recuo do Trailing Stop
            else if (p.peak >= activeConfig.trailAct && roi <= (p.peak - activeConfig.trailPull)) {
                addLog(`🎯 TRAILING: Recuo atingido. Lucro: ${roi.toFixed(2)}%`);
                await closePosition();
            }
            // F. Stop Loss Fixo
            else if (roi <= -activeConfig.stopPct) {
                addLog("📉 STOP LOSS atingido.");
                await closePosition();
            }
        }
    } catch (e) { console.log("Erro:", e.message); }
}

// --- FUNÇÕES BYBIT ---
async function openPosition(side, price, isPartial = false) {
    try {
        if (!exchange.apiKey) {
            if (isPartial) { serverData.pos.partialEntryCount++; return; }
            serverData.pos = { side, entry: price, qty: 1, roi: 0, peak: 0, partialEntryCount: 0, partialExitDone: false };
            addLog(`📝 SIMULADO: ${side.toUpperCase()}`); return;
        }
        const balance = await exchange.fetchBalance();
        const qty = (balance.free['USDT'] * (activeConfig.bankPct/100) * activeConfig.lev) / price;
        const pQty = parseFloat(exchange.amountToPrecision(activeConfig.sym, qty));

        await exchange.setLeverage(activeConfig.lev, activeConfig.sym).catch(()=>{});
        await exchange.createMarketOrder(activeConfig.sym, side, pQty);
        
        if (isPartial) { serverData.pos.qty += pQty; serverData.pos.partialEntryCount++; }
        else { serverData.pos = { side, entry: price, qty: pQty, roi: 0, peak: 0, partialEntryCount: 0, partialExitDone: false }; }
        addLog(`✅ ${isPartial ? 'PARCIAL' : 'ORDEM'} ${side.toUpperCase()} OK`);
    } catch (e) { addLog("❌ Erro Ordem: " + e.message); }
}

async function executePartial(percent) {
    try {
        if (serverData.pos && exchange.apiKey) {
            const q = parseFloat(exchange.amountToPrecision(activeConfig.sym, serverData.pos.qty * percent));
            await exchange.createMarketOrder(activeConfig.sym, serverData.pos.side === 'buy' ? 'sell' : 'buy', q);
            serverData.pos.qty -= q;
        }
    } catch (e) { addLog("❌ Erro Parcial: " + e.message); }
}

async function closePosition() {
    try {
        if (serverData.pos && exchange.apiKey) {
            await exchange.createMarketOrder(activeConfig.sym, serverData.pos.side === 'buy' ? 'sell' : 'buy', serverData.pos.qty);
        }
        serverData.pos = null; addLog("🛑 Posição encerrada.");
    } catch (e) { addLog("❌ Erro Fechar: " + e.message); serverData.pos = null; }
}

app.post('/control', async (req, res) => {
    const cfg = req.body;
    if (cfg.action === 'start') {
        activeConfig = { ...activeConfig, ...cfg };
        if (cfg.apiKey) exchange = new ccxt.bybit({ apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, options: { 'defaultType': 'linear' } });
        addLog(`🚀 NUVEM MASTER INICIADA: ${activeConfig.sym}`);
    } else if (cfg.action === 'stop' || cfg.action === 'close_now') {
        activeConfig.sym = ""; await closePosition();
    }
    res.json({ status: "ok" });
});

app.get('/status', (req, res) => res.json(serverData));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor na porta ${PORT}`);
    setInterval(analyzeStrategy, 5000); 
});
