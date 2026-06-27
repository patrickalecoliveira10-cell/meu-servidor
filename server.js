const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- CONFIGURAÇÃO DE CHAVES (RENDER ENVIRONMENT VARIABLES) ---
const BYBIT_KEY = process.env.BYBIT_API_KEY; 
const BYBIT_SECRET = process.env.BYBIT_API_SECRET;
const IS_TESTNET = process.env.USE_TESTNET === 'true';

// --- ESTADO GLOBAL DO MONITORAMENTO ---
let MONITOR = {
    active: false,
    symbol: null,
    config: { 
        bankPct: 10, 
        stopPct: 2.5, 
        trailAct: 2.0, 
        trailPull: 1.0, 
        lev: 5 
    },
    position: null, // { side, entry, qty, peak, trailActive, partialIn: 0, partialOutDone: false }
    logs: [],
    lastErrorAt: 0
};

// --- UTILITÁRIOS ---
function serverLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('pt-BR');
    const entry = { time, msg, type };
    MONITOR.logs.unshift(entry);
    if (MONITOR.logs.length > 50) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${time} - ${msg}`);
}

function roundQty(symbol, qty) {
    const integerSyms = ['DOGE', 'SHIB', 'PEPE', '1000PEPE', 'BONK', 'GALA', 'LUNC', 'FLOKI'];
    if (integerSyms.some(s => symbol.includes(s))) return Math.floor(qty).toString();
    if (symbol.includes('BTC')) return qty.toFixed(3);
    if (symbol.includes('ETH')) return qty.toFixed(2);
    return qty.toFixed(1);
}

// --- INDICADORES TÉCNICOS (LÓGICA SNIPER) ---
function calcEMA(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b) / period;
    for (let i = period; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
    }
    return ema;
}

function calcVWAP(candles) {
    let sumTPV = 0, sumVol = 0;
    candles.forEach(c => {
        const tp = (c.high + c.low + c.close) / 3;
        sumTPV += tp * c.vol;
        sumVol += c.vol;
    });
    return sumVol > 0 ? sumTPV / sumVol : null;
}

// --- COMUNICAÇÃO BYBIT V5 ---
async function bybitRequest(method, endpoint, data = {}) {
    if (Date.now() - MONITOR.lastErrorAt < 2000) return { error: "Cooling down" };
    
    const timestamp = Date.now().toString();
    const baseUrl = IS_TESTNET ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    const parameters = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
    
    const sign = crypto.createHmac('sha256', BYBIT_SECRET)
                       .update(timestamp + BYBIT_KEY + '5000' + parameters)
                       .digest('hex');

    try {
        const res = await axios({
            method,
            url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: {
                'X-BAPI-API-KEY': BYBIT_KEY,
                'X-BAPI-SIGN': sign,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': '5000',
                'Content-Type': 'application/json'
            },
            data: method !== 'GET' ? data : undefined,
            timeout: 8000
        });

        if (res.data.retCode !== 0 && res.data.retCode !== 110043) {
            if (res.data.retCode === 10002) MONITOR.lastErrorAt = Date.now();
            serverLog(`Bybit Error: ${res.data.retMsg}`, 'err');
        }
        return res.data;
    } catch (e) {
        return { error: e.message };
    }
}

async function executeTrade(side, qty, type = 'open') {
    const symbol = MONITOR.symbol;
    const q = roundQty(symbol, parseFloat(qty));
    const bybitSide = type === 'open' ? (side === 'LONG' ? 'Buy' : 'Sell') : (side === 'LONG' ? 'Sell' : 'Buy');

    if (type === 'open') {
        serverLog(`🔥 [NUVEM] Executando Entrada: ${side} em ${symbol} (Qty: ${q})`, 'warn');
        // Ajusta alavancagem antes de abrir
        await bybitRequest('POST', '/v5/position/set-leverage', {
            category: 'linear', symbol, 
            buyLeverage: MONITOR.config.lev.toString(), 
            sellLeverage: MONITOR.config.lev.toString()
        });
    } else {
        serverLog(`🛑 [NUVEM] Executando Fechamento: ${side} em ${symbol}`, 'warn');
    }

    return await bybitRequest('POST', '/v5/order/create', {
        category: 'linear', symbol, side: bybitSide,
        orderType: 'Market', qty: q, timeInForce: 'GTC'
    });
}

// --- CICLO DE INTELIGÊNCIA AUTÔNOMO ---
async function serverCycle() {
    if (!MONITOR.active || !MONITOR.symbol) return;

    try {
        const [kline, tickers, oiData] = await Promise.all([
            bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '210' }),
            bybitRequest('GET', '/v5/market/tickers', { category: 'linear', symbol: MONITOR.symbol }),
            bybitRequest('GET', '/v5/market/open-interest', { category: 'linear', symbol: MONITOR.symbol, intervalTime: '5min', limit: '2' })
        ]);

        if (!kline.result || !tickers.result) return;

        const candles = kline.result.list.map(k => ({
            high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), vol: parseFloat(k[5])
        })).reverse();
        
        const price = parseFloat(tickers.result.list[0].lastPrice);
        const ema200 = calcEMA(candles.map(c => c.close), 200);
        const vwap = calcVWAP(candles);
        
        // Volume e OI
        const lastVol = candles[candles.length - 1].vol;
        const avgVol = candles.slice(-20).reduce((a, b) => a + b.vol, 0) / 20;
        const volRatio = lastVol / avgVol;
        const oiGrowing = oiData.result && parseFloat(oiData.result.list[0].openInterest) > parseFloat(oiData.result.list[1].openInterest);

        // --- LÓGICA DE GATILHOS (SCORE 70+) ---
        // Aqui simulamos a inteligência do App: Preço acima de EMA e VWAP + Vol + OI
        const longTrigger = (price > ema200 && price > vwap && volRatio >= 1.1 && oiGrowing);
        const shortTrigger = (price < ema200 && price < vwap && volRatio >= 1.1 && oiGrowing);

        if (MONITOR.position) {
            const pos = MONITOR.position;
            const isLong = pos.side === 'LONG';
            const contrary = isLong ? shortTrigger : longTrigger;
            const favor = isLong ? longTrigger : shortTrigger;
            
            const roi = (isLong ? (price - pos.entry) / pos.entry : (pos.entry - price) / pos.entry) * 100 * MONITOR.config.lev;

            // 1. ATUALIZA PICO PARA TRAILING
            if (isLong && price > pos.peak) pos.peak = price;
            if (!isLong && (price < pos.peak || pos.peak === 0)) pos.peak = price;

            // 2. REGRA: ROI NEGATIVO + GATILHO CONTRÁRIO = VIRADA (FLIP)
            if (roi < 0 && contrary) {
                serverLog("🔄 VIRADA DE MÃO: Gatilho contrário detectado no prejuízo.", "warn");
                await executeTrade(pos.side, pos.qty, 'close');
                const newSide = isLong ? 'SHORT' : 'LONG';
                const res = await executeTrade(newSide, pos.qty, 'open');
                if (res.retCode === 0) {
                    MONITOR.position = { side: newSide, entry: price, qty: pos.qty, peak: price, trailActive: false, partialIn: 0 };
                }
                return;
            }

            // 3. REGRA: STOP LOSS FIXO
            if (roi <= -MONITOR.config.stopPct) {
                serverLog("🔴 STOP LOSS atingido na nuvem.", "err");
                await executeTrade(pos.side, pos.qty, 'close');
                MONITOR.position = null;
                return;
            }

            // 4. REGRA: POSITIVO + GATILHO A FAVOR = APORTE (Máximo 2)
            if (roi > 0.5 && favor && (pos.partialIn || 0) < 2) {
                serverLog(`📥 APORTE (#${(pos.partialIn || 0) + 1}): Aumentando posição a favor.`, "info");
                const addQty = pos.qty * 0.5; 
                const res = await executeTrade(pos.side, addQty, 'open');
                if (res.retCode === 0) {
                    pos.qty = parseFloat(pos.qty) + addQty;
                    pos.partialIn = (pos.partialIn || 0) + 1;
                }
            }

            // 5. REGRA: POSITIVO (Sem Trailing) + GATILHO CONTRÁRIO = FECHAMENTO SEGURANÇA
            if (roi > 0 && !pos.trailActive && contrary) {
                serverLog("💰 SEGURANÇA: Gatilho contrário no lucro. Encerrando para garantir.", "ok");
                await executeTrade(pos.side, pos.qty, 'close');
                MONITOR.position = null;
                return;
            }

            // 6. GESTÃO DE TRAILING STOP
            if (!pos.trailActive && roi >= MONITOR.config.trailAct) {
                pos.trailActive = true;
                serverLog("🎯 Trailing Ativado na Nuvem!", "ok");
            }

            if (pos.trailActive) {
                // Se der gatilho contrário DURANTE o trailing -> Parcial de 50%
                if (contrary) {
                    if (!pos.partialOutDone) {
                        serverLog("📤 PARCIAL: Gatilho contrário no Trailing. Tirando 50%.", "info");
                        const outQty = pos.qty * 0.5;
                        const res = await executeTrade(pos.side, outQty, 'close');
                        if (res.retCode === 0) {
                            pos.qty -= outQty;
                            pos.partialOutDone = true;
                        }
                    } else {
                        // Se já fez a parcial e o sinal contrário persistir -> Fecha tudo
                        serverLog("🏁 FECHAMENTO FINAL: Segundo sinal contrário após parcial.", "ok");
                        await executeTrade(pos.side, pos.qty, 'close');
                        MONITOR.position = null;
                        return;
                    }
                }

                // Verificação de Recuo (Pullback) do Pico
                const pullback = (isLong ? (pos.peak - price) / pos.peak : (price - pos.peak) / pos.peak) * 100 * MONITOR.config.lev;
                if (pullback >= MONITOR.config.trailPull) {
                    serverLog(`🏁 TRAILING BATIDO: Recuo de ${pullback.toFixed(2)}% ROI detectado.`, "ok");
                    await executeTrade(pos.side, pos.qty, 'close');
                    MONITOR.position = null;
                }
            }
        } 
        // 7. ENTRADA SNIPER (Apenas se houver apenas UM dos gatilhos ativo)
        else if (longTrigger ^ shortTrigger) {
            const side = longTrigger ? 'LONG' : 'SHORT';
            // Cálculo de Qty baseado no bankPct (Ex: 10% da banca fictícia de 100 USDT)
            const marginUsdt = (MONITOR.config.bankPct / 100) * 100; 
            const qty = (marginUsdt * MONITOR.config.lev) / price;

            const res = await executeTrade(side, qty, 'open');
            if (res.retCode === 0) {
                MONITOR.position = { 
                    side, entry: price, qty, peak: price, 
                    trailActive: false, partialIn: 0, partialOutDone: false 
                };
                serverLog(`🔥 ENTRADA SNIPER EXECUTADA: ${side} em ${price}`, "ok");
            }
        }

    } catch (e) {
        console.error("Erro no Ciclo do Servidor:", e.message);
    }
}

// --- ROTAS DE API ---

// Retorna o estado atual para o App mostrar na tela
app.get('/status', (req, res) => res.json(MONITOR));

// Sincroniza o App com o Servidor (Handover)
app.post('/sync-par', async (req, res) => {
    const { symbol, active, config, position } = req.body;
    
    if (active === false) {
        // Se o usuário mandar desativar, fecha tudo e para o monitor
        if (MONITOR.position) {
            serverLog(`📴 Desativando nuvem e fechando posição em ${MONITOR.symbol}`, 'warn');
            await executeTrade(MONITOR.position.side, MONITOR.position.qty, 'close');
        }
        MONITOR.active = false;
        MONITOR.position = null;
        return res.json({ success: true, message: "Servidor parado." });
    }

    // Ativa o monitoramento
    MONITOR.active = true;
    MONITOR.symbol = symbol;
    MONITOR.config = config;

    // Se o App já estiver em uma posição, o servidor assume os dados
    if (position && position.side && !MONITOR.position) {
        MONITOR.position = {
            ...position,
            side: position.side.toUpperCase(),
            partialIn: 0,
            partialOutDone: false
        };
        serverLog(`☁️ Servidor assumiu o controle de ${symbol}`, 'ok');
    }

    res.json({ success: true });
});

// Loop principal (a cada 10 segundos para evitar Rate Limit)
setInterval(serverCycle, 10000);

app.listen(PORT, () => {
    console.log(`
    =========================================
    BYBIT SNIPER PRO V8 - CLOUD ACTIVE
    Porta: ${PORT}
    Status: Pronto para Operar
    =========================================
    `);
});
