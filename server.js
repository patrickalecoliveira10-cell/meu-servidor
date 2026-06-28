const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const genAI = process.env.GEMINI_KEY ? new GoogleGenerativeAI(process.env.GEMINI_KEY) : null;

// Configurações de Pesos v9.5
const CONFIG_V9 = {
    scoring: { emaWeight: 40, vwapWeight: 30, oiWeight: 30 },
    leverage: 5
};

let MONITOR = {
    active: false,
    symbol: null,
    config: { stopPct: 2.5, trailAct: 2, trailPull: 1, lev: 5 },
    position: null, // { side, entry, qty, peak, trailActive, partialCount, partialExitDone }
    indicators: { scoreL: 0, scoreS: 0, volRatio: 0 },
    logs: [],
    lastUpdate: null
};

// Funções de Utilidade
function addLog(msg, type = 'info') {
    const ts = new Date().toLocaleTimeString('pt-BR');
    const logEntry = { time: Date.now(), msg: `[${ts}] ${msg}`, type };
    MONITOR.logs.unshift(logEntry);
    if (MONITOR.logs.length > 50) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

async function bybitRequest(method, endpoint, data = {}) {
    const key = process.env.BYBIT_KEY;
    const secret = process.env.BYBIT_SECRET;
    const timestamp = Date.now().toString();
    const baseUrl = process.env.USE_TESTNET === 'true' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    
    let parameters = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
    const sign = crypto.createHmac('sha256', secret).update(timestamp + key + '5000' + parameters).digest('hex');
    
    try {
        const res = await axios({
            method,
            url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: { 'X-BAPI-API-KEY': key, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': '5000' },
            data: method !== 'GET' ? data : undefined,
            timeout: 10000
        });
        return res.data;
    } catch (e) { return { error: e.message }; }
}

// Cálculos Técnicos
function calculateEMA(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
    return ema;
}

// Motor de Scoring 40/30/30
async function updateScoring() {
    if (!MONITOR.symbol) return null;
    
    const kRes = await bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '201' });
    if (!kRes.result || !kRes.result.list) return null;

    const list = kRes.result.list.reverse();
    const prices = list.map(k => parseFloat(k[4]));
    const volumes = list.map(k => parseFloat(k[5]));
    const price = prices[prices.length - 1];

    // 1. EMA 200 (40%)
    const ema200 = calculateEMA(prices, 200);
    
    // 2. VWAP Simples (30%) - Média ponderada das últimas 50 velas
    let vwapSum = 0, volSum = 0;
    list.slice(-50).forEach(k => {
        const p = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
        const v = parseFloat(k[5]);
        vwapSum += p * v; volSum += v;
    });
    const vwap = volSum > 0 ? vwapSum / volSum : price;

    // 3. Open Interest Trend (30%)
    const oiRes = await bybitRequest('GET', '/v5/market/open-interest', { category: 'linear', symbol: MONITOR.symbol, intervalTime: '5min', limit: '2' });
    let oiGrowing = false;
    if (oiRes.result && oiRes.result.list.length >= 2) {
        oiGrowing = parseFloat(oiRes.result.list[0].openInterest) > parseFloat(oiRes.result.list[1].openInterest);
    }

    // 4. Volume Ratio
    const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volRatio = volumes[volumes.length - 1] / avgVol;

    // Cálculo Final do Score
    let scoreL = 0, scoreS = 0;
    if (price > ema200) scoreL += 40; else scoreS += 40;
    if (price > vwap) scoreL += 30; else scoreS += 30;
    if (oiGrowing) { scoreL += 30; scoreS += 30; }

    MONITOR.indicators = { scoreL, scoreS, volRatio, price };
    return { price, scoreL, scoreS, volRatio };
}

// Loop de Decisão V9.5
setInterval(async () => {
    if (!MONITOR.active || !MONITOR.symbol) return;

    const data = await updateScoring();
    if (!data) return;

    const { price, scoreL, scoreS, volRatio } = data;
    const longTrigger = scoreL >= 70 && volRatio >= 1.1;
    const shortTrigger = scoreS >= 70 && volRatio >= 1.1;

    // --- LÓGICA DE ENTRADA (SEM POSIÇÃO) ---
    if (!MONITOR.position) {
        if (longTrigger && shortTrigger) {
            console.log("⚖️ Conflito: LONG e SHORT ativos. Aguardando...");
            return;
        }

        if (longTrigger) {
            addLog(`🚀 ENTRADA LONG: Score ${scoreL} | Vol ${volRatio.toFixed(2)}x`, 'ok');
            MONITOR.position = { side: 'long', entry: price, qty: 1, peak: price, trailActive: false, partialCount: 0 };
        } else if (shortTrigger) {
            addLog(`🚀 ENTRADA SHORT: Score ${scoreS} | Vol ${volRatio.toFixed(2)}x`, 'ok');
            MONITOR.position = { side: 'short', entry: price, qty: 1, peak: price, trailActive: false, partialCount: 0 };
        }
        return;
    }

    // --- GESTÃO DE POSIÇÃO ATIVA ---
    const pos = MONITOR.position;
    const isLong = pos.side === 'long';
    const priceVar = isLong ? (price - pos.entry) / pos.entry : (pos.entry - price) / pos.entry;
    const roi = priceVar * 100 * (MONITOR.config.lev || 5);
    const contraryTrigger = isLong ? shortTrigger : longTrigger;
    const favorTrigger = isLong ? longTrigger : shortTrigger;

    // 1. STOP LOSS
    if (roi <= -MONITOR.config.stopPct) {
        addLog(`❌ STOP LOSS: ${roi.toFixed(2)}% em ${price}`, 'err');
        MONITOR.position = null;
        return;
    }

    // 2. VIRADA (FLIP): Negativo + Gatilho Contrário
    if (roi < 0 && contraryTrigger) {
        const newSide = isLong ? 'short' : 'long';
        addLog(`🔄 VIRADA (FLIP): Revertendo para ${newSide.toUpperCase()}`, 'warn');
        MONITOR.position = { side: newSide, entry: price, qty: 1, peak: price, trailActive: false, partialCount: 0 };
        return;
    }

    // 3. APORTES A FAVOR (PARCIAIS): Positivo + Gatilho a Favor (Máximo 2)
    if (roi > 0 && favorTrigger && (pos.partialCount || 0) < 2) {
        pos.partialCount++;
        addLog(`📥 APORTE #${pos.partialCount}: Aumentando posição a favor`, 'info');
        pos.qty *= 1.3; // Simula aumento de contrato
    }

    // 4. FECHAMENTO DE SEGURANÇA: Positivo + Sinal Contrário (Antes do Trailing)
    if (roi > 0 && !pos.trailActive && contraryTrigger) {
        addLog(`💰 SEGURANÇA: Sinal contrário no lucro. Fechando posição.`, 'ok');
        MONITOR.position = null;
        return;
    }

    // 5. ATIVAÇÃO DO TRAILING
    if (!pos.trailActive && roi >= MONITOR.config.trailAct) {
        pos.trailActive = true;
        addLog(`🎯 TRAILING ATIVADO em ${roi.toFixed(2)}%`, 'ok');
    }

    // 6. GESTÃO DE TRAILING
    if (pos.trailActive) {
        // Gatilho contrário no Trailing -> Parcial de Saída 50%
        if (contraryTrigger) {
            if (!pos.partialExitDone) {
                addLog(`📤 SAÍDA PARCIAL: Reduzindo 50% por sinal contrário`, 'info');
                pos.qty *= 0.5;
                pos.partialExitDone = true;
            } else {
                addLog(`🏁 FECHAMENTO: Segundo sinal contrário após parcial.`, 'ok');
                MONITOR.position = null;
                return;
            }
        }

        // Atualiza pico e verifica recuo (Trailing Stop)
        if (isLong && price > pos.peak) pos.peak = price;
        if (!isLong && price < pos.peak) pos.peak = price;
        const pullback = isLong ? (pos.peak - price)/pos.peak*100 : (price - pos.peak)/pos.peak*100;
        
        if (pullback * (MONITOR.config.lev || 5) >= MONITOR.config.trailPull) {
            addLog(`🏁 TRAILING STOP: Recuo de ${pullback.toFixed(2)}% batido.`, 'ok');
            MONITOR.position = null;
        }
    }

}, 8000); // Ciclo de 8 segundos para evitar rate limit do Render

// Endpoints API
app.get('/status', (req, res) => {
    res.json({
        active: MONITOR.active,
        symbol: MONITOR.symbol,
        position: MONITOR.position,
        indicators: MONITOR.indicators,
        logs: MONITOR.logs,
        uptime: process.uptime()
    });
});

app.post('/sync-par', (req, res) => {
    const { symbol, active, config, position, forceEntry, forceFlip } = req.body;
    if (active) {
        MONITOR.active = true;
        MONITOR.symbol = symbol || MONITOR.symbol;
        if (config) MONITOR.config = { ...MONITOR.config, ...config };
        if (position) MONITOR.position = position;
        if (forceEntry) MONITOR.position = { side: forceEntry.side.toLowerCase(), entry: 0, qty: 1, peak: 0, trailActive: false, partialCount: 0 };
        if (forceFlip && MONITOR.position) {
            MONITOR.position.side = MONITOR.position.side === 'long' ? 'short' : 'long';
            MONITOR.position.entry = 0;
        }
        addLog(`Sincronização: ${MONITOR.symbol} Ativo.`, 'info');
    } else {
        MONITOR.active = false;
        addLog("Monitoramento Pausado.", 'warn');
    }
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Scanner Pro v9.5 Online na porta ${PORT}`));
