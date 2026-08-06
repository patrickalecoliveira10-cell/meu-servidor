const technicalindicators = require('technicalindicators');
const config = require('../config');

class IndicatorsCalculator {
  get config() {
    return config.indicators;
  }

  // Calculate EMA
  calculateEMA(data, period) {
    if (!this.config.ema) return null;
    
    const input = {
      values: data.map(c => c.close),
      period: period
    };
    
    try {
      const result = technicalindicators.EMA.calculate(input);
      return result[result.length - 1];
    } catch (error) {
      console.error(`Error calculating EMA ${period}:`, error.message);
      return null;
    }
  }

  // Calculate multiple EMAs
  calculateEMAs(data) {
    const results = {};
    this.config.emaPeriods.forEach(period => {
      results[`ema_${period}`] = this.calculateEMA(data, period);
    });
    return results;
  }

  // Calculate VWAP
  calculateVWAP(data) {
    if (!this.config.vwap) return null;
    
    try {
      let cumulativeTPV = 0;
      let cumulativeVolume = 0;
      
      data.forEach(candle => {
        const typicalPrice = (candle.high + candle.low + candle.close) / 3;
        cumulativeTPV += typicalPrice * candle.volume;
        cumulativeVolume += candle.volume;
      });
      
      return cumulativeTPV / cumulativeVolume;
    } catch (error) {
      console.error('Error calculating VWAP:', error.message);
      return null;
    }
  }

  // Calculate RSI
  calculateRSI(data, period = this.config.rsiPeriod) {
    if (!this.config.rsi) return null;
    
    const input = {
      values: data.map(c => c.close),
      period: period
    };
    
    try {
      const result = technicalindicators.RSI.calculate(input);
      const rsiValue = result[result.length - 1];
      
      let signal = 'neutral';
      if (rsiValue >= this.config.rsiOverbought) signal = 'overbought';
      else if (rsiValue <= this.config.rsiOversold) signal = 'oversold';
      
      return { value: rsiValue, signal };
    } catch (error) {
      console.error('Error calculating RSI:', error.message);
      return null;
    }
  }

  // Calculate MACD
  calculateMACD(data) {
    if (!this.config.macd) return null;
    
    const input = {
      values: data.map(c => c.close),
      fastPeriod: this.config.macdFast,
      slowPeriod: this.config.macdSlow,
      signalPeriod: this.config.macdSignal,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    };
    
    try {
      const result = technicalindicators.MACD.calculate(input);
      const macd = result[result.length - 1];
      
      let signal = 'neutral';
      if (macd.histogram > 0) signal = 'bullish';
      else if (macd.histogram < 0) signal = 'bearish';
      
      return {
        macd: macd.MACD,
        signal: macd.signal,
        histogram: macd.histogram,
        signal
      };
    } catch (error) {
      console.error('Error calculating MACD:', error.message);
      return null;
    }
  }

  // Calculate ADX
  calculateADX(data, period = this.config.adxPeriod) {
    if (!this.config.adx) return null;
    
    const input = {
      high: data.map(c => c.high),
      low: data.map(c => c.low),
      close: data.map(c => c.close),
      period: period
    };
    
    try {
      const result = technicalindicators.ADX.calculate(input);
      const adx = result[result.length - 1];
      
      let strength = 'weak';
      if (adx >= 25) strength = 'strong';
      else if (adx >= 20) strength = 'trending';
      
      return { value: adx.adx, strength };
    } catch (error) {
      console.error('Error calculating ADX:', error.message);
      return null;
    }
  }

  // Calculate ATR
  calculateATR(data, period = this.config.atrPeriod) {
    if (!this.config.atr) return null;
    
    const input = {
      high: data.map(c => c.high),
      low: data.map(c => c.low),
      close: data.map(c => c.close),
      period: period
    };
    
    try {
      const result = technicalindicators.ATR.calculate(input);
      return result[result.length - 1];
    } catch (error) {
      console.error('Error calculating ATR:', error.message);
      return null;
    }
  }

  // Calculate Bollinger Bands
  calculateBollingerBands(data) {
    if (!this.config.bollinger) return null;
    
    const input = {
      period: this.config.bollingerPeriod,
      stdDev: this.config.bollingerStdDev,
      values: data.map(c => c.close)
    };
    
    try {
      const result = technicalindicators.BollingerBands.calculate(input);
      const bb = result[result.length - 1];
      
      const currentPrice = data[data.length - 1].close;
      let position = 'middle';
      if (currentPrice > bb.upper) position = 'above_upper';
      else if (currentPrice < bb.lower) position = 'below_lower';
      else if (currentPrice > (bb.middle + bb.upper) / 2) position = 'upper';
      else if (currentPrice < (bb.middle + bb.lower) / 2) position = 'lower';
      
      return {
        middle: bb.middle,
        upper: bb.upper,
        lower: bb.lower,
        bandwidth: (bb.upper - bb.lower) / bb.middle,
        position
      };
    } catch (error) {
      console.error('Error calculating Bollinger Bands:', error.message);
      return null;
    }
  }

  // Calculate Parabolic SAR
  calculatePSAR(data) {
    if (!this.config.psar) return null;
    
    const input = {
      high: data.map(c => c.high),
      low: data.map(c => c.low),
      step: 0.02,
      max: 0.2
    };
    
    try {
      const result = technicalindicators.PSAR.calculate(input);
      const psar = result[result.length - 1];
      
      const currentPrice = data[data.length - 1].close;
      let signal = 'neutral';
      if (currentPrice > psar) signal = 'bullish';
      else if (currentPrice < psar) signal = 'bearish';
      
      return { value: psar, signal };
    } catch (error) {
      console.error('Error calculating PSAR:', error.message);
      return null;
    }
  }

  // Calculate Stochastic
  calculateStochastic(data) {
    if (!this.config.stochastic) return null;
    
    const input = {
      high: data.map(c => c.high),
      low: data.map(c => c.low),
      close: data.map(c => c.close),
      period: this.config.stochKPeriod,
      signalPeriod: this.config.stochDPeriod
    };
    
    try {
      const result = technicalindicators.Stochastic.calculate(input);
      const stoch = result[result.length - 1];
      
      let signal = 'neutral';
      if (stoch.k > 80) signal = 'overbought';
      else if (stoch.k < 20) signal = 'oversold';
      
      return {
        k: stoch.k,
        d: stoch.d,
        signal
      };
    } catch (error) {
      console.error('Error calculating Stochastic:', error.message);
      return null;
    }
  }

  // Calculate KAMA
  calculateKAMA(data) {
    if (!this.config.kama) return null;
    
    const input = {
      values: data.map(c => c.close),
      period: 10,
      fastPeriod: 2,
      slowPeriod: 30
    };
    
    try {
      const result = technicalindicators.KAMA.calculate(input);
      return result[result.length - 1];
    } catch (error) {
      console.error('Error calculating KAMA:', error.message);
      return null;
    }
  }

  // Calculate OBV
  calculateOBV(data) {
    if (!this.config.obv) return null;
    
    const input = {
      close: data.map(c => c.close),
      volume: data.map(c => c.volume)
    };
    
    try {
      const result = technicalindicators.OBV.calculate(input);
      return result[result.length - 1];
    } catch (error) {
      console.error('Error calculating OBV:', error.message);
      return null;
    }
  }

  // Calculate Supertrend
  calculateSupertrend(data, period = 10, multiplier = 3) {
    if (!this.config.supertrend) return null;
    
    try {
      const atr = this.calculateATR(data, period);
      if (!atr) return null;
      
      const hl2 = data.map(c => (c.high + c.low) / 2);
      const upperBand = hl2.map((val, i) => val + multiplier * atr);
      const lowerBand = hl2.map((val, i) => val - multiplier * atr);
      
      const lastClose = data[data.length - 1].close;
      const lastUpper = upperBand[upperBand.length - 1];
      const lastLower = lowerBand[lowerBand.length - 1];
      
      let supertrend = lastUpper;
      let signal = 'bearish';
      
      if (lastClose > lastUpper) {
        supertrend = lastLower;
        signal = 'bullish';
      }
      
      return { value: supertrend, signal };
    } catch (error) {
      console.error('Error calculating Supertrend:', error.message);
      return null;
    }
  }

  // Calculate all indicators
  calculateAll(data) {
    const indicators = {
      timestamp: data[data.length - 1].timestamp || Date.now(),
    };

    if (this.config.ema) {
      indicators.ema = this.calculateEMAs(data);
    }

    if (this.config.vwap) {
      indicators.vwap = this.calculateVWAP(data);
    }

    if (this.config.rsi) {
      indicators.rsi = this.calculateRSI(data);
    }

    if (this.config.macd) {
      indicators.macd = this.calculateMACD(data);
    }

    if (this.config.adx) {
      indicators.adx = this.calculateADX(data);
    }

    if (this.config.atr) {
      indicators.atr = this.calculateATR(data);
    }

    if (this.config.bollinger) {
      indicators.bollinger = this.calculateBollingerBands(data);
    }

    if (this.config.psar) {
      indicators.psar = this.calculatePSAR(data);
    }

    if (this.config.stochastic) {
      indicators.stochastic = this.calculateStochastic(data);
    }

    if (this.config.kama) {
      indicators.kama = this.calculateKAMA(data);
    }

    if (this.config.obv) {
      indicators.obv = this.calculateOBV(data);
    }

    if (this.config.supertrend) {
      indicators.supertrend = this.calculateSupertrend(data);
    }

    return indicators;
  }
}

module.exports = new IndicatorsCalculator();
