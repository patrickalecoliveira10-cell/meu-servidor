const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
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
    config: { bankPct: 30, partialInPct: 5, partialOutPct: 50, stopPct: 1.5, trailAct: 1.5, trailPull: 0.8, lev: 10 },
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

// --- ARREDONDAMENTO ULTRA-RIGOROSO ---
function roundQty(symbol, qty) {
    const sym = symbol.toUpperCase();
    // Moedas que só aceitam inteiros
    const integerSyms = ['AGLD', 'DOGE', 'SHIB', 'PEPE', '1000PEPE', 'BONK', 'GALA', 'LUNC', 'FLOKI', 'XVG', 'XRP'];
    
    if (integerSyms.some(s => sym.includes(s))) {
        return Math.floor(qty).toString();
    }
    
    // Moedas com precisão específica
    if (sym.includes('BTC')) return qty.toFixed(3);
    if (sym.includes('ETH')) return qty.toFixed(2);
    if (sym.includes('SOL') || sym.includes('LTC') || sym.includes('BNB')) return qty.toFixed(2);
    
    // Padrão para a maioria das altcoins
    return qty.toFixed(1);
}

async function bybitRequest(method, endpoint, data = {}) {
    const timestamp = Date.now().toString();
    const baseUrl = IS_TESTNET ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    const parameters = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
    const sign = crypto.createHmac('sha256', BYBIT_SECRET).update(timestamp + BYBIT_KEY + '5000' + parameters).digest('hex');
    try {
        const res = await axios({
            method, url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: { 'X-BAPI-API-KEY': BYBIT_KEY, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': '5000', 'Content-Type': 'application/json' },
            data: method !== 'GET' ? data : undefined, timeout: 8000
        });
        return res.data;
    } catch (e) { return { error: e.message }; }
}

async function checkActualPosition(symbol) {
    const res = await bybitRequest('GET', '/v5/position/list', { category: 'linear', symbol });
    if (res.result && res.result.list) {
        const pos = res.result.list.find(p => parseFloat(p.size) > 0);
        return pos ? { 
            side: pos.side === 'Buy' ? 'LONG' : 'SHORT', 
            entry: parseFloat(pos.avgPrice), 
            qty: parseFloat(pos.size),
            peak: parseFloat(pos.avgPrice)
        } : null;
    }
    return null;
}

async function executeTrade(side, qty, type = 'open') {
    const symbol = MONITOR.symbol;
    const ticker = await bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol });
    const price = parseFloat(ticker.result.list[0].lastPrice);
    
    let qVal = parseFloat(qty);
    // Garantir valor mínimo de contrato ($7.00) para evitar erros de "qty too small"
    if (qVal * price < 6.5) qVal = 7.0 / price;

    const q = roundQty(symbol, qVal);
    const bSide = type === 'open' ? (side === 'LONG' ? 'Buy' : 'Sell') : (side === 'LONG' ? 'Sell' : 'Buy');
    
    if (type === 'open') {
        serverLog(`🚀 ENVIANDO ORDEM ${side} | Qty: ${q}`, 'info');
        await bybitRequest('POST', '/v5/position/set-leverage', { 
            category: 'linear', symbol, 
            buyLeverage: MONITOR.config.lev.toString(), 
            sellLeverage: MONITOR.config.lev.toString() 
        });
    }

    const res = await bybitRequest('POST', '/v5/order/create', { 
        category: 'linear', symbol, side: bSide, orderType: 'Market', qty: q, timeInForce: 'GTC'
    });

    if (res.retCode !== 0) {
        serverLog(`❌ BYBIT REJEITOU: ${res.retMsg}`, 'err');
    } else {
        serverLog(`✅ ORDEM EXECUTADA: ${q} contratos`, 'ok');
    }
    return res;
}

async function serverCycle() {
    if (!MONITOR.active || !MONITOR.symbol) return;
    try {
        const realPos = await checkActualPosition(MONITOR.symbol);
        if (realPos) {
            if (!MONITOR.position) {
                MONITOR.position = realPos;
                serverLog("📡 Posição detectada e sincronizada.", "ok");
            }
        } else if (MONITOR.position) {
            serverLog("ℹ️ Posição encerrada externamente.", "warn");
            MONITOR.position = null;
            MONITOR.lastCloseTime = Date.now();
        }

        const [k, t, o, b] = await Promise.all([
            bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '210' }),
            bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol: MONITOR.symbol }),
            bybitRequest('GET', '/v5/market/open-interest', { category: 'linear', symbol: MONITOR.symbol, intervalTime: '5min', limit: '2' }),
            bybitRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' })
        ]);

        if (!k.result || !t.result) return;
        if (b.result) MONITOR.realBalance = parseFloat(b.result.list[0].totalAvailableBalance || 15);

        const candles = k.result.list.map(i=>({ high:parseFloat(i[2]), low:parseFloat(i[3]), close:parseFloat(i[4]), vol:parseFloat(i[5]), open:parseFloat(i[1]) })).reverse();
        const price = parseFloat(t.result.list[0].lastPrice);
        const oiGrow = o.result && parseFloat(o.result.list[0].openInterest) > parseFloat(o.result.list[1].openInterest);

        // --- LÓGICA DE SCORE ---
        const closes = candles.map(c => c.close);
        const ema200 = calcEMA(closes, 200);
        const vwap = calcVWAP(candles);
        const volRatio = candles[candles.length-1].vol / (candles.slice(-20).reduce((a,b)=>a+b.vol,0)/20);

        let score = 0; let side = null;
        if (ema200 && vwap) {
            if (price > ema200) { 
                side = 'LONG'; score = 40; 
                if(price > vwap) score += 20; if(oiGrow) score += 25; if(volRatio >= 1.1) score += 15;
            } else if (price < ema200) { 
                side = 'SHORT'; score = 40; 
                if(price < vwap) score += 20; if(oiGrow) score += 25; if(volRatio >= 1.1) score += 15;
            }
        }

        if (MONITOR.position) {
            const pos = MONITOR.position;
            const isLong = pos.side === 'LONG';
            const roi = (isLong ? (price-pos.entry)/pos.entry : (pos.entry-price)/pos.entry) * 100 * MONITOR.config.lev;
            if (isLong && price > pos.peak) pos.peak = price;
            if (!isLong && (price < pos.peak || pos.peak === 0)) pos.peak = price;

            if (roi <= -MONITOR.config.stopPct) { 
                await executeTrade(pos.side, pos.qty, 'close'); 
                MONITOR.position = null; MONITOR.lastCloseTime = Date.now(); 
            } else if (pos.trailActive && (isLong ? (pos.peak-price)/pos.peak : (price-pos.peak)/pos.peak) * 100 * MONITOR.config.lev >= MONITOR.config.trailPull) {
                await executeTrade(pos.side, pos.qty, 'close'); 
                MONITOR.position = null; MONITOR.lastCloseTime = Date.now();
            } else if (!pos.trailActive && roi >= MONITOR.config.trailAct) {
                pos.trailActive = true; serverLog("🎯 TRAILING ATIVADO", "ok");
            }
        } else {
            const trigger = (score >= 70 && volRatio >= 1.1);
            const cooldown = (Date.now() - MONITOR.lastCloseTime < 60000);
            if (trigger && !cooldown && (Date.now() - MONITOR.lastEntryAttempt > 15000)) {
                MONITOR.lastEntryAttempt = Date.now();
                const margin = (MONITOR.config.bankPct / 100) * MONITOR.realBalance * 0.9;
                const qty = (margin * MONITOR.config.lev) / price;
                const res = await executeTrade(side, qty, 'open');
                if (res.retCode === 0) MONITOR.position = { side, entry: price, qty: parseFloat(roundQty(MONITOR.symbol, qty)), peak: price, trailActive: false };
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
    if (position && position.side && !MONITOR.position) MONITOR.position = { ...position, side: position.side.toUpperCase(), peak: position.entry, trailActive: false };
    res.json({ success: true });
});

setInterval(serverCycle, 10000);
app.listen(PORT, () => console.log(`Sniper V8 Master Cloud`));
