// server.js - VERSÃO CORRIGIDA
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let MONITOR = {
    active: false,
    symbol: null,
    config: {},
    position: null
};

// --- FUNÇÃO DE ASSINATURA CORRIGIDA PARA V5 ---
function getSignature(parameters, secret, timestamp) {
    return crypto.createHmac('sha256', secret)
        .update(timestamp + process.env.BYBIT_KEY + '5000' + parameters)
        .digest('hex');
}

async function bybitRequest(method, endpoint, data = {}) {
    const timestamp = Date.now().toString();
    const baseUrl = process.env.USE_TESTNET === 'true' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    
    // CORREÇÃO: No GET, os parâmetros vão na assinatura. No POST, vai o JSON body.
    let parameters = "";
    if (method === 'GET') {
        parameters = new URLSearchParams(data).toString();
    } else {
        parameters = JSON.stringify(data);
    }

    const sign = getSignature(parameters, process.env.BYBIT_SECRET, timestamp);

    try {
        const config = {
            method,
            url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: {
                'X-BAPI-API-KEY': process.env.BYBIT_KEY,
                'X-BAPI-SIGN': sign,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': '5000',
                'Content-Type': 'application/json'
            }
        };
        if (method !== 'GET') config.data = data;
        
        const res = await axios(config);
        return res.data;
    } catch (e) { 
        console.error("Erro na requisição Bybit:", e.response ? e.response.data : e.message);
        return null; 
    }
}

async function parControlLoop() {
    if (!MONITOR.active || !MONITOR.symbol || !MONITOR.position) return;

    const { symbol, config, position } = MONITOR;
    // O GET agora funciona com a assinatura corrigida
    const ticker = await bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol });
    
    if (!ticker || !ticker.result || !ticker.result.list[0]) return;

    const price = parseFloat(ticker.result.list[0].lastPrice);
    const isLong = position.side.toLowerCase() === 'long';
    const priceVar = isLong ? (price - position.entry)/position.entry : (position.entry - price)/position.entry;
    const roi = priceVar * 100 * config.lev;

    // Monitoramento no console do servidor para você acompanhar
    console.log(`[${symbol}] Preço: ${price} | ROI: ${roi.toFixed(2)}% | Trailing: ${position.trailActive ? 'ON' : 'OFF'}`);

    // 1. Stop Loss
    if (roi <= -config.stopPct) {
        console.log(`[${symbol}] ❌ STOP LOSS ATINGIDO`);
        if (!position.isFake) await closeBybitPosition();
        MONITOR.active = false;
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
            console.log(`[${symbol}] 🏁 TRAILING FINALIZADO (PULLBACK)`);
            if (!position.isFake) await closeBybitPosition();
            MONITOR.active = false;
        }
    }
}

async function closeBybitPosition() {
    try {
        const side = MONITOR.position.side.toLowerCase() === 'long' ? 'Sell' : 'Buy';
        const res = await bybitRequest('POST', '/v5/order/create', {
            category: 'linear', 
            symbol: MONITOR.symbol, 
            side: side,
            orderType: 'Market', 
            qty: MONITOR.position.qty.toString(), 
            reduceOnly: true
        });
        console.log("Ordem de fechamento enviada:", res.retMsg);
    } catch(e) {
        console.error("Erro ao fechar posição:", e);
    }
}

app.post('/sync-par', (req, res) => {
    const { symbol, active, config, position } = req.body;
    if (active) {
        // Garante que o estado do trailing persistido no servidor seja mantido se for a mesma posição
        const isSamePos = MONITOR.symbol === symbol && MONITOR.active;
        MONITOR = { 
            active: true, 
            symbol, 
            config, 
            position: {
                ...position,
                trailActive: isSamePos ? MONITOR.position.trailActive : (position.trailActive || false),
                peak: isSamePos ? MONITOR.position.peak : (position.peak || position.entry)
            }
        };
    } else {
        MONITOR.active = false;
    }
    res.json({ success: true, state: MONITOR.active ? "Monitoring" : "Idle" });
});

app.get('/status', (req, res) => res.json(MONITOR));

setInterval(parControlLoop, 5000); // Roda a cada 5 segundos
app.listen(PORT, () => console.log(`Servidor Modo Par Rodando na Porta ${PORT}`));
