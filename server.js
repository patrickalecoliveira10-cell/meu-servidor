const express = require('express');
const axios = require('axios');const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BYBIT_KEY = process.env.BYBIT_API_KEY; 
const BYBIT_SECRET = process.env.BYBIT_API_SECRET;
const IS_TESTNET = process.env.USE_TESTNET === 'true';

let MONITOR = {
    active: false,
    symbol: null,
    config: { bankPct: 30, lev: 1, stopPct: 1.5, trailAct: 1.5, trailPull: 0.8 },
    position: null,
    logs: [],
    lastCloseTime: 0,
    realBalance: 15,
    lastEntryAttempt: 0
};

function serverLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('pt-BR');
    MONITOR.logs.unshift({ time, msg, type });
    if (MONITOR.logs.length > 50) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${time} - ${msg}`);
}

async function bybitRequest(method, endpoint, data = {}) {
    const timestamp = Date.now().toString();
    const baseUrl = IS_TESTNET ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    const params = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
    const sign = crypto.createHmac('sha256', BYBIT_SECRET).update(timestamp + BYBIT_KEY + '5000' + params).digest('hex');
    try {
        const res = await axios({
            method, url: baseUrl + endpoint + (method === 'GET' ? '?' + params : ''),
            headers: { 'X-BAPI-API-KEY': BYBIT_KEY, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': '5000' },
            data: method !== 'GET' ? data : undefined, timeout: 10000
        });
        return res.data;
    } catch (e) { return { error: e.message }; }
}

// BUSCA REGRAS DE PRECISÃO E MÍNIMO DA BYBIT
async function getInstrumentInfo(symbol) {
    const res = await bybitRequest('GET', '/v5/market/instruments-info', { category: 'linear', symbol });
    if (res.retCode === 0 && res.result.list.length > 0) {
        return res.result.list[0];
    }
    return null;
}

async function executeTrade(side, type = 'open') {
    const symbol = MONITOR.symbol;
    const ticker = await bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol });
    const info = await getInstrumentInfo(symbol);
    
    if (!ticker.result || !info) return;

    const price = parseFloat(ticker.result.list[0].lastPrice);
    
    // 1. CÁLCULO DE QUANTIDADE COM PROTEÇÃO DE MÍNIMO
    // Sua banca: 15 USDT | 30% = 4.5 USDT
    let desiredValue = (MONITOR.config.bankPct / 100) * MONITOR.realBalance * MONITOR.config.lev;
    
    // REGRA DE OURO: A Bybit exige mínimo de ~$5.00 para abrir posição.
    // Forçamos 5.50 para ter margem de taxas.
    if (desiredValue < 5.5) desiredValue = 5.5; 

    let qty = desiredValue / price;

    // 2. FORMATAÇÃO SEGUNDO AS REGRAS DA MOEDA (LotSizeFilter)
    const minQty = parseFloat(info.lotSizeFilter.minOrderQty);
    const qtyStep = info.lotSizeFilter.qtyStep;
    
    if (qty < minQty) qty = minQty;

    // Ajusta decimais baseado no qtyStep da Bybit
    const precision = qtyStep.includes('.') ? qtyStep.split('.')[1].length : 0;
    const finalQty = (Math.floor(qty / parseFloat(qtyStep)) * parseFloat(qtyStep)).toFixed(precision);

    const bSide = type === 'open' ? (side === 'LONG' ? 'Buy' : 'Sell') : (side === 'LONG' ? 'Sell' : 'Buy');
    
    if (type === 'open') {
        serverLog(`🚀 ABRINDO ${side} ${symbol} | Valor: $${(parseFloat(finalQty)*price).toFixed(2)} | Qty: ${finalQty}`, 'info');
        // Configura alavancagem antes de abrir
        await bybitRequest('POST', '/v5/position/set-leverage', { 
            category: 'linear', symbol, 
            buyLeverage: MONITOR.config.lev.toString(), 
            sellLeverage: MONITOR.config.lev.toString() 
        });
    }

    const res = await bybitRequest('POST', '/v5/order/create', { 
        category: 'linear', symbol, side: bSide, orderType: 'Market', qty: finalQty, timeInForce: 'GTC',
        reduceOnly: type === 'close'
    });

    if (res.retCode === 0) {
        serverLog(`✅ SUCESSO: ${finalQty} ${symbol}`, 'ok');
        if (type === 'open') {
            MONITOR.position = { side, entry: price, qty: parseFloat(finalQty), peak: price, trailActive: false };
        } else {
            MONITOR.position = null;
            MONITOR.lastCloseTime = Date.now();
        }
    } else {
        serverLog(`❌ BYBIT REJEITOU: ${res.retMsg}`, 'err');
    }
    return res;
}

// ... (Manter serverCycle e outras funções auxiliares da V9.0)
// No serverCycle, quando o gatilho acontecer, chame:
// await executeTrade(side, 'open');

async function serverCycle() {
    if (!MONITOR.active || !MONITOR.symbol) return;
    try {
        // Verifica se posição já existe para não duplicar
        const posRes = await bybitRequest('GET', '/v5/position/list', { category: 'linear', symbol: MONITOR.symbol });
        const realPos = posRes.result?.list?.find(p => parseFloat(p.size) > 0);
        
        if (realPos) {
            if (!MONITOR.position) {
                MONITOR.position = { side: realPos.side === 'Buy' ? 'LONG' : 'SHORT', entry: parseFloat(realPos.avgPrice), qty: parseFloat(realPos.size), peak: parseFloat(realPos.avgPrice), trailActive: false };
                serverLog("📡 Sincronizado com a Bybit.", "ok");
            }
        } else if (MONITOR.position) {
            MONITOR.position = null;
            MONITOR.lastCloseTime = Date.now();
        }

        const [k, t, b] = await Promise.all([
            bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '210' }),
            bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol: MONITOR.symbol }),
            bybitRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' })
        ]);

        if (!k.result || !t.result) return;
        if (b.result) MONITOR.realBalance = parseFloat(b.result.list[0].totalAvailableBalance || 15);

        const price = parseFloat(t.result.list[0].lastPrice);
        const candles = k.result.list.map(i=>({ close:parseFloat(i[4]), vol:parseFloat(i[5]) })).reverse();
        
        // LÓGICA SIMPLIFICADA DE ENTRADA (Substitua pela sua se necessário)
        const volRatio = candles[0].vol / (candles.slice(1, 21).reduce((a,b)=>a+b.vol,0)/20);
        
        if (!MONITOR.position && volRatio > 1.2 && (Date.now() - MONITOR.lastCloseTime > 60000)) {
            if (Date.now() - MONITOR.lastEntryAttempt > 15000) {
                MONITOR.lastEntryAttempt = Date.now();
                await executeTrade('LONG', 'open'); 
            }
        }
    } catch (e) {}
}

setInterval(serverCycle, 10000);
app.listen(PORT, () => console.log(`Scanner v9.1 - Proteção de Banca 15 USDT Ativa`));
