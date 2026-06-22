const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const app = express();

app.use(cors());
app.use(express.json());

let activeConfig = null;
let exchange = new ccxt.bybit({ options: { 'defaultType': 'linear' } });
let eventLog = [];
let serverData = {
    price: 0, score: 0, rsi: 50, vol: 1.0,
    pos: { side: null, entry: 0, qty: 0, roi: 0, partials: "0/2", trail: "Inativo" }
};

app.post('/control', async (req, res) => {
    const data = req.body;
    if (data.action === 'start') {
        activeConfig = data;
        if (data.apiKey && data.apiSecret) {
            exchange.apiKey = data.apiKey;
            exchange.secret = data.apiSecret;
        }
        addLog(`🚀 Monitoramento REAL Iniciado: ${data.sym}`);
        runTradingLoop(); // Inicia o motor
        res.json({ status: "ok" });
    } else {
        activeConfig = null;
        res.json({ status: "stopped" });
    }
});

app.get('/status', (req, res) => {
    res.json({ ...serverData, eventLog: eventLog.slice(-10) });
});

async function runTradingLoop() {
    while (activeConfig) {
        try {
            const sym = activeConfig.sym;
            // 1. BUSCA PREÇO E VELAS REAIS
            const ticker = await exchange.fetchTicker(sym);
            const ohlcv = await exchange.fetchOHLCV(sym, '1m', undefined, 20);
            
            const price = ticker.last;
            const closes = ohlcv.map(c => c[4]);

            // 2. CÁLCULO RSI REAL (Últimas 14 velas)
            let rsi = calculateRSI(closes);
            
            // 3. ATUALIZA DADOS
            serverData.price = price;
            serverData.rsi = rsi;
            serverData.vol = ticker.quoteVolume ? (ticker.quoteVolume / 1000000).toFixed(2) : 1.1; // Volume em Milhões
            
            // SCORE: Lógica APK 2 (RSI + Tendência)
            serverData.score = rsi > 50 ? (rsi + 15) : (rsi - 15);
            if (serverData.score > 100) serverData.score = 100;
            if (serverData.score < 0) serverData.score = 0;

            // 4. GESTÃO DE POSIÇÃO
            if (serverData.pos.side) {
                const p = serverData.pos;
                const isL = p.side === 'long';
                p.roi = isL ? ((price - p.entry)/p.entry)*100*10 : ((p.entry - price)/p.entry)*100*10;
            }

            console.log(`[${sym}] Preço: ${price} | RSI: ${rsi.toFixed(2)} | Score: ${serverData.score.toFixed(0)}`);

            await new Promise(r => setTimeout(r, 4000));
        } catch (e) {
            console.error("Erro Loop:", e.message);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

function calculateRSI(closes) {
    let gains = 0, losses = 0;
    for (let i = closes.length - 14; i < closes.length; i++) {
        let diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    let rs = gains / (losses || 1);
    return 100 - (100 / (1 + rs));
}

function addLog(msg) {
    eventLog.push({ msg, time: Date.now() });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor Online"));
