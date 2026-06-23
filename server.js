const express = require('express');
const ccxt = require('ccxt');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- ESTADO DO SERVIDOR ---
let exchange = null;
let activeConfig = {
    sym: "",
    bankPct: 10,
    lev: 10,
    stopPct: 2.5,
    trailAct: 2,
    trailPull: 1,
    apiKey: "",
    apiSecret: ""
};

let serverData = {
    pos: null, // { side, entry, qty, roi, trail, peak, partialExitDone }
    logs: [],
    lastPrice: 0,
    score: 0
};

// --- HELPER DE LOG ---
function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const logMsg = `[${time}] ${msg}`;
    serverData.logs.unshift(logMsg);
    if (serverData.logs.length > 50) serverData.logs.pop();
    console.log(logMsg);
}

// --- CONEXÃO BYBIT ---
async function initExchange(key, secret) {
    try {
        exchange = new ccxt.bybit({
            apiKey: key,
            apiSecret: secret,
            options: { 'defaultType': 'linear' }
        });
        addLog("✅ Conectado à Bybit com sucesso!");
    } catch (e) {
        addLog(`❌ Erro ao conectar Bybit: ${e.message}`);
    }
}

// --- LÓGICA DE ABERTURA (CORRIGIDA) ---
async function openPosition(side, price) {
    try {
        if (!exchange || !exchange.apiKey) {
            addLog("⚠️ Modo Simulação (Sem API Key)");
            serverData.pos = { side, entry: price, qty: 1, roi: 0, trail: "Simulado", peak: price };
            return;
        }

        addLog(`💰 Calculando saldo para ${side.toUpperCase()}...`);
        const balance = await exchange.fetchBalance();
        const usdtFree = balance.free['USDT'] || 0;

        if (usdtFree < 5) {
            addLog(`❌ Saldo insuficiente na Bybit: ${usdtFree.toFixed(2)} USDT`);
            return;
        }

        const pct = parseFloat(activeConfig.bankPct) / 100;
        const lev = parseFloat(activeConfig.lev || 10);
        
        // CÁLCULO DE QTD: (Saldo * % * Alavancagem) / Preço
        let qty = (usdtFree * pct * lev) / price;

        // Ajuste de precisão da Bybit
        const markets = await exchange.loadMarkets();
        qty = parseFloat(exchange.amountToPrecision(activeConfig.sym, qty));

        addLog(`📡 Enviando Ordem: ${side} | Qtd: ${qty} | Alav: ${lev}x`);

        // Tenta definir alavancagem na Bybit
        try { await exchange.setLeverage(lev, activeConfig.sym); } catch(e){}

        const order = await exchange.createMarketOrder(activeConfig.sym, side, qty);
        
        addLog(`🔥 POSIÇÃO ABERTA NA BYBIT!`);
        serverData.pos = { 
            side, 
            entry: price, 
            qty: qty, 
            roi: 0, 
            trail: "Inativo", 
            peak: price,
            partialExitDone: false 
        };

    } catch (e) {
        addLog(`❌ ERRO ENTRADA: ${e.message}`);
    }
}

// --- LÓGICA DE FECHAMENTO ---
async function closePosition() {
    try {
        if (serverData.pos && exchange && exchange.apiKey) {
            const side = serverData.pos.side === 'buy' ? 'sell' : 'buy';
            await exchange.createMarketOrder(activeConfig.sym, side, serverData.pos.qty);
            addLog(`🛑 Posição encerrada na Bybit.`);
        }
        serverData.pos = null;
    } catch (e) {
        addLog(`❌ Erro ao fechar: ${e.message}`);
    }
}

// --- LOOP PRINCIPAL (Monitoramento) ---
async function mainLoop() {
    if (!activeConfig.sym) return;

    try {
        // 1. Pega Preço Atual (Simulado aqui, mas CCXT buscaria real)
        const ticker = await exchange.fetchTicker(activeConfig.sym);
        const price = ticker.last;
        serverData.lastPrice = price;

        // 2. Se tiver posição, gerencia Stop e Trailing
        if (serverData.pos) {
            const p = serverData.pos;
            const isL = p.side === 'buy';
            
            // ROI
            const diff = isL ? (price - p.entry) / p.entry : (p.entry - price) / p.entry;
            p.roi = diff * 100 * activeConfig.lev;

            // Atualiza Topo para Trailing
            if (p.roi > p.peak) p.peak = p.roi;

            // Stop Loss Fixo
            if (p.roi <= -activeConfig.stopPct) {
                addLog(`📉 Stop Loss atingido! (${p.roi.toFixed(2)}%)`);
                await closePosition();
            }

            // Trailing Stop
            if (p.peak >= activeConfig.trailAct) {
                p.trail = "Ativo";
                if (p.roi <= (p.peak - activeConfig.trailPull)) {
                    addLog(`🎯 Trailing Stop acionado! Lucro: ${p.roi.toFixed(2)}%`);
                    await closePosition();
                }
            }
        }
        
        // 3. Lógica de Entrada (Exemplo baseado no Score enviado pelo App)
        // Se Score > 70 e não tem posição -> Compra
        // Se Score < -70 e não tem posição -> Venda
        // Se sinal inverter e estiver em loss -> FLIP

    } catch (e) {
        // console.log("Loop erro:", e.message);
    }
}

// --- ENDPOINTS ---

app.post('/control', async (req, res) => {
    const cfg = req.body;
    
    if (cfg.action === 'start') {
        activeConfig = { ...activeConfig, ...cfg };
        if (cfg.apiKey && cfg.apiSecret) {
            await initExchange(cfg.apiKey, cfg.apiSecret);
        }
        addLog(`🚀 Robô Iniciado: ${activeConfig.sym}`);
    } 
    
    if (cfg.action === 'stop') {
        activeConfig.sym = "";
        await closePosition();
        addLog(`🛑 Robô Desligado.`);
    }

    if (cfg.action === 'close_now') {
        await closePosition();
    }

    res.json({ status: "ok" });
});

// O App chama isso a cada 5 segundos para atualizar a tela
app.get('/status', (req, res) => {
    res.json(serverData);
});

// Recebe sinais de Score do App
app.post('/update_score', (req, res) => {
    serverData.score = req.body.score;
    // Aqui você pode disparar o openPosition se o score for alto
    res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    setInterval(mainLoop, 2000); // Roda a lógica a cada 2 segundos
});
