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

// --- ESTADO COM SUAS CONFIGURAÇÕES EXATAS ---
let MONITOR = {
    active: false,
    symbol: null,
    config: { 
        bankPct: 30,        // Sua config: 30% da banca
        partialInPct: 5,    // Sua config: 5% aporte
        partialOutPct: 50,  // Sua config: 50% saída parcial
        stopPct: 1.5,       // Sua config: 1.5% ROI
        trailAct: 1.5,      // Sua config: 1.5% Ativação
        trailPull: 0.8,     // Sua config: 0.8% Recuo
        lev: 10             // Alavancagem padrão (ajustável pelo app)
    },
    position: null,
    logs: [],
    lastErrorAt: 0,
    realBalance: 15 // Inicia com seu saldo atual
};

function serverLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('pt-BR');
    MONITOR.logs.unshift({ time, msg, type });
    if (MONITOR.logs.length > 40) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${time} - ${msg}`);
}

// ARREDONDAMENTO RIGOROSO PARA AGLD E OUTRAS
function roundQty(symbol, qty) {
    const integerSyms = ['AGLD', 'DOGE', 'SHIB', 'PEPE', '1000PEPE', 'BONK', 'GALA', 'LUNC', 'FLOKI', 'XVG'];
    if (integerSyms.some(s => symbol.includes(s))) return Math.floor(qty).toString();
    if (symbol.includes('BTC')) return qty.toFixed(3);
    if (symbol.includes('ETH')) return qty.toFixed(2);
    return qty.toFixed(1);
}

async function bybitRequest(method, endpoint, data = {}) {
    const timestamp = Date.now().toString();
    const baseUrl = IS_TESTNET ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    const parameters = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
    const sign = crypto.createHmac('sha256', BYBIT_SECRET).update(timestamp + BYBIT_KEY + '5000' + parameters).digest('hex');

    try {
        const res = await axios({
            method,
            url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: { 'X-BAPI-API-KEY': BYBIT_KEY, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': '5000', 'Content-Type': 'application/json' },
            data: method !== 'GET' ? data : undefined,
            timeout: 8000
        });
        return res.data;
    } catch (e) { return { error: e.message }; }
}

async function updateBalance() {
    try {
        let res = await bybitRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
        if (res.result && res.result.list && res.result.list[0]) {
            MONITOR.realBalance = parseFloat(res.result.list[0].totalAvailableBalance || 0);
        } else {
            res = await bybitRequest('GET', '/v5/account/wallet-balance', { accountType: 'CONTRACT', coin: 'USDT' });
            if (res.result && res.result.list[0]) MONITOR.realBalance = parseFloat(res.result.list[0].coin[0].availableToWithdraw || 0);
        }
    } catch (e) { console.error("Erro Balance"); }
}

async function executeTrade(side, qty, type = 'open') {
    const symbol = MONITOR.symbol;
    let qVal = parseFloat(qty);
    
    // Filtro de segurança: Se a quantidade for muito pequena, a Bybit rejeita.
    // Garantimos um mínimo de $5 de valor total de contrato (ajuste se necessário)
    const priceRes = await bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol });
    const price = parseFloat(priceRes.result.list[0].lastPrice);
    if (qVal * price < 5) qVal = 5.1 / price;

    const q = roundQty(symbol, qVal);
    const bybitSide = type === 'open' ? (side === 'LONG' ? 'Buy' : 'Sell') : (side === 'LONG' ? 'Sell' : 'Buy');

    if (type === 'open') {
        serverLog(`🔥 [NUVEM] Ordem ${side} | Qty: ${q}`, 'warn');
        await bybitRequest('POST', '/v5/position/set-leverage', {
            category: 'linear', symbol, 
            buyLeverage: MONITOR.config.lev.toString(), 
            sellLeverage: MONITOR.config.lev.toString()
        });
    }

    const res = await bybitRequest('POST', '/v5/order/create', {
        category: 'linear', symbol, side: bybitSide, orderType: 'Market', qty: q, timeInForce: 'GTC'
    });

    if (res.retCode !== 0) {
        serverLog(`❌ Erro: ${res.retMsg}`, 'err');
        if (res.retMsg.includes("enough")) MONITOR.lastErrorAt = Date.now();
    }
    return res;
}

// --- LÓGICA DE INDICADORES ---
function calcEMA(v, p) { 
    if (v.length < p) return null; 
    const k = 2/(p+1); 
    let ema = v.slice(0,p).reduce((a,b)=>a+b)/p;
    for(let i=p; i<v.length; i++) ema = v[i]*k + ema*(1-k);
    return ema;
}
function calcVWAP(c) {
    let t=0, v=0;
    c.forEach(i=>{ t += ((i.high+i.low+i.close)/3)*i.vol; v += i.vol; });
    return v > 0 ? t/v : null;
}

async function serverCycle() {
    if (!MONITOR.active || !MONITOR.symbol) return;
    if (Date.now() - MONITOR.lastErrorAt < 15000) return;

    try {
        await updateBalance();
        const [kline, tickers, oiData] = await Promise.all([
            bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '210' }),
            bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol: MONITOR.symbol }),
            bybitRequest('GET', '/v5/market/open-interest', { category: 'linear', symbol: MONITOR.symbol, intervalTime: '5min', limit: '2' })
        ]);

        if (!kline.result || !tickers.result) return;
        const candles = kline.result.list.map(k=>({ high:parseFloat(k[2]), low:parseFloat(k[3]), close:parseFloat(k[4]), vol:parseFloat(k[5]) })).reverse();
        const price = parseFloat(tickers.result.list[0].lastPrice);
        const ema200 = calcEMA(candles.map(c=>c.close), 200);
        const vwap = calcVWAP(candles);
        const volRatio = candles[candles.length-1].vol / (candles.slice(-20).reduce((a,b)=>a+b.vol,0)/20);
        const oiGrowing = oiData.result && parseFloat(oiData.result.list[0].openInterest) > parseFloat(oiData.result.list[1].openInterest);

        const longTrig = (price > ema200 && price > vwap && volRatio >= 1.1 && oiGrowing);
        const shortTrig = (price < ema200 && price < vwap && volRatio >= 1.1 && oiGrowing);

        if (MONITOR.position) {
            const pos = MONITOR.position;
            const isLong = pos.side === 'LONG';
            const roi = (isLong ? (price-pos.entry)/pos.entry : (pos.entry-price)/pos.entry) * 100 * MONITOR.config.lev;

            if (isLong && price > pos.peak) pos.peak = price;
            if (!isLong && (price < pos.peak || pos.peak === 0)) pos.peak = price;

            // VIRADA (FLIP)
            if (roi < 0 && (isLong ? shortTrig : longTrig)) {
                serverLog("🔄 VIRADA DE MÃO (FLIP)", "warn");
                await executeTrade(pos.side, pos.qty, 'close');
                const res = await executeTrade(isLong ? 'SHORT' : 'LONG', pos.qty, 'open');
                if (res.retCode === 0) MONITOR.position = { side: isLong?'SHORT':'LONG', entry: price, qty: pos.qty, peak: price, trailActive: false, partialIn: 0 };
                return;
            }

            // STOP LOSS
            if (roi <= -MONITOR.config.stopPct) {
                serverLog("🔴 STOP LOSS", "err");
                await executeTrade(pos.side, pos.qty, 'close');
                MONITOR.position = null; return;
            }

            // APORTE (5%)
            if (roi > 0.4 && (isLong ? longTrig : shortTrig) && (pos.partialIn || 0) < 2) {
                const addMargin = (MONITOR.config.partialInPct/100) * MONITOR.realBalance * 0.85;
                const addQty = (addMargin * MONITOR.config.lev) / price;
                const res = await executeTrade(pos.side, addQty, 'open');
                if (res.retCode === 0) { pos.qty = parseFloat(pos.qty) + addQty; pos.partialIn = (pos.partialIn||0)+1; }
            }

            // SEGURANÇA NO LUCRO
            if (roi > 0 && !pos.trailActive && (isLong ? shortTrig : longTrig)) {
                serverLog("💰 SEGURANÇA", "ok");
                await executeTrade(pos.side, pos.qty, 'close');
                MONITOR.position = null; return;
            }

            // TRAILING
            if (!pos.trailActive && roi >= MONITOR.config.trailAct) { pos.trailActive = true; serverLog("🎯 Trailing Ativado", "ok"); }
            
            if (pos.trailActive) {
                if (isLong ? shortTrig : longTrig) {
                    if (!pos.partialOutDone) {
                        const outQty = pos.qty * (MONITOR.config.partialOutPct / 100);
                        serverLog(`📤 PARCIAL (${MONITOR.config.partialOutPct}%)`, "info");
                        const res = await executeTrade(pos.side, outQty, 'close');
                        if (res.retCode === 0) { pos.qty -= outQty; pos.partialOutDone = true; }
                    } else {
                        serverLog("🏁 FECHAMENTO", "ok");
                        await executeTrade(pos.side, pos.qty, 'close');
                        MONITOR.position = null; return;
                    }
                }
                const recuo = (isLong ? (pos.peak - price)/pos.peak : (price - pos.peak)/pos.peak) * 100 * MONITOR.config.lev;
                if (recuo >= MONITOR.config.trailPull) {
                    serverLog("🏁 Recuo batido", "ok");
                    await executeTrade(pos.side, pos.qty, 'close');
                    MONITOR.position = null;
                }
            }
        } 
        else if (longTrig ^ shortTrig) {
            const side = longTrig ? 'LONG' : 'SHORT';
            // Cálculo com margem de segurança para saldo de 15 USDT
            const marginUsdt = (MONITOR.config.bankPct / 100) * MONITOR.realBalance * 0.85;
            if (marginUsdt < 1) return;
            
            const qty = (marginUsdt * MONITOR.config.lev) / price;
            const res = await executeTrade(side, qty, 'open');
            if (res.retCode === 0) MONITOR.position = { side, entry: price, qty, peak: price, trailActive: false, partialIn: 0 };
        }
    } catch (e) { console.error("Erro ciclo"); }
}

app.get('/status', (req, res) => res.json(MONITOR));
app.post('/sync-par', async (req, res) => {
    const { symbol, active, config, position } = req.body;
    if (active === false) {
        if (MONITOR.position) await executeTrade(MONITOR.position.side, MONITOR.position.qty, 'close');
        MONITOR.active = false; MONITOR.position = null;
        return res.json({ success: true });
    }
    MONITOR.active = true; MONITOR.symbol = symbol; MONITOR.config = config;
    if (position && position.side && !MONITOR.position) {
        MONITOR.position = { ...position, side: position.side.toUpperCase(), partialIn: 0 };
    }
    res.json({ success: true });
});

setInterval(serverCycle, 10000);
app.listen(PORT, () => console.log(`Sniper V8 Cloud - Saldo: ${MONITOR.realBalance} USDT`));
