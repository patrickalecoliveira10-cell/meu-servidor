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
    let fullPath = path.resolve(__dirname, modulePath);

    // Tenta o caminho original
    if (fs.existsSync(fullPath) || fs.existsSync(fullPath + '.js')) {
        return require(fullPath);
    }

    // Se falhar e for o brain, tenta brains
    if (modulePath.includes('brain.js')) {
        const altPath = fullPath.replace('brain.js', 'brains.js');
        if (fs.existsSync(altPath)) {
            console.log(`[INFO] Falling back from brain.js to brains.js at: ${altPath}`);
            return require(altPath);
        }
    }

    // Tenta ver se está um nível acima (caso de subpastas)
    console.error(`[CRITICAL] Module not found at: ${fullPath}`);
    const dir = path.dirname(fullPath);
    if (fs.existsSync(dir)) {
        console.log(`Directory listing for ${dir}:`, fs.readdirSync(dir));
    }
    throw new Error(`Cannot find module: ${fullPath}`);
}

console.log('--- INICIALIZANDO NÚCLEOS UNIFICADOS ---');
// Carregamento do Cérebro da IA (Arquivo atualizado com stayReason)
const Brain = safeRequire('./ai-brain/src/ai/brains.js');
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
const { initCron } = require('./ai-brain/src/utils/cron');

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

        // Verificação inicial de tamanho e limpeza
        await db.checkSizeAndCleanup();

        // Inicia o agendador de tarefas (Limpeza automática e estatísticas)
        initCron();

        await Brain.initialize();

        // EXPORTE GLOBAL PARA OS CONTROLLERS ACESSAREM A INSTÂNCIA VIVA
        global.liveBrainInstance = Brain;
        global.liveExecutorService = executorService;

        // CONEXÃO DIRETA: O Executor agora "ouve" o Brain sem precisar de HTTP
        if (executorService.setBrain) {
            executorService.setBrain(Brain);
        }

        // CONEXÃO DIRETA: O Scanner agora entrega dados direto para o Brain
        if (marketScanner.setBrain) {
            marketScanner.setBrain(Brain);
        }

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
