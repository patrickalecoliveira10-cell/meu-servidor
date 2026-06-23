const express = require('express');
const ccxt = require('ccxt');
const TI = require('technicalindicators');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

let exchange = new ccxt.bybit({ options: { 'defaultType': 'linear' } });
let activeConfig = { sym: "", bankPct: 10, lev: 10, stopPct: 2.5, trailAct: 2, trailPull: 1 };
let serverData = { pos: null, logs: [], lastPrice: 0, score: 0, rsi: 50, vol: 1.0 };

function addLog(msg) {
    const log = `[${new Date().toLocaleTimeString()}] ${msg}`;
    serverData.logs.unshift(log);
    if (serverData.logs.length > 50) serverData.logs.pop();
    console.log(log);
}

// --- LÓGICA DE ESTRATÉGIA (O Cérebro na Nuvem) ---
async function analyzeStrategy() {
    if (!activeConfig.sym) return;
    try {
        const candles = await exchange.fetchOHLCV(activeConfig.sym, '1m', undefined, 210);
        const closes = candles.map(c => c[4]);
        const volumes = candles.map(c => c[5]);
        const prices = candles.map(c => ({ high: c[2], low: c[3], close: c[4], volume: c[5] }));

        serverData.lastPrice = closes[closes.length - 1];

        // 1. RSI
        const rsi = TI.RSI.calculate({ values: closes, period: 14 }).pop();
        serverData.rsi = rsi;

        // 2. EMA 200
        const ema200 = TI.EMA.calculate({ values: closes, period: 200 }).pop();

        // 3. Volume Ratio (Média de 20 períodos)
        const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const currentVol = volumes[volumes.length - 1];
        serverData.vol = currentVol / avgVol;

        // 4. CÁLCULO DO MASTER SCORE
        let score = 0;
        if (serverData.lastPrice > ema200) score += 30; else score -= 30; // Tendência
        if (rsi < 30) score += 20; if (rsi > 70) score -= 20; // Exaustão
        if (serverData.vol > 1.1) score += 20; // Volume

        serverData.score = score;

        // --- GESTÃO DE POSIÇÃO ---
        if (!serverData.pos) {
            if (score >= 70) await openPosition('buy', serverData.lastPrice);
            if (score <= -70) await openPosition('sell', serverData.lastPrice);
        } else {
            await managePosition(serverData.lastPrice);
            
            // LÓGICA DE FLIP (Virada)
            if (serverData.pos.side === 'buy' && score <= -70 && serverData.pos.roi < 0) {
                addLog("🔄 FLIP DETECTADO: Virando para SHORT");
                await closePosition();
                await openPosition('sell', serverData.lastPrice);
            } else if (serverData.pos.side === 'sell' && score >= 70 && serverData.pos.roi < 0) {
                addLog("🔄 FLIP DETECTADO: Virando para LONG");
                await closePosition();
                await openPosition('buy', serverData.lastPrice);
            }
        }
    } catch (e) { console.error("Erro Estratégia:", e.message); }
}

async function managePosition(price) {
    const p = serverData.pos;
    const isL = p.side === 'buy';
    const roi = (isL ? (price - p.entry) / p.entry : (p.entry - price) / p.entry) * 100 * activeConfig.lev;
    p.roi = roi;

    if (roi > p.peak) p.peak = roi;

    // 1. Stop Loss
    if (roi <= -activeConfig.stopPct) {
        addLog(`📉 Stop Loss atingido: ${roi.toFixed(2)}%`);
        await closePosition();
    }

    // 2. Trailing Stop + Saída Parcial 50%
    if (p.peak >= activeConfig.trailAct) {
        if (!p.partialExitDone) {
            addLog("💰 ROI de Trailing atingido! Realizando 50% de lucro...");
            await executePartialExit(0.5);
            p.partialExitDone = true;
        }
        
        p.trail = "ATIVO 🔥";
        if (roi <= (p.peak - activeConfig.trailPull)) {
            addLog(`🎯 Trailing Stop acionado no lucro: ${roi.toFixed(2)}%`);
            await closePosition();
        }
    }
}

async function executePartialExit(percent) {
    try {
        if (exchange.apiKey && serverData.pos) {
            const closeQty = serverData.pos.qty * percent;
            const side = serverData.pos.side === 'buy' ? 'sell' : 'buy';
            await exchange.createMarketOrder(activeConfig.sym, side, closeQty);
            serverData.pos.qty -= closeQty;
            addLog(`✅ Saída Parcial de ${percent*100}% concluída.`);
        }
    } catch (e) { addLog("❌ Erro Parcial: " + e.message); }
}

async function openPosition(side, price) {
    try {
        if (!exchange.apiKey) {
            addLog(`⚠️ SIMULAÇÃO: Entrada em ${side}`);
            serverData.pos = { side, entry: price, qty: 100, roi: 0, peak: 0, trail: "Simulado", partialExitDone: false };
            return;
        }
        const balance = await exchange.fetchBalance();
        const usdt = balance.free['USDT'] || 0;
        const qty = (usdt * (activeConfig.bankPct/100) * activeConfig.lev) / price;
        const precisionQty = parseFloat(exchange.amountToPrecision(activeConfig.sym, qty));

        await exchange.setLeverage(activeConfig.lev, activeConfig.sym).catch(()=>{});
        await exchange.createMarketOrder(activeConfig.sym, side, precisionQty);
        
        addLog(`🔥 POSIÇÃO REAL ABERTA: ${side.toUpperCase()} ${precisionQty}`);
        serverData.pos = { side, entry: price, qty: precisionQty, roi: 0, peak: 0, trail: "Inativo", partialExitDone: false };
    } catch (e) { addLog("❌ Erro Entrada: " + e.message); }
}

async function closePosition() {
    try {
        if (serverData.pos && exchange.apiKey) {
            const side = serverData.pos.side === 'buy' ? 'sell' : 'buy';
            await exchange.createMarketOrder(activeConfig.sym, side, serverData.pos.qty);
        }
        addLog("🛑 Posição Encerrada.");
        serverData.pos = null;
    } catch (e) { addLog("❌ Erro ao fechar: " + e.message); }
}

// --- ENDPOINTS ---
app.post('/control', async (req, res) => {
    const cfg = req.body;
    if (cfg.action === 'start') {
        activeConfig = { ...activeConfig, ...cfg };
        if (cfg.apiKey) {
            exchange = new ccxt.bybit({ apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, options: { 'defaultType': 'linear' } });
            addLog("🔑 API Keys configuradas.");
        }
        addLog(`🚀 ROBÔ AUTÔNOMO INICIADO: ${activeConfig.sym}`);
    } else if (cfg.action === 'stop') {
        activeConfig.sym = "";
        await closePosition();
        addLog("🛑 Robô desligado via App.");
    }
    res.json({ status: "ok" });
});

app.get('/status', (req, res) => res.json(serverData));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor Autônomo na porta ${PORT}`);
    setInterval(analyzeStrategy, 5000); // Analisa a cada 5 segundos
});
