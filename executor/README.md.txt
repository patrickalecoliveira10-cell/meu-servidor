# Trade Executor V1.0

Servidor de execução de operações para IA Trading Criptomoedas.

## Descrição

O Trade Executor é o terceiro servidor da plataforma, responsável exclusivamente por executar operações na Bybit, monitorar posições abertas, aplicar as decisões do AI Brain e registrar todas as ações no banco de dados.

Este servidor nunca calcula indicadores, aprende padrões ou decide entradas por conta própria. Toda inteligência permanece centralizada no AI Brain.

## Funcionalidades

- ✅ Execução de ordens na Bybit (API V5)
- ✅ Monitoramento contínuo de posições
- ✅ Aplicação de decisões do AI Brain
- ✅ Stop loss dinâmico
- ✅ Trailing stop dinâmico
- ✅ Fechamento parcial de posições
- ✅ Modo manual (fechar posição, cancelar ordem)
- ✅ Modo emergência (cancelar tudo, fechar posições)
- ✅ Sincronização automática de posições
- ✅ Recuperação automática de falhas
- ✅ Limpeza automática do banco de dados (512MB)
- ✅ Logs detalhados de todas as ações

## Tecnologias

- Node.js LTS (>=18.0.0)
- Express.js
- PostgreSQL (Neon)
- Bybit API V5
- Winston (Logging)
- CryptoJS (Assinatura API)

## Instalação

```bash
npm install
```

## Configuração

Copie `.env.example` para `.env` e configure as variáveis:

```bash
cp .env.example .env
```

Variáveis obrigatórias:
- `DATABASE_URL` - URL do banco de dados Neon (compartilhado com Servidor1 e Servidor2)
- `BYBIT_API_KEY` - API Key da Bybit
- `BYBIT_API_SECRET` - API Secret da Bybit
- `AI_BRAIN_API_URL` - URL do Servidor2 (AI Brain)

## Execução

```bash
# Desenvolvimento
npm run dev

# Produção
npm start
```

## API Endpoints

### Status e Saúde
- `GET /` - Informações do servidor
- `GET /api/health` - Health check
- `GET /api/status` - Status do executor

### Posições e Ordens
- `GET /api/positions` - Posições abertas
- `GET /api/orders` - Ordens abertas
- `GET /api/history` - Histórico de ordens
- `POST /api/close` - Fechar posição específica
- `POST /api/close-all` - Fechar todas as posições

### Controle
- `POST /api/pause` - Pausar executor
- `POST /api/resume` - Retomar executor
- `POST /api/emergency` - Ativar modo emergência

### Informações
- `GET /api/statistics` - Estatísticas do executor
- `GET /api/logs` - Logs recentes

## Arquitetura

```
Trade Executor
├── src/
│   ├── config/          # Configurações
│   ├── database/        # Conexão com banco
│   ├── services/        # Serviços (Bybit, Executor)
│   ├── routes/          # Rotas da API
│   └── logger.js        # Sistema de logs
├── server.js            # Ponto de entrada
├── package.json         # Dependências
├── .env.example         # Exemplo de variáveis
└── README.md            # Documentação
```

## Integração com Outros Servidores

- **Servidor1 (Market Scanner):** Coleta dados de mercado e indicadores
- **Servidor2 (AI Brain):** Analisa dados e emite recomendações
- **Servidor3 (Trade Executor):** Executa ordens baseadas nas recomendações

Todos os três servidores compartilham o mesmo banco de dados PostgreSQL no Neon.

## Limpeza Automática do Banco

O executor possui a mesma estratégia de limpeza automática dos outros servidores:
- Limpeza quando o banco atinge 400MB (de 512MB total)
- Limpeza agendada a cada 24 horas
- Dados críticos da IA mantidos por 7-30 dias
- Dados do Executor mantidos por 12 horas
- VACUUM agressivo para liberar espaço

## Deploy no Render

### Variáveis de Ambiente

```
DATABASE_URL=postgresql://neondb_owner:npg_fiHBIp2dXrU1@ep-silent-king-as5ku59d-pooler.c-4.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
PORT=3003
NODE_ENV=production
BYBIT_API_KEY=sua_api_key
BYBIT_API_SECRET=sua_api_secret
BYBIT_API_URL=https://api.bybit.com
BYBIT_TESTNET=false
AI_BRAIN_API_URL=https://trickappserv2.onrender.com
AI_BRAIN_POLL_INTERVAL=5000
EXECUTOR_MODE=automatic
MIN_TRADE_AMOUNT=10
MAX_POSITIONS=5
EMERGENCY_MODE=false
RATE_LIMIT_WINDOW=15
RATE_LIMIT_MAX_REQUESTS=100
CORS_ORIGIN=*
LOG_LEVEL=info
LOG_FILE=true
LOG_CONSOLE=true
```

### Configurações do Web Service

- **Name:** `trade-executor-v1`
- **Branch:** `main`
- **Runtime:** `Node`
- **Build Command:** `npm install`
- **Start Command:** `node server.js`
- **Instance Type:** `Free` (ou `Standard`)
- **Region:** `Frankfurt` (mesma região dos outros servidores)

## Segurança

- Helmet (headers de segurança)
- CORS configurável
- Rate limiting
- Validação de entrada
- Proteção contra execução duplicada
- Proteção contra múltiplas ordens simultâneas
- Credenciais nunca armazenadas no código

## Licença

MIT
