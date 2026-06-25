const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Estado Global do Servidor
let MONITORING = {
    active: false,
    symbol: null,
    config: {},
    position: null // { side, entry, qty, peak, trailActive }
};

// --- FUNÇÕES DE ASSINATURA BYBIT V5 ---
function getSignature(params, secret, timestamp) {
    const recvWindow = '5000';
    return crypto.createHmac('sha256', secret)
        .update(timestamp + process.env.BYBIT_KEY + recvWindow + params)
        .digest('hex');
}

async function bybitRequest(method, endpoint, data = {}) {
    const timestamp = Date.now().toString();
    const body = method === 'GET' ? '' : JSON.stringify(data);
    const sign = getSignature(body, process.env.BYBIT_SECRET, timestamp);

    const url = (process.env.USE_TESTNET === 'true' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com') + endpoint;

    try {
        const res = await axios({
            method, url, data,
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
    } catch (e) { console.error("Erro Bybit:", e.message); return null; }
}

// --- LÓGICA DE GERENCIAMENTO (O CORAÇÃO DO MODO PAR) ---
async function manageCycle() {
    if (!MONITORING.active || !MONITORING.symbol) return;

    const { symbol, config, position } = MONITORING;
    if (!position) return; // Se não tem posição, o servidor apenas aguarda ou você pode adicionar lógica de entrada aqui

    try {
        // 1. Pega preço atual
        const ticker = await bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol });
        const price = parseFloat(ticker.result.list[0].lastPrice);
        
        const isLong = position.side === 'long';
        const lev = config.lev || 5;
        const priceVar = isLong ? (price - position.entry)/position.entry : (position.entry - price)/position.entry;
        const roi = priceVar * 100 * lev;

        console.log(`[${symbol}] ROI: ${roi.toFixed(2)}% | Price: ${price}`);

        // 2. Verificação de Stop Loss
        if (roi <= -config.stopPct) {
            console.log("❌ STOP LOSS atingido no servidor!");
            await closePosition(symbol);
            return;
        }

        // 3. Lógica de Trailing
        if (!position.trailActive && roi >= config.trailAct) {
            position.trailActive = true;
            position.peak = price;
            console.log("🎯 Trailing Ativado!");
        }

        if (position.trailActive) {
            if (isLong && price > position.peak) position.peak = price;
            if (!isLong && price < position.peak) position.peak = price;

            const pullback = isLong ? (position.peak - price)/position.peak*100 : (price - position.peak)/position.peak*100;
            const pullROI = pullback * lev;

            if (pullROI >= config.trailPull) {
                console.log(`🏁 Trailing Batido! Recuo de ${pullROI.toFixed(2)}% ROI`);
                await closePosition(symbol);
            }
        }
    } catch (e) {
        console.error("Erro no ciclo:", e.message);
    }
}

async function closePosition(symbol) {
    console.log(`Fechando ${symbol} na Bybit...`);
    const res = await bybitRequest('POST', '/v5/order/create', {
        category: 'linear',
        symbol: symbol,
        side: MONITORING.position.side === 'long' ? 'Sell' : 'Buy',
        orderType: 'Market',
        qty: MONITORING.position.qty.toString(),
        reduceOnly: true
    });
    
    if (res && res.retCode === 0) {
        MONITORING.active = false;
        MONITORING.position = null;
    }
}

// --- ENDPOINTS DE CONTROLE ---

app.post('/sync-par', (req, res) => {
    const { symbol, active, config, position } = req.body;
    
    if (active) {
        MONITORING = { active: true, symbol, config, position };
        console.log(`🚀 Servidor assumiu ${symbol}`);
    } else {
        MONITORING.active = false;
        console.log(`⏹ Servidor parou monitoramento de ${symbol}`);
    }
    res.json({ success: true });
});

app.get('/status', (req, res) => {
    res.json({ 
        online: true, 
        monitoring: MONITORING.active, 
        symbol: MONITORING.symbol,
        position: MONITORING.position 
    });
});

// Loop de execução (cada 5 segundos)
setInterval(manageCycle, 5000);

app.listen(PORT, () => console.log(`Servidor Modo Par rodando na porta ${PORT}`));
