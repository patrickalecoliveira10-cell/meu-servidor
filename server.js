// server.js
const express = require('express');const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Estado do Monitoramento
let MONITOR = {
    active: false,
    symbol: null,
    config: {},   // { stopPct, trailAct, trailPull, lev }
    position: null // { side, entry, qty, peak, trailActive }
};

// --- Funções de Assinatura Bybit V5 ---
function getSignature(params, secret, timestamp) {
    return crypto.createHmac('sha256', secret)
        .update(timestamp + process.env.BYBIT_KEY + '5000' + params)
        .digest('hex');
}

async function bybitRequest(method, endpoint, data = {}) {
    const timestamp = Date.now().toString();
    const body = method === 'GET' ? '' : JSON.stringify(data);
    const sign = getSignature(body, process.env.BYBIT_SECRET, timestamp);
    const baseUrl = process.env.USE_TESTNET === 'true' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';

    try {
        const res = await axios({
            method, url: baseUrl + endpoint, data,
            headers: {
                'X-BAPI-API-KEY': process.env.BYBIT_KEY,
                'X-BAPI-SIGN': sign,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': '5000',
                'Content-Type': 'application/json'
            },
            params: method === 'GET' ? data : {}
        });
        return res.data;
    } catch (e) { return null; }
}

// --- Loop de Gestão do Modo Par ---
async function parControlLoop() {
    if (!MONITOR.active || !MONITOR.symbol || !MONITOR.position) return;

    const { symbol, config, position } = MONITOR;
    const ticker = await bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol });
    if (!ticker || !ticker.result.list[0]) return;

    const price = parseFloat(ticker.result.list[0].lastPrice);
    const isLong = position.side === 'long';
    const priceVar = isLong ? (price - position.entry)/position.entry : (position.entry - price)/position.entry;
    const roi = priceVar * 100 * config.lev;

    // 1. Stop Loss
    if (roi <= -config.stopPct) {
        console.log(`[${symbol}] ❌ STOP LOSS ATINGIDO: ${roi.toFixed(2)}%`);
        await closeBybitPosition();
        return;
    }

    // 2. Trailing Stop
    if (!position.trailActive && roi >= config.trailAct) {
        position.trailActive = true;
        position.peak = price;
        console.log(`[${symbol}] 🎯 TRAILING ATIVADO`);
    }

    if (position.trailActive) {
        if ((isLong && price > position.peak) || (!isLong && price < position.peak)) {
            position.peak = price;
        }
        const pullback = isLong ? (position.peak - price)/position.peak*100 : (price - position.peak)/position.peak*100;
        if ((pullback * config.lev) >= config.trailPull) {
            console.log(`[${symbol}] 🏁 TRAILING FINALIZADO`);
            await closeBybitPosition();
        }
    }
}

async function closeBybitPosition() {
    const side = MONITOR.position.side === 'long' ? 'Sell' : 'Buy';
    await bybitRequest('POST', '/v5/order/create', {
        category: 'linear', symbol: MONITOR.symbol, side,
        orderType: 'Market', qty: MONITOR.position.qty.toString(), reduceOnly: true
    });
    MONITOR.active = false;
}

app.post('/sync-par', (req, res) => {
    const { symbol, active, config, position } = req.body;
    if (active) {
        MONITOR = { active: true, symbol, config, position };
    } else {
        MONITOR.active = false;
    }
    res.json({ success: true });
});

app.get('/status', (req, res) => res.json(MONITOR));

setInterval(parControlLoop, 5000);
app.listen(PORT, () => console.log(`Servidor Modo Par Rodando na Porta ${PORT}`));
