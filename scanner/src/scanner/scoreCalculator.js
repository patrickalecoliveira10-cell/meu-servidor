const config = require('../config');

class ScoreCalculator {
  constructor() {
    this.config = config.score;
  }

  calculateScore(marketData, indicators) {
    let score = 50; // Base score
    const factors = [];

    // 1. RSI Factor (20 points)
    if (indicators.rsi) {
      const rsi = indicators.rsi.value;
      if (rsi <= 30) {
        score += 20;
        factors.push({ name: 'RSI Oversold', value: 20, reason: `RSI at ${rsi.toFixed(2)} (oversold)` });
      } else if (rsi <= 40) {
        score += 10;
        factors.push({ name: 'RSI Low', value: 10, reason: `RSI at ${rsi.toFixed(2)} (low)` });
      } else if (rsi >= 70) {
        score -= 10;
        factors.push({ name: 'RSI Overbought', value: -10, reason: `RSI at ${rsi.toFixed(2)} (overbought)` });
      } else if (rsi >= 80) {
        score -= 20;
        factors.push({ name: 'RSI High', value: -20, reason: `RSI at ${rsi.toFixed(2)} (high)` });
      }
    }

    // 2. MACD Factor (15 points)
    if (indicators.macd) {
      if (indicators.macd.signal === 'bullish') {
        score += 15;
        factors.push({ name: 'MACD Bullish', value: 15, reason: 'MACD histogram positive' });
      } else if (indicators.macd.signal === 'bearish') {
        score -= 10;
        factors.push({ name: 'MACD Bearish', value: -10, reason: 'MACD histogram negative' });
      }
    }

    // 3. EMA Alignment (15 points)
    if (indicators.ema) {
      const ema9 = indicators.ema.ema_9;
      const ema21 = indicators.ema.ema_21;
      const ema50 = indicators.ema.ema_50;
      const price = marketData.close;

      if (ema9 && ema21 && ema50) {
        // Bullish alignment: price > EMA9 > EMA21 > EMA50
        if (price > ema9 && ema9 > ema21 && ema21 > ema50) {
          score += 15;
          factors.push({ name: 'EMA Bullish Alignment', value: 15, reason: 'Price above EMAs with bullish alignment' });
        }
        // Bearish alignment: price < EMA9 < EMA21 < EMA50
        else if (price < ema9 && ema9 < ema21 && ema21 < ema50) {
          score -= 10;
          factors.push({ name: 'EMA Bearish Alignment', value: -10, reason: 'Price below EMAs with bearish alignment' });
        }
      }
    }

    // 4. ADX Strength (10 points)
    if (indicators.adx) {
      if (indicators.adx.strength === 'strong') {
        score += 10;
        factors.push({ name: 'ADX Strong Trend', value: 10, reason: `ADX at ${indicators.adx.value.toFixed(2)} (strong trend)` });
      } else if (indicators.adx.strength === 'trending') {
        score += 5;
        factors.push({ name: 'ADX Trending', value: 5, reason: `ADX at ${indicators.adx.value.toFixed(2)} (trending)` });
      }
    }

    // 5. Bollinger Bands Position (10 points)
    if (indicators.bollinger) {
      if (indicators.bollinger.position === 'below_lower') {
        score += 10;
        factors.push({ name: 'BB Below Lower', value: 10, reason: 'Price below Bollinger lower band' });
      } else if (indicators.bollinger.position === 'above_upper') {
        score -= 5;
        factors.push({ name: 'BB Above Upper', value: -5, reason: 'Price above Bollinger upper band' });
      }
    }

    // 6. Volume Factor (10 points)
    if (marketData.volume_avg) {
      const volumeRatio = marketData.volume / marketData.volume_avg;
      if (volumeRatio > 2) {
        score += 10;
        factors.push({ name: 'High Volume', value: 10, reason: `Volume ${volumeRatio.toFixed(2)}x average` });
      } else if (volumeRatio > 1.5) {
        score += 5;
        factors.push({ name: 'Above Average Volume', value: 5, reason: `Volume ${volumeRatio.toFixed(2)}x average` });
      } else if (volumeRatio < 0.5) {
        score -= 5;
        factors.push({ name: 'Low Volume', value: -5, reason: `Volume ${volumeRatio.toFixed(2)}x average` });
      }
    }

    // 7. Price Change (10 points)
    if (marketData.priceChange24h) {
      const change = Math.abs(marketData.priceChange24h);
      if (change > 5 && change < 15) {
        score += 5;
        factors.push({ name: 'Moderate Movement', value: 5, reason: `24h change: ${marketData.priceChange24h.toFixed(2)}%` });
      } else if (change > 15) {
        score -= 5;
        factors.push({ name: 'Extreme Movement', value: -5, reason: `24h change: ${marketData.priceChange24h.toFixed(2)}% (too volatile)` });
      }
    }

    // 8. Volatility Factor (5 points)
    if (indicators.atr && marketData.close) {
      const atrPercent = (indicators.atr / marketData.close) * 100;
      if (atrPercent > 2 && atrPercent < 5) {
        score += 5;
        factors.push({ name: 'Good Volatility', value: 5, reason: `ATR: ${atrPercent.toFixed(2)}%` });
      } else if (atrPercent > 5) {
        score -= 3;
        factors.push({ name: 'High Volatility', value: -3, reason: `ATR: ${atrPercent.toFixed(2)}% (too high)` });
      }
    }

    // 9. Supertrend (5 points)
    if (indicators.supertrend) {
      if (indicators.supertrend.signal === 'bullish') {
        score += 5;
        factors.push({ name: 'Supertrend Bullish', value: 5, reason: 'Supertrend bullish' });
      } else if (indicators.supertrend.signal === 'bearish') {
        score -= 5;
        factors.push({ name: 'Supertrend Bearish', value: -5, reason: 'Supertrend bearish' });
      }
    }

    // Clamp score between min and max
    score = Math.max(this.config.min, Math.min(this.config.max, score));

    // Determine category
    let category = 'weak';
    if (score >= this.config.excellentThreshold) {
      category = 'excellent';
    } else if (score >= this.config.goodThreshold) {
      category = 'good';
    } else if (score >= this.config.neutralThreshold) {
      category = 'neutral';
    }

    return {
      score,
      category,
      factors,
      timestamp: Date.now()
    };
  }

  getScoreCategory(score) {
    if (score >= this.config.excellentThreshold) return 'excellent';
    if (score >= this.config.goodThreshold) return 'good';
    if (score >= this.config.neutralThreshold) return 'neutral';
    return 'weak';
  }
}

module.exports = new ScoreCalculator();
