const express = require('express');
const axios = require('axios');const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Estado Global do Monitoramento
let MONITOR = {
    active: false,
    symbol: null,
    config: { stopPct: 2.5, trailAct: 2, trailPull: 1, lev: 5 },
    position: null,
    lastUpdate: null
};

// --- ROTAS DE COMUNICAÇÃO ---

// Rota que o App consome para atualizar o gráfico e ROI
app.get('/status', (req, res) => {
    res.json({ 
        active: MONITOR.active, 
        symbol: MONITOR.symbol,
        position: MONITOR.position,
        uptime: process.uptime()
    });
});

// Sincronização vinda do App
app.post('/sync-par', async (req, res) => {
    try {
        const { symbol, active, config, position } = req.body;
        if (active === true) {
            MONITOR.symbol = symbol;
            MONITOR.config = {
                stopPct: parseFloat(config?.stopPct) || 2.5,
                trailAct: parseFloat(config?.trailAct) || 2,
                trailPull: parseFloat(config?.trailPull) || 1,
                lev: parseInt(config?.lev) || 5
            };
            MONITOR.position = position ? {
                side: position.side,
                entry: parseFloat(position.entry),
                qty: parseFloat(position.qty),
                peak: parseFloat(position.peak || position.entry),
                trailActive: !!position.trailActive
            } : null;
            MONITOR.active = true;
            console.log(`[CLOUD] Monitoramento ativo: ${symbol}`);
        } else {
            MONITOR.active = false;
            MONITOR.position = null;
            console.log("[CLOUD] Monitoramento parado");
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/', (req, res) => res.send("Bybit Scanner Pro v8 Server Online"));

// --- LÓGICA DE EXECUÇÃO BYBIT ---

function getSignature(parameters, secret, timestamp) {
    return crypto.createHmac('sha256', secret || '').update(timestamp + process.env.BYBIT_KEY + '5000' + parameters).digest('hex');
}

async function bybitRequest(method, endpoint, data = {}) {
    const key = process.env.BYBIT_KEY;
    const secret = process.env.BYBIT_SECRET;
    const timestamp = Date.now().toString();
    const baseUrl = process.env.USE_TESTNET === 'true' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    const parameters = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
    const sign = getSignature(parameters, secret, timestamp);

    try {
        const res = await axios({
            method,
            url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: { 'X-BAPI-API-KEY': key, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': '5000', 'Content-Type': 'application/json' },
            data: method !== 'GET' ? data : undefined,
            timeout: 5000
        });
        return res.data;
    } catch (e) { return { error: e.message }; }
}

// Loop de Monitoramento (5s)
setInterval(async () => {
    if (!MONITOR.active || !MONITOR.symbol || !MONITOR.position) return;

    try {
        const ticker = await bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol: MONITOR.symbol });
        if (!ticker || ticker.retCode !== 0) return;

        const price = parseFloat(ticker.result.list[0].lastPrice);
        const pos = MONITOR.position;
        const isLong = pos.side.toLowerCase() === 'long';
        const pVar = isLong ? (price - pos.entry)/pos.entry : (pos.entry - price)/pos.entry;
        const roi = pVar * 100 * MONITOR.config.lev;

        // 1. Stop Loss
        if (roi <= -MONITOR.config.stopPct) {
            console.log(`[STOP] Executando fechamento em ${price}`);
            MONITOR.position = null; // Em produção, aqui chamaria a ordem de venda da Bybit
            return;
        }

        // 2. Trailing Stop
        if (!pos.trailActive && roi >= MONITOR.config.trailAct) {
            pos.trailActive = true;
            console.log("[TRAIL] Ativado");
        }

        if (pos.trailActive) {
            if (isLong && price > pos.peak) pos.peak = price;
            if (!isLong && price < pos.peak) pos.peak = price;

            const pbPct = isLong ? (pos.peak - price)/pos.peak*100 : (price - pos.peak)/pos.peak*100;
            const pbRoi = pbPct * MONITOR.config.lev;

            if (pbRoi >= MONITOR.config.trailPull) {
                console.log(`[TAKE] Trailing batido em ${price}`);
                MONITOR.position = null;
            }
        }
    } catch (e) { console.error("Erro Ciclo:", e.message); }
}, 5000);

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
