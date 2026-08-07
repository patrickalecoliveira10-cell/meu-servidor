const logger = require('../logs/logger.js');

class Intelligence {
  constructor() {this.minConfidence = 0.60; // Sniper Threshold
  }

  // Analisa se deve entrar em uma nova moeda
  determineDecision(confidence, analysis) {
    if (confidence >= this.minConfidence && analysis.side === 'buy') return 'enter';
    return 'wait';
  }

  // GESTÃO DINÂMICA: Decide o que fazer com a posição aberta
  analyzeLivePosition(snapshot, position) {
    const currentPrice = parseFloat(snapshot.price || snapshot.close);
    const entryPrice = parseFloat(position.entry_price);
    const profitPct = ((currentPrice - entryPrice) / entryPrice) * 100;

    // 1. PROTEÇÃO DE LUCRO: Se lucro > 1%, move stop para Breakeven
    if (profitPct >= 1.0 && (!position.stop_loss || position.stop_loss < entryPrice)) {
        return { 
            action: 'move_stop', 
            params: { new_stop: entryPrice }, 
            reason: `Protegendo banca: Lucro de ${profitPct.toFixed(2)}%. Stop movido para Entrada.` 
        };
    }

    // 2. ENTRADA PARCIAL: Se tendência está forte e lucro > 0.5% (Max 2 entradas)
    if (profitPct > 0.5 && profitPct < 1.2 && (position.partial_entry_count || 0) < 2) {
        if (snapshot.indicators?.adx?.value > 25) {
            return { action: 'partial_entry', reason: "Tendência explosiva. Aumentando posição (+15%)." };
        }
    }

    // 3. SAÍDA PARCIAL: Se atingir 2% de lucro, garante 50%
    if (profitPct >= 2.0 && !position.partial_exit_done) {
        return { action: 'partial_exit', params: { percent: 0.5 }, reason: "Meta de 2% atingida. Realizando parcial de 50%." };
    }

    // 4. TRAILING STOP: Se lucro > 1.5%, trava ganho com recuo de 0.5%
    if (profitPct >= 1.5) {
        const trailingDist = currentPrice * 0.005; 
        return { action: 'activate_trailing', params: { trailing_stop: trailingDist }, reason: "Ativando Trailing Stop para seguir o lucro." };
    }

    // 5. FECHAMENTO DE EMERGÊNCIA: RSI Sobrebreado
    if (profitPct > 0.3 && snapshot.indicators?.rsi?.value > 75) {
        return { action: 'close', reason: "Exaustão de compra detectada (RSI). Fechando no lucro." };
    }

    return { action: 'hold', reason: `Acompanhando: Lucro ${profitPct.toFixed(2)}%.` };
  }
}

module.exports = Intelligence;
