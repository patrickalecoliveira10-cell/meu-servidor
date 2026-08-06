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

      const currentWeights = weights.coins?.[coin_id] || weights.global;
      const analysis = this.calculateProbabilities(indicators || {}, currentWeights);
      const setupQuality = this.evaluateSetup(indicators || {});
      const trendStrength = this.evaluateTrend(indicators || {});
      const confidence = this.calculateConfidence(analysis, setupQuality, trendStrength);
      const stayReason = this.generateStayReason(indicators || {}, confidence, analysis);
      const decisionResult = this.determineDecision(confidence, analysis);
      const price = parseFloat(snapshot.price || snapshot.close || 0);

      return {
        coin_id,
        timeframe,
        decision: decisionResult,
        price,
        side: analysis.side,
        confidence,
        stayReason,
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
    let bullScore = 0;
    let bearScore = 0;
    let totalWeight = 0;
    let hasConfirmation = false;
    const signals = {};

    // ── RSI ──────────────────────────────────────────────────────────────────
    const rsi = indicators.rsi || indicators.RSI;
    if (rsi) {
      const val = parseFloat(rsi.value ?? rsi);
      const w = parseFloat(weights['RSI'] ?? weights['rsi'] ?? 1.0);
      if (val < 30)       { bullScore += 1.0 * w; signals['rsi'] = 1.0; }
      else if (val < 40)  { bullScore += 0.5 * w; signals['rsi'] = 0.5; }
      else if (val > 70)  { bearScore += 1.0 * w; signals['rsi'] = -1.0; }
      else if (val > 60)  { bearScore += 0.5 * w; signals['rsi'] = -0.5; }
      else                { signals['rsi'] = 0; }
      totalWeight += w;
    }

    // ── MACD ─────────────────────────────────────────────────────────────────
    const macd = indicators.macd || indicators.MACD;
    if (macd) {
      const hist = parseFloat(macd.histogram ?? macd.hist ?? 0);
      const w = parseFloat(weights['MACD'] ?? weights['macd'] ?? 1.0);
      if (hist > 0)  { bullScore += 0.7 * w; signals['macd'] = 0.7; hasConfirmation = true; }
      else if (hist < 0) { bearScore += 0.7 * w; signals['macd'] = -0.7; }
      totalWeight += w;
    }

    // ── ADX ──────────────────────────────────────────────────────────────────
    const adx = indicators.adx || indicators.ADX;
    if (adx) {
      const val = parseFloat(adx.value ?? adx);
      const w = parseFloat(weights['ADX'] ?? weights['adx'] ?? 0.8);
      if (val > 25) { bullScore += 0.5 * w; signals['adx'] = 0.5; hasConfirmation = true; }
      else if (val < 15) { bearScore += 0.2 * w; signals['adx'] = -0.2; }
      totalWeight += w;
    }

    // ── EMA (cruzamento 9/21) ─────────────────────────────────────────────────
    const ema = indicators.ema || indicators.EMA;
    if (ema && ema.ema_9 && ema.ema_21) {
      const w = parseFloat(weights['EMA'] ?? weights['ema'] ?? 0.9);
      const price = parseFloat(indicators.price ?? ema.ema_9);
      if (ema.ema_9 > ema.ema_21) {
        bullScore += 0.8 * w; signals['ema'] = 0.8; hasConfirmation = true;
      } else {
        bearScore += 0.8 * w; signals['ema'] = -0.8;
      }
      // Preço acima da EMA21 = tendência de alta
      if (price > ema.ema_21) { bullScore += 0.3 * w; }
      totalWeight += w;
    }

    // ── BOLLINGER BANDS ── { upper, lower, middle, position } ─────────────────
    const bb = indicators.bollinger;
    if (bb && bb.lower && bb.upper) {
      const price = parseFloat(indicators.close ?? 0);
      const w = parseFloat(weights['BOLLINGER'] ?? 0.7);
      if (price > 0) {
        if (bb.position === 'below_lower' || price <= bb.lower)  { bullScore += 0.9 * w; signals['bollinger'] = 0.9; hasConfirmation = true; }
        else if (bb.position === 'above_upper' || price >= bb.upper) { bearScore += 0.9 * w; signals['bollinger'] = -0.9; }
        totalWeight += w;
      }
    }

    // ── SUPERTREND ── { value, signal: 'bullish'/'bearish' } ──────────────────
    const st = indicators.supertrend;
    if (st && st.signal) {
      const w = parseFloat(weights['SUPERTREND'] ?? 0.85);
      if (st.signal === 'bullish') { bullScore += 0.9 * w; signals['supertrend'] = 0.9; hasConfirmation = true; }
      else if (st.signal === 'bearish') { bearScore += 0.9 * w; signals['supertrend'] = -0.9; }
      totalWeight += w;
    }

    // ── PSAR ── { value, signal: 'bullish'/'bearish' } ────────────────────────
    const psar = indicators.psar;
    if (psar && psar.signal) {
      const w = parseFloat(weights['PSAR'] ?? 0.7);
      if (psar.signal === 'bullish') { bullScore += 0.7 * w; signals['psar'] = 0.7; hasConfirmation = true; }
      else if (psar.signal === 'bearish') { bearScore += 0.7 * w; signals['psar'] = -0.7; }
      totalWeight += w;
    }

    // ── VWAP ── número direto ─────────────────────────────────────────────────
    const vwap = indicators.vwap;
    if (vwap && typeof vwap === 'number') {
      const price = parseFloat(indicators.close ?? 0);
      const w = parseFloat(weights['VWAP'] ?? 0.75);
      if (price > 0) {
        if (price > vwap)       { bullScore += 0.6 * w; signals['vwap'] = 0.6; }
        else if (price < vwap)  { bearScore += 0.6 * w; signals['vwap'] = -0.6; }
        totalWeight += w;
      }
    }

    // ── STOCHASTIC ── { k, d, signal } ────────────────────────────────────────
    const stoch = indicators.stochastic;
    if (stoch && stoch.k !== undefined) {
      const k = parseFloat(stoch.k);
      const w = parseFloat(weights['STOCHASTIC'] ?? 0.6);
      if (stoch.signal === 'oversold' || k < 20)       { bullScore += 0.7 * w; signals['stochastic'] = 0.7; }
      else if (stoch.signal === 'overbought' || k > 80) { bearScore += 0.7 * w; signals['stochastic'] = -0.7; }
      totalWeight += w;
    }

    // ── OBV ── número direto (compara com média simples dos últimos valores) ───
    // OBV sozinho não dá direção sem histórico, então ignoramos como sinal isolado
    // mas registramos para o sistema de pesos aprender

    // ── CÁLCULO FINAL ─────────────────────────────────────────────────────────
    const netScore = totalWeight > 0 ? (bullScore - bearScore) / totalWeight : 0;
    const winProbability = Math.max(0.1, Math.min(0.9, (netScore + 1) / 2));

    // Só entra em BUY — nunca em SELL
    const side = winProbability >= 0.65 ? 'buy' : null;

    return {
      winProbability,
      lossProbability: 1 - winProbability,
      riskRatio: 2.0,
      side,
      hasConfirmation,
      signals
    };
  }

  evaluateSetup(indicators) {
    let quality = 0.5;
    const rsi = indicators.rsi || indicators.RSI;
    const macd = indicators.macd || indicators.MACD;
    const ema = indicators.ema || indicators.EMA;
    const bb = indicators.bollinger || indicators.BOLLINGER || indicators.bb;
    const st = indicators.supertrend || indicators.SUPERTREND;

    if (rsi) {
      const rv = parseFloat(rsi.value ?? rsi);
      if (rv < 35 || rv > 65) quality += 0.1;
    }
    if (macd && Math.abs(parseFloat(macd.histogram ?? 0)) > 0) quality += 0.1;
    if (ema && ema.ema_9 && ema.ema_21 && ema.ema_9 > ema.ema_21) quality += 0.1;
    if (bb) {
      const price = parseFloat(indicators.price ?? 0);
      const lower = parseFloat(bb.lower ?? bb.lowerBand ?? 0);
      if (price > 0 && lower > 0 && price <= lower) quality += 0.15;
    }
    if (st && (st.direction === 1 || st.trend === 'up' || st.trend === 'UP')) quality += 0.1;

    return Math.min(1, quality);
  }

  evaluateTrend(indicators) {
    const adx = indicators.adx || indicators.ADX;
    const st = indicators.supertrend || indicators.SUPERTREND;
    const ichi = indicators.ichimoku || indicators.ICHIMOKU;

    let trendScore = 0;
    let count = 0;

    if (adx) {
      trendScore += Math.min(1, parseFloat(adx.value ?? 0) / 50);
      count++;
    }
    if (st) {
      trendScore += (st.direction === 1 || st.trend === 'up') ? 0.8 : 0.2;
      count++;
    }
    if (ichi) {
      const price = parseFloat(indicators.price ?? 0);
      const spanA = parseFloat(ichi.span_a ?? ichi.senkouA ?? 0);
      const spanB = parseFloat(ichi.span_b ?? ichi.senkouB ?? 0);
      if (price > 0 && spanA > 0) {
        trendScore += price > Math.max(spanA, spanB) ? 0.9 : 0.3;
        count++;
      }
    }

    return count > 0 ? trendScore / count : 0.5;
  }

  calculateConfidence(analysis, setupQuality, trendStrength) {
    return (analysis.winProbability * 0.5) + (setupQuality * 0.25) + (trendStrength * 0.25);
  }

  generateStayReason(indicators, confidence, analysis) {
    const rsi = indicators.rsi || indicators.RSI;
    const adx = indicators.adx || indicators.ADX;
    const macd = indicators.macd || indicators.MACD;
    const st = indicators.supertrend || indicators.SUPERTREND;
    const bb = indicators.bollinger || indicators.BOLLINGER || indicators.bb;

    let reasons = [];

    if (rsi) {
      const val = parseFloat(rsi.value ?? rsi);
      if (val > 65)      reasons.push(`RSI em ${val.toFixed(0)} (Sobrecomprado).`);
      else if (val < 35) reasons.push(`RSI em ${val.toFixed(0)} (Sobrevendido).`);
      else               reasons.push(`RSI estável (${val.toFixed(0)}).`);
    }

    if (adx) {
      const val = parseFloat(adx.value ?? adx);
      if (val > 25)      reasons.push('Tendência forte (ADX).');
      else if (val < 15) reasons.push('Mercado lateral (ADX).');
    }

    if (macd) {
      const hist = parseFloat(macd.histogram ?? macd.hist ?? 0);
      if (hist > 0)      reasons.push('MACD bullish.');
      else if (hist < 0) reasons.push('MACD bearish.');
    }

    if (st) {
      if (st.direction === 1 || st.trend === 'up' || st.trend === 'UP') reasons.push('Supertrend: alta.');
      else if (st.direction === -1 || st.trend === 'down')               reasons.push('Supertrend: baixa.');
    }

    if (bb) {
      const price = parseFloat(indicators.price ?? 0);
      const lower = parseFloat(bb.lower ?? bb.lowerBand ?? 0);
      const upper = parseFloat(bb.upper ?? bb.upperBand ?? 0);
      if (price > 0 && lower > 0 && price <= lower)  reasons.push('Preço na banda inferior (BB).');
      else if (price > 0 && upper > 0 && price >= upper) reasons.push('Preço na banda superior (BB).');
    }

    const confPercent = Math.round(confidence * 100);
    if (confidence >= 0.68) {
      reasons.unshift(`[ENTRADA] Confiança de ${confPercent}%.`);
    } else if (confidence >= 0.55) {
      reasons.push(`Aguardando confirmação (${confPercent}%).`);
    }

    if (reasons.length === 0) reasons.push('Monitorando mercado.');
    return reasons.join(' ');
  }

  determineDecision(confidence, analysis) {
    // Exige: confiança >= 68% + side=buy + pelo menos 1 confirmação (MACD/ADX/EMA/Supertrend/Ichimoku/BB)
    if (confidence >= 0.68 && analysis.side === 'buy' && analysis.hasConfirmation) return 'enter';
    if (confidence >= 0.55) return 'wait';
    return 'not_enter';
  }

  analyzeLivePosition(snapshot, position) {
    const rsi = snapshot.indicators?.rsi?.value || 50;
    const adx = snapshot.indicators?.adx?.value || 20;
    const currentPrice = parseFloat(snapshot.price || snapshot.close);
    const entryPrice = parseFloat(position.entry_price);

    const profitPct = position.side === 'Buy' || position.side === 'buy'
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - currentPrice) / entryPrice) * 100;

    let reason = `Lucro: ${profitPct.toFixed(2)}%. RSI: ${rsi.toFixed(0)}. ADX: ${adx.toFixed(0)}.`;
    let decision = { action: 'hold', reason: `${reason} Posição estável, monitorando...`, params: {} };

    if (profitPct >= 2.0 && !position.partial_exit_done) {
      decision.action = 'partial_exit';
      decision.params = { percent: 0.5 };
      decision.reason = `${reason} Alvo de 2% atingido. Realizando parcial de 50%.`;
      return decision;
    }
    if (profitPct >= 1.5) {
      decision.action = 'activate_trailing';
      decision.params = { trailing_stop: (currentPrice * 0.005).toFixed(8) };
      decision.reason = 'Lucro expressivo. Ativando Trailing Stop.';
      return decision;
    }
    if (profitPct > 0.5 && profitPct < 1.0 && adx > 25 && (position.partial_entry_count || 0) < 2) {
      decision.action = 'partial_entry';
      decision.reason = 'Tendência forte. Realizando entrada parcial.';
      return decision;
    }
    if (profitPct < -1.0) {
      if (rsi > 60 && position.side === 'buy') {
        decision.action = 'move_stop';
        decision.params = { new_stop: entryPrice * 0.992 };
        decision.reason = 'Sinais de reversão. Encurtando stop.';
      } else if (rsi < 40 && position.side === 'buy') {
        decision.action = 'move_stop';
        decision.params = { new_stop: entryPrice * 0.97 };
        decision.reason = 'Pullback detectado. Ajustando stop.';
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
