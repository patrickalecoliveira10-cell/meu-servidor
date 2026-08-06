  async start() {
    if (this.isRunning) {
      logger.warn('Scanner is already running');
      return;
    }

    logger.info('Starting Market Scanner...');
    // Log config state at startup to confirm indicator flags
    const cfg = config.indicators;
    logger.info(`[SCANNER-CONFIG] macd=${cfg.macd} adx=${cfg.adx} ema=${cfg.ema} bb=${cfg.bollinger} st=${cfg.supertrend} psar=${cfg.psar} stoch=${cfg.stochastic} vwap=${cfg.vwap} obv=${cfg.obv}`);
    this.isRunning = true;
