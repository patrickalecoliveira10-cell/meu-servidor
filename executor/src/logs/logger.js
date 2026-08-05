const winston = require('winston');
const config = require('../config');

// Configuração de transportes garantindo pelo menos o Console para o Render
const transports = [];

// Sempre adiciona Console em produção/Render ou se configurado
if (process.env.NODE_ENV === 'production' || config.logging.console !== false) {
  transports.push(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

if (config.logging.file) {
  transports.push(new winston.transports.File({
    filename: 'logs/error.log',
    level: 'error'
  }));
  transports.push(new winston.transports.File({
    filename: 'logs/combined.log'
  }));
}

const logger = winston.createLogger({
  level: config.logging.level || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: transports.length > 0 ? transports : [new winston.transports.Console()]
});

module.exports = logger;
