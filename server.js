// ╔══════════════════════════════════════════════════════════════════════╗
// ║   BYBIT SCANNER PRO — SERVER v10.0 (BACKTEST ALINHADO COM O APP)      ║
// ║   Correções: Backtest do servidor agora usa EXATAMENTE a mesma janela ║
// ║   de candles (300, 1m), o mesmo passo de simulação (candle a candle), ║
// ║   a mesma janela de scoring (histórico completo, sem recorte de 250   ║
// ║   candles), a mesma duração de simulação (sem teto de 60 candles) e a ║
// ║   mesma classificação de vitória/derrota (timeout também é derrota)   ║
// ║   usadas pelo backtest do app. Corrigido também o handover para a     ║
// ║   nuvem: o gatilho já disparado no app agora é avaliado e executado   ║
// ║   imediatamente ao assumir o monitoramento, antes do re-scan de       ║
// ║   moeda mais eficiente (que antes podia trocar a moeda e descartar o  ║
// ║   sinal que já estava válido no momento da entrega).                  ║
// ╚══════════════════════════════════════════════════════════════════════╝

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const cors    = require('cors');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 10000;
app.use(cors());
app.use(express.json());

// ─── Estado global ────────────────────────────────────────────────────────────

let MONITOR = {
    active: false,
    symbol: null,
    engineRunning: false,
    tradeLock: false,
    config: {
        // Gatilhos (Sincronizados com a aba "Gatilhos" do App)
        emaScore: 40, 
        vwapScore: 30, 
        oiScore: 20,
        scoreMin: 70, // vindo do entrySc do App
        volMin: 1.5,  // vindo do volRatio do App
        
        // Operação (Sincronizados com "Configurar Par" e "Configurações")
        stopPct: 1.5, 
        trailAct: 1.5, 
        trailPull: 0.5,
        lev: 1, 
        orderQty: 0.1, 
        partialInPct: 5, 
        partialOutPct: 50,
        bankPct: 30
    },
    position: null,
    indicators: { scoreL: 0, scoreS: 0, volRatio: 0, price: 0 },
    logs: [],
    tradingPaused: false,
    symbolBlacklist: [],
    logCounter: 0,
    coinScan: {
        running: false, lastScanAt: 0,
        results: [], bestSymbol: null, bestWr: 0
    },
    trades: [], 
    balance: 0 
};

// ─── Log ──────────────────────────────────────────────────────────────────────

function addLog(msg, type = 'info') {
    const ts = new Date().toLocaleTimeString('pt-BR');
    MONITOR.logs.unshift({ time: Date.now(), msg: `[${ts}] ${msg}`, type });
    if (MONITOR.logs.length > 100) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ─── Registro de Trades ────────────────────────────────────────────────────────

function recordTrade(position, exitPrice, reason) {
    if (!position) return;
    const trade = {
        symbol: MONITOR.symbol,
        side: position.side,
        pnl: position.curPnl || 0,
        entry: position.entry,
        exit: exitPrice,
        entryTime: position.entryTime || Date.now(),
        exitTime: Date.now(),
        reason: reason,
        score: Math.max(MONITOR.indicators.scoreL, MONITOR.indicators.scoreS)
    };
    MONITOR.trades.unshift(trade);
    if (MONITOR.trades.length > 50) MONITOR.trades.pop();
    addLog(`📊 Trade registrado: ${trade.symbol} ${trade.side.toUpperCase()} PnL: ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)} USDT (${reason})`, trade.pnl >= 0 ? 'ok' : 'err');
}

// ─── Bybit API ────────────────────────────────────────────────────────────────

async function bybitRequest(method, endpoint, data = {}) {
    try {
        const key    = process.env.BYBIT_API_KEY;
        const secret = process.env.BYBIT_API_SECRET;
        if (!key || !secret) return { error: 'missing_credentials' };
        const timestamp  = Date.now().toString();
        const baseUrl    = process.env.USE_TESTNET === 'true' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
        const parameters = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
        const sign = crypto.createHmac('sha256', secret).update(timestamp + key + '5000' + parameters).digest('hex');
        const res = await axios({
            method, url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: { 'X-BAPI-API-KEY': key, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': '5000', ...(method !== 'GET' && { 'Content-Type': 'application/json' }) },
            data: method !== 'GET' ? parameters : undefined, timeout: 8000,
        });
        return res.data;
    } catch (e) { return { error: e.message }; }
}

// ─── Ordem ────────────────────────────────────────────────────────────────────

async function placeOrder(side, qty, isReduce = false) {
    if (!MONITOR.symbol) return null;
    // CORREÇÃO: o app sempre sincroniza a alavancagem configurada na Bybit
    // (via /v5/position/set-leverage) antes de abrir uma posição — o servidor
    // não fazia isso, então a posição abria com a alavancagem que já estivesse
    // configurada na conta/símbolo (às vezes bem maior que a do app). Como o
    // ROI usado no stop/trailing é baseado na alavancagem real da posição
    // (ver syncPositionWithBybit → curRoi), uma alavancagem real maior faz o
    // ROI subir muito mais rápido por variação de preço, disparando o stop
    // com um movimento de preço bem menor do que o configurado ("stop curtinho").
    // Só faz sentido ajustar ao ABRIR posição nova (não em ordens de redução).
    if (!isReduce) {
        const lev = Math.max(1, parseInt(MONITOR.config.lev) || 1);
        try {
            await bybitRequest('POST', '/v5/position/set-leverage', {
                category: 'linear', symbol: MONITOR.symbol,
                buyLeverage: String(lev), sellLeverage: String(lev)
            });
        } catch (e) { /* ignora erro se a alavancagem já estiver correta */ }
    }
    let finalQty = qty;
    const info = await bybitRequest('GET', '/v5/market/instruments-info', { category: 'linear', symbol: MONITOR.symbol });
    if (info?.result?.list?.[0]) {
        const limits = info.result.list[0].lotSizeFilter;
        const step = parseFloat(limits.qtyStep);
        const precision = Math.max(0, Math.round(-Math.log10(step)));
        const currentPrice = MONITOR.indicators.price || 0;
        if (!isReduce && currentPrice > 0) {
            const minQtyForNotional = Math.ceil((5.2 / currentPrice) / step) * step;
            if (finalQty < minQtyForNotional) finalQty = minQtyForNotional;
        }
        finalQty = Math.floor(finalQty / step) * step;
        finalQty = parseFloat(finalQty.toFixed(precision));
    }
    const res = await bybitRequest('POST', '/v5/order/create', {
        category: 'linear', symbol: MONITOR.symbol, side: side.toLowerCase() === 'long' ? 'Buy' : 'Sell',
        orderType: 'Market', qty: finalQty.toString(), timeInForce: 'GTC', reduceOnly: isReduce,
    });
    if (res?.retCode === 0) return finalQty;
    if (res?.retCode === 110126) {
        if (!MONITOR.symbolBlacklist.includes(MONITOR.symbol)) MONITOR.symbolBlacklist.push(MONITOR.symbol);
        addLog(`🚫 ${MONITOR.symbol} exige acordo. Bloqueada.`, 'err');
        MONITOR.tradingPaused = true;
        runCoinScan().catch(()=>{});
    }
    return null;
}

// ─── Sincronização ────────────────────────────────────────────────────────────

async function syncBalance() {
    try {
        const res = await bybitRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
        if (res?.retCode === 0 && res.result?.list?.[0]) {
            const wallet = res.result.list[0];
            MONITOR.balance = parseFloat(wallet.coin?.find(c => c.coin === 'USDT')?.walletBalance || 0);
        }
    } catch (e) {}
}

async function syncPositionWithBybit() {
    if (!MONITOR.symbol || !MONITOR.active) return;
    try {
        const res = await bybitRequest('GET', '/v5/position/list', { category: 'linear', symbol: MONITOR.symbol });
        if (res?.retCode === 0 && res.result?.list?.length > 0) {
            const bPos = res.result.list[0];
            const size = parseFloat(bPos.size);
            if (size > 0) {
                if (!MONITOR.position) {
                    MONITOR.position = {
                        side: bPos.side === 'Buy' ? 'long' : 'short', entry: parseFloat(bPos.avgPrice),
                        qty: size, peak: parseFloat(bPos.markPrice), trailActive: false, partialCount: 0,
                        lastAportePrice: parseFloat(bPos.avgPrice), partialExitDone: false, partialExitCount: 0,
                        entryTime: Date.now(), maxPartials: 2
                    };
                }
                const pnl = parseFloat(bPos.unrealisedPnl);
                const value = parseFloat(bPos.positionValue);
                const lev = parseFloat(bPos.leverage) || MONITOR.config.lev;
                MONITOR.position.qty = size;
                MONITOR.position.entry = parseFloat(bPos.avgPrice);
                MONITOR.position.curPnl = pnl;
                MONITOR.position.valueUSDT = value;
                MONITOR.position.curRoi = (pnl / (value / lev)) * 100;
            } else if (MONITOR.position) {
                recordTrade(MONITOR.position, MONITOR.indicators.price, 'closed_bybit');
                addLog('🏁 Posição encerrada na corretora.', 'info');
                MONITOR.position = null;
                runCoinScan().catch(() => {});
            }
        }
    } catch (e) {}
}

// ─── Taxas Bybit ──────────────────────────────────────────────────────────────
// Taxa taker padrão da Bybit para perpétuos USDT: ~0,055% por lado.
// Round-trip (abertura + fechamento) = 0,11%. Como o ROI aqui é medido sobre a
// margem (ROI% = variação de preço% * alavancagem), a taxa também precisa ser
// escalada pela alavancagem para representar seu real impacto no ROI.
const BYBIT_TAKER_FEE_PCT = 0.055;
const ROUNDTRIP_FEE_PCT = BYBIT_TAKER_FEE_PCT * 2; // 0.11%
function netRoi(roi, lev) { return roi - (ROUNDTRIP_FEE_PCT * lev); }

// ─── Cálculos Técnicos ────────────────────────────────────────────────────────

function calcEMA(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
    return ema;
}

async function engineScoring() {
    if (!MONITOR.symbol) return null;
    const kRes = await bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol: MONITOR.symbol, interval: '1', limit: '201' });
    if (!kRes?.result?.list?.length) return null;
    const list = [...kRes.result.list].reverse();
    const prices = list.map(k => parseFloat(k[4]));
    const curP = prices[prices.length - 1];
    const ema200 = calcEMA(prices, 200);
    
    let sL = curP > ema200 ? MONITOR.config.emaScore : 0, sS = curP < ema200 ? MONITOR.config.emaScore : 0;
    let vSum = 0, volSum = 0;
    list.slice(-50).forEach(k => { vSum += ((parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3) * parseFloat(k[5]); volSum += parseFloat(k[5]); });
    const vwap = volSum > 0 ? vSum / volSum : curP;
    sL += curP > vwap ? MONITOR.config.vwapScore : 0; sS += curP < vwap ? MONITOR.config.vwapScore : 0;
    
    const oiRes = await bybitRequest('GET', '/v5/market/open-interest', { category: 'linear', symbol: MONITOR.symbol, intervalTime: '5min', limit: '2' });
    if (oiRes?.result?.list?.length >= 2) {
        if (parseFloat(oiRes.result.list[0].openInterest) > parseFloat(oiRes.result.list[1].openInterest)) {
            if (curP > prices[prices.length - 2]) sL += MONITOR.config.oiScore; else if (curP < prices[prices.length - 2]) sS += MONITOR.config.oiScore;
        }
    }
    const avgVol = list.slice(-21, -1).reduce((a, b) => a + parseFloat(b[5]), 0) / 20;
    MONITOR.indicators = { scoreL: sL, scoreS: sS, volRatio: avgVol > 0 ? parseFloat(list[list.length - 1][5]) / avgVol : 0, price: curP };
    return MONITOR.indicators;
}

// ─── Backtest Logic (ALINHADO COM O BACKTEST DO APP) ──────────────────────────
// O app (parServerBacktest / serverEngineScoring / serverSimulatePosition) faz:
//  - Busca exatamente 300 candles de 1 minuto (parGetCandles(sym,'1',300)).
//  - Roda o scoring em CADA candle (passo 1), sempre com o histórico completo
//    desde o candle 0 até o índice atual (sem recorte de janela).
//  - Simula a posição até o FIM do array de candles (sem teto de velas), usando
//    ROI bruto (sem desconto de taxa) para a saída de segurança.
//  - Classifica como DERROTA tanto 'stop' quanto 'timeout' (só o resto é vitória).
// O backtest do servidor abaixo foi reescrito para reproduzir exatamente esse
// comportamento, para que o WR calculado pelo servidor bata com o do app.

async function fetchDayCandles(symbol) {
    // Mesma fonte de dados usada pelo app no backtest: 300 candles de 1 minuto,
    // do mais recente ao mais antigo, reordenados para ordem crescente de tempo.
    const kRes = await bybitRequest('GET', '/v5/market/kline', { category: 'linear', symbol, interval: '1', limit: '300' });
    if (!kRes?.result?.list?.length) return [];
    return [...kRes.result.list].reverse().map(k => ({ time: parseFloat(k[0]), close: parseFloat(k[4]), vol: parseFloat(k[5]), high: parseFloat(k[2]), low: parseFloat(k[3]) }));
}

function btScoring(candles, config) {
    if (candles.length < 200) return null;
    const closes = candles.map(c => c.close), curP = closes[closes.length - 1];
    const ema200 = calcEMA(closes, 200);
    let sL = curP > ema200 ? config.emaScore : 0, sS = curP < ema200 ? config.emaScore : 0;
    let vSum = 0, volSum = 0; candles.slice(-50).forEach(c => { vSum += ((c.high + c.low + c.close) / 3) * c.vol; volSum += c.vol; });
    const vwap = volSum > 0 ? vSum / volSum : curP;
    sL += curP > vwap ? config.vwapScore : 0; sS += curP < vwap ? config.vwapScore : 0;

    // Proxy de OI para o backtest: a Bybit não fornece histórico de Open Interest por
    // candle de 1min (só os últimos ~5min recentes), então é IMPOSSÍVEL recalcular OI
    // real para cada ponto do dia anterior. Sem essa pontuação, o score máximo do
    // backtest ficava travado em emaScore+vwapScore — tornando inatingível qualquer
    // scoreMin configurado acima desse teto, mesmo que o motor ao vivo (que usa OI
    // real da API) conseguisse disparar normalmente. Usamos a mesma aproximação que
    // o app usa (variação de volume das últimas 5 velas) para manter o range de score
    // do backtest compatível com o do motor ao vivo.
    const last5 = candles.slice(-5);
    if (last5.length >= 2 && last5[0].vol > 0) {
        const volChange = (candles[candles.length - 1].vol - last5[0].vol) / last5[0].vol;
        let oiProxy = 0;
        if (volChange > 0.3) oiProxy = config.oiScore;
        else if (volChange > 0.1) oiProxy = config.oiScore * 0.5;
        sL += oiProxy; sS += oiProxy;
    }

    const avgVol = candles.slice(-21, -1).reduce((a, b) => a + b.vol, 0) / 20;
    return { scoreL: sL, scoreS: sS, volRatio: avgVol > 0 ? candles[candles.length - 1].vol / avgVol : 0 };
}

// Reaproveita btScoring (sem alterá-la) para calcular o score em QUALQUER índice
// do array de candles. IMPORTANTE: usa o histórico COMPLETO desde o candle 0 até
// o índice, exatamente como o app faz em serverEngineScoring(candles.slice(0,i+1)).
// Um recorte de janela (ex.: últimos 250 candles) muda a semente da EMA200 e
// produz scores diferentes dos calculados pelo app — foi essa a causa raiz do
// backtest do servidor divergir do backtest do app.
function btScoringAt(candles, idx, config) {
    if (idx < 200) return null;
    return btScoring(candles.slice(0, idx + 1), config);
}

// Simula a posição usando EXATAMENTE a mesma lógica do backtest do app
// (serverSimulatePosition):
//  - Stop loss tem prioridade máxima.
//  - Antes do trailing ativar: gatilho contrário + ROI BRUTO (sem desconto de
//    taxa) positivo fecha tudo (segurança) — o app não desconta taxa aqui.
//  - Antes do trailing ativar: gatilho a favor + ROI positivo faria aporte (não
//    altera a classificação de resultado do backtest, que é só win/loss).
//  - Depois do trailing ativar: recuo (pull) atingido fecha tudo (trailing stop).
//  - Depois do trailing ativar e recuo não atingido: gatilho contrário fecha 50%,
//    se repetir fecha o restante (100%).
//  - Simulação roda até o FIM do array de candles (sem teto de velas), igual ao app.
function btSimulatePosition(candles, entryIdx, side, config) {
    const entry = candles[entryIdx].close;
    const isL = side === 'long';
    let pos = { peak: entry, trailActive: false, partialExitCount: 0 };
    let lastRoi = 0;

    for (let i = entryIdx + 1; i < candles.length; i++) {
        const price = candles[i].close;
        const roi = (isL ? (price - entry) / entry : (entry - price) / entry) * 100 * config.lev;
        lastRoi = roi;

        // Stop loss — prioridade máxima
        if (roi <= -config.stopPct) return { result: 'stop', roi: -config.stopPct };

        const sc = btScoringAt(candles, i, config);
        const lTrig = !!sc && sc.scoreL >= config.scoreMin && sc.volRatio >= config.volMin;
        const sTrig = !!sc && sc.scoreS >= config.scoreMin && sc.volRatio >= config.volMin;
        // Não considera gatilho quando os dois lados disparam ao mesmo tempo (igual ao engineTick)
        const bothTrig = lTrig && sTrig;
        const contrary = !bothTrig && (isL ? sTrig : lTrig);

        if (!pos.trailActive) {
            // Segurança: positiva + contrário + trailing ainda não ativo → fecha tudo.
            // Usa ROI bruto (igual ao app), não o líquido de taxa — o app não desconta
            // taxa nessa checagem, então para o backtest bater precisamos fazer o mesmo.
            if (contrary && roi >= 0) return { result: 'safety', roi };
            // Ativação do trailing
            if (roi >= config.trailAct) { pos.trailActive = true; pos.peak = price; }
            continue;
        }

        // Trailing já ativo — atualiza pico
        if (isL && price > pos.peak) pos.peak = price;
        else if (!isL && price < pos.peak) pos.peak = price;
        const pull = (isL ? (pos.peak - price) / pos.peak : (price - pos.peak) / pos.peak) * 100 * config.lev;

        // Recuo atingido → fecha o restante
        if (pull >= config.trailPull) return { result: 'trail', roi };

        // Recuo ainda não atingido, mas veio gatilho contrário → saída parcial em 2 etapas
        if (contrary) {
            pos.partialExitCount = (pos.partialExitCount || 0) + 1;
            if (pos.partialExitCount >= 2) return { result: 'contrary_partial_final', roi };
            // primeira parcial (50%): posição continua aberta com o restante
        }
    }
    return { result: 'timeout', roi: lastRoi };
}

async function runCoinScan() {
    if (MONITOR.coinScan.running) return;
    MONITOR.coinScan.running = true;
    // Guarda a moeda que estava selecionada/em operação ANTES deste escaneamento
    // (é a que o app escolheu no backtest dele, ou a que o servidor já vinha operando).
    const originalSymbol = MONITOR.symbol;
    try {
        const c = MONITOR.config;
        addLog(`🔍 Scanner: iniciando backtest (300 candles de 1m, igual ao app) — Gatilho EMA${c.emaScore}+VWAP${c.vwapScore}+OI${c.oiScore} | Score≥${c.scoreMin} Vol≥${c.volMin} | SL${c.stopPct}% Trail+${c.trailAct}%/-${c.trailPull}% | Lev${c.lev}x Banca${c.bankPct}% | moeda atual: ${originalSymbol || '—'}`, 'info');

        const tickRes = await bybitRequest('GET', '/v5/market/tickers', { category: 'linear' });
        const movers = (tickRes?.result?.list || [])
            .filter(t => t.symbol.endsWith('USDT') && !MONITOR.symbolBlacklist.includes(t.symbol))
            .sort((a, b) => (parseFloat(b.volume24h)*parseFloat(b.lastPrice)) - (parseFloat(a.volume24h)*parseFloat(a.lastPrice)))
            .slice(0, 15).map(m => m.symbol);
        addLog(`🔍 Scanner: ${movers.length} pares por volume selecionados para testar: ${movers.join(', ')}`, 'info');

        const results = [];
        for (const sym of movers) {
            const candles = await fetchDayCandles(sym);
            if (candles.length < 200) { addLog(`⏭️ Scanner: ${sym} sem candles suficientes — pulado`, 'info'); continue; }
            let wins = 0, total = 0, maxScoreSeen = 0, maxVolRatioSeen = 0, samples = 0;
            for (let i = 200; i < candles.length - 20; i++) {
                const sc = btScoring(candles.slice(0, i + 1), MONITOR.config);
                samples++;
                const topScore = Math.max(sc.scoreL, sc.scoreS);
                if (topScore > maxScoreSeen) maxScoreSeen = topScore;
                if (sc.volRatio > maxVolRatioSeen) maxVolRatioSeen = sc.volRatio;
                const lTrig = sc.scoreL >= MONITOR.config.scoreMin && sc.volRatio >= MONITOR.config.volMin;
                const sTrig = sc.scoreS >= MONITOR.config.scoreMin && sc.volRatio >= MONITOR.config.volMin;
                // Igual ao engineTick: se os dois lados dispararem juntos, não é considerado gatilho de entrada
                if (lTrig && sTrig) continue;
                if (lTrig || sTrig) {
                    const res = btSimulatePosition(candles, i, lTrig ? 'long' : 'short', MONITOR.config);
                    total++;
                    // Igual ao backtest do app: 'stop' e 'timeout' são derrota, o resto é vitória.
                    if (res.result !== 'stop' && res.result !== 'timeout') wins++;
                }
            }
            if (total > 0) {
                const wr = wins / total;
                results.push({ symbol: sym, wr, n: total });
                addLog(`📊 Scanner: ${sym} → WR ${(wr*100).toFixed(1)}% (${total} trades simulados com o gatilho/lógica configurados)`, 'info');
            } else {
                addLog(`⚪ Scanner: ${sym} — nenhum gatilho válido no período (melhor score visto: ${maxScoreSeen.toFixed(0)}/${MONITOR.config.scoreMin} exigido | melhor volRatio: ${maxVolRatioSeen.toFixed(2)}x/${MONITOR.config.volMin}x exigido | ${samples} amostras)`, 'info');
            }
        }
        results.sort((a, b) => b.wr - a.wr);
        MONITOR.coinScan.results = results;
        MONITOR.coinScan.lastScanAt = Date.now();

        if (results.length > 0) {
            const best = results[0];
            MONITOR.coinScan.bestSymbol = best.symbol; MONITOR.coinScan.bestWr = best.wr;
            addLog(`🏆 Scanner: moeda mais eficiente → ${best.symbol} (WR ${(best.wr*100).toFixed(1)}% em ${best.n} trades)`, 'ok');

            if (!MONITOR.position) {
                if (originalSymbol === best.symbol) {
                    addLog(`✅ Scanner: ${best.symbol} já era a moeda selecionada/operada — CONFIRMADA como a mais eficiente. Mantendo operação nela.`, 'ok');
                } else {
                    addLog(`🔀 Scanner: ${originalSymbol || 'nenhuma moeda'} NÃO é a mais eficiente → trocando para ${best.symbol} (WR ${(best.wr*100).toFixed(1)}%). Servidor assume operação nela.`, 'ok');
                    MONITOR.symbol = best.symbol;
                }
                MONITOR.tradingPaused = false;
            } else {
                addLog(`⏸️ Scanner: posição aberta em ${MONITOR.symbol} — resultado registrado, troca de moeda só ocorre com a posição fechada.`, 'info');
            }
        } else {
            addLog(`⚠️ Scanner: nenhum par com gatilho válido — mantendo ${originalSymbol || 'nenhuma moeda'} até o próximo escaneamento.`, 'warn');
        }
    } finally { MONITOR.coinScan.running = false; }
}

// ─── Engine Tick ──────────────────────────────────────────────────────────────

async function engineTick() {
    if (!MONITOR.active || !MONITOR.symbol) return;
    await syncBalance();
    await syncPositionWithBybit();
    const data = await engineScoring(); if (!data) return;
    const { scoreL, scoreS, volRatio, price } = data;
    const { scoreMin, volMin, stopPct, trailAct, trailPull, lev, bankPct } = MONITOR.config;

    if (!MONITOR.position) {
        if (MONITOR.tradingPaused) return;
        const lTrig = scoreL >= scoreMin && volRatio >= volMin;
        const sTrig = scoreS >= scoreMin && volRatio >= volMin;
        // Os dois lados dispararam ao mesmo tempo → não entra, espera só um lado confirmar
        if (lTrig && sTrig) return;

        const side = lTrig ? 'long' : (sTrig ? 'short' : null);
        if (side) {
            let qty = MONITOR.config.orderQty;
            const positionValue = (MONITOR.balance * (bankPct / 100)) * lev;
            if (positionValue > 0 && price > 0) qty = positionValue / price;

            const executedQty = await placeOrder(side, qty);
            if (executedQty) {
                MONITOR.position = {
                    side, entry: price, qty: executedQty, peak: price, trailActive: false,
                    partialCount: 0, lastAportePrice: price, partialExitDone: false, partialExitCount: 0,
                    entryTime: Date.now(), maxPartials: 2, initialQty: executedQty
                };
                addLog(`📥 Entrada ${side.toUpperCase()}: ${executedQty.toFixed(4)} @ ${price.toFixed(4)}`, 'ok');
            }
        }
        return;
    }

    const pos = MONITOR.position, isL = pos.side === 'long';
    const roi = pos.curRoi !== undefined ? pos.curRoi : (isL ? (price - pos.entry) / pos.entry : (pos.entry - price) / pos.entry) * 100 * lev;
    // "Positiva" para as decisões de segurança/aporte é líquida da taxa de
    // entrada+saída (round-trip), não o ROI bruto de preço.
    const roiNet = netRoi(roi, lev);

    // ── STOP LOSS — prioridade máxima, sempre verificado primeiro ──────────────
    if (roi <= -stopPct) {
        if (await placeOrder(isL ? 'short' : 'long', pos.qty, true)) {
            recordTrade(pos, price, 'stop_loss');
            MONITOR.position = null;
            runCoinScan().catch(() => {}); // reavalia a moeda mais eficiente após fechar
        }
        return;
    }

    const lTrigNow = scoreL >= scoreMin && volRatio >= volMin;
    const sTrigNow = scoreS >= scoreMin && volRatio >= volMin;
    const bothTrigNow = lTrigNow && sTrigNow; // ambos ao mesmo tempo não conta como gatilho válido
    const contrary = !bothTrigNow && (isL ? sTrigNow : lTrigNow);
    const sameDir  = !bothTrigNow && (isL ? lTrigNow : sTrigNow);

    if (!pos.trailActive) {
        // ── SEGURANÇA: positiva (líquida de taxa) + gatilho contrário + trailing ainda não ativo → fecha tudo ──
        if (contrary && roiNet >= 0) {
            if (await placeOrder(isL ? 'short' : 'long', pos.qty, true)) {
                recordTrade(pos, price, 'contrary_signal');
                MONITOR.position = null;
                runCoinScan().catch(() => {});
            }
            return;
        }

        // ── APORTE PARCIAL (máx. 2, só antes do trailing ativar) ────────────────
        // Respeita o % configurado na aba "Configurar Par"; se a banca for pequena,
        // ainda assim garante o notional mínimo exigido pela Bybit (5.2 USDT).
        if (sameDir && roiNet > 0 && pos.partialCount < 2) {
            const pVal = (MONITOR.balance * (MONITOR.config.partialInPct / 100)) * lev;
            let pQty = pVal / price;
            if (pQty * price < 5.2) pQty = 5.2 / price;
            const exe = await placeOrder(pos.side, pQty);
            if (exe) { pos.qty += exe; pos.partialCount++; addLog(`📈 Aporte ${pos.partialCount}/2: +${exe.toFixed(4)}`, 'ok'); }
        }

        // ── ATIVAÇÃO DO TRAILING ─────────────────────────────────────────────────
        if (roi >= trailAct) {
            pos.trailActive = true;
            pos.peak = price;
            addLog(`🚀 Trailing ativo @ ${price}`, 'ok');
        }
        return;
    }

    // ── TRAILING JÁ ATIVO ──────────────────────────────────────────────────────
    if (isL && price > pos.peak) pos.peak = price;
    else if (!isL && price < pos.peak) pos.peak = price;

    const pull = (isL ? (pos.peak - price) / pos.peak : (price - pos.peak) / pos.peak) * 100 * lev;

    // Recuo atingido → fecha o restante da posição (trailing stop)
    if (pull >= trailPull) {
        if (await placeOrder(isL ? 'short' : 'long', pos.qty, true)) {
            recordTrade(pos, price, 'trailing_stop');
            MONITOR.position = null;
            runCoinScan().catch(() => {});
        }
        return;
    }

    // Recuo ainda não atingido, mas apareceu gatilho contrário → saída parcial em 2 etapas
    if (contrary) {
        if ((pos.partialExitCount || 0) === 0) {
            // 1ª parcial: fecha o % configurado em "Configurar Par" (padrão 50%)
            const exitFrac = Math.min(0.95, Math.max(0.05, (MONITOR.config.partialOutPct || 50) / 100));
            const exitQty = pos.qty * exitFrac;
            const exe = await placeOrder(isL ? 'short' : 'long', exitQty, true);
            if (exe) {
                pos.qty -= exe;
                pos.partialExitCount = 1;
                addLog(`📤 Saída parcial 1/2 (${(exitFrac*100).toFixed(0)}%) por sinal contrário: -${exe.toFixed(4)}`, 'ok');
            }
        } else if (pos.partialExitCount === 1) {
            // 2ª parcial: fecha o restante (os outros 50%, ou o que sobrou)
            if (await placeOrder(isL ? 'short' : 'long', pos.qty, true)) {
                recordTrade(pos, price, 'contrary_partial_final');
                addLog(`📤 Saída parcial 2/2 (restante) por sinal contrário — posição encerrada`, 'ok');
                MONITOR.position = null;
                runCoinScan().catch(() => {});
            }
        }
    }
}

// ─── Loops & Rotas ────────────────────────────────────────────────────────────

setInterval(async () => {
    if (MONITOR.tradeLock) return; MONITOR.tradeLock = true;
    try { await engineTick(); } catch (e) {} finally { MONITOR.tradeLock = false; }
}, 5000);

setInterval(() => { if (MONITOR.active && !MONITOR.position) runCoinScan(); }, 10 * 60 * 1000);

app.get('/status', (req, res) => res.json(MONITOR));

app.post('/sync-par', async (req, res) => {
    const { symbol, active, config, position } = req.body;
    if (active) {
        MONITOR.active = true; 
        if (symbol) MONITOR.symbol = symbol;
        if (config) {
            // IMPORTANTE: o app (parHandoverToServer) envia os campos como
            // `scoreMin`, `stopPct` e `volMin`/`volRatio` — não `entrySc`/`sl`.
            // Aceita os dois formatos (novo primeiro, com fallback pro nome antigo)
            // para nunca cair silenciosamente no valor padrão ignorando o que o
            // usuário configurou na aba Par → Gatilho de Entrada / Configurar Par.
            const scoreMinIn = (config.scoreMin !== undefined ? config.scoreMin : config.entrySc);
            const stopPctIn  = (config.stopPct  !== undefined ? config.stopPct  : config.sl);
            // O app tem 2 campos de volume ("Volume Ratio Mínimo" e "Volume Mínimo
            // Absoluto"); o motor só usa 1 limiar (volRatio >= volMin), então usamos
            // o mais restritivo (maior) dos dois configurados, garantindo que ambos
            // os critérios definidos pelo usuário sejam respeitados.
            const volCandidates = [config.volMin, config.volRatio].filter(v => v !== undefined && v !== null && !isNaN(v));
            const volMinIn = volCandidates.length ? Math.max(...volCandidates) : undefined;

            MONITOR.config = {
                ...MONITOR.config,
                emaScore: config.emaScore || 40,
                vwapScore: config.vwapScore || 30,
                oiScore: config.oiScore || 20,
                scoreMin: (scoreMinIn !== undefined ? scoreMinIn : 70),
                volMin: (volMinIn !== undefined ? volMinIn : 1.5),
                stopPct: (stopPctIn !== undefined ? stopPctIn : 1.5),
                trailAct: config.trailAct || 1.5,
                trailPull: config.trailPull || 0.5,
                lev: config.lev || 1,
                bankPct: config.bankPct || 30,
                partialInPct: config.partialInPct || 5,
                partialOutPct: config.partialOutPct || 50
            };
            addLog(`⚙️ Config sincronizada: Score≥${MONITOR.config.scoreMin} Vol≥${MONITOR.config.volMin} SL${MONITOR.config.stopPct}% Trail+${MONITOR.config.trailAct}%/-${MONITOR.config.trailPull}% Lev${MONITOR.config.lev}x Banca${MONITOR.config.bankPct}%`, 'info');
        }
        if (position) {
            MONITOR.position = { 
                ...position, lastAportePrice: position.entry, partialExitDone: false, 
                partialCount: 0, partialExitCount: 0, entryTime: Date.now(), maxPartials: 2, initialQty: position.qty 
            };
        }

        // CORREÇÃO: se o gatilho já estava válido no app no exato momento da entrega
        // (o app detectou o sinal mas ainda não tinha posição aberta), o servidor
        // precisa avaliar e executar essa entrada IMEDIATAMENTE — antes de rodar o
        // runCoinScan abaixo. Antes desta correção, o runCoinScan rodava primeiro e,
        // como nenhuma posição existia ainda, podia trocar MONITOR.symbol para outra
        // moeda "mais eficiente" no backtest de 300 candles, descartando o sinal que
        // já era válido na moeda escolhida pelo usuário — e a entrada nunca acontecia,
        // pois o próximo tick do motor (5s depois) já avaliava outra moeda do zero.
        if (!MONITOR.position && !MONITOR.tradeLock) {
            MONITOR.tradeLock = true;
            try { await engineTick(); } catch (e) {} finally { MONITOR.tradeLock = false; }
        }

        // Roda o backtest do servidor com a MESMA lógica configurada acima. Se a moeda
        // escolhida pelo app não for a mais eficiente encontrada, o servidor assume a
        // que for melhor (ver runCoinScan). Se for a mesma, mantém. Se a entrada
        // imediata acima já abriu posição, o runCoinScan não troca mais de moeda
        // (ver guarda `if (!MONITOR.position)` dentro dele).
        runCoinScan();
    } else {
        MONITOR.active = false; MONITOR.symbol = null; MONITOR.position = null;
        addLog('🛑 Servidor desativado pelo app', 'info');
    }
    res.json({ success: true });
});

app.listen(PORT, () => { console.log(`Scanner Pro v10.0 ativo na porta ${PORT}`); });
