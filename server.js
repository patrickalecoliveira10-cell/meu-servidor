const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');

const app = express();
app.use(cors());
app.use(express.json());

// --- ESTADO GLOBAL ---
let activeConfig = null;
let exchange = new ccxt.bybit({ 
    timeout: 20000, 
    enableRateLimit: true, 
    options: { 'defaultType': 'linear' } 
});

let eventLog = [];
let serverData = {
    price: 0,
    score: 0,
    rsi: 50,
    vol: 1.0,
    pos: { 
        side: null, entry: 0, qty: 0, roi: 0, 
        partials: "0/2", trail: "Inativo", peak: 0 
    }
};

// Auxiliar para Logs
function addLog(msg) {
    const time = Date.now();
    console.log(`[${new Date(time).toLocaleTimeString()}] ${msg}`);
    eventLog.push({ msg, time });
    if (eventLog.length > 30) eventLog.shift();
}

// Rota de Controle
app.post('/control', async (req, res) => {
    const data = req.body;
    if (data.action === 'start') {
        activeConfig = {
            sym: data.sym,
            bankPct: parseFloat(data.bankPct) || 10,
            stopPct: parseFloat(data.stopPct) || 2.5,
            trailAct: parseFloat(data.trailAct) || 2.0,
            trailPull: parseFloat(data.trailPull) || 1.0,
            apiKey: data.apiKey,
            apiSecret: data.apiSecret
        };

        if (activeConfig.apiKey && activeConfig.apiSecret) {
            exchange.apiKey = activeConfig.apiKey;
            exchange.secret = activeConfig.apiSecret;
        }

        addLog(`🚀 Motor Iniciado: ${activeConfig.sym}`);
        runTradingLoop();
        res.json({ status: "ok" });
    } else {
        activeConfig = null;
        serverData.pos.side = null;
        addLog("🛑 Motor Parado.");
        res.json({ status: "stopped" });
    }
});

// Rota de Status (O App consulta aqui)
app.get('/status', (req, res) => {
    res.json({ ...serverData, eventLog: eventLog.slice(-10) });
});

// --- MOTOR DE TRADING ---
async function runTradingLoop() {
    while (activeConfig) {
        try {
            const sym = activeConfig.sym;
            
            // 1. Busca Preço e Velas (OHLCV)
            const ticker = await exchange.fetchTicker(sym);
            const ohlcv = await exchange.fetchOHLCV(sym, '1m', undefined, 30);
            
            const price = ticker.last;
            const closes = ohlcv.map(c => c[4]);
            const volumes = ohlcv.map(c => c[5]);

            // 2. Cálculo RSI 14 Real
            const rsi = calculateRSI(closes);

            // 3. Cálculo de Volume Relativo (Média 20)
            const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
            const currentVol = volumes[volumes.length - 1];
            const volRatio = currentVol / (avgVol || 1);

            // 4. Cálculo do Score (Lógica APK 2)
            // Score aumenta conforme RSI se afasta de 50 + bônus de Volume
            let baseScore = Math.abs(rsi - 50) * 1.8; 
            let score = baseScore + (volRatio * 8);
            if (score > 100) score = 100;

            // Atualiza dados para o Dashboard do App
            serverData.price = price;
            serverData.rsi = rsi;
            serverData.vol = volRatio;
            serverData.score = score;

            // 5. Gestão de Posição (Trailing / Stop)
            if (serverData.pos.side) {
                manageLogic(price);
            } else {
                // Gatilho de Entrada Automática (Score > 70 e Volume > 1.1)
                if (score >= 70 && volRatio >= 1.1) {
                    const side = rsi > 50 ? 'long' : 'short';
                    openCloudPos(side, price);
                }
            }

            await new Promise(r => setTimeout(r, 4000)); // Ciclo de 4 segundos
        } catch (e) {
            console.error("Erro no Loop:", e.message);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

function calculateRSI(closes) {
    if (closes.length < 15) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - 14; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    const rs = gains / (losses || 1);
    return 100 - (100 / (1 + rs));
}

function openCloudPos(side, price) {
    serverData.pos = { side, entry: price, qty: 1, roi: 0, partials: "0/2", trail: "Inativo", peak: price };
    addLog(`🔔 ENTRADA ${side.toUpperCase()} em ${price}`);
}

function manageLogic(price) {
    const p = serverData.pos;
    const isL = p.side === 'long';
    const c = activeConfig;
    
    p.roi = isL ? ((price - p.entry)/p.entry)*100*10 : ((p.entry - price)/p.entry)*100*10;

    if (p.roi <= -c.stopPct) {
        addLog(`❌ STOP LOSS: ${p.roi.toFixed(2)}%`);
        p.side = null;
        return;
    }

    if (p.trail === 'Inativo' && p.roi >= c.trailAct) {
        p.trail = 'ATIVO';
        p.peak = price;
        addLog(`🎯 Trailing Ativado em ${price}`);
    }

    if (p.trail === 'ATIVO') {
        if (isL && price > p.peak) p.peak = price;
        if (!isL && price < p.peak) p.peak = price;

        const pullback = isL ? ((p.peak - price)/p.peak)*100*10 : ((price - p.peak)/p.peak)*100*10;
        if (pullback >= c.trailPull) {
            addLog(`💰 Alvo Batido no Trailing. ROI: ${p.roi.toFixed(2)}%`);
            p.side = null;
        }
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor Scanner Pro v8 Online na porta ${PORT}`));
