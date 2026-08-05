require('dotenv').config();
process.env.UNIFIED_MODE = 'true'; // Ativa comunicação interna via localhost
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const path = require('path');

// Configurações de logs e DB (usando os do AI-Brain como base central)
const logger = require('./ai-brain/src/logs/logger');
const db = require('./ai-brain/src/database/connection');

// Importação dos Núcleos com caminhos seguros e log de depuração
console.log('Verificando caminhos de módulos...');
const brainPath = path.join(__dirname, 'ai-brain', 'src', 'ai', 'brains');
const executorPath = path.join(__dirname, 'executor', 'src', 'services', 'executor');
const scannerPath = path.join(__dirname, 'scanner', 'src', 'scanner', 'marketScanner');

const Brain = require(brainPath);
const executorService = require(executorPath);
const marketScanner = require(scannerPath);

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json());

// 1. Compatibilidade Direta com App Android (Prioridade Máxima)
app.get('/api/status', (req, res) => scannerController.getStatus(req, res));
app.get('/api/results', (req, res) => scannerController.getResults(req, res));

// 2. Rotas Unificadas dos Serviços
app.use('/api', brainRoutes); // Rotas da IA
app.use('/api/executor', executorRoutes); // Rotas do Executor
app.use('/api/scanner', scannerRoutes); // Rotas do Scanner

app.get('/', (req, res) => res.json({
    service: 'Unified Trading System V2',
    status: 'Operational',
    brain: Brain.getStatus().mode,
    scanner: marketScanner.getStatus().isRunning ? 'active' : 'idle',
    executor: executorService.getStatus().isRunning ? 'active' : 'idle'
}));

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        brain: Brain.getStatus(),
        executor: executorService.getStatus(),
        scanner: marketScanner.getStatus()
    });
});

async function start() {
    try {
        logger.info('--- SISTEMA UNIFICADO: INICIANDO ---');

        // 1. Conexão com o Banco
        await db.testConnection();

        // 2. Inicializar Cérebro (IA)
        await Brain.initialize();

        // 3. Inicializar Executor (Bybit)
        await executorService.initialize();
        await executorService.start();

        // 4. Inicializar Scanner
        logger.info('Iniciando Market Scanner...');
        setTimeout(() => {
          marketScanner.start().catch(error => {
            logger.error('Failed to auto-start scanner in unified mode:', error);
          });
        }, 5000);

        const PORT = process.env.PORT || 10000; // Porta padrão do Render
        app.listen(PORT, () => {
            logger.info(`SISTEMA UNIFICADO rodando na porta ${PORT}`);
            logger.info('Scanner, Brain e Executor operando no mesmo processo.');
        });

    } catch (err) {
        console.error('ERRO CRÍTICO NO STARTUP:', err);
        process.exit(1);
    }
}

start();
