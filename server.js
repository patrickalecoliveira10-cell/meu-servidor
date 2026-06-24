const express = require('express');
const ccxt = require('ccxt');
const TI = require('technicalindicators');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Inicialização Segura (Lê chaves do Render)
let exchange = new ccxt.bybit({
    apiKey: process.env.BYBIT_API_KEY || "",
    secret: process.env.BYBIT_API_SECRET || "",
    options: { 'defaultType': 'linear' }
});

let activeConfig = { 
    sym: "", bankPct: 30, partialBankPct: 5, lev: 1, 
    stopPct: 1.5, trailAct: 1.5, trailPull: 0.8 
};

let serverData = { 
    pos: null, eventLog: [], lastPrice: 0, 
    score: 0, rsi: 50, vol: 1.0, vwap: 0, ema200: 0
};

function addLog(msg) {
    const logEntry = { time: Date.now(), msg: msg };
    serverData.eventLog.unshift(logEntry);
    if (serverData.eventLog.length > 50) serverData.eventLog.pop();
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// 2. Sincronização Ativa com a Bybit (Recuperação de Desastres)
async function syncWithBybit() {
    if (!exchange.apiKey || !activeConfig.sym) return;
    try {
        const positions = await exchange.fetchPositions([activeConfig.sym]);
        const bPos = positions.find(p => 
            p.symbol.split(':')[0] === activeConfig.sym.split(':')[0] && 
            parseFloat(p.contracts) > 0
        );

        if (bPos) {
            if (!serverData.pos) {
                serverData.pos = {
                    side: bPos.side === 'long' ? 'buy' : 'sell',
                    entry: parseFloat(bPos.entryPrice),
                    qty: parseFloat(bPos.contracts),
                    roi: 0, peak: 0, peakPrice: parseFloat(bPos.entryPrice),
                    partialEntryCount: 0, trailActive: false, partialExitDone: false
                };
                addLog(`🔄 RECUPERADO: Posição ${bPos.side.toUpperCase()} ativa.`);
            } else {
                serverData.pos.qty = parseFloat(bPos.contracts);
            }
        } else if (serverData.pos) {
            serverData.pos = null;
            addLog("⚠️ SYNC: Posição fechada externamente.");
        }
    } catch (e) { console.error("Erro Sync:", e.message); }
}

// 3. Loop de Análise Granular (O "Cérebro" do Robô)
async function analyzeStrategy() {
    if (!activeConfig.sym) return;
    await syncWithBybit();

    try {
        const candles = await exchange.fetchOHLCV(activeConfig.sym, '1m', undefined, 210);
        if (!candles || candles.length < 205) return;

        const closes = candles.map(c => c[4]);
        const price = closes[closes.length - 1];
        serverData.lastPrice = price;

        // Indicadores
        const rsi = TI.RSI.calculate({ values: closes, period: 14 }).pop() || 50;
        const ema200 = TI.EMA.calculate({ values: closes, period: 200 }).pop();
        const vwap = (function(cands) {
            let tpv = 0, tv = 0;
            cands.forEach(c => { tpv += ((c[2]+c[3]+c[4])/3) * c[5]; tv += c[5]; });
            return tv > 0 ? tpv / tv : 0;
        })(candles.slice(-60));

        const avgVol = candles.slice(-20).reduce((a, b) => a + b[5], 0) / 20;
        const volRatio = candles[candles.length - 1][5] / (avgVol || 1);
        
        serverData.rsi = rsi; serverData.vol = volRatio;
        serverData.vwap = vwap; serverData.ema200 = ema200;

        // --- CÁLCULO DE SCORE GRANULAR (Entrada Exata) ---
        let currentScore = 0;
        const contraryForce = (candles[candles.length-1][4] > candles[candles.length-1][1]) 
            ? (candles[candles.length-2][4] < candles[candles.length-2][1] && candles[candles.length-2][5] > candles[candles.length-1][5] * 1.5)
            : (candles[candles.length-2][4] > candles[candles.length-2][1] && candles[candles.length-2][5] > candles[candles.length-1][5] * 1.5);

        if (price > ema200 && price > vwap * 0.998 && !contraryForce) {
            let sL = 10; // Base: Tendência Alta
            if (Math.abs(price - vwap)/vwap < 0.001) sL += 20; // Perto da VWAP
            else if (Math.abs(price - vwap)/vwap < 0.003) sL += 10;
            
            sL += Math.min(25, (volRatio - 0.8) * 15); // Volume
            if (rsi > 45 && rsi < 65) sL += 20; // RSI Ideal
            
            currentScore = Math.round(Math.min(100, sL));
        } else if (price < ema200 && price < vwap * 1.002 && !contraryForce) {
            let sS = 10; // Base: Tendência Queda
            if (Math.abs(price - vwap)/vwap < 0.001) sS += 20;
            else if (Math.abs(price - vwap)/vwap < 0.003) sS += 10;
            
            sS += Math.min(25, (volRatio - 0.8) * 15);
            if (rsi > 35 && rsi < 55) sS += 20;
            
            currentScore = -Math.round(Math.min(100, sS));
        }
        serverData.score = currentScore;

        // Execução
        if (!serverData.pos) {
            if (currentScore >= 70) await openPosition('buy', price);
            else if (currentScore <= -70) await openPosition('sell', price);
        } else {
            // Gerenciamento (Stop, Trailing e Parciais)
            const p = serverData.pos;
            const isL = p.side === 'buy';
            const roi = (isL ? (price - p.entry)/p.entry : (p.entry - price)/p.entry) * 100 * activeConfig.lev;
            p.roi = roi;
            if (roi > p.peak) { p.peak = roi; p.peakPrice = price; }

            if (roi <= -activeConfig.stopPct) await closePosition("Stop Loss");
            
            if (!p.trailActive && roi >= activeConfig.trailAct) {
                p.trailActive = true; addLog("🎯 Trailing Ativado!");
            }

            if (p.trailActive) {
                const recuo = Math.abs(p.peakPrice - price) / p.peakPrice * 100 * activeConfig.lev;
                if (recuo >= activeConfig.trailPull) await closePosition("Trailing Stop");
            }
        }
    } catch (e) { console.error("Erro Loop:", e.message); }
}

async function openPosition(side, price, isPartial = false) {
    try {
        if (!exchange.apiKey) {
            addLog(`📝 SIMULADO: ${side.toUpperCase()}`);
            serverData.pos = { side, entry: price, qty: 1, roi: 0, peak: 0, peakPrice: price, trailActive: false };
            return;
        }
        const balance = await exchange.fetchBalance();
        const usdt = balance.free['USDT'] || 0;
        let qty = (usdt * (activeConfig.bankPct / 100) * activeConfig.lev) / price;
        qty = parseFloat(exchange.amountToPrecision(activeConfig.sym, qty * 0.95));

        await exchange.setLeverage(activeConfig.lev, activeConfig.sym).catch(()=>{});
        await exchange.createMarketOrder(activeConfig.sym, side, qty);
        
        serverData.pos = { side, entry: price, qty, roi: 0, peak: 0, peakPrice: price, trailActive: false };
        addLog(`🔥 ORDEM REAL: ${side.toUpperCase()} em ${price}`);
    } catch (e) { addLog(`❌ Erro abrir: ${e.message}`); }
}

async function closePosition(reason) {
    try {
        if (serverData.pos && exchange.apiKey) {
            const side = serverData.pos.side === 'buy' ? 'sell' : 'buy';
            const positions = await exchange.fetchPositions([activeConfig.sym]);
            const bPos = positions.find(p => p.symbol.split(':')[0] === activeConfig.sym.split(':')[0]);
            const qty = bPos ? parseFloat(bPos.contracts) : serverData.pos.qty;
            if (qty > 0) await exchange.createMarketOrder(activeConfig.sym, side, qty);
        }
        serverData.pos = null;
        addLog(`🛑 FECHADO: ${reason}`);
    } catch (e) { addLog(`❌ Erro fechar: ${e.message}`); serverData.pos = null; }
}

// Endpoints
app.get('/', (req, res) => res.send("Ultra Master Online 🚀"));
app.get('/status', (req, res) => res.json({ ...serverData, config: activeConfig }));
app.post('/control', async (req, res) => {
    const cfg = req.body;
    if (cfg.action === 'start') {
        activeConfig = { ...activeConfig, ...cfg };
        addLog(`🚀 Iniciado: ${activeConfig.sym}`);
        await syncWithBybit();
    } else {
        await closePosition("Comando App");
        activeConfig.sym = "";
    }
    res.json({ status: "ok" });
});
app.post('/update_score', (req, res) => {
    if (req.body.score !== undefined) serverData.score = req.body.score;
    res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Porta ${PORT}`);
    setInterval(analyzeStrategy, 5000);
});
