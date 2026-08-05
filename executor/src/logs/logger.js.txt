const winston = require('winston');
const config = require('../config');

const logger = winston.createLogger({
  level: config.logging.level,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    config.logging.console ? new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }) : null,
    config.logging.file ? new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error'
    }) : null,
    config.logging.file ? new winston.transports.File({
      filename: 'logs/combined.log'
    }) : null
  ].filter(Boolean)
});

module.exports = logger;
