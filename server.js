const express = require('express');
const ccxt = require('ccxt');
const app = express();
app.use(express.json());

let activeConfig = null;
let monitorInterval = null;
let state = {
    side: null, entry: 0, qty: 0, peakPrice: 0, 
    partialEntryCount: 0, partialExitCount: 0, trailActive: false
};

// --- ROTA DE CONTROLE ---
app.post('/control', async (req, res) => {
    const { action, ...config } = req.body;
    if (action === 'start') {
        activeConfig = config;
        resetState();
        startLoop();
        res.send({ status: 'Nuvem Ativada', sym: config.sym });
    } else {
        stopLoop();
        res.send({ status: 'Nuvem Parada' });
    }
});

function resetState() {
    state = { side: null, entry: 0, qty: 0, peakPrice: 0, partialEntryCount: 0, partialExitCount: 0, trailActive: false };
}

function startLoop() {
    if (monitorInterval) clearInterval(monitorInterval);
    console.log(`🚀 Bot iniciado: ${activeConfig.sym}`);
    monitorInterval = setInterval(cycle, 15000); // 15 segundos
}

function stopLoop() {
    clearInterval(monitorInterval);
    monitorInterval = null;
}

async function cycle() {
    if (!activeConfig) return;
    try {
        const exchange = new ccxt.bybit({ apiKey: activeConfig.apiKey, secret: activeConfig.apiSecret });
        const ticker = await exchange.fetchTicker(activeConfig.sym);
        const price = ticker.last;
        const candles = await exchange.fetchOHLCV(activeConfig.sym, '5m', undefined, 100);

        // --- MOTOR DE ANÁLISE TÉCNICA (Espelhado do App) ---
        const trend = analyze(candles); 
        const sig = trend.signal;
        const volOk = trend.volRatio >= 1.1;

        console.log(`📊 [${activeConfig.sym}] Preço: ${price} | Score L:${sig.LONG} S:${sig.SHORT} | Vol:${trend.volRatio}x`);

        if (!state.side) {
            // LÓGICA DE ENTRADA UNIDIRECIONAL
            if (sig.LONG >= 70 && sig.SHORT < 70 && volOk) await enter(exchange, 'long', price);
            else if (sig.SHORT >= 70 && sig.LONG < 70 && volOk) await enter(exchange, 'short', price);
        } else {
            // LÓGICA DE GESTÃO DINÂMICA (As regras que você pediu)
            await manage(exchange, price, trend);
        }
    } catch (e) {
        console.error("❌ Erro no Ciclo:", e.message);
    }
}

async function manage(exchange, price, trend) {
    const isLong = state.side === 'long';
    const priceVar = isLong ? (price - state.entry)/state.entry : (state.entry - price)/state.entry;
    const roi = priceVar * 100 * 10; // Exemplo 10x lev
    
    const contraryTrigger = isLong ? (trend.signal.SHORT >= 70) : (trend.signal.LONG >= 70);
    const favorTrigger = isLong ? (trend.signal.LONG >= 70) : (trend.signal.SHORT >= 70);

    // 1. Virada no Prejuízo
    if (roi < 0 && contraryTrigger) {
        console.log("🔄 VIRADA DETECTADA");
        await close(exchange);
        await enter(exchange, isLong ? 'short' : 'long', price);
        return;
    }

    // 2. Aporte a Favor (Máximo 2)
    if (favorTrigger && state.partialEntryCount < 2 && Math.abs(priceVar) > 0.003) {
        console.log("📥 FAZENDO APORTE");
        await entryPartial(exchange);
    }

    // 3. Segurança no Lucro (Pré-Trailing)
    if (roi > 0 && !state.trailActive && contraryTrigger) {
        console.log("💰 FECHANDO NO LUCRO POR SEGURANÇA");
        await close(exchange);
        return;
    }

    // 4. Trailing Stop
    if (!state.trailActive && roi >= activeConfig.trailAct) state.trailActive = true;
    if (state.trailActive) {
        if (contraryTrigger) { // Parcial no Trailing
            state.partialExitCount++;
            if (state.partialExitCount === 1) await exitPartial(exchange);
            else await close(exchange);
        }
    }
}

// Funções de execução (CCXT)
async function enter(ex, side, price) {
    console.log(`🟢 Entrando em ${side}`);
    // Aqui o CCXT executaria: await ex.createMarketOrder(...)
    state.side = side; state.entry = price; state.qty = 1; // Simplificado para exemplo
}

async function close(ex) {
    console.log(`🔴 Fechando posição`);
    resetState();
}

// Simulação de Indicadores (Devem ser expandidos com a lógica real do scanner.html)
function analyze(candles) {
    // Aqui você deve portar o cálculo de EMA/RSI/VWAP do scanner.html
    return { signal: { LONG: 75, SHORT: 10 }, volRatio: 1.2 }; 
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor Scanner Online na porta ${PORT}`));
