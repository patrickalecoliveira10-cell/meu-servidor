const express = require('express');
const axios = require('axios');const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ESTADO DO SERVIDOR (Cérebro Autônomo)
let MONITOR = {
    active: false,
    symbol: null,
    config: { stopPct: 2.5, trailAct: 2, trailPull: 1, lev: 5 },
    position: null,
    logs: [] // Guarda as últimas 20 mensagens para o App ler
};

function serverLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const entry = { time, msg, type };
    MONITOR.logs.unshift(entry);
    if (MONITOR.logs.length > 20) MONITOR.logs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// --- LOGICA DE TRADING ---
// (Funções parEMA, parVWAP, parRSI, bybitRequest, openOrder, closeOrder... IGUAIS AO ANTERIOR)
// [Insira aqui as funções auxiliares que enviamos no passo anterior]

async function serverCycle() {
    if (!MONITOR.active || !MONITOR.symbol) return;

    try {
        // 1. Busca Dados Reais
        // ... (Busca Klines, Tickers e OI da Bybit)

        // 2. Calcula Score Master
        // ... (Lógica de EMA 200, VWAP, Volume e OI)

        if (MONITOR.position) {
            // 3. GESTÃO DE POSIÇÃO (Flip, Aportes, Trailing, Stop)
            // Agora o servidor decide fechar ou virar sozinho!
            // ... (Se roi < 0 e contrary -> Flip)
            // ... (Se roi > 0 e favor e aportes < 2 -> Aporte)
            // ... (Se pb >= trailPull -> Close)
        } else {
            // 4. ENTRADA AUTÔNOMA
            if (longTrigger && !shortTrigger) {
                serverLog(`🔥 Entrada Autônoma: LONG em ${MONITOR.symbol}`, 'ok');
                const res = await openOrder('LONG', MONITOR.symbol, MONITOR.config.lev, "0.01");
                if(res.retCode === 0) MONITOR.position = { side: 'LONG', entry: price, qty: "0.01", peak: price, trailActive: false, partialEntryCount: 0, partialExitDone: false };
            } else if (shortTrigger && !longTrigger) {
                serverLog(`🔥 Entrada Autônoma: SHORT em ${MONITOR.symbol}`, 'ok');
                const res = await openOrder('SHORT', MONITOR.symbol, MONITOR.config.lev, "0.01");
                if(res.retCode === 0) MONITOR.position = { side: 'SHORT', entry: price, qty: "0.01", peak: price, trailActive: false, partialEntryCount: 0, partialExitDone: false };
            }
        }
    } catch (e) { console.error("Erro no ciclo:", e.message); }
}

setInterval(serverCycle, 8000); // Roda a cada 8 segundos na nuvem

app.get('/status', (req, res) => res.json(MONITOR));
app.post('/sync-par', (req, res) => {
    const { symbol, active, config } = req.body;
    MONITOR.active = active;
    if (active) {
        MONITOR.symbol = symbol;
        MONITOR.config = config;
        serverLog(`🚀 Servidor Cloud Iniciado para ${symbol}`, 'info');
    } else {
        serverLog(`🛑 Servidor Cloud Parado pelo Usuário`, 'warn');
    }
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
