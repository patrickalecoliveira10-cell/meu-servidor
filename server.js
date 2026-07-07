// ╔══════════════════════════════════════════════════════════════════════╗
// ║         BYBIT SCANNER PRO — SERVER v2.0 (DINHEIRO REAL)             ║
// ║  Deploy: Render.com  |  Porta: process.env.PORT || 10000            ║
// ║                                                                       ║
// ║  Variáveis de ambiente necessárias no Render:                        ║
// ║    BYBIT_API_KEY    = sua chave da Bybit                             ║
// ║    BYBIT_API_SECRET = seu secret da Bybit                            ║
// ║    USE_TESTNET      = true  (remova ou coloque false para real)       ║
// ╚══════════════════════════════════════════════════════════════════════╝

'use strict';

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const cors    = require('cors');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ─── Estado Global ─────────────────────────────────────────────────────────

const MONITOR = {
    active:       false,
    symbol:       null,
    engineRunning: false,   // lock anti-reentrância do loop de 5s
    config: {
        stopPct:       1.5,   // Stop em ROI% (alavancado)
        trailAct:      1.5,   // Trailing: ativar quando ROI atingir este %
        trailPull:     0.5,   // Trailing: fechar quando recuo atingir este %
        lev:           1,     // Alavancagem
        orderQty:      0.1,   // Quantidade da entrada (em contratos)
        partialInPct:  5,     // % da orderQty para cada aporte parcial
        partialOutPct: 50,    // % da posição para saída parcial
    },
    position: null,
    // position quando aberta: { side, entry, qty, peak, trailActive,
    //                           partialCount, lastAportePrice, partialExitDone }
    indicators: { scoreL: 0, scoreS: 0, volRatio: 0, price: 0 },
    logs: [],
};

// ─── Log ───────────────────────────────────────────────────────────────────

function addLog(msg, type = 'info') {
    const ts    = new Date().toLocaleTimeString('pt-BR');
    const entry = { time: Date.now(), msg: `[${ts}] ${msg}`, type };
    MONITOR.logs.unshift(entry);
    if (MONITOR.logs.length > 100) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ─── Bybit API ─────────────────────────────────────────────────────────────

async function bybitRequest(method, endpoint, data = {}) {
    const key       = process.env.BYBIT_API_KEY    || '';
    const secret    = process.env.BYBIT_API_SECRET || '';
    const timestamp = Date.now().toString();
    const baseUrl   = process.env.USE_TESTNET === 'true'
        ? 'https://api-testnet.bybit.com'
        : 'https://api.bybit.com';

    // Para POST: assina o JSON serializado e usa exatamente esse mesmo string no body.
    // Isso garante que a assinatura bate com o body transmitido (sem surpresa de serialização do axios).
    const parameters = method === 'GET'
        ? new URLSearchParams(data).toString()
        : JSON.stringify(data);

    const sign = crypto
        .createHmac('sha256', secret)
        .update(timestamp + key + '5000' + parameters)
        .digest('hex');

    try {
        const res = await axios({
            method,
            url:     baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: {
                'X-BAPI-API-KEY':      key,
                'X-BAPI-SIGN':         sign,
                'X-BAPI-TIMESTAMP':    timestamp,
                'X-BAPI-RECV-WINDOW':  '5000',
                // Envia Content-Type explícito e o JSON pré-serializado no body
                // para garantir que o que é transmitido bate exatamente com o que foi assinado
                ...(method !== 'GET' && { 'Content-Type': 'application/json' }),
            },
            // POST: usa a string JSON já serializada (não o objeto), para consistência com a assinatura
            data:    method !== 'GET' ? parameters : undefined,
            timeout: 8000,
        });
        return res.data;
    } catch (e) {
        const msg = e.message || String(e);
        addLog(`⚠️ Erro HTTP Bybit (${endpoint}): ${msg}`, 'err');
        return { error: msg };
    }
}

// ─── Ordem ─────────────────────────────────────────────────────────────────
// Retorna a quantidade confirmada pela Bybit, ou null se falhar.
// Estado interno só é mutado APÓS confirmação (retCode === 0).

async function placeOrder(side, qty, isReduce = false) {
    if (!MONITOR.symbol) return null;

    let finalQty = qty;

    // Ajusta quantidade mínima para entradas novas (não para reduções)
    if (!isReduce) {
        try {
            const info = await bybitRequest('GET', '/v5/market/instruments-info', {
                category: 'linear',
                symbol:   MONITOR.symbol,
            });
            const instr = info && info.result && info.result.list && info.result.list[0];
            if (instr) {
                const minQty = parseFloat(instr.lotSizeFilter.minOrderQty);
                const step   = parseFloat(instr.lotSizeFilter.qtyStep);
                const price  = MONITOR.indicators.price;

                // Garante nocional mínimo de 5.2 USDT (banca pequena)
                // Se a banca for grande, usa o qty exato configurado
                if (price > 0) {
                    const qtyMinNotional = 5.2 / price;
                    if (finalQty < qtyMinNotional) finalQty = qtyMinNotional;
                }

                if (finalQty < minQty) finalQty = minQty;

                // Arredonda para o step correto da moeda
                const precision = Math.max(0, Math.round(-Math.log10(step)));
                finalQty = parseFloat(finalQty.toFixed(precision));
            }
        } catch (e) {
            addLog(`⚠️ Erro ao buscar limites do instrumento: ${e.message}`, 'warn');
        }
    }

    const bybitSide = side === 'long' ? 'Buy' : 'Sell';
    const orderData = {
        category:   'linear',
        symbol:     MONITOR.symbol,
        side:       bybitSide,
        orderType:  'Market',
        qty:        finalQty.toString(),
        timeInForce:'GTC',
        reduceOnly:  isReduce,
    };

    addLog(`📡 Ordem: ${bybitSide} ${finalQty} ${MONITOR.symbol}${isReduce ? ' [REDUÇÃO]' : ''}`, 'info');

    const res     = await bybitRequest('POST', '/v5/order/create', orderData);
    const retCode = res && res.retCode;

    if (retCode === 0) return finalQty;

    addLog(`❌ Ordem REJEITADA (retCode ${retCode}): ${res.retMsg || JSON.stringify(res)}`, 'err');
    return null;
}

// ─── Indicadores ───────────────────────────────────────────────────────────

function calcEMA(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
    return ema;
}

async function engineScoring() {
    if (!MONITOR.symbol) return null;

    const kRes = await bybitRequest('GET', '/v5/market/kline', {
        category: 'linear',
        symbol:   MONITOR.symbol,
        interval: '1',
        limit:    '201',
    });

    if (!kRes || !kRes.result || !kRes.result.list || !kRes.result.list.length) return null;

    // A API Bybit retorna do mais recente ao mais antigo — invertemos para cronológico
    const list   = [...kRes.result.list].reverse();
    const prices = list.map(k => parseFloat(k[4]));
    const curP   = prices[prices.length - 1];
    const prevP  = prices[prices.length - 2];

    if (!isFinite(curP) || !isFinite(prevP)) return null;

    // ── Score EMA 200 (40 pts) ─────────────────────────────────────────────
    const ema200 = calcEMA(prices, 200);
    let sL = curP > ema200 ? 40 : 0;
    let sS = curP < ema200 ? 40 : 0;

    // ── Score VWAP (30 pts) — últimas 50 velas ─────────────────────────────
    let vwapSum = 0, volSum = 0;
    list.slice(-50).forEach(k => {
        const p = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
        const v = parseFloat(k[5]);
        vwapSum += p * v;
        volSum  += v;
    });
    const vwap = volSum > 0 ? vwapSum / volSum : curP;
    sL += curP > vwap ? 30 : 0;
    sS += curP < vwap ? 30 : 0;

    // ── Score Open Interest (30 pts) ───────────────────────────────────────
    const oiRes = await bybitRequest('GET', '/v5/market/open-interest', {
        category:     'linear',
        symbol:       MONITOR.symbol,
        intervalTime: '5min',
        limit:        '2',
    });
    const oiList = oiRes && oiRes.result && oiRes.result.list;
    if (oiList && oiList.length >= 2) {
        const growing = parseFloat(oiList[0].openInterest) > parseFloat(oiList[1].openInterest);
        if (growing) {
            if (curP > prevP) sL += 30;
            else if (curP < prevP) sS += 30;
        }
    }

    // ── Volume ratio (última vela vs média das 20 anteriores) ─────────────
    const recent20 = list.slice(-21, -1);
    const avgVol   = recent20.length
        ? recent20.reduce((a, b) => a + parseFloat(b[5]), 0) / recent20.length
        : 0;
    const lastVol  = parseFloat(list[list.length - 1][5]);
    const vRat     = avgVol > 0 ? lastVol / avgVol : 0;

    MONITOR.indicators = { scoreL: sL, scoreS: sS, volRatio: vRat, price: curP };
    return MONITOR.indicators;
}

// ─── Engine Principal ──────────────────────────────────────────────────────

async function engineTick() {
    if (!MONITOR.active || !MONITOR.symbol) return;

    const data = await engineScoring();
    if (!data) return;

    const { scoreL, scoreS, volRatio, price } = data;
    const longTrig  = scoreL >= 70 && volRatio >= 1.1;
    const shortTrig = scoreS >= 70 && volRatio >= 1.1;

    // ═══════════════════════════════════════════════════════════════════════
    // 1. SEM POSIÇÃO → lógica de entrada
    // ═══════════════════════════════════════════════════════════════════════
    if (!MONITOR.position) {

        // Anti-conflito: ambos os lados dispararam ao mesmo tempo → ignora
        if (longTrig && shortTrig) {
            addLog('⚠️ Conflito Long+Short simultâneos. Aguardando...', 'warn');
            return;
        }

        if (longTrig || shortTrig) {
            const side = longTrig ? 'long' : 'short';
            const qty  = await placeOrder(side, MONITOR.config.orderQty);

            // Só registra posição após confirmação da Bybit (retCode 0)
            if (qty !== null) {
                MONITOR.position = {
                    side,
                    entry:          price,
                    qty,
                    peak:           price,
                    trailActive:    false,
                    partialCount:   0,      // aportes feitos (max 2)
                    lastAportePrice: price,
                    partialExitDone: false, // 1ª saída parcial já foi?
                };
                addLog(`✅ ENTRADA ${side.toUpperCase()} @ ${price} | Qty: ${qty}`, 'ok');
            }
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 2. COM POSIÇÃO → gestão
    // ═══════════════════════════════════════════════════════════════════════
    const pos  = MONITOR.position;
    const isL  = pos.side === 'long';
    const roi  = (isL
        ? (price - pos.entry) / pos.entry
        : (pos.entry - price) / pos.entry
    ) * 100 * MONITOR.config.lev;

    const contraryTrig = isL ? shortTrig : longTrig;
    const favorTrig    = isL ? longTrig  : shortTrig;

    // ── A. STOP LOSS ───────────────────────────────────────────────────────
    if (roi <= -MONITOR.config.stopPct) {
        addLog(`🛑 STOP LOSS @ ROI ${roi.toFixed(2)}%`, 'err');
        const q = await placeOrder(isL ? 'short' : 'long', pos.qty, true);
        if (q !== null) {
            MONITOR.position = null;
        } else {
            addLog('⚠️ Stop Loss: ordem rejeitada. Tentará no próximo tick.', 'err');
        }
        return;
    }

    // ── B. VIRADA (FLIP) ───────────────────────────────────────────────────
    // Posição NEGATIVA + sinal contrário → fecha e abre na direção oposta
    if (contraryTrig && roi < 0) {
        addLog(`🔄 VIRADA: ROI ${roi.toFixed(2)}% | Fechando ${pos.side.toUpperCase()}...`, 'warn');

        // Passo 1: fecha atual — se falhar, cancela o flip (não abre nova)
        const closeQ = await placeOrder(isL ? 'short' : 'long', pos.qty, true);
        if (closeQ === null) {
            addLog('⚠️ FLIP: falha ao fechar posição. Aguardando próximo tick.', 'err');
            return;
        }
        MONITOR.position = null;

        // Passo 2: abre na direção contrária — se falhar, fica flat
        const newSide = isL ? 'short' : 'long';
        const newQty  = await placeOrder(newSide, MONITOR.config.orderQty);
        if (newQty !== null) {
            MONITOR.position = {
                side:            newSide,
                entry:           price,
                qty:             newQty,
                peak:            price,
                trailActive:     false,
                partialCount:    0,
                lastAportePrice: price,
                partialExitDone: false,
            };
            addLog(`✅ NOVA POSIÇÃO ${newSide.toUpperCase()} @ ${price}`, 'ok');
        } else {
            addLog('⚠️ FLIP: posição anterior fechada, mas falha ao abrir nova. Flat.', 'warn');
        }
        return;
    }

    // ── C. SEGURANÇA NO LUCRO (trailing não ativado ainda) ─────────────────
    // Posição POSITIVA + sinal contrário + trailing NÃO ativado → fecha para garantir lucro
    if (contraryTrig && roi >= 0 && !pos.trailActive) {
        addLog(`💰 SEGURANÇA: ROI ${roi.toFixed(2)}% | Sinal contrário antes do trailing. Fechando...`, 'ok');
        const q = await placeOrder(isL ? 'short' : 'long', pos.qty, true);
        if (q !== null) {
            MONITOR.position = null;
        } else {
            addLog('⚠️ Segurança: ordem rejeitada. Tentará no próximo tick.', 'err');
        }
        return;
    }

    // ── D. APORTES PARCIAIS (máximo 2) ─────────────────────────────────────
    // Posição POSITIVA + sinal a favor + distância mínima do último aporte
    if (favorTrig && roi > 0 && pos.partialCount < 2) {
        const distPct = Math.abs(price - pos.lastAportePrice) / pos.lastAportePrice * 100;
        if (distPct >= 0.3) {
            // partialInPct = % da orderQty original (ex: 20 → 20% da qty de entrada)
            const aporteQty = MONITOR.config.orderQty * (MONITOR.config.partialInPct / 100);
            const qty = await placeOrder(pos.side, aporteQty);
            if (qty !== null) {
                pos.partialCount++;
                pos.qty            += qty;
                pos.lastAportePrice = price;
                addLog(`📥 APORTE #${pos.partialCount} @ ${price} | +${qty} | Total: ${pos.qty.toFixed(6)}`, 'info');
            }
        }
    }

    // ── E. ATIVAÇÃO DO TRAILING ─────────────────────────────────────────────
    if (!pos.trailActive && roi >= MONITOR.config.trailAct) {
        pos.trailActive = true;
        pos.peak        = price; // inicia rastreamento do pico a partir daqui
        addLog(`🎯 TRAILING ATIVADO @ ROI ${roi.toFixed(2)}% | Pico: ${price}`, 'ok');
    }

    // ── F. GESTÃO DO TRAILING ───────────────────────────────────────────────
    if (pos.trailActive) {

        // Atualiza pico (sempre rastreia o melhor preço alcançado)
        if (isL && price > pos.peak) pos.peak = price;
        if (!isL && price < pos.peak) pos.peak = price;

        // Recuo em ROI% (levando alavancagem)
        const pullbackPct = (isL
            ? (pos.peak - price) / pos.peak
            : (price - pos.peak) / pos.peak
        ) * 100 * MONITOR.config.lev;

        // F1. Sinal contrário durante o trailing
        if (contraryTrig) {
            if (!pos.partialExitDone) {
                // 1ª vez → saída parcial (partialOutPct %, padrão 50%)
                const exitQty = pos.qty * (MONITOR.config.partialOutPct / 100);
                const q = await placeOrder(isL ? 'short' : 'long', exitQty, true);
                if (q !== null) {
                    pos.qty            -= q;
                    pos.partialExitDone = true;
                    addLog(`📤 SAÍDA PARCIAL ${MONITOR.config.partialOutPct}% | Fechado: ${q.toFixed(6)} | Restante: ${pos.qty.toFixed(6)}`, 'info');
                } else {
                    addLog('⚠️ Saída parcial rejeitada. Tentará no próximo tick.', 'err');
                }
            } else {
                // 2ª vez → fecha o restante
                addLog('🏁 SAÍDA FINAL: 2º sinal contrário no trailing.', 'ok');
                const q = await placeOrder(isL ? 'short' : 'long', pos.qty, true);
                if (q !== null) {
                    MONITOR.position = null;
                } else {
                    addLog('⚠️ Saída final rejeitada. Tentará no próximo tick.', 'err');
                }
            }
            return;
        }

        // F2. Recuo do pico atingido → fecha tudo
        if (pullbackPct >= MONITOR.config.trailPull) {
            addLog(`🏁 RECUO ATINGIDO: ${pullbackPct.toFixed(2)}% | Pico: ${pos.peak} | Atual: ${price}`, 'ok');
            const q = await placeOrder(isL ? 'short' : 'long', pos.qty, true);
            if (q !== null) {
                MONITOR.position = null;
            } else {
                addLog('⚠️ Fechamento por recuo rejeitado. Tentará no próximo tick.', 'err');
            }
            return;
        }
    }
}

// Loop principal — a cada 5 segundos.
// Lock engineRunning evita que dois ticks rodem ao mesmo tempo
// (acontece quando chamadas à Bybit demoram mais de 5s).
setInterval(async () => {
    if (MONITOR.engineRunning) {
        // Tick anterior ainda em execução — pula esta iteração
        return;
    }
    MONITOR.engineRunning = true;
    try {
        await engineTick();
    } catch (e) {
        addLog(`💥 Erro inesperado no engine: ${e.message}`, 'err');
    } finally {
        MONITOR.engineRunning = false;
    }
}, 5000);

// ─── Autenticação opcional ─────────────────────────────────────────────────
// Se MONITOR_TOKEN estiver definido no Render, as rotas de escrita exigem:
//   Authorization: Bearer <MONITOR_TOKEN>
// Se não estiver definido, qualquer um pode chamar (modo dev / sem token).
function requireAuth(req, res, next) {
    const token = process.env.MONITOR_TOKEN;
    if (!token) return next(); // sem token configurado → aberto
    const auth = req.headers['authorization'];
    if (!auth || auth !== `Bearer ${token}`) {
        return res.status(401).json({ error: 'Não autorizado.' });
    }
    return next();
}

// ─── Helpers de validação ──────────────────────────────────────────────────

function safeFloat(v, fallback) {
    const n = parseFloat(v);
    return isFinite(n) ? n : fallback;
}

function safeInt(v, fallback) {
    const n = parseInt(v, 10);
    return isFinite(n) && n > 0 ? n : fallback;
}

function parseSide(raw) {
    const s = String(raw || '').toLowerCase().trim();
    if (s === 'long'  || s === 'buy')  return 'long';
    if (s === 'short' || s === 'sell') return 'short';
    return null;
}

// ─── ROTAS ─────────────────────────────────────────────────────────────────

// GET /status
// Retorna todo o estado para o app mobile.
// O app lê: data.active, data.indicators, data.position, data.logs
app.get('/status', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
    res.json({
        active:        MONITOR.active,
        symbol:        MONITOR.symbol,
        config:        MONITOR.config,
        position:      MONITOR.position,
        indicators:    MONITOR.indicators,
        engineRunning: MONITOR.engineRunning,
        logs:          MONITOR.logs.slice(0, limit),
    });
});

// GET /logs
app.get('/logs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
    res.json({ logs: MONITOR.logs.slice(0, limit) });
});

// GET /config
app.get('/config', (req, res) => {
    res.json({ config: MONITOR.config, symbol: MONITOR.symbol });
});

// GET /healthz  (para health check do Render)
app.get('/healthz', (req, res) => {
    res.json({ status: 'ok' });
});

// POST /sync-par
// Payload do app: { symbol, active, config, position?, forceEntry? }
app.post('/sync-par', requireAuth, async (req, res) => {
    const { symbol, active, config, position, forceEntry } = req.body || {};

    // ── PARAR ──────────────────────────────────────────────────────────────
    if (active === false) {
        if (MONITOR.position) {
            addLog('⏹️ Monitoramento parado. Tentando fechar posição na Bybit...', 'warn');
            const pos = MONITOR.position;
            const q   = await placeOrder(pos.side === 'long' ? 'short' : 'long', pos.qty, true);
            if (q !== null) {
                MONITOR.position = null;
                MONITOR.active   = false;
                addLog('✅ Posição fechada. Monitor parado.', 'ok');
                return res.json({ success: true });
            } else {
                // ATENÇÃO: NÃO apagamos a posição local se o fechamento falhou.
                // O engine para (active = false), mas a posição fica registrada.
                // O usuário DEVE fechar manualmente na Bybit e depois chamar
                // POST /close-position para limpar o estado local.
                MONITOR.active = false;
                addLog('🚨 CRÍTICO: falha ao fechar posição na Bybit ao parar! Feche manualmente na exchange e use /close-position para limpar o estado.', 'err');
                return res.status(500).json({
                    success: false,
                    error:   'Monitor parado, mas falha ao fechar posição na Bybit. Feche MANUALMENTE na exchange e use POST /close-position para limpar o estado local.',
                    position: MONITOR.position,
                });
            }
        } else {
            addLog('⏹️ Monitoramento parado pelo app.', 'info');
        }
        MONITOR.active = false;
        return res.json({ success: true });
    }

    // ── INICIAR ────────────────────────────────────────────────────────────
    if (active === true) {
        if (symbol && String(symbol).trim()) {
            MONITOR.symbol = String(symbol).trim().toUpperCase();
        }

        if (!MONITOR.symbol) {
            return res.status(400).json({ success: false, error: 'symbol é obrigatório para iniciar.' });
        }

        // Aplica configurações enviadas pelo app
        if (config) {
            MONITOR.config = {
                stopPct:       safeFloat(config.stopPct,       MONITOR.config.stopPct),
                trailAct:      safeFloat(config.trailAct,      MONITOR.config.trailAct),
                trailPull:     safeFloat(config.trailPull,     MONITOR.config.trailPull),
                lev:           safeInt  (config.lev,           MONITOR.config.lev),
                orderQty:      safeFloat(config.orderQty,      MONITOR.config.orderQty),
                partialInPct:  safeFloat(config.partialInPct,  MONITOR.config.partialInPct),
                partialOutPct: safeFloat(config.partialOutPct, MONITOR.config.partialOutPct),
            };
        }

        // Sincroniza posição já existente (se o app enviou uma posição aberta)
        if (position) {
            const side  = parseSide(position.side);
            const qty   = safeFloat(position.qty,   0);
            const entry = safeFloat(position.entry, 0);
            if (!side || qty <= 0 || entry <= 0) {
                return res.status(400).json({
                    success: false,
                    error: 'position.side, .qty e .entry devem ser válidos.',
                });
            }
            MONITOR.position = {
                side,
                qty,
                entry,
                peak:            safeFloat(position.peak || position.entry, entry),
                trailActive:     !!position.trailActive,
                partialCount:    Math.min(2, Math.max(0, safeInt(position.partialCount, 0))),
                lastAportePrice: entry,
                partialExitDone: false,
            };
        }

        MONITOR.active = true;
        addLog(
            `▶️ Monitor: ${MONITOR.symbol} | Lev: ${MONITOR.config.lev}x | ` +
            `Stop: ${MONITOR.config.stopPct}% | Trail: ${MONITOR.config.trailAct}% | ` +
            `Recuo: ${MONITOR.config.trailPull}% | PartialIn: ${MONITOR.config.partialInPct}% | ` +
            `PartialOut: ${MONITOR.config.partialOutPct}%`,
            'info'
        );

        // Entrada manual forçada pelo app (botão "Forçar Entrada")
        if (forceEntry) {
            const side = parseSide(forceEntry.side);
            if (!side) {
                return res.status(400).json({ success: false, error: "forceEntry.side inválido. Use 'long' ou 'short'." });
            }

            // Busca preço atual antes de abrir
            const freshData  = await engineScoring();
            const entryPrice = freshData ? freshData.price : MONITOR.indicators.price;
            if (!entryPrice || entryPrice <= 0) {
                return res.status(503).json({ success: false, error: 'Não foi possível obter preço atual da Bybit.' });
            }

            const qty = await placeOrder(side, MONITOR.config.orderQty);
            if (qty !== null) {
                MONITOR.position = {
                    side,
                    entry:           entryPrice,
                    qty,
                    peak:            entryPrice,
                    trailActive:     false,
                    partialCount:    0,
                    lastAportePrice: entryPrice,
                    partialExitDone: false,
                };
                addLog(`📲 ENTRADA MANUAL ${side.toUpperCase()} @ ${entryPrice} | Qty: ${qty}`, 'ok');
            } else {
                return res.status(500).json({ success: false, error: 'Falha ao enviar ordem de entrada manual.' });
            }
        }
    }

    return res.json({ success: true });
});

// POST /close-position
// Fecha a posição atual pelo app SEM parar o monitoramento.
// Após fechar, o server continua monitorando e entra na próxima oportunidade.
app.post('/close-position', requireAuth, async (req, res) => {
    if (!MONITOR.position) {
        return res.status(400).json({ success: false, error: 'Nenhuma posição aberta.' });
    }

    // Se o engine está decidindo neste exato momento, aguarda (best-effort)
    if (MONITOR.engineRunning) {
        return res.status(503).json({
            success: false,
            error:   'Engine em execução. Tente novamente em instantes.',
        });
    }

    const pos = MONITOR.position;
    addLog(`📲 FECHAMENTO MANUAL: ${pos.side.toUpperCase()} ${pos.qty} contratos`, 'warn');

    const q = await placeOrder(pos.side === 'long' ? 'short' : 'long', pos.qty, true);

    if (q !== null) {
        MONITOR.position = null;
        addLog(`✅ Posição fechada manualmente. Qty: ${q}`, 'ok');
        return res.json({ success: true, closedQty: q });
    } else {
        return res.status(500).json({
            success: false,
            error:   'Falha ao enviar ordem para a Bybit. Verifique os logs.',
        });
    }
});

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════════╗`);
    console.log(`║   BYBIT SCANNER PRO v2.0 — ONLINE           ║`);
    console.log(`║   Porta: ${PORT}                              ║`);
    console.log(`║   Testnet: ${process.env.USE_TESTNET === 'true' ? 'SIM (sem dinheiro real)    ' : 'NÃO — CONTA REAL!         '}║`);
    console.log(`╚══════════════════════════════════════════════╝\n`);
});
