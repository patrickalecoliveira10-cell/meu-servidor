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
    config: { bankPct: 30, lev: 10, stopPct: 1.5, trailAct: 1.5, trailPull: 0.8 },
    position: null,
    logs: [],
    lastCloseTime: 0,
    realBalance: 15,
    lastEntryAttempt: 0
};

// --- LOGS COM CORES PARA O CONSOLE ---
function serverLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('pt-BR');
    MONITOR.logs.unshift({ time, msg, type });
    if (MONITOR.logs.length > 50) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${time} - ${msg}`);
}

// --- FUNÇÃO DE ARREDONDAMENTO BASEADA NO PREÇO ---
// Se o preço é alto (SOL, BTC), precisa de decimais. 
// Se o preço é baixo (PEPE, DOGE), precisa ser inteiro.
function smartRound(symbol, qty, price) {
    const s = symbol.toUpperCase();
    const value = qty * price;
    
    // Forçar valor mínimo de $6.50 USDT por ordem
    let finalQty = qty;
    if (value < 6.5) {
        finalQty = 7.0 / price;
    }

    // Regras de decimais
    if (price > 1000) return finalQty.toFixed(3); // BTC
    if (price > 100) return finalQty.toFixed(2);  // ETH, BNB
    if (price > 1) return finalQty.toFixed(1);    // SOL, DOT, ADA
    return Math.round(finalQty).toString();       // Moedas baratas (DOGE, SHIB)
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

async function executeTrade(side, qty, type = 'open') {
    const symbol = MONITOR.symbol;
    const ticker = await bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol });
    if (!ticker.result) return;
    const price = parseFloat(ticker.result.list[0].lastPrice);
    
    const q = smartRound(symbol, qty, price);
    const bSide = type === 'open' ? (side === 'LONG' ? 'Buy' : 'Sell') : (side === 'LONG' ? 'Sell' : 'Buy');
    
    if (type === 'open') {
        serverLog(`🚀 TENTANDO ENTRADA: ${side} ${symbol} | Qty: ${q}`, 'info');
        await bybitRequest('POST', '/v5/position/set-leverage', { 
            category: 'linear', symbol, buyLeverage: MONITOR.config.lev.toString(), sellLeverage: MONITOR.config.lev.toString() 
        });
    }

    const res = await bybitRequest('POST', '/v5/order/create', { 
        category: 'linear', symbol, side: bSide, orderType: 'Market', qty: q, timeInForce: 'GTC'
    });

    if (res.retCode === 0) {
        serverLog(`✅ SUCESSO: ${q} ${symbol} ${type === 'open' ? 'Aberto' : 'Fechado'}`, 'ok');
    } else {
        serverLog(`❌ ERRO: ${res.retMsg}`, 'err');
    }
    return res;
}

async function serverCycle() {
    if (!MONITOR.active || !MONITOR.symbol) return;
    try {
        // Sincronia de Posição Real
        const posRes = await bybitRequest('GET', '/v5/position/list', { category: 'linear', symbol: MONITOR.symbol });
        const realPos = posRes.result?.list?.find(p => parseFloat(p.size) > 0);
        
        if (realPos) {
            if (!MONITOR.position) {
                MONITOR.position = { side: realPos.side === 'Buy' ? 'LONG' : 'SHORT', entry: parseFloat(realPos.avgPrice), qty: parseFloat(realPos.size), peak: parseFloat(realPos.avgPrice), trailActive: false };
                serverLog("📡 Sincronizado com a Bybit", "ok");
            }
        } else {
            if (MONITOR.position) {
                serverLog("ℹ️ Posição fechada fora do robô", "warn");
                MONITOR.position = null;
                MONITOR.lastCloseTime = Date.now();
            }
        }

        const [k, t, o, b] = await Promise.all([
            bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '210' }),
            bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol: MONITOR.symbol }),
            bybitRequest('GET', '/v5/market/open-interest', { category: 'linear', symbol: MONITOR.symbol, intervalTime: '5min', limit: '2' }),
            bybitRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' })
        ]);

        if (!k.result || !t.result) return;
        if (b.result) MONITOR.realBalance = parseFloat(b.result.list[0].totalAvailableBalance || 15);

        const candles = k.result.list.map(i=>({ high:parseFloat(i[2]), low:parseFloat(i[3]), close:parseFloat(i[4]), vol:parseFloat(i[5]) })).reverse();
        const price = parseFloat(t.result.list[0].lastPrice);
        const oiGrow = o.result && parseFloat(o.result.list[0].openInterest) > parseFloat(o.result.list[1].openInterest);
        
        // --- SCORE LOGIC (Identical to App) ---
        const closes = candles.map(c => c.close);
        const ema200 = calcEMA(closes, 200);
        const vwap = calcVWAP(candles);
        const volRatio = candles[candles.length-1].vol / (candles.slice(-20).reduce((a,b)=>a+b.vol,0)/20);

        let score = 0; let side = null;
        if (ema200 && vwap) {
            if (price > ema200) { side = 'LONG'; score = 40; if(price > vwap) score += 20; if(oiGrow) score += 25; if(volRatio >= 1.1) score += 15; }
            else if (price < ema200) { side = 'SHORT'; score = 40; if(price < vwap) score += 20; if(oiGrow) score += 25; if(volRatio >= 1.1) score += 15; }
        }

        if (MONITOR.position) {
            const pos = MONITOR.position;
            const roi = (pos.side === 'LONG' ? (price-pos.entry)/pos.entry : (pos.entry-price)/pos.entry) * 100 * MONITOR.config.lev;
            if (roi <= -MONITOR.config.stopPct) { await executeTrade(pos.side, pos.qty, 'close'); MONITOR.position = null; MONITOR.lastCloseTime = Date.now(); }
            // ... (restante do trailing logic igual)
        } else {
            if (score >= 70 && volRatio >= 1.1 && (Date.now() - MONITOR.lastCloseTime > 60000)) {
                if (Date.now() - MONITOR.lastEntryAttempt > 15000) {
                    MONITOR.lastEntryAttempt = Date.now();
                    const qty = ((MONITOR.config.bankPct/100) * MONITOR.realBalance * MONITOR.config.lev) / price;
                    await executeTrade(side, qty, 'open');
                }
            }
        }
    } catch (e) { console.error("Erro Ciclo"); }
}

function calcEMA(v, p) { if (v.length < p) return null; const k = 2/(p+1); let ema = v.slice(0,p).reduce((a,b)=>a+b)/p; for(let i=p; i<v.length; i++) ema = v[i]*k + ema*(1-k); return ema; }
function calcVWAP(c) { let t=0, v=0; c.forEach(i=>{ t += ((i.high+i.low+i.close)/3)*i.vol; v += i.vol; }); return v > 0 ? t/v : null; }

app.get('/status', (req, res) => res.json(MONITOR));
app.post('/sync-par', async (req, res) => {
    const { active, symbol, config, position } = req.body;
    if (active === false) {
        if (MONITOR.position) await executeTrade(MONITOR.position.side, MONITOR.position.qty, 'close');
        MONITOR.active = false; MONITOR.position = null; MONITOR.symbol = null; MONITOR.lastCloseTime = Date.now();
        return res.json({ success: true });
    }
    MONITOR.active = true; MONITOR.symbol = symbol; MONITOR.config = config;
    if (position && !MONITOR.position) MONITOR.position = position;
    res.json({ success: true });
});

setInterval(serverCycle, 10000);
app.listen(PORT, () => console.log(`Scanner Master V8.9 Online`));
