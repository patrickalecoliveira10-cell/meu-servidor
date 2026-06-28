const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Estado Global do Monitor (Persistente no Render)
let MONITOR = {
    active: false,
    symbol: null,
    config: { 
        stopPct: 2.5, 
        trailAct: 2.0, 
        trailPull: 1.0, 
        lev: 5, 
        orderQty: 0.1 // Quantidade padrão inicial (será validada pela API)
    }, 
    position: null, // { side, entry, qty, peak, trailActive, partialCount, partialExitDone, lastAportePrice }
    indicators: { scoreL: 0, scoreS: 0, volRatio: 0, price: 0 },
    logs: []
};

// Funções de Log
function addLog(msg, type = 'info') {
    const ts = new Date().toLocaleTimeString('pt-BR');
    const logEntry = { time: Date.now(), msg: `[${ts}] ${msg}`, type };
    MONITOR.logs.unshift(logEntry);
    if (MONITOR.logs.length > 50) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// Requisição Assinada V5 Bybit
async function bybitRequest(method, endpoint, data = {}) {
    const key = process.env.BYBIT_API_KEY;
    const secret = process.env.BYBIT_API_SECRET;
    const timestamp = Date.now().toString();
    const baseUrl = process.env.USE_TESTNET === 'true' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';

    let parameters = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
    const sign = crypto.createHmac('sha256', secret).update(timestamp + key + '5000' + parameters).digest('hex');

    try {
        const res = await axios({
            method,
            url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: {
                'X-BAPI-API-KEY': key,
                'X-BAPI-SIGN': sign,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': '5000'
            },
            data: method !== 'GET' ? data : undefined,
            timeout: 8000
        });
        return res.data;
    } catch (e) {
        return { error: e.message };
    }
}

// Função de Execução Real com Validação de Lote Mínimo
async function placeOrder(side, qty, isReduce = false) {
    if (!MONITOR.symbol) return false;
    
    let finalQty = qty;

    // Validação de Lote Mínimo e Step Size (Evita erro de contratos)
    if (!isReduce) {
        try {
            const info = await bybitRequest('GET', '/v5/market/instruments-info', { category: 'linear', symbol: MONITOR.symbol });
            if (info.result && info.result.list && info.result.list[0]) {
                const limits = info.result.list[0].lotSizeFilter;
                const minQty = parseFloat(limits.minOrderQty);
                const step = parseFloat(limits.qtyStep);
                
                if (finalQty < minQty) finalQty = minQty;
                
                // Ajusta precisão decimal conforme a Bybit exige
                const precision = Math.max(0, Math.round(-Math.log10(step)));
                finalQty = parseFloat(finalQty.toFixed(precision));
            }
        } catch (e) {
            console.error("Erro ao validar lotes:", e);
        }
    } else {
        // Para fechamento, arredondamos levemente para evitar erros de precisão
        finalQty = parseFloat(qty.toFixed(4));
    }
    
    const bybitSide = side.toLowerCase() === 'long' ? 'Buy' : 'Sell';
    const orderData = {
        category: "linear",
        symbol: MONITOR.symbol,
        side: bybitSide,
        orderType: "Market",
        qty: finalQty.toString(),
        timeInForce: "GTC",
        reduceOnly: isReduce
    };

    addLog(`📡 Enviando ${bybitSide} ${finalQty} em ${MONITOR.symbol}`, 'info');
    const res = await bybitRequest('POST', '/v5/order/create', orderData);
    
    if (res.retCode === 0) {
        addLog(`✅ Sucesso na Bybit: ${res.result.orderId}`, 'ok');
        return true;
    } else {
        addLog(`❌ Erro Bybit: ${res.retMsg}`, 'err');
        return false;
    }
}

// Motor de Scoring e Matemática
function calcEMA(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
    return ema;
}

async function engineScoring() {
    if (!MONITOR.symbol) return null;
    const kRes = await bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '201' });
    if (!kRes.result || !kRes.result.list) return null;

    const list = kRes.result.list.reverse();
    const prices = list.map(k => parseFloat(k[4]));
    const curP = prices[prices.length - 1];

    // 1. EMA 200 (40%)
    const ema200 = calcEMA(prices, 200);
    let sL = (curP > ema200) ? 40 : 0;
    let sS = (curP < ema200) ? 40 : 0;

    // 2. VWAP Simples (30%)
    let vSum = 0, volSum = 0;
    list.slice(-50).forEach(k => {
        const p = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
        const v = parseFloat(k[5]);
        vSum += p * v; volSum += v;
    });
    const vwap = volSum > 0 ? vSum / volSum : curP;
    sL += (curP > vwap) ? 30 : 0;
    sS += (curP < vwap) ? 30 : 0;

    // 3. Open Interest Trend (30%)
    const oiRes = await bybitRequest('GET', '/v5/market/open-interest', { category: 'linear', symbol: MONITOR.symbol, intervalTime: '5min', limit: '2' });
    if (oiRes.result && oiRes.result.list.length >= 2) {
        const growing = parseFloat(oiRes.result.list[0].openInterest) > parseFloat(oiRes.result.list[1].openInterest);
        if (growing) {
            if (curP > prices[prices.length - 2]) sL += 30;
            else if (curP < prices[prices.length - 2]) sS += 30;
        }
    }

    const avgVol = list.slice(-20).reduce((a, b) => a + parseFloat(b[5]), 0) / 20;
    const vRat = parseFloat(list[list.length - 1][5]) / avgVol;

    MONITOR.indicators = { scoreL: sL, scoreS: sS, volRatio: vRat, price: curP };
    return MONITOR.indicators;
}

// Loop Principal V9.5
setInterval(async () => {
    if (!MONITOR.active || !MONITOR.symbol) return;
    const data = await engineScoring();
    if (!data) return;

    const { scoreL, scoreS, volRatio, price } = data;
    const longTrig = scoreL >= 70 && volRatio >= 1.1;
    const shortTrig = scoreS >= 70 && volRatio >= 1.1;

    // --- ENTRADA ---
    if (!MONITOR.position) {
        if (longTrig && shortTrig) return; // Conflito
        if (longTrig) {
            const ok = await placeOrder('long', MONITOR.config.orderQty);
            if (ok) MONITOR.position = { side: 'long', entry: price, qty: MONITOR.config.orderQty, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price };
        } else if (shortTrig) {
            const ok = await placeOrder('short', MONITOR.config.orderQty);
            if (ok) MONITOR.position = { side: 'short', entry: price, qty: MONITOR.config.orderQty, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price };
        }
        return;
    }

    const pos = MONITOR.position;
    const isL = pos.side === 'long';
    const roi = (isL ? (price - pos.entry) / pos.entry : (pos.entry - price) / pos.entry) * 100 * (MONITOR.config.lev || 5);
    const contrary = isL ? shortTrig : longTrig;
    const favor = isL ? longTrig : shortTrig;

    // 1. STOP LOSS FÍSICO
    if (roi <= -MONITOR.config.stopPct) {
        addLog(`❌ STOP LOSS ATINGIDO: ${roi.toFixed(2)}%`, 'err');
        await placeOrder(isL ? 'short' : 'long', pos.qty, true);
        MONITOR.position = null;
        return;
    }

    // 2. VIRADA (FLIP) - PRIORIDADE
    if (roi < 0 && contrary) {
        addLog(`🔄 VIRADA (FLIP): Revertendo posição...`, 'warn');
        await placeOrder(isL ? 'short' : 'long', pos.qty, true);
        const newSide = isL ? 'short' : 'long';
        const ok = await placeOrder(newSide, MONITOR.config.orderQty);
        if (ok) MONITOR.position = { side: newSide, entry: price, qty: MONITOR.config.orderQty, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price };
        return;
    }

    // 3. FECHAMENTO SEGURANÇA (Lucro + Contrário)
    if (roi > 0 && !pos.trailActive && contrary) {
        addLog(`💰 SEGURANÇA: Fechando lucro antes do trailing por sinal contrário.`, 'ok');
        await placeOrder(isL ? 'short' : 'long', pos.qty, true);
        MONITOR.position = null;
        return;
    }

    // 4. APORTES (SCALE-IN) - MÁX 2
    if (roi > 0.5 && favor && pos.partialCount < 2) {
        const dist = Math.abs(price - pos.lastAportePrice) / pos.lastAportePrice * 100;
        if (dist >= 0.3) {
            const aporteQty = MONITOR.config.orderQty * 0.5;
            const ok = await placeOrder(pos.side, aporteQty);
            if (ok) {
                pos.partialCount++;
                pos.qty += aporteQty;
                pos.lastAportePrice = price;
                addLog(`📥 APORTE #${pos.partialCount} EXECUTADO`, 'info');
            }
        }
    }

    // 5. GESTÃO DE TRAILING
    if (!pos.trailActive && roi >= MONITOR.config.trailAct) {
        pos.trailActive = true;
        addLog(`🎯 TRAILING ATIVADO`, 'ok');
    }

    if (pos.trailActive) {
        if (contrary) {
            if (!pos.partialExitDone) {
                const exitQty = pos.qty * 0.5;
                const ok = await placeOrder(isL ? 'short' : 'long', exitQty, true);
                if (ok) {
                    pos.qty -= exitQty;
                    pos.partialExitDone = true;
                    addLog(`📤 TRAILING: Saída parcial 50%`, 'info');
                }
            } else {
                addLog(`🏁 TRAILING: Fechamento final por sinal contrário`, 'ok');
                await placeOrder(isL ? 'short' : 'long', pos.qty, true);
                MONITOR.position = null;
                return;
            }
        }
        
        if (isL && price > pos.peak) pos.peak = price;
        if (!isL && price < pos.peak) pos.peak = price;
        const pb = isL ? (pos.peak - price) / pos.peak * 100 : (price - pos.peak) / pos.peak * 100;

        if (pb * (MONITOR.config.lev || 5) >= MONITOR.config.trailPull) {
            addLog(`🏁 TRAILING STOP BATIDO`, 'ok');
            await placeOrder(isL ? 'short' : 'long', pos.qty, true);
            MONITOR.position = null;
        }
    }
}, 5000);

// Endpoints API
app.get('/status', (req, res) => res.json(MONITOR));
app.get('/heartbeat', (req, res) => res.send('OK'));

app.post('/sync-par', (req, res) => {
    const { symbol, active, config, forceEntry } = req.body;
    if (active) {
        MONITOR.active = true;
        MONITOR.symbol = symbol || MONITOR.symbol;
        if (config) {
            MONITOR.config = { ...MONITOR.config, ...config };
            // Garante que orderQty não seja zero
            if (!MONITOR.config.orderQty) MONITOR.config.orderQty = 0.1;
        }
        if (forceEntry) {
            placeOrder(forceEntry.side, MONITOR.config.orderQty).then(ok => {
                if(ok) MONITOR.position = { side: forceEntry.side.toLowerCase(), entry: MONITOR.indicators.price, qty: MONITOR.config.orderQty, peak: 0, trailActive: false, partialCount: 0, lastAportePrice: 0 };
            });
        }
    } else {
        MONITOR.active = false;
    }
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Scanner Pro v9.5 REAL-TRADE Online na porta ${PORT}`));
