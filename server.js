const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());
app.use(cors());

// --- КОНФИГУРАЦИЯ ---
const PORT = process.env.PORT || 3000;
const FAUCETPAY_API_KEY = process.env.FAUCETPAY_API_KEY || 'TEST_KEY';
const FAUCETPAY_IPN_SECRET = process.env.FAUCETPAY_IPN_SECRET || 'TEST_SECRET';
const FAUCETPAY_WALLET_ADDRESS = process.env.FAUCETPAY_WALLET_ADDRESS || 'TTestAddress...';

// Курс для P2P рынка (примерная стоимость предмета)
const MARKET_RATE_GCOIN_TO_USDT = 0.001; // 1000 G-COIN = 1 USDT

// БАЗА ДАННЫХ
let users = {}; 
let market = []; 
let pendingDeposits = {}; 

function getUser(userId) {
    if (!users[userId]) {
        users[userId] = {
            id: userId,
            balances: {
                usdt: 0.00000000, // Реальные деньги (для вывода)
                gcoin: 0           // Игровая валюта (для улучшений)
            },
            inventory: [],
            level: { cpu: 1, electricity: 1 }, 
            miningPower: 1
        };
    }
    return users[userId];
}

function calculateMiningPower(user) {
    let power = 1; 
    power += (user.level.cpu - 1) * 2; 
    power += (user.level.electricity - 1) * 5; 
    return power;
}

const UPGRADES = {
    'cpu': { name: 'Видеокарта', basePrice: 500, multiplier: 1.5, bonus: 2 }, // Цена в G-COIN
    'electricity': { name: 'Электричество', basePrice: 2000, multiplier: 1.8, bonus: 5 }
};

// --- API РОУТЫ ---

// 1. Данные пользователя
app.get('/api/user/:id', (req, res) => {
    const user = getUser(req.params.id);
    const prices = {};
    for (let key in UPGRADES) {
        const level = user.level[key];
        prices[key] = Math.floor(UPGRADES[key].basePrice * Math.pow(UPGRADES[key].multiplier, level - 1));
    }
    res.json({ 
        ...user, 
        currentPower: calculateMiningPower(user), 
        upgradePrices: prices
    });
});

// 2. Майнинг (Дает G-COIN)
app.post('/api/mine', (req, res) => {
    const { userId } = req.body;
    const user = getUser(userId);
    const power = calculateMiningPower(user);
    
    // Награда в G-COIN
    const reward = Math.floor(power * (0.5 + Math.random())); 
    
    user.balances.gcoin += reward;
    
    // Предметы (для продажи на рынок за USDT)
    if (Math.random() > 0.7) {
        const itemValue = Math.floor(Math.random() * 10) + 1;
        user.inventory.push({
            id: uuidv4(),
            type: ['GPU', 'ASIC', 'RIG'][Math.floor(Math.random() * 3)],
            value: itemValue,
            estimatedUsdt: (itemValue * MARKET_RATE_GCOIN_TO_USDT).toFixed(8) // Примерная цена в USDT
        });
    }

    res.json({ success: true, gcoin: user.balances.gcoin, reward: reward });
});

// 3. Покупка улучшений (Тратит G-COIN)
app.post('/api/upgrade', (req, res) => {
    const { userId, type } = req.body;
    const user = getUser(userId);
    const upgrade = UPGRADES[type];
    
    if (!upgrade) return res.status(400).json({ error: 'Invalid upgrade' });

    const currentLevel = user.level[type];
    const cost = Math.floor(upgrade.basePrice * Math.pow(upgrade.multiplier, currentLevel - 1));

    if (user.balances.gcoin >= cost) {
        user.balances.gcoin -= cost; 
        user.level[type] += 1;
        res.json({ success: true, gcoin: user.balances.gcoin });
    } else {
        res.status(400).json({ error: 'Not enough G-COIN' });
    }
});

// 4. Депозит (Пополнение USDT - игрок пополняет, чтобы потом снимать? Нет, в этой схеме не нужен, но оставим для тестов или если захочешь ввести "Донат")
// Логика: Игрок добывает G-COIN, продает предметы -> получает USDT -> выводит.
// Но для полноты функции "Пополнить" (например, если игрок хочет вывести больше, чем заработал) оставим:
app.post('/api/deposit/create', (req, res) => {
    const { userId, amount } = req.body;
    const depositId = uuidv4().replace(/-/g, '').substring(0, 10);
    const paymentId = `uid_${userId}_${depositId}`;
    
    pendingDeposits[paymentId] = {
        userId,
        amount: parseFloat(amount),
        status: 'pending',
        timestamp: Date.now()
    };

    const qrData = `${FAUCETPAY_WALLET_ADDRESS}?memo=${paymentId}`;
    const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(qrData)}`;

    res.json({
        success: true,
        address: FAUCETPAY_WALLET_ADDRESS,
        paymentId: paymentId,
        amount: amount,
        qrCodeLink: qrLink
    });
});

// IPN от FaucetPay (Зачисляет USDT на баланс)
app.post('/api/ipn/faucetpay', (req, res) => {
    const ipnData = req.body;
    console.log('IPN Received:', ipnData);
    
    const customField = ipnData.custom || ipnData.memo || ipnData.trx_id;

    if (pendingDeposits[customField]) {
        const deposit = pendingDeposits[customField];
        const user = getUser(deposit.userId);
        const amount = parseFloat(ipnData.amount);
        user.balances.usdt += amount; // Зачисляем USDT
        deposit.status = 'completed';
        console.log(`User ${deposit.userId} deposited ${amount} USDT`);
    }
    res.status(200).send('OK');
});

// 5. P2P: Продажа предмета (Игрок продает предмет -> Получает USDT от другого игрока)
app.post('/api/market/sell', (req, res) => {
    const { userId, itemId, price } = req.body;
    const user = getUser(userId);
    const itemIndex = user.inventory.findIndex(i => i.id === itemId);
    if (itemIndex === -1) return res.status(400).json({ error: 'Not found' });
    
    const item = user.inventory[itemIndex];
    user.inventory.splice(itemIndex, 1);
    
    market.push({
        id: uuidv4(),
        sellerId: userId,
        item: item,
        price: parseFloat(price), // Цена в USDT
        timestamp: Date.now()
    });
    res.json({ success: true });
});

// 6. P2P: Покупка предмета (Игрок тратит USDT -> Получает предмет)
app.post('/api/market/buy', (req, res) => {
    const { userId, listingId } = req.body;
    const buyer = getUser(userId);
    const listingIndex = market.findIndex(l => l.id === listingId);
    
    if (listingIndex === -1) return res.status(400).json({ error: 'Not found' });
    const listing = market[listingIndex];
    
    if (buyer.balances.usdt < listing.price) return res.status(400).json({ error: 'No USDT funds' });
    
    buyer.balances.usdt -= listing.price; // Тратим USDT
    const seller = getUser(listing.sellerId);
    seller.balances.usdt += listing.price; // Продавец получает USDT
    
    buyer.inventory.push(listing.item);
    market.splice(listingIndex, 1);
    res.json({ success: true });
});

// 7. Рынок
app.get('/api/market', (req, res) => res.json(market));

// 8. Вывод (Тратит USDT)
app.post('/api/withdraw', async (req, res) => {
    const { userId, toAddress, amount } = req.body;
    const user = getUser(userId);
    
    if (user.balances.usdt < amount) return res.status(400).json({ error: 'No USDT funds' });

    // РЕАЛЬНЫЙ ВЫВОД (Раскомментируй, если есть ключ)
    /*
    try {
        const response = await axios.post('https://faucetpay.io/api/v1/send', {
            api_key: FAUCETPAY_API_KEY,
            to: toAddress,
            amount: amount,
            currency: 'USDT',
            ref: 'Game Withdraw'
        });
        if (response.data.status === 200) {
            user.balances.usdt -= amount;
            return res.json({ success: true });
        }
    } catch (e) { return res.status(500).json({ error: 'API Error' }); }
    */

    // ТЕСТОВЫЙ РЕЖИМ
    user.balances.usdt -= amount;
    res.json({ success: true, message: 'Тестовый вывод USDT' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
