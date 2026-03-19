require('dotenv').config(); // Carrega variáveis de ambiente padrão (.env)
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

// Permite passar o nome do cliente pelo terminal ex: node index.js cliente1
const clientId = process.argv[2] || 'default';

// Se foi passado um cliente, carrega o .env específico dele (ex: .env.cliente1)
if (clientId !== 'default' && fs.existsSync(`.env.${clientId}`)) {
    require('dotenv').config({ path: `.env.${clientId}`, override: true });
}

const NOME_DISTRIBUIDORA = process.env.NOME_DISTRIBUIDORA || 'Água & Gás Express';

console.log(`\n=========================================`);
console.log(`🤖 Iniciando robô para: ${NOME_DISTRIBUIDORA} (Sessão: ${clientId})`);
console.log(`=========================================\n`);

const client = new Client({
    // O clientId abaixo garante que cada bot tenha sua própria "memória" de login, não misturando números
    authStrategy: new LocalAuth({ clientId: clientId }),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    }
});

client.on('qr', (qr) => {
    console.log('\n===============================================================');
    console.log(`⚠️ NOVO LOGIN NECESSÁRIO PARA: ${NOME_DISTRIBUIDORA}`);
    console.log('Leia o QR Code abaixo com o aplicativo WhatsApp deste cliente!');
    console.log('===============================================================\n');

    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log(`✅ O bot da ${NOME_DISTRIBUIDORA} conectou com sucesso e está operando!`);
});

// Armazena o estado de cada cliente da distribuidora
const sessions = {};

const STATE = {
    IDLE: 'IDLE',
    AWAITING_GAS_QTY: 'AWAITING_GAS_QTY',
    AWAITING_GAS_LOC: 'AWAITING_GAS_LOC',
    AWAITING_WATER_QTY: 'AWAITING_WATER_QTY',
    AWAITING_WATER_LOC: 'AWAITING_WATER_LOC',
    ATTENDANT: 'ATTENDANT'
};

const MENU_TEXT = `Olá 👋\n\nBem-vindo à *${NOME_DISTRIBUIDORA}*\n\nEscolha uma opção:\n\n1️⃣ Pedir Gás\n2️⃣ Pedir Água\n3️⃣ Falar com atendente`;
const OUT_OF_FLOW_TEXT = `Posso te ajudar com seu pedido 😊\n\nEscolha uma opção:\n\n1️⃣ Pedir Gás\n2️⃣ Pedir Água\n3️⃣ Falar com atendente`;

client.on('message', async msg => {
    if (msg.from === 'status@broadcast' || msg.isGroupMsg) return;

    const chatId = msg.from;
    const text = msg.body.trim().toLowerCase();
    
    if (!sessions[chatId]) {
        const contact = await msg.getContact();
        sessions[chatId] = { state: STATE.IDLE, product: '', quantity: '', name: contact.pushname || contact.name || 'Cliente' };
    }
    
    const session = sessions[chatId];
    
    if (session.state === STATE.ATTENDANT) {
        return;
    }
    
    const outOfFlowWords = ['preço', 'valor', 'entrega', 'demora', 'pagamento'];
    const textIsOutOfFlow = outOfFlowWords.some(word => text.includes(word));

    if (textIsOutOfFlow && session.state !== STATE.AWAITING_GAS_LOC && session.state !== STATE.AWAITING_WATER_LOC) {
        session.state = STATE.IDLE;
        await client.sendMessage(chatId, OUT_OF_FLOW_TEXT);
        return;
    }

    try {
        switch (session.state) {
            case STATE.IDLE:
                await handleIdle(msg, text, session);
                break;
            case STATE.AWAITING_GAS_QTY:
                await handleGasQty(msg, text, session);
                break;
            case STATE.AWAITING_GAS_LOC:
                await handleLocation(msg, session, 'Gás');
                break;
            case STATE.AWAITING_WATER_QTY:
                await handleWaterQty(msg, text, session);
                break;
            case STATE.AWAITING_WATER_LOC:
                await handleLocation(msg, session, 'Água');
                break;
        }
    } catch (err) {
        console.error('Erro ao processar mensagem:', err);
    }
});

async function handleIdle(msg, text, session) {
    const chatId = msg.from;

    const gasKeywords = ['gás', 'gas', 'botijão', 'botijao', 'quero gás', 'pedir gás', '1', '1️⃣', '1⃣'];
    const waterKeywords = ['água', 'agua', 'galão', 'galao', 'água mineral', '2', '2️⃣', '2⃣'];
    const attendantKeywords = ['3', '3️⃣', '3⃣', 'atendente', 'falar com atendente'];

    const hasGasWord = /\b(gás|gas|botijão|botijao)\b/i.test(text) || text === '1';
    const hasWaterWord = /\b(água|agua|galão|galao)\b/i.test(text) || text === '2';

    if (hasGasWord || text.includes('quero gás') || text.includes('pedir gás')) {
        session.state = STATE.AWAITING_GAS_QTY;
        session.product = 'Gás';
        await client.sendMessage(chatId, `🔥 Pedido de Gás\n\nQuantos botijões você deseja?\n\n1️⃣ 1 botijão\n2️⃣ 2 botijões\n3️⃣ 3 ou mais`);
        return;
    }

    if (hasWaterWord || text.includes('água mineral')) {
        session.state = STATE.AWAITING_WATER_QTY;
        session.product = 'Água';
        await client.sendMessage(chatId, `💧 Pedido de Água\n\nQuantos galões você deseja?\n\n1️⃣ 1 galão\n2️⃣ 2 galões\n3️⃣ 3 ou mais`);
        return;
    }

    if (attendantKeywords.some(kw => text === kw || text.includes(kw))) {
        session.state = STATE.ATTENDANT;
        await client.sendMessage(chatId, `Certo 👍\n\nVou chamar um atendente para continuar seu atendimento.\n\nAguarde um momento.`);
        return;
    }

    await client.sendMessage(chatId, MENU_TEXT);
}

async function handleGasQty(msg, text, session) {
    const chatId = msg.from;
    
    let qty = text;
    if (text === '1' || text === '1️⃣' || text === '1⃣') qty = '1 botijão';
    else if (text === '2' || text === '2️⃣' || text === '2⃣') qty = '2 botijões';
    else if (text === '3' || text === '3️⃣' || text === '3⃣') qty = '3 ou mais botijões';
    
    session.quantity = qty;
    session.state = STATE.AWAITING_GAS_LOC;
    
    await client.sendMessage(chatId, `Agora envie sua localização 📍\nou digite seu endereço completo.`);
}

async function handleWaterQty(msg, text, session) {
    const chatId = msg.from;
    
    let qty = text;
    if (text === '1' || text === '1️⃣' || text === '1⃣') qty = '1 galão';
    else if (text === '2' || text === '2️⃣' || text === '2⃣') qty = '2 galões';
    else if (text === '3' || text === '3️⃣' || text === '3⃣') qty = '3 ou mais galões';
    
    session.quantity = qty;
    session.state = STATE.AWAITING_WATER_LOC;
    
    await client.sendMessage(chatId, `Agora envie sua localização 📍\nou digite seu endereço completo.`);
}

async function handleLocation(msg, session, product) {
    const chatId = msg.from;
    
    let address = '';
    if (msg.type === 'location') {
        const latitude = msg.location.latitude;
        const longitude = msg.location.longitude;
        address = `Localização (Lat: ${latitude}, Long: ${longitude})`;
    } else {
        address = msg.body.trim();
    }
    
    let confirmationMsg = `Pedido recebido ✅\n\nProduto: ${product}\nQuantidade: ${session.quantity}\n\n`;
    
    if (product === 'Gás') {
        confirmationMsg += `Estamos enviando seu pedido para a entrega 🚚\nEm breve chegará até você.`;
    } else {
        confirmationMsg += `Seu pedido já foi enviado para entrega 🚚`;
    }

    await client.sendMessage(chatId, confirmationMsg);

    // Registro visual no seu terminal de quem foi a venda
    console.log(`\n=========================================`);
    console.log(`📦 NOVO PEDIDO (${NOME_DISTRIBUIDORA})`);
    console.log(`=========================================`);
    console.log(`👤 Cliente: ${session.name} (${chatId.replace('@c.us', '')})`);
    console.log(`🛍 Produto: ${product}`);
    console.log(`🔢 Quantidade: ${session.quantity}`);
    console.log(`📍 Endereço/Localização: ${address}`);
    console.log(`=========================================\n`);

    session.state = STATE.IDLE;
}

client.initialize();
