require('dotenv').config();
process.env.UNIFIED_MODE = 'true';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

// Configurações de logs e DB
const logger = require('./ai-brain/src/logs/logger');
const db = require('./ai-brain/src/database/connection');

// Função de carregamento seguro para evitar MODULE_NOT_FOUND no Render
function safeRequire(modulePath) {
    const fullPath = path.resolve(__dirname, modulePath);
    if (!fs.existsSync(fullPath) && !fs.existsSync(fullPath + '.js')) {
        console.error(`[CRITICAL] Module not found at: ${fullPath}`);
        // Tenta listar o diretório para debug
        const dir = path.dirname(fullPath);
        if (fs.existsSync(dir)) {
            console.log(`Directory listing for ${dir}:`, fs.readdirSync(dir));
        }
        throw new Error(`Cannot find module: ${fullPath}`);
    }
    return require(fullPath);
}

console.log('--- INICIALIZANDO NÚCLEOS UNIFICADOS ---');
// Tenta carregar brain.js ou brains.js para compatibilidade entre Local e Render
let Brain;
try {
    Brain = safeRequire('./ai-brain/src/ai/brain.js');
} catch (e) {
    logger.warn('brain.js not found, trying brains.js...');
    Brain = safeRequire('./ai-brain/src/ai/brains.js');
}
const executorService = safeRequire('./executor/src/services/executor.js');
const marketScanner = safeRequire('./scanner/src/scanner/marketScanner.js');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json());

// Importação das Rotas
const brainRoutes = require('./ai-brain/src/routes/index');
const executorRoutes = require('./executor/src/routes/index');
const scannerRoutes = require('./scanner/src/routes/scanner');
const scannerController = require('./scanner/src/controllers/scannerController');

// Endpoints de compatibilidade Android
app.get('/api/status', (req, res) => scannerController.getStatus(req, res));
app.get('/api/results', (req, res) => scannerController.getResults(req, res));

app.use('/api', brainRoutes);
app.use('/api/executor', executorRoutes);
app.use('/api/scanner', scannerRoutes);

app.get('/', (req, res) => res.json({
    service: 'Unified Trading System V2',
    status: 'Operational',
    brain: Brain.getStatus().mode,
    scanner: marketScanner.getStatus().isRunning ? 'active' : 'idle',
    executor: executorService.getStatus().isRunning ? 'active' : 'idle'
}));

async function start() {
    try {
        logger.info('--- SISTEMA UNIFICADO: INICIANDO ---');
        await db.testConnection();
        await Brain.initialize();
        await executorService.initialize();
        await executorService.start();

        setTimeout(() => {
          marketScanner.start().catch(err => logger.error('Scanner start error:', err));
        }, 5000);

        const PORT = process.env.PORT || 10000;
        app.listen(PORT, () => {
            logger.info(`SISTEMA UNIFICADO rodando na porta ${PORT}`);
        });
    } catch (err) {
        console.error('ERRO CRÍTICO NO STARTUP:', err);
        process.exit(1);
    }
}

start();
