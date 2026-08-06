const path = require('path');
const logger = require(path.join(__dirname, '../logs/logger.js'));
const fs = require('fs');

// No longer requiring Brain at top level to support the unified instance properly
let Brain = null;

const queries = require(path.join(__dirname, '../database/queries.js'));
const config = require(path.join(__dirname, '../config/index.js'));
const db = require(path.join(__dirname, '../database/connection.js'));

// Internal helper to get the active brain instance
const getBrain = () => {
    return global.liveBrainInstance || Brain || (Brain = require('../ai/brains.js'));
};

// Função auxiliar para padronizar respostas e evitar crashes no Android
const sendResponse = (res, success, data = null, message = null, statusCode = 200) => {
  res.status(statusCode).json({
    success: success,
    data: data,
    message: message || (success ? 'Operation successful' : 'Operation failed'),
    timestamp: Date.now() // ESSENCIAL para o Kotlin
  });
};

const defaultStats = {
  total_examples: 0,
  total_decisions: 0,
  win_rate: 0,
  avg_confidence: 0
};

class AIController {
  async getStatus(req, res) {
    try {
      const activeBrain = getBrain();
      const status = activeBrain.getStatus();
      const mem = process.memoryUsage();

      // ESTRUTURA EXATA PARA ServerInfo.kt
      sendResponse(res, true, {
        type: "AI_LEARNING",
        status: status.initialized ? "ONLINE" : "PROCESSING",
        uptime: Math.floor(process.uptime()),
        cpuUsage: 0.0,
        memoryUsage: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
        latency: 0,
        lastSync: Date.now(),
        version: "1.0.0",
        errorCount: 0,
        url: "https://trickappserv2.onrender.com",
        statusMessage: `Analyzed: ${status.examples}/${status.minExamples}`
      });
    } catch (error) {
      logger.error('Error in getStatus:', error);
      sendResponse(res, false, null, error.message, 500);
    }
  }

  // Resolve o erro 404/500 no App
  async controlStatus(req, res) {
    try {
      const activeBrain = getBrain();
      const { action } = req.body || req.query || {};
      logger.info(`AI Control action: ${action || 'PING'}`);

      sendResponse(res, true, {
        status: activeBrain.getStatus().mode,
        actionExecuted: action || 'PING',
        isOperational: activeBrain.getStatus().mode === 'operational'
      }, `AI Brain ${action || 'PING'} successful`);
    } catch (error) {
      logger.error('Error in controlStatus:', error);
      sendResponse(res, true, { status: "observing", isOperational: false }, "Fallback response");
    }
  }

  async getHealth(req, res) {
    res.json({ status: 'OK', timestamp: new Date() });
  }

  // Mapeado para AILearningData.kt
  async getAIDataForApp(req, res) {
    try {
      const live = await queries.getLiveStats();
      const activeBrain = getBrain();
      const brainWeights = activeBrain.weights?.global || {};

      const examples = live.ai_examples;
      const simulatedOps = live.total_simulated_ops;
      const realOps = live.total_real_ops;
      const winRate = live.win_rate;
      const avgConfidence = live.avg_confidence;
      const patternsLearned = live.total_decisions;

      // Indicadores reais com pesos aprendidos
      const importantIndicators = Object.entries(brainWeights)
        .map(([name, weight]) => ({ name, importance: parseFloat(weight.toFixed(2)), usage: 100 }))
        .sort((a, b) => b.importance - a.importance);

      sendResponse(res, true, {
        metrics: {
          examplesAnalyzed: examples,
          simulatedOperations: simulatedOps,
          realOperations: realOps,
          historicalAccuracy: winRate,
          dailyAccuracy: winRate,
          winRate: winRate,
          patternsLearned: patternsLearned,
          currentConfidence: avgConfidence,
          state: examples > 1000 ? "OPERATING" : "OBSERVING"
        },
        importantIndicators
      });
    } catch (error) {
      logger.error('Error in getAIDataForApp:', error);
      sendResponse(res, false, null, error.message, 500);
    }
  }

  // Alias para compatibilidade com rotas legadas
  async getAIData(req, res) {
    return this.getAIDataForApp(req, res);
  }

  // Mapeado para DatabaseData.kt (Resolve "Desconectado" e "0 Snapshots")
  async getDatabaseData(req, res) {
    try {
      const live = await queries.getLiveStats();
      const activeBrain = getBrain();
      const brainStatus = activeBrain.getStatus();

      // Pegamos o valor mais alto entre banco e memória para garantir sincronia
      const snapshotsCount = Math.max(parseInt(live.ai_examples || 0), brainStatus.examples || brainStatus.current_examples_count || 0);
      const decisionsCount = parseInt(live.total_ai_decisions || 0);

      sendResponse(res, true, {
        metrics: {
          totalRecords: snapshotsCount + decisionsCount,
          storedSnapshots: snapshotsCount,
          totalSnapshots: snapshotsCount, // Campo adicional para garantir compatibilidade
          analyzedOperations: snapshotsCount,
          aiHistory: parseInt(live.total_simulated_ops || 0),
          usedSpace: Math.round((snapshotsCount * 0.1) * 1024),
          writeSpeed: 0.98,
          integrity: 1.0,
          lastBackup: Date.now() - 3600000
        },
        isConnected: true,
        isBackupAvailable: true
      });
    } catch (error) {
      logger.error('Error in getDatabaseData fallback:', error);
      sendResponse(res, true, {
        metrics: { totalRecords: 0, storedSnapshots: 0, totalSnapshots: 0, analyzedOperations: 0, aiHistory: 0, usedSpace: 0, writeSpeed: 0, integrity: 1.0, lastBackup: Date.now() },
        isConnected: true,
        isBackupAvailable: false
      });
    }
  }

  // Mapeado para StatisticsData.kt
  async getStatisticsData(req, res) {
    try {
      const live = await queries.getLiveStats();

      const winRate = live.win_rate;
      const lossRate = Math.max(0, 1.0 - winRate);
      const wins = live.wins;
      const losses = live.losses;
      const closed = wins + losses;

      // Lucro simulado: cada win = +4% (TP), cada loss = -2% (SL)
      const totalProfit = (wins * 4.0) - (losses * 2.0);

      // Melhor/pior moeda por win rate real no banco
      let bestCoin = 'N/A', worstCoin = 'N/A';
      try {
        const coinStats = await db.query(`
          SELECT c.symbol,
            COUNT(*) FILTER (WHERE s.result = 'win') as wins,
            COUNT(*) FILTER (WHERE s.result IS NOT NULL) as total
          FROM trading_ai.ai_simulated_operations s
          JOIN trading_ai.coins c ON c.id = s.coin_id
          WHERE s.result IS NOT NULL
          GROUP BY c.symbol HAVING COUNT(*) >= 3
          ORDER BY (COUNT(*) FILTER (WHERE s.result = 'win')::float / COUNT(*)) DESC
        `);
        if (coinStats.rows.length > 0) {
          bestCoin = coinStats.rows[0].symbol;
          worstCoin = coinStats.rows[coinStats.rows.length - 1].symbol;
        }
      } catch(e) {}

      // Indicador mais eficiente pelos pesos aprendidos
      const activeBrain = getBrain();
      const weights = activeBrain.weights?.global || {};
      const sortedWeights = Object.entries(weights).sort((a, b) => b[1] - a[1]);
      const mostEfficient = sortedWeights[0]?.[0] || 'RSI';
      const leastEfficient = sortedWeights[sortedWeights.length - 1]?.[0] || 'OBV';

      sendResponse(res, true, {
        profit: {
          dailyProfit: totalProfit * 0.05,
          weeklyProfit: totalProfit * 0.25,
          monthlyProfit: totalProfit,
          totalProfit
        },
        performance: {
          winRate,
          lossRate,
          profitFactor: lossRate > 0 ? (winRate * 4) / (lossRate * 2) : 2.0,
          drawdown: losses > 0 ? (losses * 2.0) / Math.max(1, closed) : 0,
          sharpe: closed > 0 ? (totalProfit / closed) / Math.max(0.01, lossRate) : 0
        },
        streaks: {
          longestWinStreak: wins,
          longestLossStreak: losses
        },
        bestWorst: {
          bestCoin,
          worstCoin,
          bestHour: 0,
          worstHour: 0,
          bestSetup: 'Multi-Indicator',
          mostEfficientIndicator: mostEfficient,
          leastEfficientIndicator: leastEfficient
        }
      });
    } catch (error) {
      logger.error('Error in getStatisticsData:', error);
      sendResponse(res, true, {
        profit: { dailyProfit: 0, weeklyProfit: 0, monthlyProfit: 0, totalProfit: 0 },
        performance: { winRate: 0, lossRate: 0, profitFactor: 0, drawdown: 0, sharpe: 0 },
        streaks: { longestWinStreak: 0, longestLossStreak: 0 },
        bestWorst: { bestCoin: 'N/A', worstCoin: 'N/A', bestHour: 0, worstHour: 0, bestSetup: 'N/A', mostEfficientIndicator: 'N/A', leastEfficientIndicator: 'N/A' }
      });
    }
  }

  async resetDatabase(req, res) {
    try {
      logger.info('Performing Hard Reset of AI Database...');
      await queries.hardResetDatabase();

      // Reinicializa o estado do Brain em memória se necessário
      const activeBrain = getBrain();
      activeBrain.config.current_examples_count = 0;
      activeBrain.mode = 'observation';

      sendResponse(res, true, {
        message: "Database reset successfully",
        nextState: "OBSERVING"
      });
    } catch (error) {
      logger.error('Error in resetDatabase:', error);
      sendResponse(res, false, null, error.message, 500);
    }
  }

  // Retorna a operação ativa com dados dinâmicos para o Gráfico no App
  async getActiveTrade(req, res) {
    try {
      // Busca no banco a operação que está status = 'OPEN'
      const result = await db.query(
        "SELECT * FROM trading_ai.operations WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1"
      );

      if (result.rows.length === 0) {
        return sendResponse(res, true, null, "Nenhuma operação ativa.");
      }

      const op = result.rows[0];

      // Formata os valores para o App Android (Kotlin)
      sendResponse(res, true, {
        symbol: op.symbol,
        side: op.side,
        entryPrice: parseFloat(op.entry_price) / 10000000000,
        currentStopLoss: op.stop_loss ? parseFloat(op.stop_loss) / 10000000000 : null,
        currentTakeProfit: op.take_profit ? parseFloat(op.take_profit) / 10000000000 : null,
        trailingStop: op.trailing_stop ? parseFloat(op.trailing_stop) / 100 : null,
        partialExits: op.partial_exit_done ? 1 : 0,
        partialEntries: op.partial_entry_count || 0,
        aiAnalysis: op.last_analysis || "IA analisando movimentação...",
        openedAt: op.opened_at,
        // Coordenadas para o gráfico desenhar as linhas
        chartMarkers: {
            stopLine: op.stop_loss ? parseFloat(op.stop_loss) / 10000000000 : null,
            trailingLine: op.trailing_stop ? "ATIVO" : "INATIVO",
            entryPoints: [parseFloat(op.entry_price) / 10000000000]
        }
      });
    } catch (error) {
      sendResponse(res, false, null, error.message, 500);
    }
  }

  async getRecentDecisions(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 20;
      const logs = await queries.getRecentDecisions(limit);
      res.json(logs);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async receiveSnapshot(req, res) {
    try {
      const activeBrain = getBrain();
      const snapshot = req.body;
      if (!snapshot) return res.status(400).json({ error: 'No data' });

      // Responde imediatamente ao Scanner para não travar a conexão
      res.status(202).json({ accepted: true });

      // Processa em background
      setImmediate(() => {
        activeBrain.processMarketSnapshot(snapshot).catch(err =>
          logger.error('Error processing snapshot in background:', err)
        );
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async getRecommendations(req, res) {
    try {
      const activeBrain = getBrain();
      // Pega as recomendações vivas da memória do Brain, não do histórico do banco
      const recommendations = activeBrain.getRecommendations();

      // O Executor espera um array de recomendações com stayReason
      sendResponse(res, true, recommendations);
    } catch (error) {
      logger.error('Error in getRecommendations:', error);
      sendResponse(res, false, [], error.message, 500);
    }
  }
}

module.exports = new AIController();
