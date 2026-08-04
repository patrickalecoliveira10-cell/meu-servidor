<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Brain V1.0 - Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        .card { @apply bg-gray-800 p-6 rounded-lg shadow-lg border border-gray-700; }
        .stat-label { @apply text-gray-400 text-sm font-medium; }
        .stat-value { @apply text-white text-2xl font-bold; }
    </style>
</head>
<body class="bg-gray-900 text-gray-100 font-sans">
    <div class="container mx-auto px-4 py-8">
        <header class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-bold text-blue-500">AI BRAIN <span class="text-white text-sm font-normal">V1.0</span></h1>
                <p class="text-gray-400">Plataforma de Inteligência para Trading</p>
            </div>
            <div id="status-badge" class="px-4 py-2 rounded-full text-sm font-bold bg-yellow-500 text-black">
                MODO: OBSERVAÇÃO
            </div>
        </header>

        <!-- Stats Grid -->
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            <div class="card">
                <p class="stat-label">Exemplos Coletados</p>
                <p id="stat-examples" class="stat-value">0 / 1000</p>
                <div class="w-full bg-gray-700 rounded-full h-2.5 mt-2">
                    <div id="progress-examples" class="bg-blue-600 h-2.5 rounded-full" style="width: 0%"></div>
                </div>
            </div>
            <div class="card">
                <p class="stat-label">Precisão Histórica</p>
                <p id="stat-winrate" class="stat-value text-green-400">0%</p>
            </div>
            <div class="card">
                <p class="stat-label">Confiança Média</p>
                <p id="stat-confidence" class="stat-value text-yellow-400">0.00</p>
            </div>
            <div class="card">
                <p class="stat-label">Operações Analisadas</p>
                <p id="stat-total" class="stat-value">0</p>
            </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <!-- Padrões e Pesos -->
            <div class="lg:col-span-2 space-y-8">
                <div class="card">
                    <h2 class="text-xl font-bold mb-4">Padrões de Mercado Detectados</h2>
                    <div class="overflow-x-auto">
                        <table class="w-full text-left">
                            <thead>
                                <tr class="text-gray-400 border-b border-gray-700">
                                    <th class="pb-2">Moeda</th>
                                    <th class="pb-2">Padrão</th>
                                    <th class="pb-2">Taxa Sucesso</th>
                                    <th class="pb-2">Ocorrências</th>
                                </tr>
                            </thead>
                            <tbody id="patterns-table">
                                <!-- Data via JS -->
                            </tbody>
                        </table>
                    </div>
                </div>

                <div class="card">
                    <h2 class="text-xl font-bold mb-4">Pesos dos Indicadores (Global)</h2>
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-4" id="weights-grid">
                        <!-- Data via JS -->
                    </div>
                </div>
            </div>

            <!-- Logs Recentes -->
            <div class="card">
                <h2 class="text-xl font-bold mb-4">Logs de Aprendizado</h2>
                <div id="logs-container" class="space-y-3 max-h-[500px] overflow-y-auto pr-2">
                    <!-- Data via JS -->
                </div>
            </div>
        </div>
    </div>

    <script>
        async function updateDashboard() {
            try {
                // Status
                const statusRes = await fetch('/api/status');
                const status = await statusRes.json();

                document.getElementById('status-badge').innerText = `MODO: ${status.mode.toUpperCase()}`;
                document.getElementById('status-badge').className = `px-4 py-2 rounded-full text-sm font-bold ${status.isOperational ? 'bg-green-500 text-white' : 'bg-yellow-500 text-black'}`;

                document.getElementById('stat-examples').innerText = `${status.examples} / ${status.minExamples}`;
                const progress = (status.examples / status.minExamples) * 100;
                document.getElementById('progress-examples').style.width = `${Math.min(100, progress)}%`;

                // Learning & Stats
                const learnRes = await fetch('/api/learning');
                const learnData = await learnRes.json();

                if (learnData.global) {
                    document.getElementById('stat-winrate').innerText = `${(learnData.global.win_rate * 100).toFixed(1)}%`;
                    document.getElementById('stat-confidence').innerText = parseFloat(learnData.global.avg_confidence).toFixed(2);
                    document.getElementById('stat-total').innerText = learnData.global.total_decisions;
                }

                // Weights
                const weightsRes = await fetch('/api/weights');
                const weights = await weightsRes.json();
                const weightsGrid = document.getElementById('weights-grid');
                weightsGrid.innerHTML = weights.filter(w => !w.coin_id).map(w => `
                    <div class="bg-gray-700 p-3 rounded text-center">
                        <p class="text-xs text-gray-400 uppercase">${w.indicator_name}</p>
                        <p class="text-lg font-bold">${parseFloat(w.weight).toFixed(2)}</p>
                    </div>
                `).join('');

                // Logs
                const logsRes = await fetch('/api/logs?limit=15');
                const logs = await logsRes.json();
                const logsContainer = document.getElementById('logs-container');
                logsContainer.innerHTML = logs.map(log => `
                    <div class="text-xs border-l-2 border-blue-500 pl-2 py-1">
                        <span class="text-gray-500">${new Date(log.timestamp).toLocaleTimeString()}</span>
                        <p class="text-gray-300">${log.message}</p>
                    </div>
                `).join('');

            } catch (err) {
                console.error('Error updating dashboard:', err);
            }
        }

        setInterval(updateDashboard, 5000);
        updateDashboard();
    </script>
</body>
</html>
