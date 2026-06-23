const express = require('express');const ccxt = require('ccxt');
const TI = require('technicalindicators');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- ESTADO GLOBAL ---
let exchange = new ccxt.bybit({ options: { 'defaultType': 'linear' } });
let activeConfig = { 
    sym: "", bankPct: 10, lev: 10, stopPct: 2.5, 
    trailAct: 2, trailPull: 1, apiKey: "", apiSecret: "" 
};

let serverData = {
    pos: null, // { side, entry, qty, roi, peak, partialEntryCount, partialExitDone }
    logs: [],
    lastPrice: 0,
    scoreLong: 0,
    scoreShort: 0,
    rsi: 50,
    vol: 1.0
};

function addLog(msg) {
    const log = `[${new Date().toLocaleTimeString()}] ☁️ ${msg}`;
    serverData.logs.unshift(log);
    if (serverData.logs.length > 50) serverData.logs.pop();
    console.log(log);
}

// --- CÉREBRO AUTÔNOMO (ESTRATÉGIA) ---
async function analyzeStrategy() {
    if (!activeConfig.sym) return;
    try {
        const candles = await exchange.fetchOHLCV(activeConfig.sym, '1m', undefined, 210);
        const closes = candles.map(c => c[4]);
        const volumes = candles.map(c => c[5]);
        const price = closes[closes.length - 1];
        serverData.lastPrice = price;

        // 1. Cálculos Técnicos
        const rsi = TI.RSI.calculate({ values: closes, period: 14 }).pop() || 50;
        const ema200 = TI.EMA.calculate({ values: closes, period: 200 }).pop();
        const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const volRatio = volumes[volumes.length - 1] / (avgVol || 1);

        serverData.rsi = rsi;
        serverData.vol = volRatio;

        // 2. Score Master (Long vs Short)
        let sL = 0, sS = 0;
        if (price > ema200) sL += 40; else sS += 40; // Tendência EMA 200
        if (rsi < 35) sL += 35; if (rsi > 65) sS += 35; // RSI OB/OS
        if (volRatio > 1.1) { sL += 10; sS += 10; } // Bônus Volume

        serverData.scoreLong = sL;
        serverData.scoreShort = sS;

        const isLongTrigger = (sL >= 70 && volRatio >= 1.1);
        const isShortTrigger = (sS >= 70 && volRatio >= 1.1);

        // --- LÓGICA DE EXECUÇÃO ---
        
        // 1. Verificação de Conflito (Se houver os dois, não faz nada)
        if (isLongTrigger && isShortTrigger) return;

        if (!serverData.pos) {
            // ENTRADA INICIAL
            if (isLongTrigger) await openPosition('buy', price);
            else if (isShortTrigger) await openPosition('sell', price);
        } else {
            const p = serverData.pos;
            const isL = p.side === 'buy';
            const roi = (isL ? (price - p.entry)/p.entry : (p.entry - price)/p.entry) * 100 * activeConfig.lev;
            p.roi = roi;
            if (roi > p.peak) p.peak = roi;

            const currentTrigger = isL ? isLongTrigger : isShortTrigger;
            const oppositeTrigger = isL ? isShortTrigger : isLongTrigger;

            // A. Stop Loss Fixo
            if (roi <= -activeConfig.stopPct) {
                addLog(`📉 Stop Loss atingido: ${roi.toFixed(2)}%`);
                await closePosition();
                return;
            }

            // B. Lógica de Sinal Contrário (Viradas e Saídas)
            if (oppositeTrigger) {
                if (roi < 0) {
                    addLog("🔄 FLIP: Sinal contrário em prejuízo. Virando mão...");
                    await closePosition();
                    await openPosition(isL ? 'sell' : 'buy', price);
                } else if (roi > 0 && p.peak < activeConfig.trailAct) {
                    addLog("⚠️ CLOSE: Sinal contrário antes do Trailing.");
                    await closePosition();
                } else if (p.peak >= activeConfig.trailAct) {
                    if (!p.partialExitDone) {
                        addLog("💰 PARCIAL 50%: Sinal contrário no Trailing.");
                        await executePartial(0.5); // Sai com metade
                        p.partialExitDone = true;
                    } else {
                        addLog("🛑 FECHAMENTO FINAL: Segundo sinal contrário no Trailing.");
                        await closePosition();
                    }
                }
            } 
            // C. Lógica de Reforço (Parciais a favor)
            else if (currentTrigger && roi > 0 && p.partialEntryCount < 2) {
                addLog(`➕ ADICIONANDO PARCIAL (${p.partialEntryCount + 1}/2)`);
                await openPosition(p.side, price, true); // True indica que é parcial
            }

            // D. Trailing Stop (Recuo)
            if (p.peak >= activeConfig.trailAct && roi <= (p.peak - activeConfig.trailPull)) {
                addLog(`🎯 Trailing Stop (Recuo): Fechando com ${roi.toFixed(2)}% de lucro.`);
                await closePosition();
            }
        }
    } catch (e) { console.log("Erro Ciclo:", e.message); }
}

// --- FUNÇÕES DE TROCA (BYBIT) ---
async function openPosition(side, price, isPartial = false) {
    try {
        if (!exchange.apiKey) {
            addLog(`📝 SIMULADO: ${isPartial ? 'Parcial' : 'Entrada'} ${side}`);
            if (isPartial) { serverData.pos.partialEntryCount++; return; }
            serverData.pos = { side, entry: price, qty: 1, roi: 0, peak: 0, partialEntryCount: 0, partialExitDone: false };
            return;
        }
        
        const balance = await exchange.fetchBalance();
        const usdt = balance.free['USDT'] || 0;
        let qty = (usdt * (activeConfig.bankPct/100) * activeConfig.lev) / price;
        const precisionQty = parseFloat(exchange.amountToPrecision(activeConfig.sym, qty));

        await exchange.setLeverage(activeConfig.lev, activeConfig.sym).catch(()=>{});
        await exchange.createMarketOrder(activeConfig.sym, side, precisionQty);
        
        if (isPartial) {
            serverData.pos.qty += precisionQty;
            serverData.pos.partialEntryCount++;
            addLog(`✅ Parcial Adicionada. Nova Qtd: ${serverData.pos.qty}`);
        } else {
            serverData.pos = { side, entry: price, qty: precisionQty, roi: 0, peak: 0, partialEntryCount: 0, partialExitDone: false };
            addLog(`🚀 Entrada REAL executada: ${side.toUpperCase()}`);
        }
    } catch (e) { addLog("❌ Erro Ordem: " + e.message); }
}

async function executePartial(percent) {
    try {
        if (serverData.pos && exchange.apiKey) {
            const closeQty = parseFloat(exchange.amountToPrecision(activeConfig.sym, serverData.pos.qty * percent));
            const side = serverData.pos.side === 'buy' ? 'sell' : 'buy';
            await exchange.createMarketOrder(activeConfig.sym, side, closeQty);
            serverData.pos.qty -= closeQty;
        }
    } catch (e) { addLog("❌ Erro Parcial: " + e.message); }
}

async function closePosition() {
    try {
        if (serverData.pos && exchange.apiKey) {
            const side = serverData.pos.side === 'buy' ? 'sell' : 'buy';
            await exchange.createMarketOrder(activeConfig.sym, side, serverData.pos.qty);
        }
        serverData.pos = null;
        addLog("🛑 Posição encerrada.");
    } catch (e) { addLog("❌ Erro ao fechar: " + e.message); serverData.pos = null; }
}

// --- ENDPOINTS ---
app.post('/control', async (req, res) => {
    const cfg = req.body;
    if (cfg.action === 'start') {
        activeConfig = { ...activeConfig, ...cfg };
        if (cfg.apiKey) exchange = new ccxt.bybit({ apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, options: { 'defaultType': 'linear' } });
        addLog(`🟢 Robô Autônomo Online: ${activeConfig.sym}`);
    } else if (cfg.action === 'stop') {
        activeConfig.sym = "";
        await closePosition();
    } else if (cfg.action === 'close_now') {
        await closePosition();
    }
    res.json({ status: "ok" });
});

app.get('/status', (req, res) => res.json(serverData));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor Live na porta ${PORT}`);
    setInterval(analyzeStrategy, 5000); 
});
