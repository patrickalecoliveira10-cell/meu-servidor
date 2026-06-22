const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const app = express();
app.use(cors());
app.use(express.json());

let activeConfig = null;
let exchange = null;
let eventLog = [];
let serverStatus = {
    price: 0,
    score: 0,
    rsi: 50,
    vol: 1.0,
    trend: 'Buscando...',
    pos: { side: null, entry: 0, qty: 0, pnl: 0, roi: 0, partials: 0, trail: 'Inativo' }
};

app.post('/control', async (req, res) => {
    const data = req.body;
    if (data.action === 'start') {
        activeConfig = data;
        eventLog.push({ msg: `🚀 Iniciado: ${data.sym}`, time: Date.now() });
        if (data.apiKey && data.apiSecret) {
            exchange = new ccxt.bybit({ apiKey: data.apiKey, secret: data.apiSecret, options: { 'defaultType': 'linear' } });
        }
        runEngine();
        res.status(200).send({ status: "ok" });
    } else {
        activeConfig = null;
        serverStatus.pos.side = null;
        res.status(200).send({ status: "stopped" });
    }
});

app.get('/status', (req, res) => {
    res.json({ ...serverStatus, eventLog: eventLog.slice(-10) });
});

async function runEngine() {
    while (activeConfig) {
        try {
            const ticker = await exchange.fetchTicker(activeConfig.sym);
            const price = ticker.last;
            
            // SIMULAÇÃO DE ANÁLISE TÉCNICA (O robô calcula isso 24h)
            serverStatus.price = price;
            serverStatus.rsi = 45 + Math.random() * 10; // Exemplo: No futuro calculamos real
            serverStatus.score = serverStatus.rsi > 50 ? 75 : 40;
            serverStatus.vol = 1.15;
            serverStatus.trend = serverStatus.score > 70 ? 'FORTE ALTA' : 'NEUTRO';

            if (serverStatus.pos.side) {
                manageLogic(price);
            } else if (serverStatus.score > 70) {
                openPos('long', price);
            }

            await new Promise(r => setTimeout(r, 3000));
        } catch (e) { await new Promise(r => setTimeout(r, 5000)); }
    }
}

function manageLogic(price) {
    const p = serverStatus.pos;
    const isL = p.side === 'long';
    p.roi = isL ? ((price - p.entry)/p.entry)*100*10 : ((p.entry - price)/p.entry)*100*10;
    
    // Se atingir trailing, parciais, etc, ele gera o log:
    if (p.roi >= 2.0 && p.trail === 'Inativo') {
        p.trail = 'ATIVO';
        eventLog.push({ msg: "🎯 Trailing Ativado na Nuvem!", time: Date.now() });
    }
}

async function openPos(side, price) {
    serverStatus.pos = { side, entry: price, qty: 10, pnl: 0, roi: 0, partials: 0, trail: 'Inativo' };
    eventLog.push({ msg: `🔔 Entrada ${side.toUpperCase()} em ${price}`, time: Date.now() });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor v8 Online"));
