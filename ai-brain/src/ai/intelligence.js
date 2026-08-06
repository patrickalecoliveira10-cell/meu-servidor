const logger = require('../logs/logger.js');
const queries = require('../database/queries.js');

class Intelligence {
  constructor() {
    this.brain = null;
    this.stats = {
      total_snapshots: 0,
      total_simulated_ops: 0
    };
  }

  async init(brain) {
    this.brain = brain;
    try {
        const live = await queries.getLiveStats();
        this.stats.total_snapshots = parseInt(live.ai_examples || 0);
        this.stats.total_simulated_ops = parseInt(live.total_simulated_ops || 0);
        logger.info(`[INTEL] Recuperados do banco: ${this.stats.total_snapshots} snapshots e ${this.stats.total_simulated_ops} simulações.`);
    } catch(e) {
        logger.error('Erro ao carregar stats iniciais na Intelligence:', e);
    }
    logger.info('Intelligence module initialized');
  }

  async analyze(snapshot, weights, config) {
    try {
      this.stats.total_snapshots++;
      const { coin_id, timeframe, indicators } = snapshot;

      // 1. Get relevant weights
      const currentWeights = weights.coins[coin_id] || weights.global;

      // 2. Calculate probabilities with smart indicator mapping
      const analysis = this.calculateProbabilities(indicators || {}, currentWeights);

      // 3. Evaluate Setup & Trend
      const setupQuality = this.evaluateSetup(indicators || {});
      const trendStrength = this.evaluateTrend(indicators || {});

      // 4. Calculate Final Confidence
      const confidence = this.calculateConfidence(analysis, setupQuality, trendStrength);

      // 5. Generate Human Reason for Android App
      const stayReason = this.generateStayReason(indicators || {}, confidence, analysis);

      // 6. Determine Decision
      const decisionResult = this.determineDecision(confidence, analysis, config);

      const price = parseFloat(snapshot.price || snapshot.close || 0);

      return {
        coin_id,
        timeframe,
        decision: decisionResult,
        price: price,
        side: analysis.winProbability > 0.5 ? 'buy' : 'sell',
        confidence,
        stayReason, // Agora enviando o motivo real
        win_probability: analysis.winProbability,
        loss_probability: analysis.lossProbability,
        risk: analysis.riskRatio,
        trend_strength: trendStrength,
        setup_quality: setupQuality,
        indicators_summary: indicators,
        timestamp: snapshot.timestamp || new Date()
      };
    } catch (error) {
      logger.error('Error in Intelligence analysis:', error);
      return this.getFallbackDecision(snapshot);
    }
  }

  calculateProbabilities(indicators, weights) {
    let score = 0;
    let totalWeight = 0;

    for (const [name, weight] of Object.entries(weights)) {
      const ind = indicators[name.toLowerCase()] || indicators[name.toUpperCase()];
      if (ind) {
        let signal = 0;

        // Se for um objeto retornado pelo IndicatorsCalculator
        if (typeof ind === 'object') {
          if (name.toLowerCase() === 'rsi') {
            const val = parseFloat(ind.value);
            if (val < 30) signal = 0.8;
            else if (val > 70) signal = -0.8;
          } else if (name.toLowerCase() === 'macd') {
            const hist = parseFloat(ind.histogram || 0);
            if (hist > 0) signal = 0.6;
            else if (hist < 0) signal = -0.6;
            else signal = 0; // Neutral
          } else if (name.toLowerCase() === 'adx') {
            const adxVal = parseFloat(ind.value || 0);
            signal = (adxVal > 25) ? 0.5 : (adxVal < 15 ? -0.2 : 0);
          } else if (ind.signal !== undefined) {
             // Fallback para sinais numéricos se existirem
             const s = parseFloat(ind.signal);
             if (!isNaN(s)) signal = s;
          }
        } else {
          // Fallback para valor numérico direto
          const val = parseFloat(ind);
          if (name.toLowerCase() === 'rsi') {
            if (val < 35) signal = 0.8;
            else if (val > 65) signal = -0.8;
          }
        }

        score += signal * parseFloat(weight);
        totalWeight += parseFloat(weight);
      }
    }

    const normalizedScore = totalWeight > 0 ? score / totalWeight : 0;
    const winProbability = Math.max(0.1, Math.min(0.9, (normalizedScore + 1) / 2));

    return { winProbability, lossProbability: 1 - winProbability, riskRatio: 2.0 };
  }

  evaluateSetup(indicators) {
    let quality = 0.5;
    const rsi = indicators.rsi || indicators.RSI;
    const macd = indicators.macd || indicators.MACD;
    const ema = indicators.ema || indicators.EMA;

    if (rsi && rsi.value) {
      const rv = rsi.value;
      if (rv < 40 || rv > 60) quality += 0.1;
    }

    if (macd && Math.abs(macd.histogram) > 0) quality += 0.1;

    // Cruzamento de EMA se disponível
    if (ema && ema.ema_9 && ema.ema_21) {
       if (ema.ema_9 > ema.ema_21) quality += 0.1;
    }

    return Math.min(1, quality);
  }

  evaluateTrend(indicators) {
    const adx = indicators.adx || indicators.ADX;
    if (adx) {
      const val = parseFloat(adx.value || 0);
      return Math.min(1, val / 50); // ADX 50 é tendência muito forte
    }
    return 0.5;
  }

  calculateConfidence(analysis, setupQuality, trendStrength) {
    return (analysis.winProbability * 0.5) + (setupQuality * 0.25) + (trendStrength * 0.25);
  }

  generateStayReason(indicators, confidence, analysis) {
    const rsi = indicators.rsi || indicators.RSI;
    const adx = indicators.adx || indicators.ADX;
    const macd = indicators.macd || indicators.MACD;

    let reasons = [];

    if (rsi) {
      const val = parseFloat(rsi.value || rsi);
      if (val > 70) reasons.push(`RSI em ${val.toFixed(0)} (Sobrecomprado).`);
      else if (val < 30) reasons.push(`RSI em ${val.toFixed(0)} (Sobrevendido).`);
      else reasons.push(`RSI estável (${val.toFixed(0)}).`);
    }

    if (adx) {
      const val = parseFloat(adx.value || adx);
      if (val > 25) reasons.push("Tendência direcional forte confirmada.");
      else if (val < 15) reasons.push("Baixa volatilidade/Mercado lateral.");
      else reasons.push("Consolidação detectada.");
    }

    if (macd) {
      const hist = parseFloat(macd.histogram || macd.hist || 0);
      if (hist > 0) reasons.push("Momentum de alta (MACD Hist > 0).");
      else if (hist < 0) reasons.push("Momentum de baixa (MACD Hist < 0).");
    }

    const confPercent = Math.round(confidence * 100);
    if (confidence >= 0.70) {
        reasons.unshift(`[ENTRADA] Confiança de ${confPercent}%.`);
    } else if (confidence >= 0.60) {
        reasons.push(`Aguardando confirmação (${confPercent}%).`);
    }

    if (reasons.length === 0) reasons.push("Monitorando fluxo de ordens.");

    return reasons.join(" ");
  }

  determineDecision(confidence, analysis, config) {
    // Reduzido para 70% conforme solicitado para aumentar frequência de entradas
    const entryThreshold = 0.70;

    if (confidence >= entryThreshold) return 'enter';
    if (confidence >= 0.60) return 'wait'; // Analisando possível entrada
    return 'not_enter';
  }

  // Analisa uma posição aberta e decide manobras dinâmicas
  analyzeLivePosition(snapshot, position) {
    const rsi = snapshot.indicators?.rsi?.value || 50;
    const adx = snapshot.indicators?.adx?.value || 20;
    const currentPrice = parseFloat(snapshot.price || snapshot.close);
    const entryPrice = parseFloat(position.entry_price);

    const profitPct = position.side === 'Buy' || position.side === 'buy'
        ? ((currentPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - currentPrice) / entryPrice) * 100;

    let reason = `Lucro: ${profitPct.toFixed(2)}%. RSI: ${rsi.toFixed(0)}. ADX: ${adx.toFixed(0)}.`;

    let decision = {
        action: 'hold',
        reason: `${reason} Posição estável, monitorando...`,
        params: {}
    };

    // 1. SAÍDA PARCIAL (Proteger Lucro)
    if (profitPct >= 2.0 && !position.partial_exit_done) {
        decision.action = 'partial_exit';
        decision.params = { percent: 0.5 };
        decision.reason = `${reason} Alvo de 2% atingido. Realizando parcial de 50%.`;
        return decision;
    }

    // 2. TRAILING STOP (Maximizar Lucro)
    if (profitPct >= 1.5) {
        decision.action = 'activate_trailing';
        // Calcula o recuo de 0.5% em valor absoluto baseado no preço atual
        const distance = (currentPrice * 0.005).toFixed(8);
        decision.params = { trailing_stop: distance };
        decision.reason = "Lucro expressivo detectado. Ativando Trailing Stop para acompanhar a subida.";
        return decision;
    }

    // 3. ENTRADA PARCIAL (Aumentar aposta se promissor)
    if (profitPct > 0.5 && profitPct < 1.0 && adx > 25 && (position.partial_entry_count || 0) < 2) {
        decision.action = 'partial_entry';
        decision.reason = "Tendência forte confirmada. Realizando entrada parcial para maximizar retorno.";
        return decision;
    }

    // 4. GESTÃO DE LOSS (Reduzir Stop se reverter)
    if (profitPct < -1.0) {
        if (rsi > 60 && position.side === 'buy') {
            decision.action = 'move_stop';
            decision.params = { new_stop: entryPrice * 0.992 }; // Encurta o stop
            decision.reason = "Sinais de reversão contra a posição. Encurtando stop para minimizar perda.";
        } else if (rsi < 40 && position.side === 'buy') {
            decision.action = 'move_stop';
            decision.params = { new_stop: entryPrice * 0.97 }; // Dá mais espaço se for só um susto
            decision.reason = "Pullback saudável detectado. Ajustando stop para evitar violinada.";
        }
    }

    return decision;
  }

  getFallbackDecision(snapshot) {
    return {
      coin_id: snapshot.coin_id,
      decision: 'wait',
      confidence: 0.5,
      win_probability: 0.5,
      timestamp: new Date()
    };
  }
}

module.exports = Intelligence;
