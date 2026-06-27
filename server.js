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

async function getInstrumentInfo(symbol) {
    const res = await bybitRequest('GET', '/v5/market/instruments-info', { category: 'linear', symbol });
    if (res.retCode === 0 && res.result.list.length > 0) return res.result.list[0];
    return null;
}

async function executeTrade(side, type = 'open') {
    const symbol = MONITOR.symbol;
    const ticker = await bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol });
    const info = await getInstrumentInfo(symbol);
    if (!ticker.result || !info) return;

    const price = parseFloat(ticker.result.list[0].lastPrice);
    let desiredValue = (MONITOR.config.bankPct / 100) * MONITOR.realBalance * MONITOR.config.lev;
    if (desiredValue < 5.5) desiredValue = 5.5; 

    let qty = desiredValue / price;
    const minQty = parseFloat(info.lotSizeFilter.minOrderQty);
    const qtyStep = info.lotSizeFilter.qtyStep;
    if (qty < minQty) qty = minQty;

    const precision = qtyStep.includes('.') ? qtyStep.split('.')[1].length : 0;
    const finalQty = (Math.floor(qty / parseFloat(qtyStep)) * parseFloat(qtyStep)).toFixed(precision);
    const bSide = type === 'open' ? (side === 'LONG' ? 'Buy' : 'Sell') : (side === 'LONG' ? 'Sell' : 'Buy');
    
    if (type === 'open') {
        serverLog(`🚀 ABRINDO ${side} | Valor: $${(parseFloat(finalQty)*price).toFixed(2)}`, 'info');
        await bybitRequest('POST', '/v5/position/set-leverage', { category: 'linear', symbol, buyLeverage: MONITOR.config.lev.toString(), sellLeverage: MONITOR.config.lev.toString() });
    }

    const res = await bybitRequest('POST', '/v5/order/create', { 
        category: 'linear', symbol, side: bSide, orderType: 'Market', qty: finalQty, timeInForce: 'GTC', reduceOnly: type === 'close'
    });

    if (res.retCode === 0) {
        serverLog(`✅ ORDEM EXECUTADA: ${finalQty} ${symbol}`, 'ok');
        if (type === 'open') MONITOR.position = { side, entry: price, qty: parseFloat(finalQty), peak: price, trailActive: false };
        else { MONITOR.position = null; MONITOR.lastCloseTime = Date.now(); }
    } else {
        serverLog(`❌ ERRO BYBIT: ${res.retMsg}`, 'err');
    }
    return res;
}

// LÓGICA DE INDICADORES (Sincronizada com App)
function calcEMA(v, p) { if (v.length < p) return null; const k = 2/(p+1); let ema = v.slice(0,p).reduce((a,b)=>a+b)/p; for(let i=p; i<v.length; i++) ema = v[i]*k + ema*(1-k); return ema; }
function calcVWAP(c) { let t=0, v=0; c.forEach(i=>{ t += ((i.high+i.low+i.close)/3)*i.vol; v += i.vol; }); return v > 0 ? t/v : null; }

async function serverCycle() {
    if (!MONITOR.active || !MONITOR.symbol) return;
    try {
        const posRes = await bybitRequest('GET', '/v5/position/list', { category: 'linear', symbol: MONITOR.symbol });
        const realPos = posRes.result?.list?.find(p => parseFloat(p.size) > 0);
        if (realPos) {
            if (!MONITOR.position) {
                MONITOR.position = { side: realPos.side === 'Buy' ? 'LONG' : 'SHORT', entry: parseFloat(realPos.avgPrice), qty: parseFloat(realPos.size), peak: parseFloat(realPos.avgPrice), trailActive: false };
                serverLog("📡 Sincronizado com Bybit", "ok");
            }
        } else if (MONITOR.position) {
            MONITOR.position = null; MONITOR.lastCloseTime = Date.now();
        }

        const [k, t, o, b] = await Promise.all([
            bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '210' }),
            bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol: MONITOR.symbol }),
            bybitRequest('GET', '/v5/market/open-interest', { category: 'linear', symbol: MONITOR.symbol, intervalTime: '5min', limit: '2' }),
            bybitRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' })
        ]);

        if (b.result) MONITOR.realBalance = parseFloat(b.result.list[0].totalAvailableBalance || 15);
        if (!k.result || !t.result) return;

        const price = parseFloat(t.result.list[0].lastPrice);
        const candles = k.result.list.map(i=>({ high:parseFloat(i[2]), low:parseFloat(i[3]), close:parseFloat(i[4]), vol:parseFloat(i[5]) })).reverse();
        const oiGrow = o.result && parseFloat(o.result.list[0].openInterest) > parseFloat(o.result.list[1].openInterest);

        const closes = candles.map(c => c.close);
        const ema200 = calcEMA(closes, 200);
        const vwap = calcVWAP(candles);
        const volRatio = candles[0].vol / (candles.slice(1, 21).reduce((a,b)=>a+b.vol,0)/20);

        let score = 0, side = null;
        if (ema200 && vwap) {
            if (price > ema200) { side = 'LONG'; score = 40; if(price > vwap) score += 20; if(oiGrow) score += 25; if(volRatio >= 1.1) score += 15; }
            else { side = 'SHORT'; score = 40; if(price < vwap) score += 20; if(oiGrow) score += 25; if(volRatio >= 1.1) score += 15; }
        }

        if (MONITOR.position) {
            const pos = MONITOR.position;
            const isLong = pos.side === 'LONG';
            const roi = (isLong ? (price-pos.entry)/pos.entry : (pos.entry-price)/pos.entry) * 100 * MONITOR.config.lev;
            if (isLong && price > pos.peak) pos.peak = price;
            if (!isLong && price < pos.peak) pos.peak = price;

            if (roi <= -MONITOR.config.stopPct) await executeTrade(pos.side, 'close');
            else if (pos.trailActive) {
                const pull = (isLong ? (pos.peak-price)/pos.peak : (price-pos.peak)/pos.peak) * 100 * MONITOR.config.lev;
                if (pull >= MONITOR.config.trailPull) await executeTrade(pos.side, 'close');
            } else if (roi >= MONITOR.config.trailAct) { pos.trailActive = true; serverLog("🎯 TRAILING ATIVADO", "ok"); }
        } else if (score >= 70 && volRatio >= 1.1 && Date.now() - MONITOR.lastCloseTime > 60000) {
            if (Date.now() - MONITOR.lastEntryAttempt > 15000) {
                MONITOR.lastEntryAttempt = Date.now();
                await executeTrade(side, 'open');
            }
        }
    } catch (e) { console.error("Erro Ciclo"); }
}

// ROTAS ESSENCIAIS (O QUE ESTAVA DANDO 404)
app.get('/status', (req, res) => res.json(MONITOR));
app.post('/sync-par', async (req, res) => {
    const { active, symbol, config, position } = req.body;
    if (active === false) {
        if (MONITOR.position) await executeTrade(MONITOR.position.side, 'close');
        MONITOR.active = false; MONITOR.position = null; MONITOR.symbol = null;
        return res.json({ success: true });
    }
    MONITOR.active = true; MONITOR.symbol = symbol; MONITOR.config = config;
    if (position && !MONITOR.position) MONITOR.position = { ...position, side: position.side.toUpperCase() };
    res.json({ success: true });
});

setInterval(serverCycle, 10000);
app.listen(PORT, () => console.log(`Servidor Ativo na porta ${PORT}`));
