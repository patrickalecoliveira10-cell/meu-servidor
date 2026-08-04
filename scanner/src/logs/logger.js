const winston = require('winston');
const config = require('../config');

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const logger = winston.createLogger({
  level: config.logging.level || 'info',
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple())
    })
  ]
});

const originalLog = logger.log.bind(logger);

logger.logToDatabase = async (level, message, context = {}) => {
  if (level === 'debug') return;
  try {
    const queries = require('../database/queries');
    if (queries && typeof queries.insertLog === 'function') {
      await queries.insertLog({ level, message, context, source: 'scanner' });
    }
  } catch (err) {
    console.error('Database logging failed:', err.message);
  }
};

logger.log = (level, message, metadata) => {
  originalLog(level, message, metadata);
  if (['error', 'warn'].includes(level)) {
    logger.logToDatabase(level, message, metadata).catch(() => {});
  }
};

logger.info = (msg, meta) => logger.log('info', msg, meta);
logger.error = (msg, meta) => logger.log('error', msg, meta);
logger.warn = (msg, meta) => logger.log('warn', msg, meta);

module.exports = logger;
