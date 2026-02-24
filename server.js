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
// Ключи берутся из Vercel Environment Variables, если их нет - берем заглушки
const FAUCETPAY_API_KEY = process.env.FAUCETPAY_API_KEY || 'TEST_KEY';
const FAUCETPAY_IPN_SECRET = process.env.FAUCETPAY_IPN_SECRET || 'TEST_SECRET';
const FAUCETPAY_WALLET_ADDRESS = process.env.FAUCETPAY_WALLET_ADDRESS || 'TTestAddress...';

// БАЗА ДАННЫХ (В памяти)
let users = {}; 
let market = []; 
let pendingDeposits = {}; 

// Функция получения пользователя
function getUser(userId) {
    if (!users[userId]) {
        users[userId] = {
            id: userId,
            balance: 0.00000000,
            inventory: [],
            level: { cpu: 1, electricity: 1 }, 
            miningPower: 1
        };
    }
    return users[userId];
}

// Расчет силы
function calculateMiningPower(user) {
    let power = 1; 
    power += (user.level.cpu - 1) * 2; 
    power += (user.level.electricity - 1) * 5; 
    return power;
}

const UPGRADES = {
    'cpu': { name: 'Видеокарта', basePrice: 10, multiplier: 1.5, bonus: 2 },
    'electricity': { name: 'Электричество', basePrice: 50, multiplier: 1.8, bonus: 5 }
};

// --- API РОУТЫ ---

// 1. Данные пользователя
app.get('/api/user/:id', (req, res) => {
    const user = getUser(req.params.id);
    const prices = {};
    for (let key in UPGRADES) {
        const level = user.level[key];
        prices[key] = parseFloat((UPGRADES[key].basePrice * Math.pow(UPGRADES[key].multiplier, level - 1)).toFixed(8));
    }
    res.json({ ...user, currentPower: calculateMiningPower(user), upgradePrices: prices });
});

// 2. Майнинг
app.post('/api/mine', (req, res) => {
    const { userId } = req.body;
    const user = getUser(userId);
    const power = calculateMiningPower(user);
    const reward = parseFloat((power * (0.5 + Math.random())).toFixed(8));
    user.balance += reward;
    // Шанс предмета 30%
    if (Math.random() > 0.7) {
        const itemValue = Math.floor(Math.random() * 10) + 1;
        user.inventory.push({
            id: uuidv4(),
            type: ['GPU', 'ASIC', 'RIG'][Math.floor(Math.random() * 3)],
            value: itemValue
        });
    }
    res.json({ success: true, newBalance: user.balance, reward: reward });
});

// 3. Улучшение
app.post('/api/upgrade', (req, res) => {
    const { userId, type } = req.body;
    const user = getUser(userId);
    const upgrade = UPGRADES[type];
    if (!upgrade) return res.status(400).json({ error: 'Invalid upgrade' });

    const currentLevel = user.level[type];
    const cost = parseFloat((upgrade.basePrice * Math.pow(upgrade.multiplier, currentLevel - 1)).toFixed(8));

    if (user.balance >= cost) {
        user.balance -= cost;
        user.level[type] += 1;
        res.json({ success: true, newBalance: user.balance });
    } else {
        res.status(400).json({ error: 'No money' });
    }
});

// 4. Создание депозита
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

// 5. IPN от FaucetPay
app.post('/api/ipn/faucetpay', (req, res) => {
    const ipnData = req.body;
    console.log('IPN Received:', ipnData);
    
    // Ищем ID в разных полях (зависит от настроек FP)
    const customField = ipnData.custom || ipnData.memo || ipnData.trx_id;

    if (pendingDeposits[customField]) {
        const deposit = pendingDeposits[customField];
        const user = getUser(deposit.userId);
        const amount = parseFloat(ipnData.amount);
        user.balance += amount;
        deposit.status = 'completed';
        console.log(`User ${deposit.userId} deposited ${amount}`);
    }
    res.status(200).send('OK');
});

// 6. Продажа на рынок
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
        price: parseFloat(price),
        timestamp: Date.now()
    });
    res.json({ success: true });
});

// 7. Покупка на рынке
app.post('/api/market/buy', (req, res) => {
    const { userId, listingId } = req.body;
    const buyer = getUser(userId);
    const listingIndex = market.findIndex(l => l.id === listingId);
    
    if (listingIndex === -1) return res.status(400).json({ error: 'Not found' });
    const listing = market[listingIndex];
    
    if (buyer.balance < listing.price) return res.status(400).json({ error: 'No funds' });
    
    buyer.balance -= listing.price;
    const seller = getUser(listing.sellerId);
    seller.balance += listing.price;
    buyer.inventory.push(listing.item);
    market.splice(listingIndex, 1);
    res.json({ success: true });
});

// 8. Рынок
app.get('/api/market', (req, res) => res.json(market));

// 9. Вывод (Тестовый режим)
app.post('/api/withdraw', async (req, res) => {
    const { userId, toAddress, amount } = req.body;
    const user = getUser(userId);
    
    if (user.balance < amount) return res.status(400).json({ error: 'No funds' });

    // РАСКОММЕНТИРУЙ НИЖЕ ДЛЯ РЕАЛЬНОГО ВЫВОДА, ЕСЛИ ЕСТЬ КЛЮЧ
    /*
    try {
        const response = await axios.post('https://faucetpay.io/api/v1/send', {
            api_key: FAUCETPAY_API_KEY,
            to: toAddress,
            amount: amount,
            currency: 'USDT',
            ref: 'Game'
        });
        if (response.data.status === 200) {
            user.balance -= amount;
            return res.json({ success: true });
        }
    } catch (e) { return res.status(500).json({ error: 'API Error' }); }
    */

    // Тестовый режим
    user.balance -= amount;
    res.json({ success: true, message: 'Тестовый вывод' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));