const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ verify: (req, res, buf, encoding) => {
    if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf8');
    }
}}));
app.use(express.urlencoded({ extended: true }));

// 📁 Database file path - Use Railway Volume if available
const VOLUME_PATH = process.env.VOLUME_PATH || __dirname;
const DB_FILE = path.join(VOLUME_PATH, 'users.json');

// Create volume directory if it doesn't exist
if (process.env.VOLUME_PATH && !fs.existsSync(VOLUME_PATH)) {
    fs.mkdirSync(VOLUME_PATH, { recursive: true });
    console.log(`📁 Created volume directory: ${VOLUME_PATH}`);
}

console.log(`💾 Database location: ${DB_FILE}`);
console.log(`📂 Using ${process.env.VOLUME_PATH ? 'Railway Volume (Persistent)' : 'Local Storage (Ephemeral)'}`);

// 🔧 Database helper functions
function readDB() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            const initialData = {
                admin: {
                    username: process.env.ADMIN_USERNAME || 'admin',
                    password: process.env.ADMIN_PASSWORD || 'admin123'
                },
                games: []
            };
            fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
            console.log('✅ Created new database file');
            return initialData;
        }
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (error) {
        console.error('❌ Error reading database:', error);
        return { admin: { username: 'admin', password: 'admin123' }, games: [] };
    }
}

function writeDB(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('❌ Error writing database:', error);
        return false;
    }
}

// 🎮 Initialize games from environment variables and database
function initializeGames() {
    const db = readDB();
    const envGames = [];
    
    // ✅ PERBAIKAN: Dinamis membaca semua GAME_X_* dari environment variables
    let gameIndex = 1;
    while (true) {
        const universeId = process.env[`GAME_${gameIndex}_UNIVERSE_ID`];
        const apiKey = process.env[`GAME_${gameIndex}_API_KEY`];
        const webhookSecret = process.env[`GAME_${gameIndex}_WEBHOOK_SECRET`];
        const password = process.env[`GAME_${gameIndex}_PASSWORD`];
        
        // Jika tidak ada required fields, stop loop
        if (!universeId || !apiKey || !webhookSecret || !password) {
            break;
        }
        
        envGames.push({
            id: `game${gameIndex}`,
            name: process.env[`GAME_${gameIndex}_NAME`] || `Game ${gameIndex}`,
            universeId: universeId,
            apiKey: apiKey,
            topic: process.env[`GAME_${gameIndex}_TOPIC`] || 'ArchieDonationIDR',
            webhookSecret: webhookSecret,
            password: password,
            saweriaToken: process.env[`GAME_${gameIndex}_SAWERIA_TOKEN`],
            socialbuzzToken: process.env[`GAME_${gameIndex}_SOCIALBUZZ_TOKEN`]
        });
        
        gameIndex++;
        
        // Safety limit untuk mencegah infinite loop
        if (gameIndex > 100) {
            console.warn('⚠️ Reached maximum game limit (100)');
            break;
        }
    }

    // Merge with database games
    const mergedGames = [];
    for (const envGame of envGames) {
        const dbGame = db.games.find(g => g.id === envGame.id);
        if (dbGame) {
            // Use database password if exists, otherwise use env
            mergedGames.push({
                ...envGame,
                password: dbGame.password || envGame.password,
                lastActive: dbGame.lastActive || new Date().toISOString(),
                createdAt: dbGame.createdAt || new Date().toISOString()
            });
        } else {
            // New game from env
            mergedGames.push({
                ...envGame,
                lastActive: new Date().toISOString(),
                createdAt: new Date().toISOString()
            });
        }
    }

    // Update database with merged games
    db.games = mergedGames;
    writeDB(db);

    return mergedGames;
}

let GAMES = initializeGames();

if (GAMES.length === 0) {
    console.error('❌ No games configured!');
    console.error('   Required variables per game:');
    console.error('   - GAME_X_UNIVERSE_ID');
    console.error('   - GAME_X_API_KEY');
    console.error('   - GAME_X_WEBHOOK_SECRET');
    console.error('   - GAME_X_PASSWORD');
    process.exit(1);
}

console.log('🎮 Archie Webhook - ' + GAMES.length + ' games configured');
GAMES.forEach(game => {
    console.log(`   📌 ${game.id}: ${game.name} (Universe: ${game.universeId})`);
});

// 🔐 Auth Helpers
function authenticateGame(password) {
    return GAMES.find(game => game.password && game.password === password);
}

function authenticateAdmin(username, password) {
    const db = readDB();
    return db.admin.username === username && db.admin.password === password;
}

function updateGameLastActive(gameId) {
    const db = readDB();
    const game = db.games.find(g => g.id === gameId);
    if (game) {
        game.lastActive = new Date().toISOString();
        writeDB(db);
    }
}

// Helper Functions
function verifyWebhookToken(req, expectedToken) {
    if (!expectedToken) return true;
    const token = req.headers['x-webhook-token'] || req.headers['authorization']?.replace('Bearer ', '') || req.body?.token;
    return token === expectedToken;
}

// ✅ PERBAIKAN: Fungsi extractUsername yang lebih robust
function extractUsername(message, donatorName) {
    if (!message || message.trim() === '') return donatorName;
    
    const trimmedMessage = message.trim();
    
    // Format: [username] atau [username]message
    const bracketMatch = trimmedMessage.match(/^\[([^\]]+)\]/);
    if (bracketMatch && bracketMatch[1].trim()) {
        return bracketMatch[1].trim();
    }
    
    // Format: @username atau @username message
    const atMatch = trimmedMessage.match(/^@([^\s]+)/);
    if (atMatch && atMatch[1].trim()) {
        return atMatch[1].trim();
    }
    
    // Format: username: message
    const colonMatch = trimmedMessage.match(/^([^\s:]+):/);
    if (colonMatch && colonMatch[1].trim()) {
        return colonMatch[1].trim();
    }
    
    // Format: username (word pertama jika tidak ada format khusus)
    // Hanya ambil jika kata pertama terlihat seperti username
    const firstWord = trimmedMessage.split(/\s+/)[0];
    if (firstWord && firstWord.length >= 3 && firstWord.length <= 20) {
        // Cek apakah kata pertama terlihat seperti username (alphanumeric + underscore)
        // DAN harus mengandung setidaknya satu angka atau underscore (untuk membedakan dari kata biasa)
        if (/^[a-zA-Z0-9_]+$/.test(firstWord) && /[0-9_]/.test(firstWord)) {
            return firstWord;
        }
    }
    
    return donatorName;
}

function formatRupiah(amount) {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(amount);
}

async function sendToRoblox(game, donationData) {
    const apiUrl = `https://apis.roblox.com/messaging-service/v1/universes/${game.universeId}/topics/${encodeURIComponent(game.topic)}`;
    console.log(`📤 [${game.name}] Sending ${formatRupiah(donationData.amount)} for ${donationData.username}`);
    
    try {
        const response = await axios.post(apiUrl, { 
            message: JSON.stringify(donationData) 
        }, {
            headers: { 
                'Content-Type': 'application/json', 
                'x-api-key': game.apiKey 
            },
            timeout: 10000
        });
        
        console.log(`✅ [${game.name}] Success! Status: ${response.status}`);
        updateGameLastActive(game.id);
        return { success: true, status: response.status, data: response.data };
    } catch (error) {
        console.error(`❌ [${game.name}] Failed to send to Roblox`);
        if (error.response) {
            console.error('📛 Response Status:', error.response.status);
            console.error('📛 Response Data:', JSON.stringify(error.response.data, null, 2));
        }
        throw error;
    }
}

// 🔧 Webhook Routes
GAMES.forEach(game => {
    // Saweria
    app.post(`/${game.webhookSecret}/saweria`, async (req, res) => {
        console.log(`\n📩 [${game.name}] Saweria webhook received`);
        
        if (game.saweriaToken && !verifyWebhookToken(req, game.saweriaToken)) {
            console.log(`❌ [${game.name}] Unauthorized - Invalid token`);
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        const payload = req.body;
        if (!payload || payload.type !== 'donation') {
            return res.status(200).json({ success: true, message: 'OK' });
        }
        
        const donationData = {
            username: extractUsername(payload.message || '', payload.donator_name || 'Anonymous'),
            displayName: payload.donator_name || 'Anonymous',
            amount: Math.floor(payload.amount_raw || 0),
            timestamp: Math.floor(Date.now() / 1000),
            source: 'Saweria',
            message: payload.message || '',
            email: payload.donator_email || ''
        };
        
        try {
            await sendToRoblox(game, donationData);
            return res.status(200).json({ success: true, message: 'Processed' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed' });
        }
    });
    
    // ✅ PERBAIKAN: SocialBuzz webhook dengan logging lebih detail
    app.post(`/${game.webhookSecret}/socialbuzz`, async (req, res) => {
        console.log(`\n📩 [${game.name}] SocialBuzz webhook received`);
        console.log('📦 Raw payload:', JSON.stringify(req.body, null, 2));
        
        if (game.socialbuzzToken && !verifyWebhookToken(req, game.socialbuzzToken)) {
            console.log(`❌ [${game.name}] Unauthorized - Invalid token`);
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        const payload = req.body;
        if (!payload) {
            return res.status(400).json({ success: false, error: 'No payload' });
        }
        
        // ✅ Ekstraksi data yang lebih lengkap dari berbagai field yang mungkin
        const rawMessage = payload.message || payload.supporter_message || payload.note || payload.comment || '';
        const rawName = payload.supporter_name || payload.name || payload.donator_name || 'Anonymous';
        
        console.log('📝 Extracted message:', rawMessage);
        console.log('👤 Extracted name:', rawName);
        
        const extractedUsername = extractUsername(rawMessage, rawName);
        console.log('✅ Final username:', extractedUsername);
        
        const donationData = {
            username: extractedUsername,
            displayName: rawName,
            amount: Math.floor(payload.amount || payload.donation_amount || payload.amount_raw || 0),
            timestamp: Math.floor(Date.now() / 1000),
            source: 'SocialBuzz',
            message: rawMessage,
            email: payload.supporter_email || payload.email || ''
        };
        
        console.log('📤 Donation data to send:', JSON.stringify(donationData, null, 2));
        
        try {
            await sendToRoblox(game, donationData);
            return res.status(200).json({ success: true, message: 'Processed' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed' });
        }
    });
    
    // Test Endpoint
    app.post(`/${game.webhookSecret}/test`, async (req, res) => {
        const password = req.query.password || req.body?.password;
        const authGame = authenticateGame(password);
        
        if (!authGame || authGame.id !== game.id) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        console.log(`\n🧪 Test endpoint - ${game.name}`);
        const testPayload = {
            username: req.body.username || 'TestUser',
            displayName: 'Test Donator',
            amount: parseInt(req.body.amount) || 25000,
            timestamp: Math.floor(Date.now() / 1000),
            source: 'Test',
            message: 'Test donation'
        };
        
        try {
            await sendToRoblox(game, testPayload);
            res.json({ success: true, message: 'Test sent', game: game.name });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Test failed', details: error.message });
        }
    });
});

// 🏠 Homepage
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Archie Webhook Integration</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', system-ui, sans-serif;
            background: #0a0e27;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            overflow: hidden;
            position: relative;
        }
        body::before {
            content: '';
            position: absolute;
            width: 200%;
            height: 200%;
            background: 
                radial-gradient(circle at 20% 50%, rgba(120, 119, 198, 0.3), transparent 50%),
                radial-gradient(circle at 80% 80%, rgba(88, 166, 255, 0.3), transparent 50%),
                radial-gradient(circle at 40% 20%, rgba(139, 92, 246, 0.2), transparent 50%);
            animation: float 20s ease-in-out infinite;
        }
        @keyframes float {
            0%, 100% { transform: translate(0, 0) rotate(0deg); }
            33% { transform: translate(30px, -50px) rotate(120deg); }
            66% { transform: translate(-20px, 20px) rotate(240deg); }
        }
        .grid-bg {
            position: absolute;
            width: 100%;
            height: 100%;
            background-image: 
                linear-gradient(rgba(139, 92, 246, 0.1) 1px, transparent 1px),
                linear-gradient(90deg, rgba(139, 92, 246, 0.1) 1px, transparent 1px);
            background-size: 50px 50px;
            animation: grid-move 20s linear infinite;
            opacity: 0.3;
        }
        @keyframes grid-move {
            0% { transform: translate(0, 0); }
            100% { transform: translate(50px, 50px); }
        }
        .container {
            position: relative;
            z-index: 10;
            width: 90%;
            max-width: 450px;
        }
        .login-box {
            background: rgba(15, 23, 42, 0.8);
            backdrop-filter: blur(20px);
            border: 1px solid rgba(139, 92, 246, 0.3);
            border-radius: 24px;
            padding: 48px 40px;
            box-shadow: 
                0 20px 60px rgba(0, 0, 0, 0.5),
                0 0 100px rgba(139, 92, 246, 0.1),
                inset 0 1px 0 rgba(255, 255, 255, 0.1);
            animation: fadeIn 0.6s ease-out;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(30px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .logo {
            text-align: center;
            margin-bottom: 40px;
        }
        .logo-icon {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #8b5cf6, #3b82f6);
            border-radius: 20px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 40px;
            margin-bottom: 16px;
            box-shadow: 0 10px 30px rgba(139, 92, 246, 0.4);
            animation: pulse 2s ease-in-out infinite;
        }
        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
        }
        h1 {
            color: #ffffff;
            font-size: 28px;
            font-weight: 700;
            margin-bottom: 8px;
            text-shadow: 0 2px 10px rgba(139, 92, 246, 0.5);
        }
        .subtitle {
            color: #94a3b8;
            font-size: 14px;
            font-weight: 400;
        }
        .form-group {
            margin-bottom: 24px;
        }
        label {
            display: block;
            color: #cbd5e1;
            font-size: 14px;
            font-weight: 500;
            margin-bottom: 8px;
            letter-spacing: 0.3px;
        }
        .input-wrapper {
            position: relative;
        }
        input {
            width: 100%;
            padding: 16px 48px 16px 16px;
            background: rgba(15, 23, 42, 0.6);
            border: 2px solid rgba(139, 92, 246, 0.2);
            border-radius: 12px;
            color: #ffffff;
            font-size: 15px;
            transition: all 0.3s;
            outline: none;
        }
        input:focus {
            border-color: #8b5cf6;
            background: rgba(15, 23, 42, 0.9);
            box-shadow: 0 0 0 4px rgba(139, 92, 246, 0.1);
        }
        .input-icon {
            position: absolute;
            right: 16px;
            top: 50%;
            transform: translateY(-50%);
            color: #64748b;
            font-size: 20px;
        }
        button {
            width: 100%;
            padding: 16px;
            background: linear-gradient(135deg, #8b5cf6, #3b82f6);
            border: none;
            border-radius: 12px;
            color: #ffffff;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
            box-shadow: 0 8px 24px rgba(139, 92, 246, 0.4);
            position: relative;
            overflow: hidden;
        }
        button::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
            transition: left 0.5s;
        }
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 12px 32px rgba(139, 92, 246, 0.5);
        }
        button:hover::before {
            left: 100%;
        }
        button:active {
            transform: translateY(0);
        }
        .error {
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.3);
            color: #fca5a5;
            padding: 12px 16px;
            border-radius: 8px;
            font-size: 14px;
            margin-top: 16px;
            display: none;
            animation: shake 0.5s;
        }
        @keyframes shake {
            0%, 100% { transform: translateX(0); }
            25% { transform: translateX(-10px); }
            75% { transform: translateX(10px); }
        }
        .tabs {
            display: flex;
            gap: 12px;
            margin-bottom: 32px;
        }
        .tab {
            flex: 1;
            padding: 12px;
            background: rgba(15, 23, 42, 0.5);
            border: 1px solid rgba(139, 92, 246, 0.2);
            border-radius: 12px;
            color: #94a3b8;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
            text-align: center;
        }
        .tab.active {
            background: rgba(139, 92, 246, 0.2);
            border-color: #8b5cf6;
            color: #8b5cf6;
        }
        .tab:hover {
            background: rgba(139, 92, 246, 0.15);
        }
        .tab-content {
            display: none;
        }
        .tab-content.active {
            display: block;
        }
        .footer {
            text-align: center;
            margin-top: 32px;
            padding-top: 24px;
            border-top: 1px solid rgba(139, 92, 246, 0.1);
        }
        .footer-text {
            color: #64748b;
            font-size: 13px;
            margin-bottom: 12px;
        }
        .discord-link {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            color: #8b5cf6;
            text-decoration: none;
            font-size: 14px;
            font-weight: 500;
            padding: 8px 16px;
            border-radius: 8px;
            background: rgba(139, 92, 246, 0.1);
            border: 1px solid rgba(139, 92, 246, 0.2);
            transition: all 0.3s;
        }
        .discord-link:hover {
            background: rgba(139, 92, 246, 0.2);
            border-color: rgba(139, 92, 246, 0.4);
            transform: translateY(-2px);
        }
        .loader {
            display: none;
            width: 20px;
            height: 20px;
            border: 3px solid rgba(255,255,255,0.3);
            border-top-color: #fff;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin: 0 auto;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="grid-bg"></div>
    <div class="container">
        <div class="login-box">
            <div class="logo">
                <div class="logo-icon">🎮</div>
                <h1>Archie Webhook</h1>
                <p class="subtitle">Secure Integration Portal</p>
            </div>
            
            <div class="tabs">
                <div class="tab active" onclick="switchTab('user')">👤 User Login</div>
                <div class="tab" onclick="switchTab('admin')">🔐 Admin Login</div>
            </div>
            
            <!-- User Login -->
            <div id="userTab" class="tab-content active">
                <form id="userLoginForm">
                    <div class="form-group">
                        <label for="userPassword">Access Password</label>
                        <div class="input-wrapper">
                            <input type="password" id="userPassword" placeholder="Enter your password" autocomplete="off" required>
                            <span class="input-icon">🔐</span>
                        </div>
                    </div>
                    <button type="submit" id="userLoginBtn">
                        <span id="userBtnText">Access Dashboard</span>
                        <div class="loader" id="userLoader"></div>
                    </button>
                    <div class="error" id="userError">Invalid password. Please try again.</div>
                </form>
            </div>
            
            <!-- Admin Login -->
            <div id="adminTab" class="tab-content">
                <form id="adminLoginForm">
                    <div class="form-group">
                        <label for="adminUsername">Username</label>
                        <div class="input-wrapper">
                            <input type="text" id="adminUsername" placeholder="Enter admin username" autocomplete="off" required>
                            <span class="input-icon">👤</span>
                        </div>
                    </div>
                    <div class="form-group">
                        <label for="adminPassword">Password</label>
                        <div class="input-wrapper">
                            <input type="password" id="adminPassword" placeholder="Enter admin password" autocomplete="off" required>
                            <span class="input-icon">🔐</span>
                        </div>
                    </div>
                    <button type="submit" id="adminLoginBtn">
                        <span id="adminBtnText">Admin Access</span>
                        <div class="loader" id="adminLoader"></div>
                    </button>
                    <div class="error" id="adminError">Invalid credentials. Please try again.</div>
                </form>
            </div>
            
            <div class="footer">
                <p class="footer-text">Need assistance?</p>
                <a href="https://discord.com/users/wispray" target="_blank" class="discord-link">
                    <span>💬</span>
                    <span>Contact on Discord</span>
                </a>
            </div>
        </div>
    </div>
    
    <script>
        function switchTab(tab) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            if (tab === 'user') {
                document.querySelectorAll('.tab')[0].classList.add('active');
                document.getElementById('userTab').classList.add('active');
            } else {
                document.querySelectorAll('.tab')[1].classList.add('active');
                document.getElementById('adminTab').classList.add('active');
            }
        }
        
        // User Login
        document.getElementById('userLoginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = document.getElementById('userPassword').value.trim();
            const btn = document.getElementById('userLoginBtn');
            const btnText = document.getElementById('userBtnText');
            const loader = document.getElementById('userLoader');
            const error = document.getElementById('userError');
            
            if (!password) return;
            
            btnText.style.display = 'none';
            loader.style.display = 'block';
            btn.disabled = true;
            error.style.display = 'none';
            
            try {
                const response = await fetch('/api/auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    window.location.href = '/dashboard?password=' + encodeURIComponent(password);
                } else {
                    error.style.display = 'block';
                    document.getElementById('userPassword').value = '';
                    document.getElementById('userPassword').focus();
                }
            } catch (err) {
                error.style.display = 'block';
                error.textContent = 'Connection error. Please try again.';
            } finally {
                btnText.style.display = 'block';
                loader.style.display = 'none';
                btn.disabled = false;
            }
        });
        
        // Admin Login
        document.getElementById('adminLoginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('adminUsername').value.trim();
            const password = document.getElementById('adminPassword').value.trim();
            const btn = document.getElementById('adminLoginBtn');
            const btnText = document.getElementById('adminBtnText');
            const loader = document.getElementById('adminLoader');
            const error = document.getElementById('adminError');
            
            if (!username || !password) return;
            
            btnText.style.display = 'none';
            loader.style.display = 'block';
            btn.disabled = true;
            error.style.display = 'none';
            
            try {
                const response = await fetch('/api/admin/auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    window.location.href = '/admin/dashboard?token=' + encodeURIComponent(data.token);
                } else {
                    error.style.display = 'block';
                    document.getElementById('adminPassword').value = '';
                    document.getElementById('adminPassword').focus();
                }
            } catch (err) {
                error.style.display = 'block';
                error.textContent = 'Connection error. Please try again.';
            } finally {
                btnText.style.display = 'block';
                loader.style.display = 'none';
                btn.disabled = false;
            }
        });
    </script>
</body>
</html>`;
    res.send(html);
});

// 🔐 API: User Auth
app.post('/api/auth', (req, res) => {
    const { password } = req.body;
    const game = authenticateGame(password);
    
    if (game) {
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

// 🔐 API: Admin Auth
app.post('/api/admin/auth', (req, res) => {
    const { username, password } = req.body;
    
    if (authenticateAdmin(username, password)) {
        // Simple token (in production, use JWT or session)
        const token = Buffer.from(`${username}:${password}`).toString('base64');
        res.json({ success: true, token });
    } else {
        res.json({ success: false });
    }
});

// 🔐 API: Change User Password
app.post('/api/user/change-password', (req, res) => {
    const { currentPassword, newPassword } = req.body;
    
    if (!newPassword || newPassword.length < 6) {
        return res.json({ success: false, error: 'Password must be at least 6 characters' });
    }
    
    const game = authenticateGame(currentPassword);
    if (!game) {
        return res.json({ success: false, error: 'Current password is incorrect' });
    }
    
    const db = readDB();
    const dbGame = db.games.find(g => g.id === game.id);
    if (dbGame) {
        dbGame.password = newPassword;
        if (writeDB(db)) {
            // Reload games
            GAMES = initializeGames();
            res.json({ success: true, message: 'Password changed successfully' });
        } else {
            res.json({ success: false, error: 'Failed to save password' });
        }
    } else {
        res.json({ success: false, error: 'Game not found' });
    }
});

// 🔐 API: Admin Get Users
app.get('/api/admin/users', (req, res) => {
    const token = req.query.token;
    if (!token) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [username, password] = decoded.split(':');
        
        if (!authenticateAdmin(username, password)) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        const db = readDB();
        const users = db.games.map(game => ({
            id: game.id,
            name: game.name,
            universeId: game.universeId,
            lastActive: game.lastActive,
            createdAt: game.createdAt,
            hasPassword: !!game.password
        }));
        
        res.json({ success: true, users });
    } catch (error) {
        res.status(401).json({ success: false, error: 'Invalid token' });
    }
});

// 🔐 API: Admin Reset Password
app.post('/api/admin/reset-password', (req, res) => {
    const { token, gameId, newPassword } = req.body;
    
    if (!token) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [username, password] = decoded.split(':');
        
        if (!authenticateAdmin(username, password)) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        if (!newPassword || newPassword.length < 6) {
            return res.json({ success: false, error: 'Password must be at least 6 characters' });
        }
        
        const db = readDB();
        const game = db.games.find(g => g.id === gameId);
        
        if (!game) {
            return res.json({ success: false, error: 'Game not found' });
        }
        
        game.password = newPassword;
        if (writeDB(db)) {
            // Reload games
            GAMES = initializeGames();
            res.json({ success: true, message: 'Password reset successfully' });
        } else {
            res.json({ success: false, error: 'Failed to save password' });
        }
    } catch (error) {
        res.status(401).json({ success: false, error: 'Invalid token' });
    }
});

// 📊 User Dashboard
app.get('/dashboard', (req, res) => {
    const password = req.query.password;
    const game = authenticateGame(password);
    
    if (!game) {
        return res.redirect('/');
    }
    
    const baseUrl = `https://${req.get('host')}`;
    
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${game.name} - Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', system-ui, sans-serif;
            background: #0a0e27;
            color: #ffffff;
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 1000px; margin: 0 auto; }
        .header {
            background: linear-gradient(135deg, rgba(139, 92, 246, 0.2), rgba(59, 130, 246, 0.2));
            border: 1px solid rgba(139, 92, 246, 0.3);
            border-radius: 20px;
            padding: 32px;
            margin-bottom: 32px;
            backdrop-filter: blur(10px);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 16px;
        }
        .header-left h1 {
            font-size: 32px;
            margin-bottom: 8px;
            background: linear-gradient(135deg, #8b5cf6, #3b82f6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .header-left p { color: #94a3b8; font-size: 14px; }
        .header-right {
            display: flex;
            gap: 12px;
            align-items: center;
        }
        .card {
            background: rgba(15, 23, 42, 0.8);
            border: 1px solid rgba(139, 92, 246, 0.2);
            border-radius: 16px;
            padding: 28px;
            margin-bottom: 24px;
            backdrop-filter: blur(10px);
        }
        .card h3 {
            color: #8b5cf6;
            font-size: 18px;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .info-row {
            display: flex;
            justify-content: space-between;
            padding: 12px 0;
            border-bottom: 1px solid rgba(139, 92, 246, 0.1);
            align-items: center;
        }
        .info-row:last-child { border-bottom: none; }
        .info-label { color: #94a3b8; font-size: 14px; }
        .info-value { color: #ffffff; font-weight: 500; font-size: 14px; }
        .url-box {
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(139, 92, 246, 0.2);
            border-radius: 10px;
            padding: 16px;
            margin: 12px 0;
            position: relative;
        }
        .url-label {
            color: #8b5cf6;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            margin-bottom: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .url-text {
            color: #10b981;
            font-family: 'Courier New', monospace;
            font-size: 13px;
            word-break: break-all;
            line-height: 1.6;
            padding: 12px;
            background: rgba(0, 0, 0, 0.4);
            border-radius: 8px;
        }
        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
        }
        .badge-success {
            background: rgba(16, 185, 129, 0.2);
            color: #10b981;
            border: 1px solid rgba(16, 185, 129, 0.3);
        }
        .badge-warning {
            background: rgba(245, 158, 11, 0.2);
            color: #f59e0b;
            border: 1px solid rgba(245, 158, 11, 0.3);
        }
        .btn {
            padding: 10px 20px;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: linear-gradient(135deg, #8b5cf6, #3b82f6);
            color: white;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(139, 92, 246, 0.4);
        }
        .btn-secondary {
            background: rgba(139, 92, 246, 0.2);
            border: 1px solid rgba(139, 92, 246, 0.4);
        }
        .btn-secondary:hover {
            background: rgba(139, 92, 246, 0.3);
        }
        .success-toast, .error-toast {
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 16px 24px;
            border-radius: 12px;
            font-weight: 600;
            display: none;
            animation: slideIn 0.3s ease-out;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 1000;
        }
        .success-toast {
            background: rgba(16, 185, 129, 0.9);
            color: white;
        }
        .error-toast {
            background: rgba(239, 68, 68, 0.9);
            color: white;
        }
        @keyframes slideIn {
            from { transform: translateX(400px); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            backdrop-filter: blur(5px);
            z-index: 1000;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .modal.active {
            display: flex;
        }
        .modal-content {
            background: rgba(15, 23, 42, 0.95);
            border: 1px solid rgba(139, 92, 246, 0.3);
            border-radius: 20px;
            padding: 32px;
            max-width: 500px;
            width: 100%;
            animation: modalFadeIn 0.3s ease-out;
        }
        @keyframes modalFadeIn {
            from { opacity: 0; transform: scale(0.9); }
            to { opacity: 1; transform: scale(1); }
        }
        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 24px;
        }
        .modal-header h2 {
            color: #8b5cf6;
            font-size: 24px;
        }
        .close-btn {
            background: none;
            border: none;
            color: #94a3b8;
            font-size: 24px;
            cursor: pointer;
            padding: 0;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 8px;
            transition: all 0.3s;
        }
        .close-btn:hover {
            background: rgba(139, 92, 246, 0.2);
            color: #8b5cf6;
        }
        .form-group {
            margin-bottom: 20px;
        }
        .form-group label {
            display: block;
            color: #cbd5e1;
            font-size: 14px;
            font-weight: 500;
            margin-bottom: 8px;
        }
        .form-group input {
            width: 100%;
            padding: 12px 16px;
            background: rgba(15, 23, 42, 0.6);
            border: 2px solid rgba(139, 92, 246, 0.2);
            border-radius: 10px;
            color: #ffffff;
            font-size: 15px;
            transition: all 0.3s;
            outline: none;
        }
        .form-group input:focus {
            border-color: #8b5cf6;
            background: rgba(15, 23, 42, 0.9);
        }
        .modal-footer {
            display: flex;
            gap: 12px;
            justify-content: flex-end;
            margin-top: 24px;
        }
        @media (max-width: 768px) {
            .header { padding: 24px; flex-direction: column; }
            .header-left h1 { font-size: 24px; }
            .card { padding: 20px; }
        }
    </style>
</head>
<body>
    <div class="success-toast" id="successToast"></div>
    <div class="error-toast" id="errorToast"></div>
    
    <!-- Change Password Modal -->
    <div class="modal" id="changePasswordModal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>🔐 Change Password</h2>
                <button class="close-btn" onclick="closeModal()">&times;</button>
            </div>
            <form id="changePasswordForm">
                <div class="form-group">
                    <label>Current Password</label>
                    <input type="password" id="currentPassword" required>
                </div>
                <div class="form-group">
                    <label>New Password</label>
                    <input type="password" id="newPassword" minlength="6" required>
                </div>
                <div class="form-group">
                    <label>Confirm New Password</label>
                    <input type="password" id="confirmPassword" minlength="6" required>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                    <button type="submit" class="btn">Change Password</button>
                </div>
            </form>
        </div>
    </div>
    
    <div class="container">
        <div class="header">
            <div class="header-left">
                <h1>🎮 ${game.name}</h1>
                <p>Webhook Integration Dashboard</p>
            </div>
            <div class="header-right">
                <button class="btn btn-secondary" onclick="openChangePasswordModal()">🔑 Change Password</button>
                <button class="btn" onclick="window.location.href='/'">🚪 Logout</button>
            </div>
        </div>
        
        <div class="card">
            <h3>📋 Game Information</h3>
            <div class="info-row">
                <span class="info-label">Universe ID</span>
                <span class="info-value">${game.universeId}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Topic</span>
                <span class="info-value">${game.topic}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Webhook Secret</span>
                <span class="info-value">
                    <span class="badge badge-success">✓ Configured</span>
                </span>
            </div>
        </div>
        
        <div class="card">
            <h3>🔐 Security Status</h3>
            <div class="info-row">
                <span class="info-label">Saweria Token</span>
                <span class="info-value">
                    <span class="badge ${game.saweriaToken ? 'badge-success' : 'badge-warning'}">
                        ${game.saweriaToken ? '✓ Configured' : '⚠ Optional'}
                    </span>
                </span>
            </div>
            <div class="info-row">
                <span class="info-label">SocialBuzz Token</span>
                <span class="info-value">
                    <span class="badge ${game.socialbuzzToken ? 'badge-success' : 'badge-warning'}">
                        ${game.socialbuzzToken ? '✓ Configured' : '⚠ Optional'}
                    </span>
                </span>
            </div>
        </div>
        
        <div class="card">
            <h3>🔗 Webhook URLs</h3>
            <p style="color: #94a3b8; font-size: 13px; margin-bottom: 20px;">
                Gunakan URL berikut di settings Saweria dan SocialBuzz. Klik "Copy" untuk menyalin.
            </p>
            
            <div class="url-box">
                <div class="url-label">
                    <span>📡 Saweria Webhook</span>
                    <button class="btn" onclick="copyUrl('saweriaUrl')">📋 Copy</button>
                </div>
                <div class="url-text" id="saweriaUrl">${baseUrl}/${game.webhookSecret}/saweria</div>
            </div>
            
            <div class="url-box">
                <div class="url-label">
                    <span>📡 SocialBuzz Webhook</span>
                    <button class="btn" onclick="copyUrl('socialbuzzUrl')">📋 Copy</button>
                </div>
                <div class="url-text" id="socialbuzzUrl">${baseUrl}/${game.webhookSecret}/socialbuzz</div>
            </div>
            
            <div class="url-box">
                <div class="url-label">
                    <span>🧪 Test Endpoint</span>
                    <button class="btn" onclick="copyUrl('testUrl')">📋 Copy</button>
                </div>
                <div class="url-text" id="testUrl">${baseUrl}/${game.webhookSecret}/test?password=${encodeURIComponent(password)}</div>
            </div>
        </div>
        
        <div class="card">
            <h3>💡 Quick Tips</h3>
            <div style="color: #94a3b8; font-size: 14px; line-height: 1.8;">
                <p>• Donatur format: <code style="color: #10b981;">[RobloxUsername] Message</code></p>
                <p>• Alternatif: <code style="color: #10b981;">@RobloxUsername Message</code></p>
                <p>• Alternatif: <code style="color: #10b981;">RobloxUsername: Message</code></p>
                <p>• Alternatif: <code style="color: #10b981;">RobloxUsername (tanpa format khusus)</code></p>
                <p>• Webhook secret minimal 16 karakter</p>
                <p>• Token verification otomatis jika di-set</p>
                <p>• Jangan share webhook URLs ke siapapun</p>
                <p>• Gunakan tombol "Change Password" untuk ganti password</p>
            </div>
        </div>
    </div>
    
    <script>
        const currentPassword = '${password}';
        
        function openChangePasswordModal() {
            document.getElementById('changePasswordModal').classList.add('active');
            document.getElementById('currentPassword').focus();
        }
        
        function closeModal() {
            document.getElementById('changePasswordModal').classList.remove('active');
            document.getElementById('changePasswordForm').reset();
        }
        
        document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const currentPwd = document.getElementById('currentPassword').value;
            const newPwd = document.getElementById('newPassword').value;
            const confirmPwd = document.getElementById('confirmPassword').value;
            
            if (newPwd !== confirmPwd) {
                showToast('Passwords do not match', 'error');
                return;
            }
            
            if (newPwd.length < 6) {
                showToast('Password must be at least 6 characters', 'error');
                return;
            }
            
            try {
                const response = await fetch('/api/user/change-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        currentPassword: currentPwd,
                        newPassword: newPwd
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showToast('Password changed successfully! Redirecting...', 'success');
                    setTimeout(() => {
                        window.location.href = '/dashboard?password=' + encodeURIComponent(newPwd);
                    }, 2000);
                } else {
                    showToast(data.error || 'Failed to change password', 'error');
                }
            } catch (error) {
                showToast('Connection error. Please try again.', 'error');
            }
        });
        
        function copyUrl(elementId) {
            const element = document.getElementById(elementId);
            const text = element.textContent;
            
            navigator.clipboard.writeText(text).then(() => {
                showToast('URL copied to clipboard!', 'success');
            }).catch(() => {
                const tempInput = document.createElement('input');
                tempInput.value = text;
                document.body.appendChild(tempInput);
                tempInput.select();
                document.execCommand('copy');
                document.body.removeChild(tempInput);
                showToast('URL copied to clipboard!', 'success');
            });
        }
        
        function showToast(message, type = 'success') {
            const toastId = type === 'success' ? 'successToast' : 'errorToast';
            const toast = document.getElementById(toastId);
            toast.textContent = message;
            toast.style.display = 'block';
            setTimeout(() => {
                toast.style.display = 'none';
            }, 3000);
        }
        
        // Close modal on outside click
        document.getElementById('changePasswordModal').addEventListener('click', (e) => {
            if (e.target.id === 'changePasswordModal') {
                closeModal();
            }
        });
    </script>
</body>
</html>`;
    res.send(html);
});

// 📊 Admin Dashboard
app.get('/admin/dashboard', async (req, res) => {
    const token = req.query.token;
    
    if (!token) {
        return res.redirect('/');
    }
    
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [username, password] = decoded.split(':');
        
        if (!authenticateAdmin(username, password)) {
            return res.redirect('/');
        }
    } catch (error) {
        return res.redirect('/');
    }
    
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Dashboard - Archie Webhook</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', system-ui, sans-serif;
            background: #0a0e27;
            color: #ffffff;
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header {
            background: linear-gradient(135deg, rgba(139, 92, 246, 0.2), rgba(59, 130, 246, 0.2));
            border: 1px solid rgba(139, 92, 246, 0.3);
            border-radius: 20px;
            padding: 32px;
            margin-bottom: 32px;
            backdrop-filter: blur(10px);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 16px;
        }
        .header-left h1 {
            font-size: 32px;
            margin-bottom: 8px;
            background: linear-gradient(135deg, #8b5cf6, #3b82f6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .header-left p { color: #94a3b8; font-size: 14px; }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 32px;
        }
        .stat-card {
            background: rgba(15, 23, 42, 0.8);
            border: 1px solid rgba(139, 92, 246, 0.2);
            border-radius: 16px;
            padding: 24px;
            backdrop-filter: blur(10px);
        }
        .stat-card h3 {
            color: #94a3b8;
            font-size: 14px;
            margin-bottom: 12px;
            font-weight: 500;
        }
        .stat-card .value {
            font-size: 36px;
            font-weight: 700;
            background: linear-gradient(135deg, #8b5cf6, #3b82f6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .card {
            background: rgba(15, 23, 42, 0.8);
            border: 1px solid rgba(139, 92, 246, 0.2);
            border-radius: 16px;
            padding: 28px;
            margin-bottom: 24px;
            backdrop-filter: blur(10px);
        }
        .card h2 {
            color: #8b5cf6;
            font-size: 24px;
            margin-bottom: 24px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .table-container {
            overflow-x: auto;
        }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        thead {
            background: rgba(139, 92, 246, 0.1);
        }
        th, td {
            padding: 16px;
            text-align: left;
            border-bottom: 1px solid rgba(139, 92, 246, 0.1);
        }
        th {
            color: #8b5cf6;
            font-weight: 600;
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        td {
            color: #cbd5e1;
            font-size: 14px;
        }
        tbody tr {
            transition: background 0.2s;
        }
        tbody tr:hover {
            background: rgba(139, 92, 246, 0.05);
        }
        .badge {
            display: inline-block;
            padding: 6px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
        }
        .badge-success {
            background: rgba(16, 185, 129, 0.2);
            color: #10b981;
            border: 1px solid rgba(16, 185, 129, 0.3);
        }
        .badge-active {
            background: rgba(59, 130, 246, 0.2);
            color: #3b82f6;
            border: 1px solid rgba(59, 130, 246, 0.3);
        }
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: linear-gradient(135deg, #8b5cf6, #3b82f6);
            color: white;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(139, 92, 246, 0.4);
        }
        .btn-danger {
            background: linear-gradient(135deg, #ef4444, #dc2626);
        }
        .btn-secondary {
            background: rgba(139, 92, 246, 0.2);
            border: 1px solid rgba(139, 92, 246, 0.4);
        }
        .success-toast, .error-toast {
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 16px 24px;
            border-radius: 12px;
            font-weight: 600;
            display: none;
            animation: slideIn 0.3s ease-out;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 1000;
        }
        .success-toast {
            background: rgba(16, 185, 129, 0.9);
            color: white;
        }
        .error-toast {
            background: rgba(239, 68, 68, 0.9);
            color: white;
        }
        @keyframes slideIn {
            from { transform: translateX(400px); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            backdrop-filter: blur(5px);
            z-index: 1000;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .modal.active {
            display: flex;
        }
        .modal-content {
            background: rgba(15, 23, 42, 0.95);
            border: 1px solid rgba(139, 92, 246, 0.3);
            border-radius: 20px;
            padding: 32px;
            max-width: 500px;
            width: 100%;
            animation: modalFadeIn 0.3s ease-out;
        }
        @keyframes modalFadeIn {
            from { opacity: 0; transform: scale(0.9); }
            to { opacity: 1; transform: scale(1); }
        }
        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 24px;
        }
        .modal-header h2 {
            color: #8b5cf6;
            font-size: 24px;
        }
        .close-btn {
            background: none;
            border: none;
            color: #94a3b8;
            font-size: 24px;
            cursor: pointer;
            padding: 0;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 8px;
            transition: all 0.3s;
        }
        .close-btn:hover {
            background: rgba(139, 92, 246, 0.2);
            color: #8b5cf6;
        }
        .form-group {
            margin-bottom: 20px;
        }
        .form-group label {
            display: block;
            color: #cbd5e1;
            font-size: 14px;
            font-weight: 500;
            margin-bottom: 8px;
        }
        .form-group input {
            width: 100%;
            padding: 12px 16px;
            background: rgba(15, 23, 42, 0.6);
            border: 2px solid rgba(139, 92, 246, 0.2);
            border-radius: 10px;
            color: #ffffff;
            font-size: 15px;
            transition: all 0.3s;
            outline: none;
        }
        .form-group input:focus {
            border-color: #8b5cf6;
            background: rgba(15, 23, 42, 0.9);
        }
        .modal-footer {
            display: flex;
            gap: 12px;
            justify-content: flex-end;
            margin-top: 24px;
        }
        .loading {
            display: inline-block;
            width: 16px;
            height: 16px;
            border: 2px solid rgba(255,255,255,0.3);
            border-top-color: #fff;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="success-toast" id="successToast"></div>
    <div class="error-toast" id="errorToast"></div>
    
    <!-- Reset Password Modal -->
    <div class="modal" id="resetPasswordModal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>🔐 Reset Password</h2>
                <button class="close-btn" onclick="closeModal()">&times;</button>
            </div>
            <form id="resetPasswordForm">
                <input type="hidden" id="resetGameId">
                <div class="form-group">
                    <label>Game Name</label>
                    <input type="text" id="resetGameName" readonly style="opacity: 0.7;">
                </div>
                <div class="form-group">
                    <label>New Password</label>
                    <input type="text" id="resetNewPassword" minlength="6" required placeholder="Enter new password">
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                    <button type="submit" class="btn btn-danger">Reset Password</button>
                </div>
            </form>
        </div>
    </div>
    
    <div class="container">
        <div class="header">
            <div class="header-left">
                <h1>🔐 Admin Dashboard</h1>
                <p>User Management & System Overview</p>
            </div>
            <button class="btn" onclick="window.location.href='/'">🚪 Logout</button>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <h3>Total Users</h3>
                <div class="value" id="totalUsers">0</div>
            </div>
            <div class="stat-card">
                <h3>Active Games</h3>
                <div class="value" id="activeGames">0</div>
            </div>
            <div class="stat-card">
                <h3>System Status</h3>
                <div class="value" style="font-size: 24px;">🟢 Online</div>
            </div>
        </div>
        
        <div class="card">
            <h2>👥 User Management</h2>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Game ID</th>
                            <th>Game Name</th>
                            <th>Universe ID</th>
                            <th>Last Active</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody id="usersTableBody">
                        <tr>
                            <td colspan="6" style="text-align: center; padding: 40px;">
                                <div class="loading"></div>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>
    
    <script>
        const token = '${token}';
        
        async function loadUsers() {
            try {
                const response = await fetch('/api/admin/users?token=' + encodeURIComponent(token));
                const data = await response.json();
                
                if (data.success) {
                    const users = data.users;
                    document.getElementById('totalUsers').textContent = users.length;
                    document.getElementById('activeGames').textContent = users.length;
                    
                    const tbody = document.getElementById('usersTableBody');
                    tbody.innerHTML = '';
                    
                    if (users.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: #64748b;">No users found</td></tr>';
                        return;
                    }
                    
                    users.forEach(user => {
                        const lastActive = user.lastActive ? new Date(user.lastActive).toLocaleString() : 'Never';
                        const tr = document.createElement('tr');
                        tr.innerHTML = \`
                            <td><span class="badge badge-active">\${user.id}</span></td>
                            <td><strong>\${user.name}</strong></td>
                            <td style="font-family: monospace; font-size: 12px;">\${user.universeId}</td>
                            <td style="font-size: 12px;">\${lastActive}</td>
                            <td><span class="badge badge-success">✓ Active</span></td>
                            <td>
                                <button class="btn btn-danger" onclick="openResetModal('\${user.id}', '\${user.name}')">
                                    🔑 Reset Password
                                </button>
                            </td>
                        \`;
                        tbody.appendChild(tr);
                    });
                }
            } catch (error) {
                console.error('Error loading users:', error);
                showToast('Failed to load users', 'error');
            }
        }
        
        function openResetModal(gameId, gameName) {
            document.getElementById('resetGameId').value = gameId;
            document.getElementById('resetGameName').value = gameName;
            document.getElementById('resetNewPassword').value = '';
            document.getElementById('resetPasswordModal').classList.add('active');
            document.getElementById('resetNewPassword').focus();
        }
        
        function closeModal() {
            document.getElementById('resetPasswordModal').classList.remove('active');
            document.getElementById('resetPasswordForm').reset();
        }
        
        document.getElementById('resetPasswordForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const gameId = document.getElementById('resetGameId').value;
            const newPassword = document.getElementById('resetNewPassword').value;
            
            if (newPassword.length < 6) {
                showToast('Password must be at least 6 characters', 'error');
                return;
            }
            
            try {
                const response = await fetch('/api/admin/reset-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token: token,
                        gameId: gameId,
                        newPassword: newPassword
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showToast('Password reset successfully!', 'success');
                    closeModal();
                    loadUsers(); // Reload users
                } else {
                    showToast(data.error || 'Failed to reset password', 'error');
                }
            } catch (error) {
                showToast('Connection error. Please try again.', 'error');
            }
        });
        
        function showToast(message, type = 'success') {
            const toastId = type === 'success' ? 'successToast' : 'errorToast';
            const toast = document.getElementById(toastId);
            toast.textContent = message;
            toast.style.display = 'block';
            setTimeout(() => {
                toast.style.display = 'none';
            }, 3000);
        }
        
        // Close modal on outside click
        document.getElementById('resetPasswordModal').addEventListener('click', (e) => {
            if (e.target.id === 'resetPasswordModal') {
                closeModal();
            }
        });
        
        // Load users on page load
        loadUsers();
        
        // Auto refresh every 30 seconds
        setInterval(loadUsers, 30000);
    </script>
</body>
</html>`;
    res.send(html);
});

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Start
app.listen(port, () => {
    console.log(`✅ Server running on port ${port}`);
    console.log(`🎮 Configured games: ${GAMES.map(g => g.name).join(', ')}`);
    const db = readDB();
    console.log(`👑 Admin username: ${db.admin.username}`);
});
