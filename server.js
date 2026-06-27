app.post('/sync-par', async (req, res) => {
    const { active, symbol, config, position } = req.body;

    // Se o comando for desativar (active: false), paramos TUDO imediatamente
    if (active === false) {
        serverLog("🛑 COMANDO RECEBIDO: Desativando Nuvem e Fechando Ordens.", "warn");
        
        // Se houver posição aberta, fecha na Bybit
        if (MONITOR.position) {
            await executeTrade(MONITOR.position.side, MONITOR.position.qty, 'close');
        }
        
        // RESETA TUDO
        MONITOR.active = false; 
        MONITOR.position = null; 
        MONITOR.symbol = null; 
        MONITOR.lastCloseTime = Date.now();
        
        return res.json({ success: true, message: "Nuvem Desligada" });
    }

    // Se for para ativar
    MONITOR.active = true; 
    MONITOR.symbol = symbol; 
    if (config) MONITOR.config = config;
    
    if (position && position.side && !MONITOR.position) {
        MONITOR.position = { ...position, side: position.side.toUpperCase() };
        serverLog(`☁️ Assumindo monitoramento de ${symbol}`, "ok");
    }
    
    res.json({ success: true });
});
