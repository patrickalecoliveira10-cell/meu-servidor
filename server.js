const express = require('express');
const ccxt = require('ccxt');
const TI = require('technicalindicators');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

let exchange = new ccxt.bybit({ options: { 'defaultType': 'linear' } });
let activeConfig = { sym: "", bankPct: 30, partialBankPct: 5, lev: 1, stopPct: 1.5, trailAct: 1.5, trailPull: 0.8, apiKey: "", apiSecret: "" };
let serverData = { pos: null, eventLog: [], lastPrice: 0, score: 0, rsi: 50, vol: 1.0 };

function addLog(msg) {
    const logEntry = { time: Date.now(), msg: msg };
    serverData.eventLog.unshift(logEntry);
    if (serverData.eventLog.length > 30) serverData.eventLog.pop();
    console.log(`[LOG] ${msg}`);
}

// --- NOVIDADE: SINCRONIZAÇÃO REAL COM A BYBIT ---
async function syncWithBybit() {
    if (!exchange.apiKey || !activeConfig.sym) return;
    try {
        const positions = await exchange.fetchPositions([activeConfig.sym]);
        const bPos = positions.find(p => p.symbol.replace(':USDT','') === activeConfig.sym.replace(':USDT','') && parseFloat(p.contracts) > 0);
        
        if (bPos) {
            // Se existe posição na Bybit mas o servidor "esqueceu" (reiniciou)
            if (!serverData.pos) {
                serverData.pos = {
                    side: bPos.side === 'long' ? 'buy' : 'sell',
                    entry: parseFloat(bPos.entryPrice),
                    qty: parseFloat(bPos.contracts),
                    roi: 0, peak: 0, peakPrice: parseFloat(bPos.entryPrice),
                    partialEntryCount: 0, trailActive: false, partialExitDone: false
                };
                addLog(`🔄 SINCRONIZADO: Posição ${bPos.side.toUpperCase()} recuperada da Bybit.`);
            }
        } else if (serverData.pos) {
            // Se o servidor acha que tem posição mas na Bybit já fechou
            serverData.pos = null;
            addLog(`⚠️ SINCRONIZADO: Posição não encontrada na Bybit. Estado limpo.`);
        }
    } catch (e) { console.log("Erro Sync Bybit:", e.message); }
}

async function analyzeStrategy() {
    if (!activeConfig.sym) return;
    await syncWithBybit(); // Sempre sincroniza antes de analisar
    
    try {
        const candles = await exchange.fetchOHLCV(activeConfig.sym, '1m', undefined, 210);
        if (!candles || candles.length < 200) return;

        const closes = candles.map(c => c[4]);
        const price = closes[closes.length - 1];
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
        const volRatio = candles[candles.length-1][5] / (avgVol || 1);
        
        serverData.rsi = rsi;
        serverData.vol = volRatio;

        // Lógica de Score simplificada para o exemplo
        let sL = 0, sS = 0;
        if (price > ema200 && price > vwap) sL = 70;
        else if (price < ema200 && price < vwap) sS = 70;
        serverData.score = sL >= sS ? sL : -sS;

        if (!serverData.pos) {
            if (sL >= 70 && volRatio > 1.1) await openPosition('buy', price);
            else if (sS >= 70 && volRatio > 1.1) await openPosition('sell', price);
        } else {
            const p = serverData.pos;
            const isL = p.side === 'buy';
            const roi = (isL ? (price - p.entry)/p.entry : (p.entry - price)/p.entry) * 100 * activeConfig.lev;
            p.roi = roi;

            // Gerenciamento de Trailing e Parciais (igual ao anterior, mas com o estado sincronizado)
            if (roi <= -activeConfig.stopPct) await closePosition("Stop Loss Real");
            else if (roi >= activeConfig.trailAct && !p.trailActive) {
                p.trailActive = true;
                addLog("🎯 Trailing Ativado!");
            }
            // ... resto da sua lógica de fechamento
        }
    } catch (e) { console.log("Erro Análise:", e.message); }
}

async function openPosition(side, price) {
    try {
        if (!exchange.apiKey) {
            serverData.pos = { side, entry: price, qty: 1, roi: 0, peak: 0, peakPrice: price, partialEntryCount: 0, trailActive: false, partialExitDone: false };
            addLog(`📝 SIMULADO: ${side.toUpperCase()}`);
            return;
        }
        // ... (seu código de criar market order aqui)
        // Ao abrir, o CCXT retorna a quantidade exata e o preço
        // serverData.pos = { ... }
        addLog(`🔥 ENTRADA REAL: ${side.toUpperCase()}`);
    } catch (e) { addLog(`❌ Erro Ordem: ${e.message}`); }
}

async function closePosition(reason = "") {
    try {
        if (exchange.apiKey) {
            // SEGURANÇA: Fecha TUDO que houver do símbolo na Bybit, independente do que o servidor acha
            const positions = await exchange.fetchPositions([activeConfig.sym]);
            const bPos = positions.find(p => p.symbol.replace(':USDT','') === activeConfig.sym.replace(':USDT','') && parseFloat(p.contracts) > 0);
            
            if (bPos) {
                const side = bPos.side === 'long' ? 'sell' : 'buy';
                await exchange.createMarketOrder(activeConfig.sym, side, bPos.contracts);
            }
        }
        serverData.pos = null;
        addLog(`🛑 FECHADO: ${reason}`);
    } catch (e) { addLog(`❌ Erro Fechar: ${e.message}`); serverData.pos = null; }
}

app.post('/control', async (req, res) => {
    const cfg = req.body;
    if (cfg.action === 'start') {
        activeConfig = { ...activeConfig, ...cfg };
        if (cfg.apiKey && cfg.apiSecret) {
            exchange.apiKey = cfg.apiKey;
            exchange.secret = cfg.apiSecret;
        }
        await syncWithBybit(); // Sincroniza IMEDIATAMENTE ao clicar em iniciar
        addLog(`🚀 Monitorando: ${activeConfig.sym}`);
    } else if (cfg.action === 'stop' || cfg.action === 'close_now') {
        await closePosition("Comando Manual");
    }
    res.json({ status: "ok" });
});

app.get('/status', (req, res) => res.json(serverData));
app.get('/', (req, res) => res.send("Bot Online 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { 
    setInterval(analyzeStrategy, 5000); 
});
