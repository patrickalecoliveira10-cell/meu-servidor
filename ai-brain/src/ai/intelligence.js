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
            signal = parseFloat(ind.histogram || 0) > 0 ? 0.6 : -0.6;
          } else if (name.toLowerCase() === 'adx') {
            signal = (parseFloat(ind.value || 0) > 25) ? 0.4 : 0;
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
      if (val > 70) reasons.push("Sobrecomprado (RSI alto).");
      else if (val < 30) reasons.push("Sobrevendido (RSI baixo).");
      else reasons.push(`RSI saudável em ${val.toFixed(0)}.`);
    }

    if (adx) {
      const val = parseFloat(adx.value || adx);
      if (val > 25) reasons.push("Tendência direcional forte.");
      else reasons.push("Consolidação/Baixa volatilidade.");
    }

    if (macd) {
      const hist = parseFloat(macd.histogram || macd.hist || 0);
      if (hist > 0) reasons.push("Momentum comprador (MACD Hist > 0).");
      else if (hist < 0) reasons.push("Momentum vendedor (MACD Hist < 0).");
    }

    if (confidence > 0.70) reasons.push("Configuração técnica de alta probabilidade.");
    if (reasons.length === 0) reasons.push("Monitorando fluxo de ordens e suportes.");

    return reasons.join(" ");
  }

  determineDecision(confidence, analysis, config) {
    let threshold = config.confidence_threshold || 0.7;
    if (threshold > 1) threshold = threshold / 100;

    if (confidence >= threshold) return 'enter';
    if (confidence >= threshold - 0.1) return 'wait';
    return 'not_enter';
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

module.exports = new Intelligence();
