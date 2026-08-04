const winston = require('winston');
const config = require('../config/index.js');

// Defensive check to prevent "Cannot read properties of undefined"
const loggingConfig = config.logging || {
  level: 'info',
  console: true,
  file: false
};

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(metadata).length > 0) {
      msg += ` ${JSON.stringify(metadata)}`;
    }
    return msg;
  })
);

const transports = [];

if (loggingConfig.console !== false) {
  transports.push(
    new winston.transports.Console({
      format: consoleFormat,
      level: loggingConfig.level || 'info',
    })
  );
}

if (loggingConfig.file === true) {
  transports.push(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: logFormat,
    })
  );
  transports.push(
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: logFormat,
    })
  );
}

const logger = winston.createLogger({
  level: loggingConfig.level || 'info',
  format: logFormat,
  transports,
  exitOnError: false,
});

module.exports = logger;
