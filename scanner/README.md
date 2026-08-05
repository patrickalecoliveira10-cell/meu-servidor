# Market Scanner V1.0

Servidor de monitoramento de mercado para IA Trading Criptomoedas.

## Descrição

O Market Scanner é o primeiro servidor da plataforma de Inteligência Artificial para Trading de Criptomoedas. Ele é responsável exclusivamente por monitorar o mercado em tempo real, coletar dados, calcular indicadores técnicos, gerar snapshots completos do mercado e armazenar essas informações no banco PostgreSQL (Neon).

**Este servidor NÃO executa ordens de compra ou venda.** Ele é apenas a fonte de dados para os demais módulos.

## Funcionalidades

- **Monitoramento Contínuo**: Monitora até 500 pares USDT configuráveis
- **Múltiplos Timeframes**: Suporta 1m, 3m, 5m, 15m, 30m, 1h, 4h, 1D
- **15 Indicadores Técnicos**: EMA, VWAP, RSI, MACD, ADX, ATR, Bollinger Bands, Parabolic SAR, Stochastic, KAMA, Heiken Ashi, Ichimoku, OBV, Supertrend
- **Sistema de Score**: Classificação de oportunidades (0-100)
- **APIs REST**: Endpoints para consulta pelo aplicativo Android
- **Recuperação Automática**: Reconexão automática em caso de falhas
- **Logs Completos**: Registro de todas as operações
- **Performance Otimizada**: Desenvolvido para Render Free

## Tecnologias

- **Node.js LTS** - Runtime
- **Express** - Framework web
- **PostgreSQL (Neon)** - Banco de dados
- **Bybit API** - Dados de mercado
- **Technical Indicators** - Cálculo de indicadores
- **Winston** - Sistema de logs

## Instalação

### Pré-requisitos

- Node.js 18 ou superior
- npm ou yarn
- Banco de dados PostgreSQL (Neon) configurado

### Passos

1. **Clone o repositório** (se aplicável)
2. **Navegue até a pasta do scanner**:
   ```bash
   cd scanner
   ```

3. **Instale as dependências**:
   ```bash
   npm install
   ```

4. **Configure as variáveis de ambiente**:
   ```bash
   cp .env.example .env
   ```
   
   Edite o arquivo `.env` com suas configurações:
   ```env
   DATABASE_URL=postgresql://neondb_owner:npg_fiHBIp2dXrU1@ep-silent-king-as5ku59d-pooler.c-4.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
   PORT=3001
   SCANNER_COINS_COUNT=100
   SCANNER_UPDATE_INTERVAL=60000
   SCANNER_TIMEFRAMES=1m,5m,15m,1h,4h,1D
   ```

5. **Execute o schema do banco de dados** (se ainda não foi executado):
   ```bash
   cd ../database
   psql -h ep-silent-king-as5ku59d-pooler.c-4.eu-central-1.aws.neon.tech -U neondb_owner -d neondb -f 00_main.sql
   ```

## Uso

### Iniciar o servidor

```bash
npm start
```

### Modo desenvolvimento (com auto-reload)

```bash
npm run dev
```

### Auto-iniciar o scanner

Para que o scanner inicie automaticamente junto com o servidor, adicione ao `.env`:

```env
AUTO_START_SCANNER=true
```

## APIs REST

### Status e Controle

#### GET `/api/scanner/status`
Retorna o status atual do scanner.

**Response:**
```json
{
  "success": true,
  "data": {
    "isRunning": true,
    "sessionId": "session-id",
    "stats": {
      "coinsScanned": 100,
      "snapshotsCreated": 500,
      "errorsCount": 0,
      "startTime": 1234567890,
      "lastUpdateTime": 1234567890,
      "uptime": 3600
    },
    "config": {
      "coinsCount": 100,
      "updateInterval": 60000,
      "timeframes": ["1m", "5m", "15m", "1h", "4h", "1D"]
    }
  }
}
```

#### POST `/api/scanner/start`
Inicia o scanner.

**Response:**
```json
{
  "success": true,
  "message": "Scanner started successfully"
}
```

#### POST `/api/scanner/stop`
Para o scanner.

**Response:**
```json
{
  "success": true,
  "message": "Scanner stopped successfully"
}
```

### Dados

#### GET `/api/scanner/coins`
Retorna a lista de moedas monitoradas.

**Parâmetros:**
- `limit` (opcional): Número de moedas (default: 100)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "BTCUSDT",
      "symbol": "BTCUSDT",
      "name": "Bitcoin",
      "active": true,
      "volume_24h": 1000000
    }
  ]
}
```

#### GET `/api/scanner/results`
Retorna os resultados mais recentes do scanner.

**Parâmetros:**
- `limit` (opcional): Número de resultados (default: 50)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "coin_id": "BTCUSDT",
      "timeframe": "1h",
      "score": 85,
      "price": 50000,
      "volume": 1000,
      "volatility": 2.5,
      "timestamp": "2024-01-01T00:00:00Z"
    }
  ]
}
```

#### GET `/api/scanner/top`
Retorna as melhores oportunidades.

**Parâmetros:**
- `limit` (opcional): Número de oportunidades (default: 20)
- `minScore` (opcional): Score mínimo (default: 70)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "coin_id": "BTCUSDT",
      "score": 85,
      "category": "excellent",
      "price": 50000,
      "timestamp": "2024-01-01T00:00:00Z"
    }
  ]
}
```

#### GET `/api/scanner/statistics`
Retorna estatísticas do scanner.

**Response:**
```json
{
  "success": true,
  "data": {
    "database": {
      "total_sessions": 100,
      "active_sessions": 1,
      "avg_coins_scanned": 100,
      "avg_snapshots": 500,
      "avg_errors": 0,
      "avg_duration": 3600
    },
    "runtime": {
      "coinsScanned": 100,
      "snapshotsCreated": 500,
      "errorsCount": 0,
      "uptime": 3600
    }
  }
}
```

### Sistema

#### GET `/api/health`
Health check do servidor.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00Z",
  "uptime": 3600,
  "memory": {
    "rss": 12345678,
    "heapTotal": 1234567,
    "heapUsed": 123456
  },
  "scanner": {
    "isRunning": true
  }
}
```

## Configuração

### Variáveis de Ambiente Principais

| Variável | Descrição | Default |
|----------|-----------|---------|
| `DATABASE_URL` | String de conexão do PostgreSQL | - |
| `PORT` | Porta do servidor | 3001 |
| `SCANNER_COINS_COUNT` | Número de moedas a monitorar | 100 |
| `SCANNER_UPDATE_INTERVAL` | Intervalo de atualização (ms) | 60000 |
| `SCANNER_TIMEFRAMES` | Timeframes a monitorar | 1m,5m,15m,1h,4h,1D |
| `AUTO_START_SCANNER` | Auto-iniciar scanner | false |

### Indicadores

Todos os indicadores podem ser ativados/desativados via `.env`:

```env
INDICATORS_EMA=true
INDICATORS_VWAP=true
INDICATORS_RSI=true
INDICATORS_MACD=true
INDICATORS_ADX=true
INDICATORS_ATR=true
INDICATORS_BOLLINGER=true
INDICATORS_PSAR=true
INDICATORS_STOCHASTIC=true
INDICATORS_KAMA=true
INDICATORS_HEIKEN=false
INDICATORS_ICHIMOKU=false
INDICATORS_OBV=true
INDICATORS_SUPERTREND=true
```

### Sistema de Score

O score é calculado baseado em múltiplos fatores:

- **RSI** (20 pontos): Oversold (+20), Low (+10), Overbought (-10), High (-20)
- **MACD** (15 pontos): Bullish (+15), Bearish (-10)
- **EMA Alignment** (15 pontos): Bullish (+15), Bearish (-10)
- **ADX Strength** (10 pontos): Strong (+10), Trending (+5)
- **Bollinger Bands** (10 pontos): Below lower (+10), Above upper (-5)
- **Volume** (10 pontos): High volume (+10), Above average (+5), Low (-5)
- **Price Change** (10 pontos): Moderate (+5), Extreme (-5)
- **Volatility** (5 pontos): Good (+5), High (-3)
- **Supertrend** (5 pontos): Bullish (+5), Bearish (-5)

**Categorias:**
- **0-30**: Mercado fraco
- **31-60**: Neutro
- **61-80**: Boa oportunidade
- **81-100**: Excelente oportunidade

## Estrutura do Projeto

```
scanner/
├── src/
│   ├── config/           # Configurações
│   │   └── index.js
│   ├── database/         # Conexão e queries do banco
│   │   ├── connection.js
│   │   └── queries.js
│   ├── indicators/       # Cálculo de indicadores técnicos
│   │   └── index.js
│   ├── logs/            # Sistema de logs
│   │   └── logger.js
│   ├── routes/          # Rotas da API
│   │   └── scanner.js
│   ├── controllers/     # Controladores da API
│   │   └── scannerController.js
│   ├── scanner/         # Lógica do scanner
│   │   ├── marketScanner.js
│   │   └── scoreCalculator.js
│   ├── services/        # Serviços externos
│   │   └── bybit.js
│   └── utils/           # Funções auxiliares
│       └── helpers.js
├── logs/                # Arquivos de log
├── .env.example         # Exemplo de configuração
├── .gitignore
├── package.json
├── server.js            # Arquivo principal
└── README.md
```

## Deploy no Render

### Pré-requisitos

1. Conta no Render
2. Repositório Git com o código
3. Banco de dados Neon configurado

### Passos

1. **Crie um Web Service no Render**
   - Type: Node.js
   - Build Command: `npm install`
   - Start Command: `node server.js`

2. **Configure as variáveis de ambiente**
   - Adicione todas as variáveis do `.env.example`
   - `DATABASE_URL`: String de conexão do Neon
   - `PORT`: Deixe em branco (Render define automaticamente)
   - `NODE_ENV`: `production`

3. **Deploy**
   - Conecte seu repositório
   - Render fará deploy automático

### Performance no Render Free

O scanner foi otimizado para funcionar no plano gratuito do Render:

- **Uso de CPU**: Otimizado com ciclos configuráveis
- **Uso de Memória**: Gerenciamento eficiente de conexões
- **Timeout**: Configurado para evitar suspensão
- **Rate Limiting**: Proteção contra excesso de requisições

## Monitoramento

### Logs

Os logs são salvos em:
- Console (configurável)
- `logs/combined.log` (todos os logs)
- `logs/error.log` (apenas erros)
- Banco de dados (tabela `logs`)

### Métricas

Monitorar:
- Uptime do scanner
- Quantidade de moedas escaneadas
- Erros por ciclo
- Tempo de resposta da API Bybit
- Latência do banco de dados

## Solução de Problemas

### Scanner não inicia

- Verifique a conexão com o banco de dados
- Verifique a conexão com a API Bybit
- Verifique as variáveis de ambiente
- Consulte os logs em `logs/combined.log`

### Erro de conexão com banco

- Verifique `DATABASE_URL` no `.env`
- Verifique se o schema `trading_ai` existe
- Verifique se as tabelas foram criadas

### Erro na API Bybit

- Verifique a conexão com a internet
- Verifique se a URL da API está correta
- O sistema tentará reconectar automaticamente

### Performance baixa

- Reduza `SCANNER_COINS_COUNT`
- Aumente `SCANNER_UPDATE_INTERVAL`
- Desative indicadores não utilizados
- Reduza a quantidade de timeframes

## Segurança

- Helmet para headers de segurança
- CORS configurável
- Rate limiting
- Validação de entrada
- Logs de erro
- Variáveis de ambiente para dados sensíveis
- SSL no banco de dados

## Próximos Passos

Este servidor prepara o terreno para:

1. **Servidor 2 (AI Brain)**: Utilizará os dados e scores para aprendizado e decisões
2. **Servidor 3 (Executor)**: Executará ordens baseadas nas decisões da IA
3. **App Android**: Já pode consultar os dados através das APIs

## Suporte

Para dúvidas ou problemas:
- Consulte os logs em `logs/`
- Verifique a documentação do banco de dados em `../database/README.md`
- Consulte a documentação da API Bybit

## Licença

Este servidor é parte integrante da plataforma de IA Trading de Criptomoedas.
