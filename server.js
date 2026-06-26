// --- CONFIGURAÇÃO DE CHAVES (Nomes corrigidos para o seu Render) ---
const BYBIT_KEY = process.env.BYBIT_API_KEY; 
const BYBIT_SECRET = process.env.BYBIT_API_SECRET;
const IS_TESTNET = process.env.USE_TESTNET === 'true';

// Log de verificação (aparecerá no console do Render no boot)
console.log("Sistema Iniciado. Chave API presente:", !!BYBIT_KEY);

function getSignature(parameters, secret, timestamp) {
    return crypto.createHmac('sha256', secret).update(timestamp + BYBIT_KEY + '5000' + parameters).digest('hex');
}

async function bybitRequest(method, endpoint, data = {}) {
    const timestamp = Date.now().toString();
    const baseUrl = IS_TESTNET ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    
    const parameters = method === 'GET' ? new URLSearchParams(data).toString() : JSON.stringify(data);
    const sign = getSignature(parameters, BYBIT_SECRET, timestamp);

    try {
        const res = await axios({
            method,
            url: baseUrl + endpoint + (method === 'GET' ? '?' + parameters : ''),
            headers: { 
                'X-BAPI-API-KEY': BYBIT_KEY, 
                'X-BAPI-SIGN': sign, 
                'X-BAPI-TIMESTAMP': timestamp, 
                'X-BAPI-RECV-WINDOW': '5000', 
                'Content-Type': 'application/json' 
            },
            data: method !== 'GET' ? data : undefined,
            timeout: 5000
        });

        // Log detalhado de erro da Bybit se a ordem falhar
        if (res.data.retCode !== 0) {
            serverLog(`Erro Bybit: ${res.data.retMsg} (Code: ${res.data.retCode})`, 'err');
        }

        return res.data;
    } catch (e) { 
        serverLog(`Falha de conexão: ${e.message}`, 'err');
        return { error: e.message }; 
    }
}
