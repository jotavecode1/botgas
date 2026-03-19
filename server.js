const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- FUNÇÕES DE SIMILARIDADE E NLP PARA PRODUTOS ---
function normalizeText(text) {
    if (!text) return '';
    return text.toString()
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function levenshteinDistance(s, t) {
    if (!s.length) return t.length;
    if (!t.length) return s.length;
    const arr = [];
    for (let i = 0; i <= t.length; i++) {
        arr[i] = [i];
        for (let j = 1; j <= s.length; j++) {
            arr[i][j] = i === 0 ? j : Math.min(
                arr[i - 1][j] + 1,
                arr[i][j - 1] + 1,
                arr[i - 1][j - 1] + (s[j - 1] === t[i - 1] ? 0 : 1)
            );
        }
    }
    return arr[t.length][s.length];
}

function calculateSimilarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    const longerLength = longer.length;
    if (longerLength === 0) return 100;
    const distance = levenshteinDistance(longer, shorter);
    return ((longerLength - distance) / longerLength) * 100;
}

function generateAutoSynonyms(name) {
    if (!name) return [];
    const normalized = normalizeText(name);
    const synonyms = new Set([normalized]);
    
    // Suporte para plural
    if (!normalized.endsWith('s')) synonyms.add(normalized + 's');
    if (normalized.endsWith('o')) synonyms.add(normalized.slice(0, -1) + 'oes');
    
    // Categorias comuns
    if (normalized.includes('refrigerante')) synonyms.add('refri');
    if (normalized.includes('gas') || normalized.includes('botijao')) {
        synonyms.add('gas'); synonyms.add('botijao');
    }
    if (normalized.includes('agua')) synonyms.add('agua');

    // Extração de características (5kg, 13kg, 20l, etc)
    const traits = normalized.match(/(\d+(kg|l|ml))/g);
    if (traits) {
        traits.forEach(t => synonyms.add(t));
    }

    return Array.from(synonyms);
}

function findBestMatch(text, items) {
    if (!text || !items || items.length === 0) return [];

    const normText = normalizeText(text);
    const userWords = normText.split(/\s+/).filter(w => w.length > 2);

    // 1. Check for direct number choice
    const choiceMatch = text.trim().match(/^\d+$/);
    if (choiceMatch) {
        const choice = parseInt(choiceMatch[0], 10);
        if (choice > 0 && choice <= items.length) return [items[choice - 1]];
    }

    const scoredItems = [];

    for (const item of items) {
        const itemName = typeof item === 'string' ? item : (item.name || '');
        const normName = normalizeText(itemName);
        
        let itemSynonyms = item.synonyms ? item.synonyms.map(s => normalizeText(s)) : [];
        const autoSynonyms = generateAutoSynonyms(itemName);
        const allSyns = [...new Set([...itemSynonyms, ...autoSynonyms, normName])];

        let maxItemScore = 0;

        for (const syn of allSyns) {
            let score = 0;
            const synWords = syn.split(/\s+/).filter(w => w.length > 2);

            // Exact match is king (1000 pts)
            if (syn === normText) {
                score = 1000;
            } else {
                // Count how many words from user are in this synonym
                let matchedWords = 0;
                userWords.forEach(uw => {
                    if (syn.includes(uw)) matchedWords++;
                });

                // If all user words are in syn, very high score (500 pts)
                if (matchedWords === userWords.length && userWords.length > 0) {
                    score = 500 + (matchedWords * 10);
                } else {
                    score = matchedWords * 50;
                }

                // Penalty for length difference (prefer shorter matches for short input)
                const lenDiff = Math.abs(syn.length - normText.length);
                score -= lenDiff;

                // Bonus for starting with the same word
                if (syn.startsWith(userWords[0])) score += 30;
            }
            
            if (score > maxItemScore) maxItemScore = score;
        }

        if (maxItemScore > 0) {
            scoredItems.push({ item, score: maxItemScore });
        }
    }

    if (scoredItems.length > 0) {
        scoredItems.sort((a, b) => b.score - a.score);
        
        const top = scoredItems[0];
        // If top is significantly better (e.g., 20% higher than second), return only top
        if (scoredItems.length > 1) {
            const runnerUp = scoredItems[1];
            if (top.score > runnerUp.score * 1.3) {
                return [top.item];
            }
            // Otherwise return all that are close (within 15% range)
            return scoredItems.filter(si => si.score >= top.score * 0.85).map(si => si.item);
        }
        return [top.item];
    }
    return [];
}
// ----------------------------------------------------------------

const latestQR = {}; // Armazena o último QR code de cada cliente para novos acessos à página

io.on('connection', (socket) => {
    socket.on('requestData', (clientId) => {
        if (latestQR[clientId]) {
            socket.emit('qr', { clientId, qr: latestQR[clientId] });
        }
        if (clientsData[clientId]) {
            socket.emit('statusUpdate', { clientId, status: clientsData[clientId].status });
        }
    });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const clientsDataFile = path.join(__dirname, 'clients.json');
let clientsData = {};

if (fs.existsSync(clientsDataFile)) {
    try {
        clientsData = JSON.parse(fs.readFileSync(clientsDataFile, 'utf8'));
    } catch (e) {
        console.error("Erro ao ler clients.json", e);
    }
}

function saveClientsData() {
    fs.writeFileSync(clientsDataFile, JSON.stringify(clientsData, null, 2));
}

const ordersDataFile = path.join(__dirname, 'orders.json');
let ordersData = {};

if (fs.existsSync(ordersDataFile)) {
    try {
        ordersData = JSON.parse(fs.readFileSync(ordersDataFile, 'utf8'));
    } catch (e) {
        console.error("Erro ao ler orders.json", e);
    }
}

function saveOrdersData() {
    fs.writeFileSync(ordersDataFile, JSON.stringify(ordersData, null, 2));
}

const botInstances = {};
const chatSessions = {};

const clientsProfilesFile = path.join(__dirname, 'clients_profiles.json');
let clientsProfiles = {}; // { clientId: { phone: { name: "...", lastOrder: {...} } } }

if (fs.existsSync(clientsProfilesFile)) {
    try {
        clientsProfiles = JSON.parse(fs.readFileSync(clientsProfilesFile, 'utf8'));
    } catch (e) {
        console.error("Erro ao ler clients_profiles.json", e);
    }
}

function saveClientsProfiles() {
    fs.writeFileSync(clientsProfilesFile, JSON.stringify(clientsProfiles, null, 2));
}

const STATE = {
    IDLE: 'IDLE',
    AWAITING_NAME: 'AWAITING_NAME',
    CONFIRM_REPEAT: 'CONFIRM_REPEAT',
    AWAITING_PRODUCT: 'AWAITING_PRODUCT',
    CLARIFY_PRODUCT: 'CLARIFY_PRODUCT',
    AWAITING_BRAND: 'AWAITING_BRAND',
    CLARIFY_BRAND: 'CLARIFY_BRAND',
    AWAITING_QTY: 'AWAITING_QTY',
    AWAITING_MORE: 'AWAITING_MORE',
    AWAITING_PAYMENT: 'AWAITING_PAYMENT',
    AWAITING_LOCATION: 'AWAITING_LOCATION',
    ATTENDANT: 'ATTENDANT'
};

function startBot(clientId) {
    if (botInstances[clientId]) {
        return;
    }

    chatSessions[clientId] = {};
    if(clientsData[clientId]) {
        clientsData[clientId].status = 'Iniciando...';
        saveClientsData();
    }
    io.emit('statusUpdate', { clientId, status: 'Iniciando...' });

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: clientId }),
        puppeteer: { 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-software-rasterizer'
            ],
            headless: true
        },
        webVersionCache: { 
            type: 'remote', 
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html' 
        }
    });

    client.on('qr', (qr) => {
        if(clientsData[clientId]) clientsData[clientId].status = 'Aguardando QR Code';
        saveClientsData();
        latestQR[clientId] = qr;
        io.emit('statusUpdate', { clientId, status: 'Aguardando QR Code' });
        io.emit('qr', { clientId, qr });
    });

    client.on('authenticated', () => {
        if(clientsData[clientId]) clientsData[clientId].status = 'Autenticado';
        saveClientsData();
        io.emit('statusUpdate', { clientId, status: 'Autenticado' });
    });

    client.on('ready', () => {
        if(clientsData[clientId]) clientsData[clientId].status = 'Conectado';
        saveClientsData();
        delete latestQR[clientId]; // QR Code não é mais necessário
        io.emit('statusUpdate', { clientId, status: 'Conectado' });
        io.emit('ready', { clientId });
    });

    client.on('disconnected', (reason) => {
        if(clientsData[clientId]) clientsData[clientId].status = 'Desconectado';
        saveClientsData();
        delete botInstances[clientId];
        delete latestQR[clientId];
        io.emit('statusUpdate', { clientId, status: 'Desconectado' });
    });

    client.on('message', async msg => {
        if (msg.from === 'status@broadcast' || msg.isGroupMsg) return;

        const config = clientsData[clientId];
        if (!config) return;

        const chatId = msg.from;
        const text = msg.body.trim().toLowerCase();
        
        if (!chatSessions[clientId][chatId]) {
            const contact = await msg.getContact();
            chatSessions[clientId][chatId] = { 
                state: STATE.IDLE, 
                name: 'Cliente',
                cart: [] 
            };
        }
        
        const session = chatSessions[clientId][chatId];
        
        if (session.state === STATE.ATTENDANT) return;

        // Se o cliente perguntar sobre tempo de entrega
        const deliveryWords = ['tempo', 'demora', 'previsão', 'previsao', 'chegar'];
        if (deliveryWords.some(w => text.includes(w)) && !text.match(/^\d+$/)) {
            const deliveryStr = config.companyInfo?.deliveryTime || 'breve';
            await client.sendMessage(chatId, `Nosso tempo estimado de entrega é: ${deliveryStr} 🚚\nPodemos continuar com o seu pedido?`);
            // Retorna para não mudar o estado e permitir que o cliente continue o fluxo
            return;
        }

        // Se o cliente digitar algo fora de ordem
        const resetWords = ['menu', 'cancelar', 'início', 'inicio', 'oi', 'olá', 'ola', 'voltar'];
        if (resetWords.some(w => text === w)) {
            session.state = STATE.IDLE;
        }

        try {
            switch (session.state) {
                case STATE.IDLE:
                    await handleIdle(client, msg, text, session, config);
                    break;
                case STATE.AWAITING_NAME:
                    await handleName(client, msg, text, session, config);
                    break;
                case STATE.CONFIRM_REPEAT:
                    await handleConfirmRepeat(client, msg, text, session, config);
                    break;
                case STATE.AWAITING_PRODUCT:
                    await handleProduct(client, msg, text, session, config);
                    break;
                case STATE.CLARIFY_PRODUCT:
                    await handleClarifyProduct(client, msg, text, session, config);
                    break;
                case STATE.AWAITING_BRAND:
                    await handleBrand(client, msg, text, session, config);
                    break;
                case STATE.CLARIFY_BRAND:
                    await handleClarifyBrand(client, msg, text, session, config);
                    break;
                case STATE.AWAITING_QTY:
                    await handleQty(client, msg, text, session, config);
                    break;
                case STATE.AWAITING_MORE:
                    await handleMore(client, msg, text, session, config);
                    break;
                case STATE.AWAITING_PAYMENT:
                    await handlePayment(client, msg, text, session, config);
                    break;
                case STATE.AWAITING_LOCATION:
                    await handleLocation(client, msg, session, config);
                    break;
            }
        } catch (err) {
            console.error('Erro no fluxo de mensagens:', err);
        }
    });

    client.initialize().catch(err => {
        console.error(`Erro fatal ao iniciar bot [${clientId}]:`, err);
        if(clientsData[clientId]) clientsData[clientId].status = 'Erro';
        saveClientsData();
        io.emit('statusUpdate', { clientId, status: 'Erro' });
    });
    
    botInstances[clientId] = client;
}

function checkOpen(info) {
    if (info.operatingHoursAdvanced) {
        const adv = info.operatingHoursAdvanced;
        const now = new Date();
        const day = now.getDay(); // 0=Dom, 1=Seg.. 6=Sab
        let rules;
        if (day >= 1 && day <= 5) rules = adv.segsex;
        else if (day === 6) rules = adv.sab;
        else if (day === 0) rules = adv.dom;

        if (!rules || rules.open === false) return false;

        const start = rules.start;
        const end = rules.end;
        if (!start || !end) return true;

        const [startH, startM] = start.split(':').map(Number);
        const [endH, endM] = end.split(':').map(Number);
        
        const currentMins = now.getHours() * 60 + now.getMinutes();
        const startMins = startH * 60 + startM;
        let endMins = endH * 60 + endM;
        if (endMins < startMins) endMins += 24 * 60;
        
        let compareMins = currentMins;
        if (compareMins < startMins && endMins >= 24 * 60) compareMins += 24 * 60;
        
        return compareMins >= startMins && compareMins <= endMins;
    }

    const hoursStr = info.operatingHours;
    if (!hoursStr) return true;
    const times = hoursStr.match(/\d{1,2}:\d{2}/g);
    if (!times || times.length < 2) return true;
    
    const [startH, startM] = times[0].split(':').map(Number);
    const [endH, endM] = times[1].split(':').map(Number);
    
    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const startMins = startH * 60 + startM;
    let endMins = endH * 60 + endM;
    
    if (endMins < startMins) endMins += 24 * 60; // Crosses midnight
    
    let compareMins = currentMins;
    if (compareMins < startMins && endMins >= 24 * 60) compareMins += 24 * 60;
    
    return compareMins >= startMins && compareMins <= endMins;
}

async function handleIdle(client, msg, text, session, config) {
    const chatId = msg.from;
    const info = config.companyInfo || {};

    if ((info.operatingHoursAdvanced || info.operatingHours) && !checkOpen(info)) {
        const closedMsg = info.msgClosed || `Desculpe, não estamos de plantão no momento!`;
        await client.sendMessage(chatId, closedMsg);
        return;
    }

    let welcomeMsgs = info.welcomeMessages;
    if (!welcomeMsgs || welcomeMsgs.length === 0) {
        welcomeMsgs = [
            `Olá! 👋\nBem-vindo à ${info.name || 'nossa conveniência'}.`,
            `Fazemos entrega rápida de água e gás na sua região 🚚`
        ];
    }

    for (const msgContent of welcomeMsgs) {
        await client.sendMessage(chatId, msgContent);
    }

    // Verificação de Perfil para Boas-vinda Personalizada
    const profile = (clientsProfiles[config.id] || {})[chatId];
    if (profile && profile.name) {
        session.name = profile.name;
        if (profile.lastOrder) {
            let repeatMsg = `Olá, *${profile.name}*! Que bom ter você de volta. 👋\n\n🔁 Seu último pedido foi:\n\n*${profile.lastOrder.quantity}x ${profile.lastOrder.productName} (${profile.lastOrder.brandName})*\n\nDeseja repetir o mesmo pedido?\n\n1️⃣ Sim, repetir pedido\n2️⃣ Ver outros produtos`;
            await client.sendMessage(chatId, repeatMsg);
            session.state = STATE.CONFIRM_REPEAT;
            return;
        }
    }

    await showMenu(client, chatId, session, config);
}

async function handleName(client, msg, text, session, config) {
    const chatId = msg.from;
    session.name = msg.body.trim();
    
    if (!clientsProfiles[config.id]) clientsProfiles[config.id] = {};
    clientsProfiles[config.id][chatId] = { name: session.name };
    saveClientsProfiles();
    
    await client.sendMessage(chatId, `📍 Envie seu endereço completo para entrega.`);
    session.state = STATE.AWAITING_LOCATION;
}

async function handleConfirmRepeat(client, msg, text, session, config) {
    const chatId = msg.from;
    const profile = clientsProfiles[config.id][chatId];

    if (text === '1' || text.includes('sim') || text.includes('repetir')) {
        const last = profile.lastOrder;
        session.selectedProduct = config.products.find(p => p.name === last.productName) || { name: last.productName };
        session.selectedBrand = { name: last.brandName, price: last.price };
        session.quantity = last.quantity;
        
        // CORREÇÃO: Preencher o carrinho para o total não vir zerado
        session.cart = [{
            product: last.productName,
            brand: last.brandName,
            qty: last.quantity,
            price: last.price
        }];

        const precoFmt = (parseFloat(last.price.toString().replace(',','.')) * last.quantity).toFixed(2).replace('.', ',');
        await client.sendMessage(chatId, `Ótimo! ✅\n\nConfirmado: *${last.quantity}x ${last.brandName}* - R$ ${precoFmt}`);

        const pays = config.paymentMethods && config.paymentMethods.length > 0 ? config.paymentMethods : ['Dinheiro', 'Cartão na Entrega', 'Pix'];
        let paymentMsg = `💳 Como deseja pagar?\n\n`;
        pays.forEach((pm, idx) => { paymentMsg += `${idx + 1}️⃣ ${pm}\n`; });
        paymentMsg += `\n_Digite o número ou o nome da opção._`;
        
        await client.sendMessage(chatId, paymentMsg);
        session.state = STATE.AWAITING_PAYMENT;
    } else {
        await showMenu(client, chatId, session, config);
    }
}

async function showMenu(client, chatId, session, config) {
    let menuText = `📦 O que você gostaria de pedir hoje?\n\n`;
    if (config.products && config.products.length > 0) {
        config.products.forEach((p, index) => {
            menuText += `${index + 1}️⃣ ${p.name}\n`;
        });
    }
    menuText += `\n_Digite o número ou o nome do produto._`;
    await client.sendMessage(chatId, menuText);
    session.state = STATE.AWAITING_PRODUCT;
}

async function handleProduct(client, msg, text, session, config) {
    const chatId = msg.from;

    if (text === '0') {
        session.state = STATE.ATTENDANT;
        await client.sendMessage(chatId, "Encaminhando para um atendente. Por favor, aguarde.");
        return;
    }

    const matches = findBestMatch(text, config.products || []);

    if (matches.length === 1) {
        const selectedMatch = matches[0];
        session.selectedProduct = selectedMatch;
        await client.sendMessage(chatId, "Ótima escolha 👍");
        if (selectedMatch.brands && selectedMatch.brands.length > 0) {
            let brandMsg = `💧 Temos essas opções disponíveis:\n\n`;
            selectedMatch.brands.forEach((b, idx) => {
                const precoFmt = parseFloat(b.price.toString().replace(',','.')).toFixed(2).replace('.', ',');
                brandMsg += `${idx + 1}️⃣ ${b.name} — R$${precoFmt}\n`;
            });
            brandMsg += `\nQual você prefere? _(Digite o número ou o nome)_`;
            await client.sendMessage(chatId, brandMsg);
            session.state = STATE.AWAITING_BRAND;
        } else {
            session.selectedBrand = { name: 'Padrão', price: 'Consulte' };
            await client.sendMessage(chatId, `Quantas unidades você deseja?\n\nDigite apenas o número.\nExemplo: 1 ou 2`);
            session.state = STATE.AWAITING_QTY;
        }
    } else if (matches.length > 1) {
        session.clarifyOptions = matches;
        let msgClarify = `Você quis dizer:\n\n`;
        matches.forEach((m, idx) => {
            msgClarify += `${idx + 1}️⃣ ${m.name}\n`;
        });
        msgClarify += `\n_Digite o número da opção._`;
        await client.sendMessage(chatId, msgClarify);
        session.state = STATE.CLARIFY_PRODUCT;
    } else {
        await client.sendMessage(chatId, "Não consegui identificar o produto 🤔\n\nEscolha uma opção do catálogo ou digite o nome do produto.");
    }
}

async function handleClarifyProduct(client, msg, text, session, config) {
    const choiceMatch = text.trim().match(/^\d+$/);
    const options = session.clarifyOptions || [];
    
    if (choiceMatch) {
        const choice = parseInt(choiceMatch[0], 10);
        if (choice > 0 && choice <= options.length) {
            session.state = STATE.AWAITING_PRODUCT;
            await handleProduct(client, msg, options[choice - 1].name, session, config);
            return;
        }
    }
    session.state = STATE.AWAITING_PRODUCT;
    await handleProduct(client, msg, text, session, config);
}

async function handleBrand(client, msg, text, session, config) {
    const chatId = msg.from;
    const brands = session.selectedProduct.brands || [];

    const matches = findBestMatch(text, brands);

    if (matches.length === 1) {
        session.selectedBrand = matches[0];
        await client.sendMessage(chatId, `Quantas unidades você deseja?\n\nDigite apenas o número.\nExemplo: 1 ou 2`);
        session.state = STATE.AWAITING_QTY;
    } else if (matches.length > 1) {
        session.clarifyOptions = matches;
        let msgClarify = `Você quis dizer:\n\n`;
        matches.forEach((m, idx) => {
            msgClarify += `${idx + 1}️⃣ ${m.name}\n`;
        });
        msgClarify += `\n_Digite o número da opção._`;
        await client.sendMessage(chatId, msgClarify);
        session.state = STATE.CLARIFY_BRAND;
    } else {
        await client.sendMessage(chatId, "Não consegui identificar a opção 🤔\n\nEscolha uma opção digitando o número ou o nome.");
    }
}

async function handleClarifyBrand(client, msg, text, session, config) {
    const choiceMatch = text.trim().match(/^\d+$/);
    const options = session.clarifyOptions || [];
    
    if (choiceMatch) {
        const choice = parseInt(choiceMatch[0], 10);
        if (choice > 0 && choice <= options.length) {
            session.state = STATE.AWAITING_BRAND;
            await handleBrand(client, msg, options[choice - 1].name, session, config);
            return;
        }
    }
    session.state = STATE.AWAITING_BRAND;
    await handleBrand(client, msg, text, session, config);
}

async function handleQty(client, msg, text, session, config) {
    const chatId = msg.from;
    const qtyMatch = text.match(/\d+/);
    if (!qtyMatch) {
        await client.sendMessage(chatId, "Não consegui entender 🤔\n\nPor favor digite apenas o número.\nExemplo: 1 ou 2");
        return;
    }
    const qty = parseInt(qtyMatch[0]) || 1; 

    if (!session.cart) session.cart = [];
    
    session.cart.push({
        product: session.selectedProduct.name,
        brand: session.selectedBrand.name,
        qty: qty,
        price: session.selectedBrand.price
    });

    await client.sendMessage(chatId, `Seu produto foi adicionado ao pedido ✅\n\nDeseja adicionar mais alguma coisa?\n\n1️⃣ Ver catálogo novamente\n2️⃣ Finalizar pedido`);
    session.state = STATE.AWAITING_MORE;
}

async function handleMore(client, msg, text, session, config) {
    const chatId = msg.from;
    const choice = text.replace(/\D/g, '');
    
    if (choice === '1' || text.toLowerCase().includes('sim') || text.toLowerCase().includes('catálogo') || text.toLowerCase().includes('catalogo')) {
        await showMenu(client, chatId, session, config);
    } else if (choice === '2' || text.toLowerCase().includes('não') || text.toLowerCase().includes('nao') || text.toLowerCase().includes('finalizar')) {
        const pays = config.paymentMethods && config.paymentMethods.length > 0 ? config.paymentMethods : ['Dinheiro', 'Cartão na Entrega', 'Pix'];
        let paymentMsg = `💳 Como deseja pagar?\n\n`;
        pays.forEach((pm, idx) => {
            paymentMsg += `${idx + 1}️⃣ ${pm}\n`;
        });
        paymentMsg += `\n_Digite o número ou o nome da opção._`;
        
        await client.sendMessage(chatId, paymentMsg);
        session.state = STATE.AWAITING_PAYMENT;
    } else {
        await client.sendMessage(chatId, "Não consegui entender 🤔\n\nPor favor digite 1 para ver o catálogo novamente ou 2 para finalizar.");
    }
}

async function handlePayment(client, msg, text, session, config) {
    const chatId = msg.from;
    const paysRaw = config.paymentMethods && config.paymentMethods.length > 0 ? config.paymentMethods : ['Dinheiro', 'Cartão na Entrega', 'Pix'];
    
    const payOptions = paysRaw.map(p => {
        let syns = [normalizeText(p)];
        if (p === 'Dinheiro') syns.push('dinheiro', 'especie', 'nota', 'troco', 'cash');
        if (p === 'Pix') syns.push('pix', 'chave', 'transferencia', 'qrcode');
        if (p === 'Cartão na Entrega') syns.push('cartao', 'debito', 'credito', 'maquina', 'maquininha', 'visa', 'master', 'elo');
        return { name: p, synonyms: syns };
    });

    const matches = findBestMatch(text, payOptions);

    if (matches.length === 1) {
        session.paymentMethod = matches[0].name;
    } else if (matches.length > 1) {
        let msgClarify = `Você quis dizer qual forma de pagamento?\n\n`;
        matches.forEach((m, idx) => { msgClarify += `${idx + 1}️⃣ ${m.name}\n`; });
        await client.sendMessage(chatId, msgClarify);
        return;
    } else {
        await client.sendMessage(chatId, "Puxa, não entendi a forma de pagamento 🤔\n\nTemos: Dinheiro, Pix ou Cartão na Entrega.");
        return;
    }

    if (!session.name || session.name === 'Cliente') {
        await client.sendMessage(chatId, `Para finalizar, qual é o seu nome?`);
        session.state = STATE.AWAITING_NAME;
    } else {
        await client.sendMessage(chatId, `📍 Envie seu endereço completo para entrega.`);
        session.state = STATE.AWAITING_LOCATION;
    }
}

async function handleLocation(client, msg, session, config) {
    const chatId = msg.from;
    let address = '';
    if (msg.type === 'location') {
        const latitude = msg.location.latitude;
        const longitude = msg.location.longitude;
        address = `https://maps.google.com/?q=${latitude},${longitude}`;
    } else {
        address = msg.body.trim();
    }

    if (!address || address.length < 4) {
        await client.sendMessage(chatId, "Não consegui entender 🤔\n\nPor favor, envie o seu endereço completo para entrega.");
        return;
    }

    session.location = address;
    await finalizeOrder(client, chatId, session, config);
}

async function finalizeOrder(client, chatId, session, config) {
    const info = config.companyInfo || {};
    
    let taxaValue = 0;
    let recognizedBairro = null;

    if (info.deliveryFee) {
        taxaValue = parseFloat(info.deliveryFee.toString().replace(',','.'));
    }

    // Busca taxas customizadas por bairro na mensagem de localização
    if (info.neighborhoods && info.neighborhoods.length > 0) {
        // Ordena pela string maior primeiro para evitar que "Vila X" seja validado por "Vila"
        const sortedBairros = [...info.neighborhoods].sort((a,b) => b.name.length - a.name.length);
        const lowerLoc = session.location.toLowerCase();
        for (const n of sortedBairros) {
            if (lowerLoc.includes(n.name.toLowerCase())) {
                taxaValue = parseFloat(n.fee.toString().replace(',','.'));
                recognizedBairro = n.name;
                break;
            }
        }
    }
    
    const configId = config.id;
    if (!clientsData[configId].lastOrderNumber) {
        clientsData[configId].lastOrderNumber = (ordersData[configId] ? ordersData[configId].length : 0);
    }
    clientsData[configId].lastOrderNumber++;
    const orderNumber = clientsData[configId].lastOrderNumber;
    saveClientsData();

    let subtotal = 0;
    let itemsText = '';
    session.cart.forEach(item => {
        const itemTotal = parseFloat(item.price.toString().replace(',','.')) * item.qty;
        subtotal += itemTotal;
        itemsText += `${item.qty}x ${item.product} ${item.brand}\n`;
    });
    
    // Lógica de Pedido Mínimo (FRETE GRÁTIS SE ATINGIR)
    const minOrderForFree = info.minOrder ? parseFloat(info.minOrder.toString().replace(',','.')) : 0;
    let finalTaxa = taxaValue;
    let deliveryStatusMsg = '';

    if (minOrderForFree > 0) {
        if (subtotal >= minOrderForFree) {
            finalTaxa = 0;
            deliveryStatusMsg = `✅ *Frete Grátis aplicado!* (Pedido atingiu o mínimo)\n`;
        } else {
            deliveryStatusMsg = `⚠️ Faltam R$ ${(minOrderForFree - subtotal).toFixed(2).replace('.', ',')} para obter frete grátis.\n`;
        }
    }
    
    if (recognizedBairro && finalTaxa > 0) {
        deliveryStatusMsg = `📍 Taxa calculada p/ *${recognizedBairro}*: R$ ${finalTaxa.toFixed(2).replace('.', ',')}\n` + deliveryStatusMsg;
    }

    let total = subtotal + finalTaxa;
    const subtotalFmt = subtotal.toFixed(2).replace('.', ',');
    const totalFmt = total.toFixed(2).replace('.', ',');
    const taxaFmtMsg = finalTaxa === 0 ? '🚚 Entrega: Grátis' : `🚚 Taxa: R$ ${finalTaxa.toFixed(2).replace('.', ',')}`;
    const deliveryTimeMin = info.deliveryTime && info.deliveryTime !== 'breve' ? info.deliveryTime : '35 a 50 minutos';

    let template = config.finalMessage;
    if (!template || template.trim() === '' || template.includes('{quantidade}')) {
        template = '🧾 Pedido #{numero_pedido} confirmado!\n\n' +
                   '📦 Seu pedido\n\n' +
                   '{itens}\n' +
                   '💰 Subtotal: R${subtotal}\n' +
                   '{taxa_entrega}\n' +
                   '💵 Total: R${total}\n\n' +
                   '💳 Pagamento: {pagamento}\n\n' +
                   '📍 Entrega:\n' +
                   '{endereco}\n\n' +
                   '🚚 Previsão de entrega:\n' +
                   '{tempo_entrega}\n\n' +
                   '🙏 Obrigado por comprar com a {nome_empresa}!\n\n' +
                   'Seu pedido já foi enviado para nossa equipe.\n\n' +
                   'Em breve sairá para entrega 🚚';
    }

    let finalMsg = template
        .replace(/{numero_pedido}/g, String(orderNumber).padStart(3, '0'))
        .replace(/{nome_empresa}/g, info.name || 'nossa loja')
        .replace(/{itens}/g, itemsText.trim())
        .replace(/{subtotal}/g, subtotalFmt)
        .replace(/{taxa_entrega}/g, taxaFmtMsg)
        .replace(/{status_entrega}/g, deliveryStatusMsg ? deliveryStatusMsg + '\n' : '')
        .replace(/{total}/g, totalFmt)
        .replace(/{pagamento}/g, session.paymentMethod)
        .replace(/{endereco}/g, session.location)
        .replace(/{tempo_entrega}/g, deliveryTimeMin);

    if (info.closingMessage && info.closingMessage.trim() !== '') {
        if (!template.includes('🙏 Obrigado por comprar')) {
            finalMsg += '\n\n' + info.closingMessage;
        }
    }

    await client.sendMessage(chatId, finalMsg);

    // Notificar atendente
    let attendantPhone = config.attendantPhone || '5518981014240';
    const attendantId = attendantPhone.replace(/\D/g, '') + '@c.us';

    const orderId = `${config.id}_${Date.now()}`;
    const hora_pedido = new Date().toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'});

    const mapLink = session.location.includes('maps.google') ? session.location : `https://maps.google.com/?q=${encodeURIComponent(session.location)}`;

    const orderSummary = `🤖 *NOVO PEDIDO #CHAT-${orderNumber}*\n\n` +
    `👤 *Cliente:* ${session.name}\n` +
    `📱 *WhatsApp:* ${chatId.replace('@c.us', '')}\n\n` +
    `📦 *ITENS:* \n${itemsText.trim()}\n\n` +
    `💰 *Total:* R$ ${totalFmt}\n` +
    `💳 *Pagamento:* ${session.paymentMethod}\n\n` +
    `📍 *ENDEREÇO:* \n${session.location}\n\n` +
    `🗺 *Mapa:* ${mapLink}\n\n` +
    `⏱ Realizado às ${hora_pedido}\n\n` +
    `✅ Status: Aguardando preparo`;

    try {
        await client.sendMessage(attendantId, orderSummary);
    } catch (e) { console.error("Erro ao avisar atendente:", e); }

    // Salvar pedido no histórico
    if (!ordersData[config.id]) ordersData[config.id] = [];
    ordersData[config.id].push({
        id: orderId,
        orderNumber,
        customerName: session.name,
        customerPhone: chatId.replace('@c.us', ''),
        items: session.cart,
        total,
        paymentMethod: session.paymentMethod,
        location: session.location,
        status: 'Novo',
        source: 'Chatbot',
        timestamp: new Date().toISOString()
});
    saveOrdersData();

    // Salvar no perfil para recompra
    if (!clientsProfiles[config.id]) clientsProfiles[config.id] = {};
    const firstItem = session.cart[0];
    clientsProfiles[config.id][chatId] = {
        name: session.name,
        lastOrder: {
            productName: firstItem.product,
            brandName: firstItem.brand,
            quantity: firstItem.qty,
            price: firstItem.price,
            timestamp: new Date().toISOString()
        }
    };
    saveClientsProfiles();

    session.state = STATE.IDLE;
    session.cart = [];
}

// ROTAS DA API WEB (PAINEL DE GERENCIAMENTO)

app.get('/api/clients', (req, res) => {
    res.json(clientsData);
});

// Adicionar um novo cliente
app.post('/api/clients', (req, res) => {
    const clientData = req.body;
    
    if (!clientData.id) {
        return res.status(400).json({ error: 'ID é obrigatório' });
    }
    
    const cleanId = clientData.id.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');

        clientsData[cleanId] = { 
        ...clientData,
        id: cleanId, 
        status: 'Desconectado',
        createdAt: new Date().toISOString()
    };
    saveClientsData();
    
    res.json({ success: true, client: clientsData[cleanId] });
});

// Editar cliente existente
app.put('/api/clients/:id', (req, res) => {
    const { id } = req.params;
    const clientData = req.body;
    
    if (!clientsData[id]) {
        return res.status(404).json({ error: 'Cliente não encontrado' });
    }
    
    // Atualiza mantendo dados sensíveis como status se necessário
    clientsData[id] = { 
        ...clientsData[id], 
        ...clientData,
        id: id // garante que o ID não mude
    };
    
    saveClientsData();
    res.json({ success: true, client: clientsData[id] });
});

// Excluir cliente
app.delete('/api/clients/:id', async (req, res) => {
    const { id } = req.params;
    
    if (botInstances[id]) {
        try { await botInstances[id].logout(); } catch(e) {}
        try { await botInstances[id].destroy(); } catch(e) {}
        delete botInstances[id];
    }
    
    if (clientsData[id]) {
        delete clientsData[id];
        saveClientsData();
    }

    res.json({ success: true });
});

app.post('/api/clients/:id/start', (req, res) => {
    const { id } = req.params;
    if (!clientsData[id]) return res.status(404).json({ error: 'Cliente não encontrado' });
    
    startBot(id);
    res.json({ success: true, message: 'Inicializando o bot...' });
});

app.post('/api/clients/:id/stop', async (req, res) => {
    const { id } = req.params;
    if (botInstances[id]) {
        try { await botInstances[id].destroy(); } catch(e) {}
        delete botInstances[id];
        clientsData[id].status = 'Desconectado';
        saveClientsData();
        io.emit('statusUpdate', { clientId: id, status: 'Desconectado' });
    }
    res.json({ success: true, message: 'Bot parado.' });
});

// Login do cliente
app.post('/api/client-login', (req, res) => {
    const { login, password } = req.body;
    
    for (const [id, data] of Object.entries(clientsData)) {
        if (data.login === login && data.password === password) {
            return res.json({ success: true, clientId: id });
        }
    }
    
    res.status(401).json({ success: false, error: 'Usuário ou senha inválidos' });
});

// Dados do dashboard do cliente
app.get('/api/catalog/:id', (req, res) => {
    const { id } = req.params;
    if (!clientsData[id]) {
        return res.status(404).json({ error: 'Catálogo não encontrado' });
    }
    const client = clientsData[id];
    res.json({
        success: true,
        companyInfo: client.companyInfo,
        products: client.products,
        paymentMethods: client.paymentMethods,
        attendantPhone: client.attendantPhone,
        id: client.id
    });
});

app.get('/api/client-dashboard/:clientId', (req, res) => {
    const { clientId } = req.params;
    
    if (!clientsData[clientId]) {
        return res.status(404).json({ error: 'Cliente não encontrado' });
    }
    
    const clientOrders = ordersData[clientId] || [];
    
    // Calcula estatísticas
    let totalSales = 0;
    let totalOrders = clientOrders.length;
    const productsCount = {};
    
    clientOrders.forEach(order => {
        totalSales += (order.total || (order.price * order.quantity) || 0);
        if (order.items && Array.isArray(order.items)) {
            order.items.forEach(item => {
                const prodKey = `${item.product} - ${item.brand}`;
                if (!productsCount[prodKey]) productsCount[prodKey] = 0;
                productsCount[prodKey] += (item.qty || 1);
            });
        }
    });
    
    res.json({
        success: true,
        companyName: clientsData[clientId].companyInfo?.name || clientId,
        stats: {
            totalSales,
            totalOrders,
            productsCount
        },
        recentOrders: clientOrders.slice(-500).reverse(), // Últimos 500 pedidos para o histórico
        config: clientsData[clientId].companyInfo || {},
        botStatus: clientsData[clientId].status || 'Desconectado',
        products: clientsData[clientId].products || []
    });
});

// Atualizar status do pedido e notificar cliente
app.post('/api/client-dashboard/:clientId/order/:orderId/status', async (req, res) => {
    const { clientId, orderId } = req.params;
    const { status } = req.body;

    if (!ordersData[clientId]) return res.status(404).json({ error: 'Empresa não encontrada' });
    
    const order = ordersData[clientId].find(o => o.id === orderId);
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });

    order.status = status;
    saveOrdersData();

    // Notificar via WhatsApp
    const bot = botInstances[clientId];
    const clientStatus = clientsData[clientId].status;

    if (bot && clientStatus === 'Conectado') {
        let phoneRaw = String(order.customerPhone).trim();
        
        // Se for 'Web' sem número, não tem como enviar. Mas se tiver número, envia!
        if (!phoneRaw || phoneRaw.toLowerCase() === 'web' || phoneRaw.length < 5) {
            console.log(`[Status] Origem sem número válido (${phoneRaw}). Ignorando WhatsApp.`);
            return res.json({ success: true, note: 'Sem número' });
        }

        // Normalização agressiva do JID
        let cleaned = phoneRaw.replace(/\D/g, '');
        // Se não tem 55 e parece um número brasileiro (10 ou 11 dígitos), coloca 55
        if (cleaned.length >= 10 && cleaned.length <= 11 && !cleaned.startsWith('55')) {
            cleaned = '55' + cleaned;
        }
        
        const jid = cleaned.includes('@') ? cleaned : cleaned + '@c.us';

        const info = clientsData[clientId].companyInfo || {};
        let statusMsg = '';
        
        switch(status) {
            case 'Preparando': 
                statusMsg = info.msgPreparing || `👨‍🍳 Seu pedido #${order.orderNumber} já está sendo preparado!`; 
                break;
            case 'Saiu para entrega': 
                statusMsg = info.msgInRoute || `🚚 Boa notícia! Seu pedido #${order.orderNumber} saiu para entrega.\n\nEm breve chegará até você.`; 
                break;
            case 'Entregue': 
                statusMsg = info.msgDelivered || `✅ Pedido entregue!\n\nObrigado por comprar com a ${info.name || 'nossa loja'}.\n\nSe precisar é só chamar 😉`; 
                break;
        }

        if (statusMsg) {
            bot.sendMessage(jid, statusMsg)
                .then(() => console.log(`[Status] OK: Enviado para ${jid} (${status})`))
                .catch(e => console.error(`[Status] ERRO para ${jid}:`, e.message));
        }
    } else {
        console.warn(`[Status] Bot ${clientId} offline. Notificação não enviada.`);
    }

    res.json({ success: true });
});

// Criar pedido via Web (Anota Ai / Sistema)
app.post('/api/orders', (req, res) => {
    const { clientId, customerName, customerPhone, items, total, paymentMethod, location } = req.body;

    if (!clientsData[clientId]) return res.status(404).json({ error: 'Empresa não encontrada' });

    if (!clientsData[clientId].lastOrderNumber) {
        clientsData[clientId].lastOrderNumber = (ordersData[clientId] ? ordersData[clientId].length : 0);
    }
    clientsData[clientId].lastOrderNumber++;
    const orderNumber = clientsData[clientId].lastOrderNumber;
    saveClientsData();

    const orderId = `${clientId}_${Date.now()}`;

    const newOrder = {
        id: orderId,
        orderNumber,
        customerName,
        customerPhone: customerPhone || 'Web',
        items,
        total,
        paymentMethod,
        location,
        status: 'Novo',
        source: 'Catálogo',
        timestamp: new Date().toISOString()
};

    if (!ordersData[clientId]) ordersData[clientId] = [];
    ordersData[clientId].push(newOrder);
    saveOrdersData();

    // Notificar atendente via WhatsApp se o bot estiver online
    if (botInstances[clientId]) {
        let itemsText = '';
        items.forEach(item => {
            itemsText += `${item.qty}x ${item.product} ${item.brand}\n`;
        });

        const hora_pedido = new Date().toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'});
        const attendantPhone = clientsData[clientId].attendantPhone || '5518981014240';
        const attendantId = attendantPhone.replace(/\D/g, '') + '@c.us';

        const orderSummary = `🛍 *NOVO PEDIDO #CAT-${orderNumber}*\n\n` +
        `👤 *Cliente:* ${customerName}\n` +
        `📍 *Endereço:* ${location}\n\n` +
        `📦 *ITENS:* \n${itemsText.trim()}\n\n` +
        `💰 *Total:* R$ ${total.toFixed(2).replace('.', ',')}\n` +
        `💳 *Pagamento:* ${paymentMethod}\n\n` +
        `⏱ Realizado às ${hora_pedido}\n\n` +
        `✅ Status: Aguardando preparo no Painel`;

        botInstances[clientId].sendMessage(attendantId, orderSummary).catch(e => console.error("Erro ao avisar atendente sobre pedido WEB:", e));
    }

    res.json({ success: true, orderId });
});

// Atualizar configurações da empresa via Dashboard
app.post('/api/client-dashboard/:clientId/config', async (req, res) => {
    const { clientId } = req.params;
    const { 
        msgPreparing, msgInRoute, msgDelivered, products, 
        deliveryFee, minOrder, recallDays, useAutoRecall, paymentMethods,
        login, password
    } = req.body;

    if (!clientsData[clientId]) return res.status(404).json({ error: 'Empresa não encontrada' });
    
    // Atualizar credenciais (nível raiz do objeto do cliente)
    if (login) clientsData[clientId].login = login;
    if (password) clientsData[clientId].password = password;

    if (!clientsData[clientId].companyInfo) clientsData[clientId].companyInfo = {};
    
    clientsData[clientId].companyInfo.msgPreparing = msgPreparing;
    clientsData[clientId].companyInfo.msgInRoute = msgInRoute;
    clientsData[clientId].companyInfo.msgDelivered = msgDelivered;
    
    // Campos legados (segurança ante travamentos)
    if (deliveryFee !== undefined) clientsData[clientId].companyInfo.deliveryFee = parseFloat(deliveryFee) || 0;
    if (minOrder !== undefined) clientsData[clientId].companyInfo.minOrder = parseFloat(minOrder) || 0;
    if (recallDays !== undefined) clientsData[clientId].companyInfo.recallDays = parseInt(recallDays) || 15;
    if (useAutoRecall !== undefined) clientsData[clientId].companyInfo.useAutoRecall = !!useAutoRecall;
    
    if (paymentMethods) {
        clientsData[clientId].paymentMethods = paymentMethods;
    }
    
    if (products) {
        clientsData[clientId].products = products;
    }
    
    saveClientsData();
    res.json({ success: true });
});

setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 10 && now.getMinutes() === 0) { // Executa às 10h da manhã (melhor horário para pedir gás/água)
        for (const clientId in clientsProfiles) {
            const config = clientsData[clientId];
            if (!config || !config.companyInfo?.useAutoRecall) continue;

            const recallDays = parseInt(config.companyInfo.recallDays) || 15;
            const msInDay = 24 * 60 * 60 * 1000;
            const profiles = clientsProfiles[clientId];
            
            for (const phone in profiles) {
                const p = profiles[phone];
                if (p.lastOrder && p.lastOrder.timestamp && botInstances[clientId]) {
                    const lastDate = new Date(p.lastOrder.timestamp);
                    const diffDays = Math.floor((now - lastDate) / msInDay);

                    if (diffDays === recallDays) {
                        const msgRecall = `Olá ${p.name}! 👋\n\nFaz cerca de ${recallDays} dias desde seu último pedido de ${p.lastOrder.productName}.\n\nGostaria de pedir novamente hoje para não ficar sem? 😊`;
                        try {
                            await botInstances[clientId].sendMessage(phone, msgRecall);
                            console.log(`[Recall] Mensagem enviada para ${p.name} (${clientId})`);
                        } catch(e) { console.error("Erro no recall:", e); }
                    }
                }
            }
        }
    }
}, 60000); // Checa a cada minuto


const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`\n🔥 Servidor Multi-Bot ZapGas rodando!`);
    console.log(`👉 Painel Admin: http://localhost:${PORT}/`);
    
    // Auto-start bots
    console.log(`\n⏳ Iniciando bots salvos...`);
    for (const id in clientsData) {
        if (clientsData[id].status === 'Conectado' || clientsData[id].status === 'Iniciando') {
            console.log(`[Auto-Start] Iniciando bot: ${id}`);
            startBot(id);
        }
    }
});

// Global Error Handling to prevent crashes
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
