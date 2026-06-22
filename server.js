const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const app = express();

app.use(cors()); // PERMISSÃO PARA O APP CONECTAR
app.use(express.json());

let activeConfig = null;
let monitorInterval = null;

app.post('/control', (req, res) => {
    const { action, sym } = req.body;
    console.log(`Command received: ${action} for ${sym}`);

    if (action === 'start') {
        activeConfig = req.body;
        console.log("🚀 Iniciando monitoramento na nuvem...");
        res.status(200).send({ message: "Started" });
    } else {
        activeConfig = null;
        console.log("🛑 Parando monitoramento.");
        res.status(200).send({ message: "Stopped" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor Online na porta ${PORT}`));
