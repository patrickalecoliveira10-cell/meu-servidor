const express = require('express');
const ccxt = require('ccxt');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- ESTADO GLOBAL DO SERVIDOR ---
let exchange = null;
let activeConfig = {
    sym: "",
    bankPct: 10,     // % da banca por trade
    lev: 10,         // Alavancagem
    stopPct: 2.5,    // Stop Loss Fixo
    trailAct: 2,     // Ativa Trailing com 2% de ROI
    trailPull: 1,    // Recuo de 1% para fechar
    apiKey: "",
    apiSecret: ""
};

let serverData = {
    pos: null, 
    logs: [],
    lastPrice: 0,
    score: 0,
    rsi: 50,
    vol: 1.0
};

// --- SISTEMA DE LOGS ---
function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const logMsg = `[${time}] ${msg}`;
    serverData.logs.unshift(logMsg);
    if (serverData.logs.length > 50) serverData.logs.pop();
    console.log(logMsg);
}

// --- CONEXÃO COM A BYBIT ---
async function initExchange(key, secret) {
    try {
        exchange = new ccxt.bybit({
            apiKey: key,
            apiSecret: secret,
            options: { 'defaultType': 'linear' }
        });
        addLog("✅ API Bybit Conectada!");
    } catch (e) {
        addLog(`❌ Erro API: ${e.message}`);
    }
}

// --- EXECUÇÃO DE ORDENS (Cálculo de Lote Real) ---
async function openPosition(side, price) {
    try {
        if (!exchange || !exchange.apiKey) {
            addLog("⚠️ MODO SIMULADO: Sem chaves de API.");
            serverData.pos = { side, entry: price, qty: 1, roi: 0, trail: "Simulado", peak: 0 };
            return;
        }

        // 1. Busca saldo real USDT
        const balance = await exchange.fetchBalance();
        const usdtFree = balance.free['USDT'] || 0;

        if (usdtFree < 5) {
            addLog(`❌ Saldo insuficiente na Bybit: ${usdtFree.toFixed(2)} USDT`);
            return;
        }

        // 2. Calcula Quantidade: (Saldo * % da Banca * Alavancagem) / Preço
        const pct = parseFloat(activeConfig.bankPct) / 100;
        const lev = parseFloat(activeConfig.lev || 10);
        let qty = (usdtFree * pct * lev) / price;

        // 3. Ajusta precisão conforme regras da Bybit
        const markets = await exchange.loadMarkets();
        qty = parseFloat(exchange.amountToPrecision(activeConfig.sym, qty));

        addLog(`📡 Abrindo ${side.toUpperCase()} | Banca: ${usdtFree.toFixed(2)} USDT | Qtd: ${qty}`);

        // Define a alavancagem na corretora
        try { await exchange.setLeverage(lev, activeConfig.sym); } catch(e) {}

        // Envia ordem a mercado
        const order = await exchange.createMarketOrder(activeConfig.sym, (side === 'buy' ? 'buy' : 'sell'), qty);
        
        addLog(`🔥 ORDEM EXECUTADA NA BYBIT!`);
        serverData.pos = { 
            side, 
            entry: price, 
            qty: qty, 
            roi: 0, 
            trail: "Inativo", 
            peak: 0 
        };
    } catch (e) {
        addLog(`❌ ERRO BYBIT: ${e.message}`);
    }
}

// --- FECHAMENTO DE POSIÇÃO ---
async function closePosition() {
    try {
        if (serverData.pos && exchange && exchange.apiKey) {
            const side = serverData.pos.side === 'buy' ? 'sell' : 'buy';
            await exchange.createMarketOrder(activeConfig.sym, side, serverData.pos.qty);
            addLog(`🛑 Posição encerrada com sucesso.`);
        }
        serverData.pos = null;
    } catch (e) {
        addLog(`❌ Erro ao fechar: ${e.message}`);
    }
}

// --- MONITORAMENTO EM TEMPO REAL (Loop) ---
async function mainLoop() {
    if (!activeConfig.sym || !exchange) return;

    try {
        const ticker = await exchange.fetchTicker(activeConfig.sym);
        const price = ticker.last;
        serverData.lastPrice = price;

        if (serverData.pos) {
            const p = serverData.pos;
            const isL = p.side === 'buy';
            
            // ROI Realizado
            const diff = isL ? (price - p.entry) / p.entry : (p.entry - price) / p.entry;
            p.roi = diff * 100 * activeConfig.lev;

            // Trailing Stop Logic
            if (p.roi > p.peak) p.peak = p.roi;

            // Stop Loss Fixo
            if (p.roi <= -activeConfig.stopPct) {
                addLog(`📉 Stop Loss acionado! ROI: ${p.roi.toFixed(2)}%`);
                await closePosition();
            }

            // Trailing Stop Ativo
            if (p.peak >= activeConfig.trailAct) {
                p.trail = "ATIVO 🔥";
                if (p.roi <= (p.peak - activeConfig.trailPull)) {
                    addLog(`🎯 Trailing Stop: Lucro garantido! ROI: ${p.roi.toFixed(2)}%`);
                    await closePosition();
                }
            }
        }
    } catch (e) {}
}

// --- ENDPOINTS DE COMUNICAÇÃO ---

// Iniciar/Parar via App
app.post('/control', async (req, res) => {
    const cfg = req.body;
    if (cfg.action === 'start') {
        activeConfig = { ...activeConfig, ...cfg };
        if (cfg.apiKey && cfg.apiSecret) await initExchange(cfg.apiKey, cfg.apiSecret);
        addLog(`🚀 Robô Iniciado em ${activeConfig.sym}`);
    } else if (cfg.action === 'stop') {
        activeConfig.sym = "";
        await closePosition();
        addLog(`🛑 Robô Desligado.`);
    } else if (cfg.action === 'close_now') {
        await closePosition();
    }
    res.json({ status: "ok" });
});

// Envia status para o App (Preço, Logs, ROI)
app.get('/status', (req, res) => {
    res.json(serverData);
});

// Recebe Indicadores e Gatilhos do App
app.post('/update_score', async (req, res) => {
    serverData.score = req.body.score || 0;
    serverData.rsi = req.body.rsi || 50;
    serverData.vol = req.body.vol || 1.0;

    // GATILHO AUTOMÁTICO DE ENTRADA (Baseado no sinal do App)
    if (!serverData.pos && activeConfig.sym) {
        if (serverData.score >= 75) {
            addLog(`⚡ Sinal de COMPRA recebido (Score: ${serverData.score})`);
            await openPosition('buy', serverData.lastPrice);
        } else if (serverData.score <= -75) {
            addLog(`⚡ Sinal de VENDA recebido (Score: ${serverData.score})`);
            await openPosition('sell', serverData.lastPrice);
        }
    }
    res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    setInterval(mainLoop, 3000); 
});
