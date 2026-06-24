const express = require('express');
const ccxt = require('ccxt');
const TI = require('technicalindicators');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Inicialização da Exchange usando as chaves seguras do Render
// Se não houver chaves no Render, ele entrará em modo SIMULADO automaticamente
let exchange = new ccxt.bybit({
    apiKey: process.env.BYBIT_API_KEY || "",
    secret: process.env.BYBIT_API_SECRET || "",
    options: { 'defaultType': 'linear' }
});

let activeConfig = { 
    sym: "", 
    bankPct: 30, 
    partialBankPct: 5, 
    lev: 1, 
    stopPct: 1.5, 
    trailAct: 1.5, 
    trailPull: 0.8 
};

let serverData = { 
    pos: null, 
    eventLog: [], 
    lastPrice: 0, 
    score: 0, 
    rsi: 50, 
    vol: 1.0,
    vwap: 0,
    ema200: 0
};

// Função de Log para Telemetria no App
function addLog(msg) {
    const logEntry = { time: Date.now(), msg: msg };
    serverData.eventLog.unshift(logEntry);
    if (serverData.eventLog.length > 50) serverData.eventLog.pop();
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// 2. SINCRONIZAÇÃO ATIVA: O Coração da Resiliência
// Esta função impede que o robô "perca" o controle se o Render reiniciar
async function syncWithBybit() {
    if (!exchange.apiKey || !activeConfig.sym) return;
    try {
        const positions = await exchange.fetchPositions([activeConfig.sym]);
        // Procura posição aberta para o par atual
        const bPos = positions.find(p => 
            p.symbol.split(':')[0] === activeConfig.sym.split(':')[0] && 
            parseFloat(p.contracts) > 0
        );

        if (bPos) {
            if (!serverData.pos) {
                // RECUPERAÇÃO DE ESTADO: O servidor "acordou" e descobriu que já está operando
                serverData.pos = {
                    side: bPos.side === 'long' ? 'buy' : 'sell',
                    entry: parseFloat(bPos.entryPrice),
                    qty: parseFloat(bPos.contracts),
                    roi: 0, 
                    peak: 0, 
                    peakPrice: parseFloat(bPos.entryPrice),
                    partialEntryCount: 0, 
                    trailActive: false, 
                    partialExitDone: false
                };
                addLog(`🔄 RECUPERADO: Posição ${bPos.side.toUpperCase()} detectada na Bybit.`);
            } else {
                // Atualiza a quantidade real (caso tenha feito parciais manuais)
                serverData.pos.qty = parseFloat(bPos.contracts);
            }
        } else if (serverData.pos) {
            // Se o servidor achava que tinha posição mas a Bybit diz que não, limpamos o estado
            serverData.pos = null;
            addLog("⚠️ SINCRONIZADO: Posição não encontrada na Bybit. Estado resetado.");
        }
    } catch (e) { console.error("Erro Sync Bybit:", e.message); }
}

// 3. LOOP DE ANÁLISE MASTER (Executa a cada 5 segundos)
async function analyzeStrategy() {
    if (!activeConfig.sym) return;
    
    await syncWithBybit(); // Sincroniza antes de cada análise

    try {
        const candles = await exchange.fetchOHLCV(activeConfig.sym, '1m', undefined, 210);
        if (!candles || candles.length < 200) return;

        const closes = candles.map(c => c[4]);
        const price = closes[closes.length - 1];
        serverData.lastPrice = price;

        // INDICADORES MASTER
        const rsi = TI.RSI.calculate({ values: closes, period: 14 }).pop() || 50;
        const ema200 = TI.EMA.calculate({ values: closes, period: 200 }).pop();
        
        // VWAP das últimas 60 velas
        const vwap = (function(cands) {
            let tpv = 0, tv = 0;
            cands.forEach(c => {
                let p = (c[2] + c[3] + c[4]) / 3;
                tpv += p * c[5]; tv += c[5];
            });
            return tv > 0 ? tpv / tv : 0;
        })(candles.slice(-60));

        const avgVol = candles.slice(-20).reduce((a, b) => a + b[5], 0) / 20;
        const volRatio = candles[candles.length - 1][5] / (avgVol || 1);

        serverData.rsi = rsi;
        serverData.vol = volRatio;
        serverData.vwap = vwap;
        serverData.ema200 = ema200;

        // LÓGICA DE SCORE MASTER
        let sL = 0, sS = 0;
        if (price > ema200 && price > vwap * 0.999) {
            sL = 40; 
            if (volRatio >= 1.1) sL += 30;
            if (rsi < 70) sL += 30;
        } else if (price < ema200 && price < vwap * 1.001) {
            sS = 40;
            if (volRatio >= 1.1) sS += 30;
            if (rsi > 30) sS += 30;
        }
        serverData.score = sL >= sS ? sL : -sS;

        // GESTÃO DE EXECUÇÃO
        if (!serverData.pos) {
            // ENTRADA
            if (sL >= 70 && volRatio >= 1.1) await openPosition('buy', price);
            else if (sS >= 70 && volRatio >= 1.1) await openPosition('sell', price);
        } else {
            // GERENCIAMENTO DA POSIÇÃO ATIVA
            const p = serverData.pos;
            const isL = p.side === 'buy';
            const roi = (isL ? (price - p.entry)/p.entry : (p.entry - price)/p.entry) * 100 * activeConfig.lev;
            p.roi = roi;

            if (roi > p.peak) { p.peak = roi; p.peakPrice = price; }

            // 1. Stop Loss Fixo
            if (roi <= -activeConfig.stopPct) await closePosition("Stop Loss");

            // 2. Trailing Stop Inteligente com Saída Parcial
            if (!p.trailActive && roi >= activeConfig.trailAct) {
                p.trailActive = true;
                addLog("🎯 Trailing Ativado!");
            }

            if (p.trailActive) {
                const contrary = isL ? (sS >= 70) : (sL >= 70);
                if (contrary) {
                    if (!p.partialExitDone) {
                        await executePartial(0.5); // Saída de 50% no primeiro sinal contrário
                        p.partialExitDone = true;
                        addLog("💰 Parcial 50% Executada!");
                    } else {
                        await closePosition("Sinal Contrário");
                    }
                } else if ((p.peak - roi) >= activeConfig.trailPull) {
                    await closePosition("Trailing Stop (Recuo)");
                }
            }

            // 3. Aportes Parciais (Máximo 2)
            const dist = Math.abs((price - p.entry)/p.entry) * 100;
            const favor = isL ? (sL >= 70) : (sS >= 70);
            if (favor && p.partialEntryCount < 2 && dist >= 0.5) {
                await openPosition(p.side, price, true);
            }
        }
    } catch (e) { console.error("Erro Análise:", e.message); }
}

async function openPosition(side, price, isPartial = false) {
    try {
        if (!exchange.apiKey || exchange.apiKey === "") {
            addLog(`📝 SIMULADO: ${isPartial ? 'Aumento' : side.toUpperCase()}`);
            if (isPartial) { serverData.pos.partialEntryCount++; return; }
            serverData.pos = { side, entry: price, qty: 1, roi: 0, peak: 0, peakPrice: price, partialEntryCount: 0, trailActive: false, partialExitDone: false };
            return;
        }

        const balance = await exchange.fetchBalance();
        const usdt = balance.free['USDT'] || 0;
        const pct = isPartial ? activeConfig.partialBankPct : activeConfig.bankPct;
        let qty = (usdt * (pct / 100) * activeConfig.lev) / price;
        qty = parseFloat(exchange.amountToPrecision(activeConfig.sym, qty * 0.95));

        if (qty <= 0) return addLog("❌ Saldo insuficiente na Bybit.");

        await exchange.setLeverage(activeConfig.lev, activeConfig.sym).catch(()=>{});
        await exchange.createMarketOrder(activeConfig.sym, side, qty);
        
        if (isPartial) {
            // Recalcula preço médio e quantidade
            const oldTotal = serverData.pos.qty * serverData.pos.entry;
            const newTotal = qty * price;
            serverData.pos.qty += qty;
            serverData.pos.entry = (oldTotal + newTotal) / serverData.pos.qty;
            serverData.pos.partialEntryCount++;
            addLog(`✅ Aporte Realizado (+${qty})`);
        } else {
            serverData.pos = { side, entry: price, qty: qty, roi: 0, peak: 0, peakPrice: price, partialEntryCount: 0, trailActive: false, partialExitDone: false };
            addLog(`🔥 ORDEM REAL ABERTA: ${side.toUpperCase()} ${qty}`);
        }
    } catch (e) { addLog(`❌ Erro ao abrir: ${e.message}`); }
}

async function closePosition(reason) {
    try {
        if (serverData.pos && exchange.apiKey) {
            const side = serverData.pos.side === 'buy' ? 'sell' : 'buy';
            // SEGURANÇA: Busca a quantidade real exata na Bybit antes de fechar
            const positions = await exchange.fetchPositions([activeConfig.sym]);
            const bPos = positions.find(p => p.symbol.split(':')[0] === activeConfig.sym.split(':')[0]);
            const qty = bPos ? parseFloat(bPos.contracts) : serverData.pos.qty;
            
            if (qty > 0) await exchange.createMarketOrder(activeConfig.sym, side, qty);
        }
        serverData.pos = null;
        addLog(`🛑 FECHADO: ${reason}`);
    } catch (e) { addLog(`❌ Erro ao fechar: ${e.message}`); serverData.pos = null; }
}

async function executePartial(pct) {
    try {
        const qtyToClose = parseFloat(exchange.amountToPrecision(activeConfig.sym, serverData.pos.qty * pct));
        const side = serverData.pos.side === 'buy' ? 'sell' : 'buy';
        await exchange.createMarketOrder(activeConfig.sym, side, qtyToClose);
        serverData.pos.qty -= qtyToClose;
    } catch (e) { addLog(`❌ Erro Parcial: ${e.message}`); }
}

// 4. ENDPOINTS DE CONTROLE E TELEMETRIA
app.get('/', (req, res) => res.send("Ultra Master Phone-Off: ONLINE 🚀"));

app.get('/status', (req, res) => res.json({ ...serverData, config: activeConfig }));

app.post('/control', async (req, res) => {
    const cfg = req.body;
    if (cfg.action === 'start') {
        activeConfig = { ...activeConfig, ...cfg };
        addLog(`🚀 Monitoramento Iniciado: ${activeConfig.sym}`);
        await syncWithBybit();
    } else {
        await closePosition("Comando App");
        activeConfig.sym = "";
    }
    res.json({ status: "ok" });
});

app.post('/update_score', (req, res) => {
    // Sincroniza a análise do App com o servidor para redundância
    if (req.body.score !== undefined) {
        serverData.score = req.body.score;
        serverData.rsi = req.body.rsi || serverData.rsi;
        serverData.vol = req.body.vol || serverData.vol;
    }
    res.json({ status: "ok" });
});

// 5. INICIALIZAÇÃO
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    // Loop de 5 segundos para garantir velocidade de resposta
    setInterval(analyzeStrategy, 5000);
});
