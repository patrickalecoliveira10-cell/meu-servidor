const logger = require('../logs/logger.js');

class Intelligence {
  constructor() {
    this.brain = null;
  }

  async init(brain) {
    this.brain = brain;
    logger.info('Intelligence module initialized');
  }

  async analyze(snapshot, weights, config) {
    try {
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
        if (ind.signal !== undefined) {
          signal = parseFloat(ind.signal);
        } else {
          const val = parseFloat(ind.value || ind);
          if (name.toLowerCase() === 'rsi') {
            if (val < 35) signal = 0.8;
            else if (val > 65) signal = -0.8;
          } else if (name.toLowerCase() === 'macd') {
            signal = parseFloat(ind.hist || 0) > 0 ? 0.5 : -0.5;
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
    if (rsi && macd) quality += 0.2;
    return Math.min(1, quality);
  }

  evaluateTrend(indicators) {
    const adx = indicators.adx || indicators.ADX;
    if (adx) return Math.min(1, parseFloat(adx.value || adx) / 100);
    return 0.5;
  }

  calculateConfidence(analysis, setupQuality, trendStrength) {
    return (analysis.winProbability * 0.6) + (setupQuality * 0.2) + (trendStrength * 0.2);
  }

  generateStayReason(indicators, confidence, analysis) {
    const rsi = indicators.rsi || indicators.RSI;
    const adx = indicators.adx || indicators.ADX;
    const macd = indicators.macd || indicators.MACD;

    let reasons = [];

    if (rsi) {
      const val = parseFloat(rsi.value || rsi);
      if (val > 70) reasons.push("Sobrecomprado (RSI alto).");
      else if (val < 30) reasons.push("Sobreprendido (RSI baixo).");
      else reasons.push(`RSI em ${val.toFixed(0)}.`);
    }

    if (adx) {
      const val = parseFloat(adx.value || adx);
      if (val > 25) reasons.push("Tendência forte.");
      else reasons.push("Mercado lateral.");
    }

    if (macd && macd.hist) {
      const hist = parseFloat(macd.hist);
      if (hist > 0) reasons.push("Momentum de alta.");
      else reasons.push("Pressão vendedora.");
    }

    if (confidence > 0.70) reasons.push("Sinal de alta confiança.");

    return reasons.length > 0 ? reasons.join(" ") : "Monitorando volatilidade e padrões de preço.";
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
