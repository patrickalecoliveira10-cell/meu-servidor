const technicalindicators = require('technicalindicators');

class IndicatorsCalculator {
  calculateAll(data) {
    if (!data || data.length < 20) return null;
    
    const closes = data.map(c => c.close);
    const results = { timestamp: data[data.length - 1].timestamp };

    try {
      const rsi = technicalindicators.RSI.calculate({ values: closes, period: 14 });
      results.rsi = rsi.length ? rsi[rsi.length - 1] : null;

      const atr = technicalindicators.ATR.calculate({
        high: data.map(c => c.high),
        low: data.map(c => c.low),
        close: closes,
        period: 14
      });
      results.atr = atr.length ? atr[atr.length - 1] : null;
    } catch (e) {
      console.error("Indicator calculation error:", e.message);
    }

    return results;
  }
}

module.exports = new IndicatorsCalculator();
