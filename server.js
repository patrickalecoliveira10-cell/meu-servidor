const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const app = express();

app.use(cors());
app.use(express.json());

// ESTADO GLOBAL DO ROBÔ
let activeConfig = null;
let exchange = null;
let eventLog = []; 
let pos = { 
    side: null, entry: 0, qty: 0, 
    partialEntries: 0, partialExits: 0, 
    trailActive: false, peak: 0 
};

// Rota de Controle (App -> Servidor)
app.post('/control', async (req, res) => {
    const data = req.body;
    
    if (data.action === 'start') {
        console.log(`\n🚀 INICIANDO OPERAÇÃO: ${data.sym}`);
        activeConfig = {
            ...data,
            bankPct: parseFloat(data.bankPct),
            stopPct: parseFloat(data.stopPct),
            trailAct: parseFloat(data.trailAct),
            trailPull: parseFloat(data.trailPull),
            partialEntryPct: parseFloat(data.partialEntryPct) || 20,
            partialExitPct: parseFloat(data.partialExitPct) || 40,
            lev: 10
        };

        if (data.apiKey && data.apiSecret) {
            exchange = new ccxt.bybit({ 
                apiKey: data.apiKey, secret: data.apiSecret, 
                options: { 'defaultType': 'linear' } 
            });
        }
        
        // Limpa logs antigos ao iniciar nova moeda
        eventLog = [{ msg: `📡 Monitorando ${data.sym} na nuvem...`, time: Date.now() }];
        
        runEngine();
        res.status(200).send({ status: "ok" });
    } else {
        activeConfig = null;
        console.log("🛑 PARADA SOLICITADA.");
        res.status(200).send({ status: "stopped" });
    }
});

// Rota de Status (Servidor -> App busca notificações)
app.get('/status', (req, res) => {
    res.json({ pos, eventLog: eventLog.slice(-15) });
});

async function runEngine() {
    while (activeConfig) {
        try {
            const ticker = await exchange.fetchTicker(activeConfig.sym);
            const price = ticker.last;

            if (!pos.side) {
                // Abre a primeira posição baseada na escolha inicial do App
                // Aqui podemos integrar o Score > 70 automático depois
                await openPosition('long', price); // Inicia como Long por padrão ao clicar
            } else {
                await managePosition(price);
            }
            
            await new Promise(r => setTimeout(r, 3000)); // Checa a cada 3 segundos
        } catch (e) {
            console.error("Erro Engine:", e.message);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    notify("💤 Servidor em Standby.");
}

async function openPosition(side, price) {
    const c = activeConfig;
    // Cálculo de Qty baseado na banca % (Simulado APK 2)
    const qty = (c.bankPct / 100) * 10; // Exemplo de cálculo de contrato
    
    pos = { 
        side, entry: price, qty, 
        partialEntries: 0, partialExits: 0, 
        trailActive: false, peak: price 
    };
    
    notify(`🔔 ENTRADA ${side.toUpperCase()} em ${price}`);
    // exchange.createMarketOrder(c.sym, side === 'long' ? 'buy' : 'sell', qty);
}

async function managePosition(price) {
    const c = activeConfig;
    const isL = pos.side === 'long';
    const lev = c.lev;
    
    // Variação e ROI (Igual APK 2)
    const priceVar = isL ? (price - pos.entry)/pos.entry : (pos.entry - price)/pos.entry;
    const roi = priceVar * 100 * lev;

    // 1. STOP LOSS
    if (roi <= -c.stopPct) {
        notify(`❌ STOP LOSS: ${roi.toFixed(2)}% em ${price}`);
        return closeAll();
    }

    // 2. VIRADA (FLIP) 
    // Se estiver no prejuízo e detectarmos exaustão (Simulado)
    if (roi < -1.5) { 
        // Aqui o robô inverteria a mão se o Score contrário fosse alto
    }

    // 3. APORTES (ENTRADA PARCIAL) - Se estiver no lucro e tendência forte
    if (roi >= 1.0 && pos.partialEntries < 2) {
        const addQty = (c.partialEntryPct / 100) * 10;
        // Recalcula Preço Médio
        pos.entry = ((pos.entry * pos.qty) + (price * addQty)) / (pos.qty + addQty);
        pos.qty += addQty;
        pos.partialEntries++;
        notify(`📥 APORTE #${pos.partialEntries} realizado. Novo Preço Médio: ${pos.entry.toFixed(4)}`);
    }

    // 4. TRAILING STOP (Ativação e Recuo)
    if (!pos.trailActive && roi >= c.trailAct) {
        pos.trailActive = true;
        pos.peak = price;
        notify(`🎯 TRAILING ATIVADO em ${price}`);
    }

    if (pos.trailActive) {
        if (isL && price > pos.peak) pos.peak = price;
        if (!isL && price < pos.peak) pos.peak = price;

        const pullbackROI = isL ? ((pos.peak - price)/pos.peak)*100*lev : ((price - pos.peak)/pos.peak)*100*lev;

        // Saída Parcial durante o Trailing (Se houver sinal contrário)
        if (pullbackROI >= (c.trailPull / 2) && pos.partialExits < 1) {
            const exitQty = pos.qty * (c.partialExitPct / 100);
            pos.qty -= exitQty;
            pos.partialExits++;
            notify(`📤 SAÍDA PARCIAL (Trailing) realizada em ${price}`);
        }

        // Saída Total por Recuo
        if (pullbackROI >= c.trailPull) {
            notify(`🏁 TRAILING STOP FINALIZADO: ${roi.toFixed(2)}% de lucro.`);
            return closeAll();
        }
    }
}

function notify(msg) {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] ${msg}`);
    eventLog.push({ msg, time: Date.now() });
}

function closeAll() {
    // exchange.createMarketOrder(activeConfig.sym, pos.side === 'long' ? 'sell' : 'buy', pos.qty);
    pos = { side: null, entry: 0, qty: 0, partialEntries: 0, partialExits: 0, trailActive: false, peak: 0 };
    notify(`💰 Posição Encerrada.`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor Lucrativo Online na porta ${PORT}`));
