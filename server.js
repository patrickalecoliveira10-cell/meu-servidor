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
    logs: []
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

        if (!isReduce) {
            const currentPrice = MONITOR.indicators.price || 0;
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
    try {
        await engineTick();
    } catch (e) {
        addLog(`💥 ERRO INESPERADO NO ENGINE (antes invisível!): ${e.message}`, 'err');
    } finally {
        MONITOR.tradeLock = false;
    }
}, 5000);

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
