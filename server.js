const express = require('express');
const axios = require('axios');
const crypto = require('crypto');const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

let MONITOR = {
    active: false,
    symbol: null,
    config: { stopPct: 2.5, trailAct: 2, trailPull: 1, lev: 5 },
    position: null
};

// --- HELPER BYBIT (GERADOR DE ASSINATURA) ---
function getSignature(parameters, secret, timestamp) {
    return crypto.createHmac('sha256', secret).update(timestamp + process.env.BYBIT_KEY + '5000' + parameters).digest('hex');
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
            headers: { 
                'X-BAPI-API-KEY': key, 
                'X-BAPI-SIGN': sign, 
                'X-BAPI-TIMESTAMP': timestamp, 
                'X-BAPI-RECV-WINDOW': '5000', 
                'Content-Type': 'application/json' 
            },
            data: method !== 'GET' ? data : undefined,
            timeout: 5000
        });
        return res.data;
    } catch (e) { return { error: e.message }; }
}

// --- LOGICA DE ABERTURA DE ORDEM ---
async function parServerOpenPosition(side, symbol, lev) {
    console.log(`[CLOUD] Abrindo ordem de ${side} para ${symbol}`);
    // 1. Ajusta Alavancagem antes
    await bybitRequest('POST', '/v5/position/set-leverage', { category: 'linear', symbol, buyLeverage: lev.toString(), sellLeverage: lev.toString() });
    
    // 2. Aqui você deve definir a quantidade (Qty) baseada no seu saldo ou config
    // Exemplo simplificado: Ordem a Mercado
    const order = await bybitRequest('POST', '/v5/order/create', {
        category: 'linear',
        symbol: symbol,
        side: side.charAt(0).toUpperCase() + side.slice(1).toLowerCase(), // Buy ou Sell
        orderType: 'Market',
        qty: "0.01", // <--- AJUSTE A QUANTIDADE AQUI OU ENVIE VIA APP
        timeInForce: 'GTC'
    });
    return order;
}

// --- ROTAS ---
app.get('/status', (req, res) => res.json({ active: MONITOR.active, symbol: MONITOR.symbol, position: MONITOR.position }));

app.post('/sync-par', async (req, res) => {
    const { symbol, active, config, position, forceEntry } = req.body;
    if (active) {
        MONITOR.symbol = symbol;
        MONITOR.config = config;
        MONITOR.active = true;
        // Se o App enviou uma posição ou um comando de entrada forçada
        if (position) MONITOR.position = position;
        if (forceEntry) {
            const side = forceEntry.side; // LONG ou SHORT
            const order = await parServerOpenPosition(side === 'LONG' ? 'Buy' : 'Sell', symbol, config.lev);
            if (order.retCode === 0) {
                MONITOR.position = { side: side.toLowerCase(), entry: parseFloat(order.result.price) || 0, qty: "0.01", peak: 0, trailActive: false };
            }
        }
    } else {
        MONITOR.active = false;
        MONITOR.position = null;
    }
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Servidor Ativo na porta ${PORT}`));
