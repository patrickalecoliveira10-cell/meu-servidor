const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Estado do Monitoramento (Persistente no Servidor)
let MONITOR = {
    active: false,
    symbol: null,
    config: {},   // { stopPct, trailAct, trailPull, lev }
    position: null // { side, entry, qty, peak, trailActive }
};

// --- FUNÇÃO DE ASSINATURA BYBIT V5 (CORRIGIDA) ---
// Na V5, para GET a query string deve estar na assinatura.
function getSignature(parameters, secret, timestamp) {
    return crypto.createHmac('sha256', secret)
        .update(timestamp + (process.env.BYBIT_KEY || '') + '5000' + parameters)
        .digest('hex');
}

async function bybitRequest(method, endpoint, data = {}) {
    const key = process.env.BYBIT_KEY;
    const secret = process.env.BYBIT_SECRET;
    
    if (!key || !secret) {
        console.error("❌ ERRO: BYBIT_KEY ou BYBIT_SECRET não configurados no .env");
        return null;
    }

    const timestamp = Date.now().toString();
    const baseUrl = process.env.USE_TESTNET === 'true' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    
    let parameters = "";
    if (method === 'GET') {
        parameters = new URLSearchParams(data).toString();
    } else {
        parameters = JSON.stringify(data);
    }

    const sign = getSignature(parameters, secret, timestamp);

    try {
        const config = {
            method,
            url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: {
                'X-BAPI-API-KEY': key,
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
        console.error("❌ Erro Bybit:", e.response ? e.response.data : e.message);
        return null; 
    }
}

// --- LOOP DE GESTÃO DO MODO PAR ---
async function parControlLoop() {
    if (!MONITOR.active || !MONITOR.symbol || !MONITOR.position) return;

    try {
        const { symbol, config, position } = MONITOR;
        
        // Busca o preço atual da moeda
        const ticker = await bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol });
        
        if (!ticker || !ticker.result || !ticker.result.list[0]) {
            console.log(`[${symbol}] Aguardando resposta da Bybit...`);
            return;
        }

        const price = parseFloat(ticker.result.list[0].lastPrice);
        const isLong = position.side.toLowerCase() === 'long';
        
        // Cálculo de variação e ROI com alavancagem
        const priceVar = isLong ? (price - position.entry)/position.entry : (position.entry - price)/position.entry;
        const roi = priceVar * 100 * (config.lev || 1);

        console.log(`[${symbol}] Preço: ${price} | ROI: ${roi.toFixed(2)}% | Trailing: ${position.trailActive ? 'ON' : 'OFF'}`);

        // 1. Lógica de Stop Loss
        if (roi <= -config.stopPct) {
            console.log(`[${symbol}] ❌ STOP LOSS ATINGIDO: ${roi.toFixed(2)}%`);
            await closeBybitPosition();
            return;
        }

        // 2. Lógica de Trailing Stop
        // Ativa o trailing se atingir o gatilho de ativação (trailAct)
        if (!position.trailActive && roi >= config.trailAct) {
            position.trailActive = true;
            position.peak = price;
            console.log(`[${symbol}] 🎯 TRAILING ATIVADO`);
        }

        // Se o trailing estiver ativo, monitora o recuo (pullback)
        if (position.trailActive) {
            // Atualiza o ponto de pico (maior preço para Long, menor para Short)
            if ((isLong && price > position.peak) || (!isLong && price < position.peak)) {
                position.peak = price;
            }

            // Calcula o recuo a partir do pico
            const pullback = isLong ? (position.peak - price)/position.peak*100 : (price - position.peak)/position.peak*100;
            const pullbackROI = pullback * (config.lev || 1);

            if (pullbackROI >= config.trailPull) {
                console.log(`[${symbol}] 🏁 TRAILING FINALIZADO POR RECUO. ROI: ${roi.toFixed(2)}%`);
                await closeBybitPosition();
            }
        }
    } catch (err) {
        console.error("Erro no Ciclo de Controle:", err.message);
    }
}

// --- FUNÇÃO PARA FECHAR POSIÇÃO NA BYBIT ---
async function closeBybitPosition() {
    if (!MONITOR.symbol || !MONITOR.position) return;
    
    // Inverte o lado para fechar a posição
    const side = MONITOR.position.side.toLowerCase() === 'long' ? 'Sell' : 'Buy';
    
    console.log(`[${MONITOR.symbol}] Enviando ordem de fechamento a mercado...`);
    
    const res = await bybitRequest('POST', '/v5/order/create', {
        category: 'linear', 
        symbol: MONITOR.symbol, 
        side: side,
        orderType: 'Market', 
        qty: MONITOR.position.qty.toString(), 
        reduceOnly: true
    });
    
    if (res && res.retCode === 0) {
        console.log(`✅ [${MONITOR.symbol}] Posição encerrada com sucesso.`);
    } else {
        console.log(`⚠️ Erro ao fechar na Bybit: ${res ? res.retMsg : 'Sem resposta'}`);
    }
    
    // Desativa o monitoramento independente do resultado para evitar loops de erro
    MONITOR.active = false;
}

// --- ROTAS DO SERVIDOR ---

// Rota de Sincronização (O App envia os dados para cá)
app.post('/sync-par', (req, res) => {
    try {
        const { symbol, active, config, position } = req.body;
        
        if (!symbol) {
            return res.status(400).json({ success: false, error: "Symbol is required" });
        }

        if (active) {
            // Preserva o estado do trailing (pico) se for a mesma moeda já monitorada
            const isSame = MONITOR.active && MONITOR.symbol === symbol;
            
            MONITOR = { 
                active: true, 
                symbol, 
                config: config || {}, 
                position: {
                    ...position,
                    peak: isSame ? MONITOR.position.peak : (position.peak || position.entry),
                    trailActive: isSame ? MONITOR.position.trailActive : (position.trailActive || false)
                }
            };
            console.log(`[SYNC] Monitorando ${symbol}. SL: ${config.stopPct}% | TA: ${config.trailAct}%`);
        } else {
            MONITOR.active = false;
            console.log(`[SYNC] Monitoramento de ${symbol} parado.`);
        }

        res.json({ success: true });
    } catch (err) {
        console.error("Erro na rota /sync-par:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Rota de Status (Para conferir o que o servidor está fazendo)
app.get('/status', (req, res) => res.json(MONITOR));

// Inicia o loop de monitoramento a cada 5 segundos
setInterval(parControlLoop, 5000);

app.listen(PORT, () => {
    console.log(`
    ==========================================
    🚀 SERVIDOR BYBIT SCANNER PRO V8 ONLINE
    Porta: ${PORT}
    Monitoramento: Ativo (5s)
    ==========================================
    `);
});
