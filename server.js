// ╔══════════════════════════════════════════════════════════════════════╗
// ║   BYBIT SCANNER PRO — SERVER v9.6 (FINAL-SYNC + BLINDADO)            ║
// ║   Deploy: Render.com                                                  ║
// ║                                                                        ║
// ║   Variáveis de ambiente OBRIGATÓRIAS no Render:                       ║
// ║     BYBIT_API_KEY    = sua chave da Bybit                             ║
// ║     BYBIT_API_SECRET = seu secret da Bybit                            ║
// ║     USE_TESTNET      = true (remova para operar com dinheiro real)    ║
// ╚══════════════════════════════════════════════════════════════════════╝

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

let MONITOR = {
    active: false,
    symbol: null,
    engineRunning: false, // lock anti-reentrância do loop de 5s
    tradeLock: false,     // lock compartilhado: impede engine e rotas (close/stop) de mexerem na posição ao mesmo tempo
    config: {
        stopPct: 1.5,
        trailAct: 1.5,
        trailPull: 0.5,
        lev: 1,
        orderQty: 0.1,
        partialInPct: 5,
        partialOutPct: 50,
        // Configurações do gatilho de entrada (customizável pelo app)
        emaScore: 40,
        vwapScore: 30,
        oiScore: 20,
        volRatio: 1.2,
        scoreMin: 50,
        volMin: 1.0
    },
    position: null,
    indicators: { scoreL: 0, scoreS: 0, volRatio: 0, price: 0 },
    logs: [],
    // Seleção automática de moeda por backtest (últimas 24h), igual ao "Escanear" da aba PAR do app
    tradingPaused: false, // true quando nenhuma moeda tem eficácia >= 60% — monitora mas não entra
    coinScan: {
        running: false,
        lastScanAt: 0,
        results: [],       // [{symbol, wr, trades, pnl}] ordenado por wr desc
        bestSymbol: null,
        bestWr: 0
    }
};

function addLog(msg, type = 'info') {
    const ts = new Date().toLocaleTimeString('pt-BR');
    const logEntry = { time: Date.now(), msg: `[${ts}] ${msg}`, type };
    MONITOR.logs.unshift(logEntry);
    if (MONITOR.logs.length > 100) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ─── Checagem de credenciais no boot ───────────────────────────────────────
// Se as chaves não estiverem configuradas, avisa IMEDIATAMENTE no log do app
// (antes disso, um erro de assinatura só aparecia no console do Render, nunca no app).
function checkCredentials() {
    const key = process.env.BYBIT_API_KEY;
    const secret = process.env.BYBIT_API_SECRET;
    if (!key || !secret) {
        addLog('🚨 CRÍTICO: BYBIT_API_KEY e/ou BYBIT_API_SECRET não configuradas no Render! Nenhuma ordem poderá ser enviada. Configure em Environment Variables.', 'err');
        return false;
    }
    return true;
}

// ─── Bybit API ──────────────────────────────────────────────────────────────
// TUDO que pode falhar (assinatura, rede, timeout, resposta inválida) é
// capturado aqui dentro e devolvido como { error }, e SEMPRE logado.
// Isso evita que um erro "estoure" como unhandled rejection e desapareça
// silenciosamente do loop de monitoramento.
async function bybitRequest(method, endpoint, data = {}) {
    try {
        const key = process.env.BYBIT_API_KEY;
        const secret = process.env.BYBIT_API_SECRET;

        if (!key || !secret) {
            addLog(`🚨 Chamada à Bybit (${endpoint}) abortada: API Key/Secret ausentes.`, 'err');
            return { error: 'missing_credentials' };
        }

        const timestamp = Date.now().toString();
        const baseUrl = process.env.USE_TESTNET === 'true'
            ? 'https://api-testnet.bybit.com'
            : 'https://api.bybit.com';

        const parameters = method === 'GET'
            ? new URLSearchParams(data).toString()
            : JSON.stringify(data);

        // A assinatura (HMAC) pode lançar exceção se a chave for inválida —
        // agora está DENTRO do try/catch principal, então nunca mais some silenciosamente.
        const sign = crypto
            .createHmac('sha256', secret)
            .update(timestamp + key + '5000' + parameters)
            .digest('hex');

        const res = await axios({
            method,
            url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: {
                'X-BAPI-API-KEY': key,
                'X-BAPI-SIGN': sign,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': '5000',
                ...(method !== 'GET' && { 'Content-Type': 'application/json' }),
            },
            // Envia exatamente a mesma string que foi assinada (evita divergência de serialização)
            data: method !== 'GET' ? parameters : undefined,
            timeout: 8000,
        });
        return res.data;
    } catch (e) {
        const msg = (e.response && e.response.data)
            ? JSON.stringify(e.response.data)
            : (e.message || String(e));
        addLog(`⚠️ Erro HTTP Bybit (${endpoint}): ${msg}`, 'err');
        return { error: msg };
    }
}

// ─── Ordem ──────────────────────────────────────────────────────────────────
async function placeOrder(side, qty, isReduce = false) {
    if (!MONITOR.symbol) {
        addLog(`❌ placeOrder: MONITOR.symbol não definido`, 'err');
        return null;
    }

    let finalQty = qty;

    // Normaliza a quantidade para o step/mínimo do instrumento — para ordens de
    // entrada E de redução/fechamento (qty acumulada por aportes pode não estar
    // alinhada ao qtyStep, e a Bybit rejeita ordens fora do step).
    const info = await bybitRequest('GET', '/v5/market/instruments-info', { category: 'linear', symbol: MONITOR.symbol });
    if (info && info.result && info.result.list && info.result.list[0]) {
        const instr = info.result.list[0];
        const limits = instr.lotSizeFilter;
        const minQty = parseFloat(limits.minOrderQty);
        const step = parseFloat(limits.qtyStep);
        const precision = Math.max(0, Math.round(-Math.log10(step)));

        const currentPrice = MONITOR.indicators.price || 0;
        if (!isReduce) {
            if (currentPrice > 0) {
                // Arredonda para CIMA ao step para garantir nocional >= 5.2 USDT APÓS o floor.
                // Sem ceil aqui, Math.floor posterior pode derrubar o nocional abaixo de 5 USDT
                // (ex: 5.2 / 0.38 = 13.68 → floor = 13 → 13×0.38 = 4.94 → rejeitado).
                const minNotional = 5.2;
                const rawMinQty = minNotional / currentPrice;
                const minQtyForNotional = Math.ceil(rawMinQty / step) * step;
                if (finalQty < minQtyForNotional) {
                    addLog(`📐 Qty ajustada de ${finalQty} → ${minQtyForNotional} para atingir nocional mínimo (${(minQtyForNotional * currentPrice).toFixed(2)} USDT)`, 'info');
                    finalQty = minQtyForNotional;
                }
            }
            if (finalQty < minQty) finalQty = minQty;
        }
        // Arredonda para baixo ao step (ordens de entrada já chegam alinhadas pelo ceil acima)
        finalQty = Math.floor(finalQty / step) * step;
        finalQty = parseFloat(finalQty.toFixed(precision));
        if (isReduce && finalQty <= 0) {
            addLog(`⚠️ Qty de redução ficou ${finalQty} após arredondamento ao step (${step}). Abortando ordem para evitar rejeição.`, 'warn');
            return null;
        }
        // Guarda de segurança final: usa o mesmo currentPrice do bloco acima para consistência.
        // Limiar 4.99 em vez de 5.0 para não abortar por erro de ponto flutuante na fronteira.
        if (!isReduce && currentPrice > 0) {
            const notional = finalQty * currentPrice;
            if (notional < 4.99) {
                addLog(`❌ Nocional final (${notional.toFixed(2)} USDT) ainda abaixo do mínimo Bybit (5 USDT). Abortando ordem.`, 'err');
                return null;
            }
        }
    } else {
        addLog(`⚠️ Não foi possível obter informações do instrumento ${MONITOR.symbol}. Usando qty original: ${finalQty}`, 'warn');
    }

    const bybitSide = side.toLowerCase() === 'long' ? 'Buy' : 'Sell';
    const orderData = {
        category: 'linear',
        symbol: MONITOR.symbol,
        side: bybitSide,
        orderType: 'Market',
        qty: finalQty.toString(),
        timeInForce: 'GTC',
        reduceOnly: isReduce,
    };

    addLog(`📡 Enviando ordem: ${bybitSide} ${finalQty} ${MONITOR.symbol} (reduceOnly=${isReduce})`, 'info');

    const res = await bybitRequest('POST', '/v5/order/create', orderData);

    if (res && res.retCode === 0) {
        addLog(`✅ Ordem aceita pela Bybit: ${(res.result && res.result.orderId) || 'sem ID'}`, 'ok');
        return finalQty;
    }

    // Cobre tanto erro de rede/assinatura ({error: ...}) quanto rejeição da Bybit (retCode != 0)
    if (res && res.error) {
        addLog(`❌ Falha de comunicação com a Bybit: ${res.error}`, 'err');
    } else {
        addLog(`❌ Erro Bybit (retCode=${res ? res.retCode : 'sem resposta'}): ${res ? res.retMsg : ''}`, 'err');
        if (res) {
            if (res.retCode === 10001) addLog('💡 Dica: verifique se a API Key tem permissão de Trading (Contratos).', 'err');
            if (res.retCode === 10003) addLog('💡 Dica: API Key inválida ou incorreta.', 'err');
            if (res.retCode === 10004) addLog('💡 Dica: assinatura inválida — confira se o Secret está correto e sem espaços.', 'err');
            if (res.retCode === 10005) addLog('💡 Dica: permissão negada — confira as permissões da API Key na Bybit.', 'err');
            if (res.retCode === 10016) addLog('💡 Dica: saldo insuficiente.', 'err');
            if (res.retCode === 10018) addLog('💡 Dica: quantidade inválida ou abaixo do mínimo.', 'err');
            if (res.retCode === 110007) addLog('💡 Dica: saldo/margem insuficiente para essa alavancagem.', 'err');
        }
    }
    return null;
}

function calcEMA(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
    return ema;
}

async function engineScoring() {
    if (!MONITOR.symbol) return null;

    const kRes = await bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '201' });
    if (!kRes || !kRes.result || !kRes.result.list || !kRes.result.list.length) {
        if (kRes && kRes.error) addLog(`⚠️ Sem dados de candles (${MONITOR.symbol}): ${kRes.error}`, 'warn');
        return null;
    }

    const list = [...kRes.result.list].reverse();
    const prices = list.map(k => parseFloat(k[4]));
    const curP = prices[prices.length - 1];
    const prevP = prices[prices.length - 2];
    if (!isFinite(curP) || !isFinite(prevP)) return null;

    const ema200 = calcEMA(prices, 200);

    const emaScore = MONITOR.config.emaScore || 40;
    const vwapScore = MONITOR.config.vwapScore || 30;
    const oiScore = MONITOR.config.oiScore || 20;

    let sL = (curP > ema200) ? emaScore : 0;
    let sS = (curP < ema200) ? emaScore : 0;

    let vwapSum = 0, volSum = 0;
    list.slice(-50).forEach(k => {
        const p = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
        const v = parseFloat(k[5]);
        vwapSum += p * v; volSum += v;
    });
    const vwap = volSum > 0 ? vwapSum / volSum : curP;
    sL += (curP > vwap) ? vwapScore : 0;
    sS += (curP < vwap) ? vwapScore : 0;

    const oiRes = await bybitRequest('GET', '/v5/market/open-interest', { category: 'linear', symbol: MONITOR.symbol, intervalTime: '5min', limit: '2' });
    if (oiRes && oiRes.result && oiRes.result.list && oiRes.result.list.length >= 2) {
        const growing = parseFloat(oiRes.result.list[0].openInterest) > parseFloat(oiRes.result.list[1].openInterest);
        if (growing) {
            if (curP > prevP) sL += oiScore;
            else if (curP < prevP) sS += oiScore;
        }
    }

    const recent20 = list.slice(-21, -1);
    const avgVol = recent20.length ? recent20.reduce((a, b) => a + parseFloat(b[5]), 0) / recent20.length : 0;
    const lastVol = parseFloat(list[list.length - 1][5]);
    const vRat = avgVol > 0 ? lastVol / avgVol : 0;

    MONITOR.indicators = { scoreL: sL, scoreS: sS, volRatio: vRat, price: curP };
    return MONITOR.indicators;
}

// ─── Backtest de Seleção de Moeda (últimas 24h) ────────────────────────────
// Reproduz EXATAMENTE a lógica de "Escanear" da aba PAR do app (serverEngineScoring
// + serverSimulatePosition), só que rodando aqui no servidor com a config vigente
// (gatilho, PAR e alavancagem da última vez que o monitoramento foi iniciado).

// Busca candles de 1min das últimas ~24h via paginação (Bybit limita 1000 por chamada).
async function fetchDayCandles(symbol) {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let all = [];
    let endTime = Date.now();
    for (let page = 0; page < 3; page++) {
        const kRes = await bybitRequest('GET', '/v5/market/kline', {
            category: 'linear', symbol, interval: '1', end: String(endTime), limit: '1000'
        });
        if (!kRes || !kRes.result || !kRes.result.list || !kRes.result.list.length) break;
        const batch = kRes.result.list; // mais recente primeiro
        all = all.concat(batch);
        const oldestTs = parseFloat(batch[batch.length - 1][0]);
        if (oldestTs <= oneDayAgo || batch.length < 1000) break;
        endTime = oldestTs - 1;
    }
    if (!all.length) return null;
    const map = new Map();
    all.forEach(k => map.set(k[0], k));
    const sorted = [...map.values()]
        .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
        .filter(k => parseFloat(k[0]) >= oneDayAgo);
    return sorted.map(k => ({
        time: parseFloat(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), vol: parseFloat(k[5])
    }));
}

// Scoring idêntico ao engineScoring(), mas offline (sem chamada de OI real — usa o
// mesmo proxy de OI por variação de volume que o backtest da aba PAR do app usa,
// já que não há histórico de Open Interest candle-a-candle disponível).
function btScoring(candles, config) {
    if (!candles || candles.length < 200) return null;
    const closes = candles.map(c => c.close);
    const curP = closes[closes.length - 1];
    const prevP = closes[closes.length - 2];
    if (!isFinite(curP) || !isFinite(prevP)) return null;

    const ema200 = calcEMA(closes, 200);
    const emaScore = config.emaScore || 40;
    const vwapScore = config.vwapScore || 30;
    const oiScore = config.oiScore || 20;

    let sL = curP > ema200 ? emaScore : 0;
    let sS = curP < ema200 ? emaScore : 0;

    let vwapSum = 0, volSum = 0;
    candles.slice(-50).forEach(c => {
        const p = (c.high + c.low + c.close) / 3;
        vwapSum += p * c.vol; volSum += c.vol;
    });
    const vwap = volSum > 0 ? vwapSum / volSum : curP;
    sL += curP > vwap ? vwapScore : 0;
    sS += curP < vwap ? vwapScore : 0;

    const recent5 = candles.slice(-5);
    let volTrend = 0;
    if (recent5.length >= 2) {
        const lastVol = candles[candles.length - 1].vol;
        const volChange = (lastVol - recent5[0].vol) / (recent5[0].vol || 1);
        if (volChange > 0.3) volTrend = oiScore;
        else if (volChange > 0.1) volTrend = oiScore * 0.5;
    }
    sL += volTrend; sS += volTrend;

    const recent20 = candles.slice(-21, -1);
    const avgVol = recent20.length ? recent20.reduce((a, b) => a + b.vol, 0) / recent20.length : 0;
    const lastVol = candles[candles.length - 1].vol;
    const vRat = avgVol > 0 ? lastVol / avgVol : 0;

    return { scoreL: sL, scoreS: sS, volRatio: vRat, price: curP };
}

// Simula a gestão de posição do engine real (stop, trailing, flip, aportes) para o backtest.
function btSimulatePosition(candles, entryIdx, side, config) {
    const entry = candles[entryIdx].close;
    const stopPct = config.stopPct || 1.5;
    const trailAct = config.trailAct || 1.5;
    const trailPull = config.trailPull || 0.5;
    const lev = config.lev || 1;
    const isL = side === 'long';

    let pos = { peak: entry, trailActive: false, partialExitDone: false };
    let lastRoi = 0;

    for (let i = entryIdx + 1; i < candles.length; i++) {
        const price = candles[i].close;
        const roi = (isL ? (price - entry) / entry : (entry - price) / entry) * 100 * lev;
        lastRoi = roi;

        if (roi <= -stopPct) return { result: 'stop', roi };

        const scoring = btScoring(candles.slice(0, i + 1), config);
        if (!scoring) continue;
        const scoreMin = config.scoreMin || 50;
        const volMin = config.volMin || 1.0;
        const longTrig = scoring.scoreL >= scoreMin && scoring.volRatio >= volMin;
        const shortTrig = scoring.scoreS >= scoreMin && scoring.volRatio >= volMin;
        const contraryTrig = isL ? shortTrig : longTrig;

        if (contraryTrig && roi >= 0 && !pos.trailActive) return { result: 'safety', roi };

        if (!pos.trailActive && roi >= trailAct) { pos.trailActive = true; pos.peak = price; }

        if (pos.trailActive) {
            if (isL && price > pos.peak) pos.peak = price;
            if (!isL && price < pos.peak) pos.peak = price;
            const pullbackPct = (isL ? (pos.peak - price) / pos.peak : (price - pos.peak) / pos.peak) * 100 * lev;

            if (contraryTrig) {
                if (!pos.partialExitDone) { pos.partialExitDone = true; continue; }
                return { result: 'trail_exit', roi };
            }
            if (pullbackPct >= trailPull) return { result: 'trail_exit', roi };
        }
    }
    return { result: 'timeout', roi: lastRoi };
}

// Roda o backtest completo (últimas 24h) para uma moeda e retorna a eficácia (win rate).
async function backtestSymbol(symbol, config) {
    const candles = await fetchDayCandles(symbol);
    if (!candles || candles.length < 220) return { symbol, wr: 0, trades: 0, pnl: 0 };

    const scoreMin = config.scoreMin || 50;
    const volMin = config.volMin || 1.0;
    let wins = 0, trades = 0, totalPnl = 0;

    for (let i = 200; i < candles.length - 1; i++) {
        const scoring = btScoring(candles.slice(0, i + 1), config);
        if (!scoring) continue;
        const longTrig = scoring.scoreL >= scoreMin && scoring.volRatio >= volMin;
        const shortTrig = scoring.scoreS >= scoreMin && scoring.volRatio >= volMin;
        if (longTrig && shortTrig) continue;
        if (!longTrig && !shortTrig) continue;

        const side = longTrig ? 'long' : 'short';
        const result = btSimulatePosition(candles, i, side, config);
        trades++;
        totalPnl += result.roi;
        if (result.result !== 'stop' && result.result !== 'timeout') wins++;
    }

    const wr = trades > 0 ? wins / trades : 0;
    return { symbol, wr, trades, pnl: totalPnl };
}

// Busca as moedas com maior volume 24h na Bybit (mesmo filtro do "Escanear" da aba PAR do app).
async function getTopMovers(limit = 20) {
    const [instRes, tickRes] = await Promise.all([
        bybitRequest('GET', '/v5/market/instruments-info', { category: 'linear' }),
        bybitRequest('GET', '/v5/market/tickers', { category: 'linear' })
    ]);
    const instruments = (instRes && instRes.result && instRes.result.list) || [];
    const tickers = (tickRes && tickRes.result && tickRes.result.list) || [];
    const instSet = new Set();
    instruments.forEach(i => { if (i.quoteCoin === 'USDT' && i.status === 'Trading') instSet.add(i.symbol); });

    const candidates = tickers
        .filter(t => t.symbol.endsWith('USDT') && instSet.has(t.symbol))
        .map(t => ({ symbol: t.symbol, volUSD: (parseFloat(t.volume24h) || 0) * (parseFloat(t.lastPrice) || 0) }))
        .filter(t => t.volUSD >= 20000)
        .sort((a, b) => b.volUSD - a.volUSD)
        .slice(0, limit)
        .map(t => t.symbol);

    return candidates;
}

// Roda o backtest em todas as candidatas e decide qual moeda o servidor deve operar:
//  - Mantém a moeda atual se ela continuar sendo a de maior eficácia e >= 60%.
//  - Troca para a de maior eficácia se a atual não for mais a melhor.
//  - Pausa as entradas (mas continua monitorando/backtestando) se a melhor ficar < 60%.
// NUNCA troca de moeda enquanto houver posição aberta (chamado só quando MONITOR.position é null).
async function runCoinScan() {
    if (MONITOR.coinScan.running) return;
    MONITOR.coinScan.running = true;
    try {
        addLog('🔍 Backtest de seleção de moeda iniciado (últimas 24h, config vigente)...', 'info');
        const config = MONITOR.config;
        const movers = await getTopMovers(20);
        const candidates = new Set(movers);
        if (MONITOR.symbol) candidates.add(MONITOR.symbol); // sempre reavalia a moeda atual também

        const results = [];
        for (const sym of candidates) {
            try {
                const r = await backtestSymbol(sym, config);
                results.push(r);
                addLog(`📊 Backtest ${sym}: eficácia=${(r.wr * 100).toFixed(0)}% trades=${r.trades}`, 'info');
            } catch (e) {
                addLog(`⚠️ Backtest falhou para ${sym}: ${e.message}`, 'warn');
            }
        }

        results.sort((a, b) => (b.wr - a.wr) || (b.trades - a.trades));
        MONITOR.coinScan.results = results;
        MONITOR.coinScan.lastScanAt = Date.now();

        if (!results.length) {
            addLog('⚠️ Backtest de seleção não retornou resultados. Mantendo moeda atual.', 'warn');
            return;
        }

        const best = results[0];
        MONITOR.coinScan.bestSymbol = best.symbol;
        MONITOR.coinScan.bestWr = best.wr;

        // Nunca troca de moeda com posição aberta (proteção extra, além do gatilho de chamada)
        if (MONITOR.position) {
            addLog('ℹ️ Posição aberta durante o backtest — seleção de moeda será aplicada após o fechamento.', 'info');
            return;
        }

        if (best.wr < 0.6) {
            MONITOR.tradingPaused = true;
            addLog(`⏸️ Nenhuma moeda com eficácia >= 60% (melhor: ${best.symbol} ${(best.wr * 100).toFixed(0)}%). Servidor NÃO vai operar até melhorar.`, 'warn');
            return;
        }

        MONITOR.tradingPaused = false;
        const currentResult = results.find(r => r.symbol === MONITOR.symbol);
        const currentIsStillBest = currentResult && currentResult.wr >= 0.6 && currentResult.wr >= best.wr - 1e-9;

        if (currentIsStillBest) {
            addLog(`✅ Moeda atual (${MONITOR.symbol}) continua com a maior eficácia (${(currentResult.wr * 100).toFixed(0)}%). Mantendo.`, 'ok');
        } else {
            const prevSymbol = MONITOR.symbol;
            MONITOR.symbol = best.symbol;
            addLog(`🔀 Trocando moeda: ${prevSymbol || '—'} → ${best.symbol} (eficácia ${(best.wr * 100).toFixed(0)}% > atual). Servidor passa a operar ${best.symbol}.`, 'ok');
        }
    } finally {
        MONITOR.coinScan.running = false;
    }
}

// ─── Engine (tick único, chamado com lock anti-reentrância abaixo) ─────────
async function engineTick() {
    if (!MONITOR.active || !MONITOR.symbol) return;
    const data = await engineScoring();
    if (!data) return;
    const { scoreL, scoreS, volRatio, price } = data;

    const scoreMin = MONITOR.config.scoreMin || 50;
    const volMin = MONITOR.config.volMin || 1.0;

    const longTrig = scoreL >= scoreMin && volRatio >= volMin;
    const shortTrig = scoreS >= scoreMin && volRatio >= volMin;

    if (longTrig || shortTrig) {
        addLog(`🎯 GATILHO ATIVADO: scoreL=${scoreL.toFixed(0)} scoreS=${scoreS.toFixed(0)} volRatio=${volRatio.toFixed(2)} scoreMin=${scoreMin} volMin=${volMin}`, 'info');
    }

    if (!MONITOR.logCounter) MONITOR.logCounter = 0;
    MONITOR.logCounter++;
    if (MONITOR.logCounter % 60 === 0) {
        addLog(`📊 STATUS MONITORAMENTO: scoreL=${scoreL.toFixed(0)}/${scoreMin} scoreS=${scoreS.toFixed(0)}/${scoreMin} volRatio=${volRatio.toFixed(2)}/${volMin} price=${price}`, 'info');
    }

    // --- ENTRADA ---
    if (!MONITOR.position) {
        if (MONITOR.tradingPaused) {
            return; // Nenhuma moeda com eficácia >= 60% no último backtest — servidor não entra
        }
        if (longTrig && shortTrig) {
            addLog('⚖️ Conflito: LONG e SHORT ativos. Ignorando entrada.', 'warn');
            return;
        }
        if (longTrig) {
            addLog(`🚀 GATILHO LONG: scoreL=${scoreL.toFixed(0)} >= ${scoreMin}, volRatio=${volRatio.toFixed(2)} >= ${volMin}. Enviando ordem...`, 'info');
            const qty = await placeOrder('long', MONITOR.config.orderQty);
            if (qty) {
                MONITOR.position = { side: 'long', entry: price, qty, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price, partialExitDone: false };
                addLog(`✅ ENTRADA LONG EXECUTADA: qty=${qty} @ ${price}`, 'ok');
            } else {
                addLog('❌ FALHA NA ENTRADA LONG: veja o erro específico acima (credenciais, saldo ou permissão).', 'err');
            }
        } else if (shortTrig) {
            addLog(`🚀 GATILHO SHORT: scoreS=${scoreS.toFixed(0)} >= ${scoreMin}, volRatio=${volRatio.toFixed(2)} >= ${volMin}. Enviando ordem...`, 'info');
            const qty = await placeOrder('short', MONITOR.config.orderQty);
            if (qty) {
                MONITOR.position = { side: 'short', entry: price, qty, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price, partialExitDone: false };
                addLog(`✅ ENTRADA SHORT EXECUTADA: qty=${qty} @ ${price}`, 'ok');
            } else {
                addLog('❌ FALHA NA ENTRADA SHORT: veja o erro específico acima (credenciais, saldo ou permissão).', 'err');
            }
        }
        return;
    }

    // --- GESTÃO DE POSIÇÃO ATIVA ---
    const pos = MONITOR.position;
    const isL = pos.side === 'long';
    const roi = (isL ? (price - pos.entry) / pos.entry : (pos.entry - price) / pos.entry) * 100 * (MONITOR.config.lev || 1);
    const contraryTrig = isL ? shortTrig : longTrig;
    const favorTrig = isL ? longTrig : shortTrig;

    // 1. STOP LOSS
    if (roi <= -MONITOR.config.stopPct) {
        const q = await placeOrder(isL ? 'short' : 'long', pos.qty, true);
        if (q !== null) {
            MONITOR.position = null;
            addLog(`❌ STOP LOSS BATIDO em ${roi.toFixed(2)}%`, 'err');
        } else {
            addLog('⚠️ Stop Loss: ordem rejeitada. Tentará novamente no próximo tick.', 'err');
        }
        return;
    }

    // 2. VIRADA (FLIP) OU SEGURANÇA
    if (contraryTrig) {
        if (roi < 0) {
            addLog(`🔄 VIRADA (FLIP): ROI ${roi.toFixed(2)}%. Invertendo...`, 'warn');
            const closeQ = await placeOrder(isL ? 'short' : 'long', pos.qty, true);
            if (closeQ === null) {
                addLog('⚠️ FLIP: falha ao fechar posição atual. Aguardando próximo tick.', 'err');
                return;
            }
            MONITOR.position = null;
            const newSide = isL ? 'short' : 'long';
            const qty = await placeOrder(newSide, MONITOR.config.orderQty);
            if (qty) {
                MONITOR.position = { side: newSide, entry: price, qty, peak: price, trailActive: false, partialCount: 0, lastAportePrice: price, partialExitDone: false };
                addLog(`✅ NOVA POSIÇÃO ${newSide.toUpperCase()} @ ${price}`, 'ok');
            } else {
                addLog('⚠️ FLIP: posição fechada, mas falha ao abrir nova. Estado: flat.', 'warn');
            }
            return;
        } else if (!pos.trailActive) {
            addLog(`💰 SEGURANÇA: Lucro de ${roi.toFixed(2)}%. Fechando por sinal contrário.`, 'ok');
            const q = await placeOrder(isL ? 'short' : 'long', pos.qty, true);
            if (q !== null) {
                MONITOR.position = null;
            } else {
                addLog('⚠️ Segurança: ordem rejeitada. Tentará novamente no próximo tick.', 'err');
            }
            return;
        }
    }

    // 3. APORTES (SCALE-IN): Máximo 2
    if (favorTrig && roi > 0.5 && pos.partialCount < 2) {
        const dist = Math.abs(price - pos.lastAportePrice) / pos.lastAportePrice * 100;
        if (dist >= 0.3) {
            // CORRIGIDO: partialInPct é % da orderQty (ex: 20 => 20%), não /30
            const aporteQty = MONITOR.config.orderQty * (MONITOR.config.partialInPct / 100);
            const qty = await placeOrder(pos.side, aporteQty);
            if (qty) {
                pos.partialCount++;
                pos.qty += qty;
                pos.lastAportePrice = price;
                addLog(`📥 APORTE #${pos.partialCount} EXECUTADO @ ${price} | +${qty} | Total: ${pos.qty.toFixed(6)}`, 'info');
            }
        }
    }

    // 4. ATIVAÇÃO DO TRAILING
    if (!pos.trailActive && roi >= MONITOR.config.trailAct) {
        pos.trailActive = true;
        pos.peak = price;
        addLog(`🎯 TRAILING ATIVADO em ${roi.toFixed(2)}% ROI`, 'ok');
    }

    // 5. GESTÃO DE SAÍDA NO TRAILING
    if (pos.trailActive) {
        if (contraryTrig) {
            if (!pos.partialExitDone) {
                const exitQty = pos.qty * (MONITOR.config.partialOutPct / 100);
                const q = await placeOrder(isL ? 'short' : 'long', exitQty, true);
                if (q) {
                    pos.qty -= q;
                    pos.partialExitDone = true;
                    addLog(`📤 PARCIAL TRAILING: Sinal contrário. Reduzindo ${MONITOR.config.partialOutPct}% | Restante: ${pos.qty.toFixed(6)}`, 'info');
                } else {
                    addLog('⚠️ Parcial de trailing rejeitada. Tentará no próximo tick.', 'err');
                }
            } else {
                addLog('🏁 FECHAMENTO TRAILING: Segundo sinal contrário detectado.', 'ok');
                const q = await placeOrder(isL ? 'short' : 'long', pos.qty, true);
                if (q !== null) {
                    MONITOR.position = null;
                } else {
                    addLog('⚠️ Fechamento final rejeitado. Tentará no próximo tick.', 'err');
                }
                return;
            }
        }

        if (isL && price > pos.peak) pos.peak = price;
        if (!isL && price < pos.peak) pos.peak = price;
        const pb = isL ? (pos.peak - price) / pos.peak * 100 : (price - pos.peak) / pos.peak * 100;

        if (pb * (MONITOR.config.lev || 1) >= MONITOR.config.trailPull) {
            addLog(`🏁 RECUO TRAILING: Queda de ${pb.toFixed(2)}% do topo. Encerrando.`, 'ok');
            const q = await placeOrder(isL ? 'short' : 'long', pos.qty, true);
            if (q !== null) {
                MONITOR.position = null;
            } else {
                addLog('⚠️ Fechamento por recuo rejeitado. Tentará no próximo tick.', 'err');
            }
        }
    }
}

// Lock compartilhado: usado tanto pelo tick do engine quanto pelas rotas HTTP
// que mexem em MONITOR.position (/close-position, parar monitoramento), para
// que uma ação manual nunca colida com o engine no meio de um stop/flip/trailing.
async function withTradeLock(fn) {
    if (MONITOR.tradeLock) {
        throw new Error('Engine ocupado processando outra ação. Tente novamente em instantes.');
    }
    MONITOR.tradeLock = true;
    try {
        return await fn();
    } finally {
        MONITOR.tradeLock = false;
    }
}

// Loop principal, agora com:
//  - lock compartilhado (tradeLock) — nunca roda ao mesmo tempo que uma ação manual
//  - try/catch cobrindo TUDO — nenhum erro nunca mais desaparece sem log
setInterval(async () => {
    if (MONITOR.tradeLock) return; // ocupado (tick anterior ou ação manual em andamento), pula
    MONITOR.tradeLock = true;
    const hadPosition = !!MONITOR.position;
    try {
        await engineTick();
        // Posição acabou de fechar (stop/segurança/trailing/flip-para-flat) — reavalia
        // a melhor moeda por backtest antes da próxima entrada, fora do lock do engine.
        if (hadPosition && !MONITOR.position && MONITOR.active) {
            addLog('📊 Posição fechada. Reavaliando melhor moeda via backtest...', 'info');
            runCoinScan().catch(e => addLog(`⚠️ Erro no backtest pós-fechamento: ${e.message}`, 'warn'));
        }
    } catch (e) {
        addLog(`💥 ERRO INESPERADO NO ENGINE (antes invisível!): ${e.message}`, 'err');
    } finally {
        MONITOR.tradeLock = false;
    }
}, 5000);

// Backtest periódico de seleção de moeda: a cada 10 minutos, se o monitoramento
// estiver ativo e não houver posição aberta (ainda sem gatilho de entrada), reavalia
// as moedas para manter sempre a de maior eficácia selecionada.
setInterval(() => {
    if (MONITOR.active && !MONITOR.position && !MONITOR.coinScan.running) {
        addLog('⏱️ Backtest periódico (10 min) de seleção de moeda...', 'info');
        runCoinScan().catch(e => addLog(`⚠️ Erro no backtest periódico: ${e.message}`, 'warn'));
    }
}, 10 * 60 * 1000);

// Rede de segurança final: captura qualquer promise rejeitada que escape
// de todo o resto do código, e registra no log do app em vez de sumir no console do Render.
process.on('unhandledRejection', (reason) => {
    addLog(`💥 REJEIÇÃO NÃO TRATADA: ${reason && reason.message ? reason.message : String(reason)}`, 'err');
});
process.on('uncaughtException', (err) => {
    addLog(`💥 EXCEÇÃO NÃO CAPTURADA: ${err.message}`, 'err');
});

// ─── Autenticação opcional ──────────────────────────────────────────────────
// Se MONITOR_TOKEN estiver definida no Render, todas as rotas que mudam o
// estado (ligar/desligar monitoramento, fechar posição) exigem o header
// 'x-monitor-token'. Sem essa env var, o servidor continua público (não
// recomendado para uso real, mas evita travar quem ainda não configurou).
function requireAuth(req, res, next) {
    const token = process.env.MONITOR_TOKEN;
    if (!token) return next(); // não configurado = sem autenticação
    if (req.headers['x-monitor-token'] === token) return next();
    addLog('🔒 Tentativa de acesso negada: token inválido/ausente.', 'warn');
    return res.status(401).json({ success: false, error: 'Não autorizado. Envie o header x-monitor-token.' });
}

// ─── Rotas ──────────────────────────────────────────────────────────────────

app.get('/status', (req, res) => res.json(MONITOR));
app.get('/heartbeat', (req, res) => res.send('OK'));
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.post('/sync-par', requireAuth, (req, res) => {
    const { symbol, active, config, position, forceEntry } = req.body || {};

    if (active) {
        const wasInactive = !MONITOR.active;
        MONITOR.active = true;
        MONITOR.symbol = symbol || MONITOR.symbol;

        if (config) {
            MONITOR.config = {
                stopPct: parseFloat(config.stopPct) || 1.5,
                trailAct: parseFloat(config.trailAct) || 1.5,
                trailPull: parseFloat(config.trailPull) || 0.5,
                lev: parseInt(config.lev) || 1,
                orderQty: parseFloat(config.orderQty) || 0.1,
                partialInPct: parseFloat(config.partialInPct) || 5,
                partialOutPct: parseFloat(config.partialOutPct) || 50,
                emaScore: parseFloat(config.emaScore) || 40,
                vwapScore: parseFloat(config.vwapScore) || 30,
                oiScore: parseFloat(config.oiScore) || 20,
                volRatio: parseFloat(config.volRatio) || 1.2,
                scoreMin: parseFloat(config.scoreMin) || 50,
                volMin: parseFloat(config.volMin) || 1.0
            };
            addLog(`⚙️ CONFIGURAÇÕES: scoreMin=${MONITOR.config.scoreMin}, volMin=${MONITOR.config.volMin}, ema=${MONITOR.config.emaScore}, vwap=${MONITOR.config.vwapScore}, oi=${MONITOR.config.oiScore}, lev=${MONITOR.config.lev}x, qty=${MONITOR.config.orderQty}`, 'info');
        }

        if (position) {
            const entry = parseFloat(position.entry);
            const qty = parseFloat(position.qty);
            const side = (position.side || '').toLowerCase();
            if ((side !== 'long' && side !== 'short') || !isFinite(entry) || entry <= 0 || !isFinite(qty) || qty <= 0) {
                addLog(`⚠️ Payload de posição inválido (side=${position.side}, entry=${position.entry}, qty=${position.qty}). Ignorando restauração.`, 'warn');
            } else {
                MONITOR.position = {
                    side,
                    entry,
                    qty,
                    peak: parseFloat(position.peak) || entry,
                    trailActive: !!position.trailActive,
                    partialCount: 0,
                    lastAportePrice: entry,
                    partialExitDone: false
                };
                addLog(`📊 POSIÇÃO RESTAURADA: ${MONITOR.position.side.toUpperCase()} @ ${MONITOR.position.entry}, qty=${MONITOR.position.qty}`, 'info');
            }
        }

        // Verifica credenciais assim que o monitoramento é ligado — feedback imediato no app
        checkCredentials();

        // Início do monitoramento (ou primeiro sync após restart): dispara o backtest de
        // seleção de moeda (últimas 24h) com a config recém-recebida, igual ao "Escanear" da aba PAR.
        if (wasInactive || !MONITOR.coinScan.lastScanAt) {
            addLog('🔍 Monitoramento iniciado: disparando backtest inicial de seleção de moeda...', 'info');
            runCoinScan().catch(e => addLog(`⚠️ Erro no backtest inicial: ${e.message}`, 'warn'));
        }

        if (forceEntry) {
            addLog(`⚡ FORÇAR ENTRADA: ${forceEntry.side.toUpperCase()}`, 'warn');
            placeOrder(forceEntry.side, MONITOR.config.orderQty).then(q => {
                if (q) {
                    MONITOR.position = { side: forceEntry.side.toLowerCase(), entry: MONITOR.indicators.price, qty: q, peak: MONITOR.indicators.price, trailActive: false, partialCount: 0, lastAportePrice: MONITOR.indicators.price, partialExitDone: false };
                    addLog(`✅ ENTRADA FORÇADA EXECUTADA: ${forceEntry.side.toUpperCase()} qty=${q}`, 'ok');
                } else {
                    addLog('❌ FALHA NA ENTRADA FORÇADA: veja o erro específico acima.', 'err');
                }
            }).catch(e => addLog(`💥 Erro na entrada forçada: ${e.message}`, 'err'));
        }

        addLog(`🚀 MONITORAMENTO INICIADO: ${MONITOR.symbol}`, 'ok');
    } else {
        // Parar: tenta fechar posição aberta antes de desativar.
        // Usa o lock compartilhado para nunca competir com o engine no meio de um tick.
        MONITOR.active = false;
        addLog('⏹️ MONITORAMENTO ENCERRADO', 'warn');
        if (MONITOR.position) {
            const pos = MONITOR.position;
            addLog('⏹️ Tentando fechar posição aberta na Bybit...', 'warn');
            withTradeLock(() => placeOrder(pos.side === 'long' ? 'short' : 'long', pos.qty, true))
                .then(q => {
                    if (q !== null) {
                        MONITOR.position = null;
                        addLog('✅ Posição fechada com sucesso.', 'ok');
                    } else {
                        addLog('🚨 CRÍTICO: falha ao fechar posição na Bybit! Feche MANUALMENTE na exchange e use POST /close-position para limpar o estado.', 'err');
                    }
                })
                .catch(e => addLog(`⚠️ Fechamento ao parar adiado: ${e.message}`, 'warn'));
        }
    }
    res.json({ success: true });
});

// POST /close-position — fecha manualmente pelo app, sem parar o monitoramento
app.post('/close-position', requireAuth, async (req, res) => {
    if (!MONITOR.position) {
        return res.status(400).json({ success: false, error: 'Nenhuma posição aberta.' });
    }
    try {
        const result = await withTradeLock(async () => {
            const pos = MONITOR.position;
            addLog(`📲 FECHAMENTO MANUAL solicitado: ${pos.side.toUpperCase()} ${pos.qty}`, 'warn');
            const q = await placeOrder(pos.side === 'long' ? 'short' : 'long', pos.qty, true);
            if (q !== null) {
                MONITOR.position = null;
                addLog(`✅ Posição fechada manualmente. Qty: ${q}`, 'ok');
            }
            return q;
        });
        if (result !== null) return res.json({ success: true, closedQty: result });
        return res.status(500).json({ success: false, error: 'Falha ao enviar ordem de fechamento. Veja os logs.' });
    } catch (e) {
        return res.status(409).json({ success: false, error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`Scanner Pro v9.6 BLINDADO na porta ${PORT}`);
    checkCredentials();
});
