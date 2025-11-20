const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ verify: (req, res, buf, encoding) => {
    if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf8');
    }
}}));
app.use(express.urlencoded({ extended: true }));

// 🎮 GAMES CONFIG - Each game has unique PASSWORD
const GAMES = [
    {
        id: 'game1',
        name: process.env.GAME_1_NAME || 'Game 1',
        universeId: process.env.GAME_1_UNIVERSE_ID,
        apiKey: process.env.GAME_1_API_KEY,
        topic: process.env.GAME_1_TOPIC || 'ArchieDonationIDR',
        webhookSecret: process.env.GAME_1_WEBHOOK_SECRET,
        password: process.env.GAME_1_PASSWORD,
        saweriaToken: process.env.GAME_1_SAWERIA_TOKEN,
        socialbuzzToken: process.env.GAME_1_SOCIALBUZZ_TOKEN
    },
    {
        id: 'game2',
        name: process.env.GAME_2_NAME || 'Game 2',
        universeId: process.env.GAME_2_UNIVERSE_ID,
        apiKey: process.env.GAME_2_API_KEY,
        topic: process.env.GAME_2_TOPIC || 'ArchieDonationIDR',
        webhookSecret: process.env.GAME_2_WEBHOOK_SECRET,
        password: process.env.GAME_2_PASSWORD,
        saweriaToken: process.env.GAME_2_SAWERIA_TOKEN,
        socialbuzzToken: process.env.GAME_2_SOCIALBUZZ_TOKEN
    },
    {
        id: 'game3',
        name: process.env.GAME_3_NAME || 'Game 3',
        universeId: process.env.GAME_3_UNIVERSE_ID,
        apiKey: process.env.GAME_3_API_KEY,
        topic: process.env.GAME_3_TOPIC || 'ArchieDonationIDR',
        webhookSecret: process.env.GAME_3_WEBHOOK_SECRET,
        password: process.env.GAME_3_PASSWORD,
        saweriaToken: process.env.GAME_3_SAWERIA_TOKEN,
        socialbuzzToken: process.env.GAME_3_SOCIALBUZZ_TOKEN
    }
].filter(game => game.universeId && game.apiKey && game.webhookSecret && game.password);

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

// 🔐 Auth Helper
function authenticateGame(password) {
    return GAMES.find(game => game.password && game.password === password);
}

// Helper Functions
function verifyWebhookToken(req, expectedToken) {
    if (!expectedToken) return true;
    const token = req.headers['x-webhook-token'] || req.headers['authorization']?.replace('Bearer ', '') || req.body?.token;
    return token === expectedToken;
}

function extractUsername(message, donatorName) {
    if (!message) return donatorName;
    const bracketMatch = message.match(/^\[(\w+)\]/);
    if (bracketMatch) return bracketMatch[1];
    const atMatch = message.match(/^@(\w+)/);
    if (atMatch) return atMatch[1];
    const colonMatch = message.match(/^(\w+):/);
    if (colonMatch) return colonMatch[1];
    return donatorName;
}

function formatRupiah(amount) {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(amount);
}

// ✨ UPDATED: Enhanced error logging
async function sendToRoblox(game, donationData) {
    const apiUrl = `https://apis.roblox.com/messaging-service/v1/universes/${game.universeId}/topics/${encodeURIComponent(game.topic)}`;
    console.log(`📤 [${game.name}] Sending ${formatRupiah(donationData.amount)} for ${donationData.username}`);
    console.log(`🔗 API URL: ${apiUrl}`);
    console.log(`🔑 API Key: ${game.apiKey.substring(0, 30)}...`);
    console.log(`📋 Topic: ${game.topic}`);
    
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
        return { success: true, status: response.status, data: response.data };
    } catch (error) {
        console.error(`❌ [${game.name}] Failed to send to Roblox`);
        
        if (error.response) {
            // Server responded with error status
            console.error('📛 Response Status:', error.response.status);
            console.error('📛 Response Data:', JSON.stringify(error.response.data, null, 2));
            console.error('📛 Response Headers:', JSON.stringify(error.response.headers, null, 2));
        } else if (error.request) {
            // Request made but no response
            console.error('📛 No response received from Roblox API');
            console.error('📛 Request details:', error.message);
        } else {
            // Error in request setup
            console.error('📛 Error setting up request:', error.message);
        }
        
        console.error('📛 Full error:', error.toString());
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
        console.log(`📦 Payload:`, JSON.stringify(payload, null, 2));
        
        if (!payload || payload.type !== 'donation') {
            console.log(`ℹ️ [${game.name}] Not a donation event, skipping`);
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
        
        console.log(`💰 Donation data:`, JSON.stringify(donationData, null, 2));
        
        try {
            await sendToRoblox(game, donationData);
            console.log(`✅ [${game.name}] Webhook processed successfully`);
            return res.status(200).json({ success: true, message: 'Processed' });
        } catch (error) {
            console.error(`❌ [${game.name}] Webhook processing failed:`, error.message);
            return res.status(500).json({ success: false, error: 'Failed' });
        }
    });
    
    // SocialBuzz
    app.post(`/${game.webhookSecret}/socialbuzz`, async (req, res) => {
        console.log(`\n📩 [${game.name}] SocialBuzz webhook received`);
        
        if (game.socialbuzzToken && !verifyWebhookToken(req, game.socialbuzzToken)) {
            console.log(`❌ [${game.name}] Unauthorized - Invalid token`);
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        const payload = req.body;
        console.log(`📦 Payload:`, JSON.stringify(payload, null, 2));
        
        if (!payload) {
            console.log(`❌ [${game.name}] No payload received`);
            return res.status(400).json({ success: false, error: 'No payload' });
        }
        
        const donationData = {
            username: extractUsername(
                payload.message || payload.supporter_message || payload.note || '',
                payload.supporter_name || payload.name || 'Anonymous'
            ),
            displayName: payload.supporter_name || payload.name || 'Anonymous',
            amount: Math.floor(payload.amount || payload.donation_amount || 0),
            timestamp: Math.floor(Date.now() / 1000),
            source: 'SocialBuzz',
            message: payload.message || payload.supporter_message || payload.note || '',
            email: payload.supporter_email || payload.email || ''
        };
        
        console.log(`💰 Donation data:`, JSON.stringify(donationData, null, 2));
        
        try {
            await sendToRoblox(game, donationData);
            console.log(`✅ [${game.name}] Webhook processed successfully`);
            return res.status(200).json({ success: true, message: 'Processed' });
        } catch (error) {
            console.error(`❌ [${game.name}] Webhook processing failed:`, error.message);
            return res.status(500).json({ success: false, error: 'Failed' });
        }
    });
    
    // Test Endpoint
    app.post(`/${game.webhookSecret}/test`, async (req, res) => {
        const password = req.query.password || req.body?.password;
        const authGame = authenticateGame(password);
        
        if (!authGame || authGame.id !== game.id) {
            console.log(`❌ Test endpoint - Unauthorized attempt`);
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
        
        console.log(`💰 Test data:`, JSON.stringify(testPayload, null, 2));
        
        try {
            await sendToRoblox(game, testPayload);
            console.log(`✅ Test completed successfully`);
            res.json({ success: true, message: 'Test sent', game: game.name });
        } catch (error) {
            console.error(`❌ Test failed:`, error.message);
            res.status(500).json({ success: false, error: 'Test failed', details: error.message });
        }
    });
});

// 🏠 Homepage - Futuristic Login UI
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
        
        input[type="password"] {
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
        
        input[type="password"]:focus {
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
        
        @media (max-width: 480px) {
            .login-box {
                padding: 36px 28px;
            }
            h1 { font-size: 24px; }
            .logo-icon { width: 64px; height: 64px; font-size: 32px; }
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
            
            <form id="loginForm">
                <div class="form-group">
                    <label for="password">Access Password</label>
                    <div class="input-wrapper">
                        <input type="password" id="password" placeholder="Enter your password" autocomplete="off" required>
                        <span class="input-icon">🔐</span>
                    </div>
                </div>
                
                <button type="submit" id="loginBtn">
                    <span id="btnText">Access Dashboard</span>
                    <div class="loader" id="loader"></div>
                </button>
                
                <div class="error" id="error">Invalid password. Please try again.</div>
            </form>
            
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
        const form = document.getElementById('loginForm');
        const passwordInput = document.getElementById('password');
        const loginBtn = document.getElementById('loginBtn');
        const btnText = document.getElementById('btnText');
        const loader = document.getElementById('loader');
        const error = document.getElementById('error');
        
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = passwordInput.value.trim();
            
            if (!password) return;
            
            btnText.style.display = 'none';
            loader.style.display = 'block';
            loginBtn.disabled = true;
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
                    passwordInput.value = '';
                    passwordInput.focus();
                }
            } catch (err) {
                error.style.display = 'block';
                error.textContent = 'Connection error. Please try again.';
            } finally {
                btnText.style.display = 'block';
                loader.style.display = 'none';
                loginBtn.disabled = false;
            }
        });
        
        passwordInput.focus();
    </script>
</body>
</html>`;
    res.send(html);
});

// 🔐 API: Auth
app.post('/api/auth', (req, res) => {
    const { password } = req.body;
    const game = authenticateGame(password);
    
    if (game) {
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

// 📊 Dashboard
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
        }
        .header h1 {
            font-size: 32px;
            margin-bottom: 8px;
            background: linear-gradient(135deg, #8b5cf6, #3b82f6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .header p { color: #94a3b8; font-size: 14px; }
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
        .btn:active { transform: translateY(0); }
        
        .success-toast {
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(16, 185, 129, 0.9);
            color: white;
            padding: 16px 24px;
            border-radius: 12px;
            font-weight: 600;
            display: none;
            animation: slideIn 0.3s ease-out;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 1000;
        }
        @keyframes slideIn {
            from { transform: translateX(400px); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        
        .footer {
            text-align: center;
            padding: 32px 0;
            color: #64748b;
            font-size: 14px;
        }
        .discord-link {
            color: #8b5cf6;
            text-decoration: none;
            font-weight: 500;
        }
        .discord-link:hover { text-decoration: underline; }
        
        @media (max-width: 768px) {
            .header { padding: 24px; }
            .header h1 { font-size: 24px; }
            .card { padding: 20px; }
            .url-text { font-size: 11px; }
        }
    </style>
</head>
<body>
    <div class="success-toast" id="toast">✓ Copied to clipboard!</div>
    
    <div class="container">
        <div class="header">
            <h1>🎮 ${game.name}</h1>
            <p>Webhook Integration Dashboard</p>
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
                    <span class="badge ${game.webhookSecret ? 'badge-success' : 'badge-warning'}">
                        ${game.webhookSecret ? '✓ Configured' : '⚠ Not Set in Railway'}
                    </span>
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
                <div class="url-text" id="saweriaUrl">${baseUrl}/${game.webhookSecret || 'SET_WEBHOOK_SECRET_IN_RAILWAY'}/saweria</div>
            </div>
            
            <div class="url-box">
                <div class="url-label">
                    <span>📡 SocialBuzz Webhook</span>
                    <button class="btn" onclick="copyUrl('socialbuzzUrl')">📋 Copy</button>
                </div>
                <div class="url-text" id="socialbuzzUrl">${baseUrl}/${game.webhookSecret || 'SET_WEBHOOK_SECRET_IN_RAILWAY'}/socialbuzz</div>
            </div>
            
            <div class="url-box">
                <div class="url-label">
                    <span>🧪 Test Endpoint</span>
                    <button class="btn" onclick="copyUrl('testUrl')">📋 Copy</button>
                </div>
                <div class="url-text" id="testUrl">${baseUrl}/${game.webhookSecret || 'SET_WEBHOOK_SECRET_IN_RAILWAY'}/test?password=${encodeURIComponent(password)}</div>
            </div>
        </div>
        
        <div class="card">
            <h3>⚙️ Railway Variables</h3>
            <div style="color: #94a3b8; font-size: 14px; line-height: 1.8;">
                <p style="margin-bottom: 12px;">Pastikan variables berikut sudah di-set di Railway:</p>
                <p>• <code style="color: #8b5cf6;">GAME_${game.id.slice(-1)}_WEBHOOK_SECRET</code> = random string (contoh: med9082xyz8513abc)</p>
                <p>• <code style="color: #8b5cf6;">GAME_${game.id.slice(-1)}_SAWERIA_TOKEN</code> = token dari Saweria (optional)</p>
                <p>• <code style="color: #8b5cf6;">GAME_${game.id.slice(-1)}_SOCIALBUZZ_TOKEN</code> = token dari SocialBuzz (optional)</p>
            </div>
        </div>
        
        <div class="card">
            <h3>💡 Quick Tips</h3>
            <div style="color: #94a3b8; font-size: 14px; line-height: 1.8;">
                <p>• Donatur format: <code style="color: #10b981;">[RobloxUsername] Message</code></p>
                <p>• Webhook secret minimal 16 karakter</p>
                <p>• Token verification otomatis jika di-set</p>
                <p>• Jangan share webhook URLs ke siapapun</p>
            </div>
        </div>
        
        <div class="footer">
            <p>Archie Webhook Integration • Made with 💜</p>
            <p style="margin-top: 8px;">
                Need help? <a href="https://discord.com/users/wispray" target="_blank" class="discord-link">Contact on Discord</a>
            </p>
        </div>
    </div>
    
    <script>
        function copyUrl(elementId) {
            const element = document.getElementById(elementId);
            const text = element.textContent;
            
            if (text.includes('SET_WEBHOOK_SECRET_IN_RAILWAY')) {
                showToast('⚠ Set WEBHOOK_SECRET in Railway first!');
                return;
            }
            
            navigator.clipboard.writeText(text).then(() => {
                showToast('✓ URL copied to clipboard!');
            }).catch(() => {
                const tempInput = document.createElement('input');
                tempInput.value = text;
                document.body.appendChild(tempInput);
                tempInput.select();
                document.execCommand('copy');
                document.body.removeChild(tempInput);
                showToast('✓ URL copied to clipboard!');
            });
        }
        
        function showToast(message) {
            const toast = document.getElementById('toast');
            toast.textContent = message;
            toast.style.display = 'block';
            setTimeout(() => {
                toast.style.display = 'none';
            }, 2000);
        }
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
});
