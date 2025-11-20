const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json({ verify: (req, res, buf, encoding) => {
    if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf8');
    }
}}));

app.use(express.urlencoded({ extended: true }));

// 🔐 ADMIN PASSWORD untuk akses dashboard
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ArchieInHere';

// 🎮 KONFIGURASI MULTIPLE GAMES dengan SECRET WEBHOOK PATH
const GAMES = [
    {
        id: 'game1',
        name: process.env.GAME_1_NAME || 'Game 1',
        universeId: process.env.GAME_1_UNIVERSE_ID,
        apiKey: process.env.GAME_1_API_KEY,
        topic: process.env.GAME_1_TOPIC || 'ArchieDonationIDR',
        // 🔑 SECRET WEBHOOK PATH - Gunakan string random yang susah ditebak
        webhookSecret: process.env.GAME_1_WEBHOOK_SECRET || 'game1',
        saweriaToken: process.env.GAME_1_SAWERIA_TOKEN,
        socialbuzzToken: process.env.GAME_1_SOCIALBUZZ_TOKEN
    },
    {
        id: 'game2',
        name: process.env.GAME_2_NAME || 'Game 2',
        universeId: process.env.GAME_2_UNIVERSE_ID,
        apiKey: process.env.GAME_2_API_KEY,
        topic: process.env.GAME_2_TOPIC || 'ArchieDonationIDR',
        webhookSecret: process.env.GAME_2_WEBHOOK_SECRET || 'game2',
        saweriaToken: process.env.GAME_2_SAWERIA_TOKEN,
        socialbuzzToken: process.env.GAME_2_SOCIALBUZZ_TOKEN
    },
    {
        id: 'game3',
        name: process.env.GAME_3_NAME || 'Game 3',
        universeId: process.env.GAME_3_UNIVERSE_ID,
        apiKey: process.env.GAME_3_API_KEY,
        topic: process.env.GAME_3_TOPIC || 'ArchieDonationIDR',
        webhookSecret: process.env.GAME_3_WEBHOOK_SECRET || 'game3',
        saweriaToken: process.env.GAME_3_SAWERIA_TOKEN,
        socialbuzzToken: process.env.GAME_3_SOCIALBUZZ_TOKEN
    },
    {
        id: 'game4',
        name: process.env.GAME_4_NAME || 'Game 4',
        universeId: process.env.GAME_4_UNIVERSE_ID,
        apiKey: process.env.GAME_4_API_KEY,
        topic: process.env.GAME_4_TOPIC || 'ArchieDonationIDR',
        webhookSecret: process.env.GAME_4_WEBHOOK_SECRET || 'game4',
        saweriaToken: process.env.GAME_4_SAWERIA_TOKEN,
        socialbuzzToken: process.env.GAME_4_SOCIALBUZZ_TOKEN
    },
    {
        id: 'game5',
        name: process.env.GAME_5_NAME || 'Game 5',
        universeId: process.env.GAME_5_UNIVERSE_ID,
        apiKey: process.env.GAME_5_API_KEY,
        topic: process.env.GAME_5_TOPIC || 'ArchieDonationIDR',
        webhookSecret: process.env.GAME_5_WEBHOOK_SECRET || 'game5',
        saweriaToken: process.env.GAME_5_SAWERIA_TOKEN,
        socialbuzzToken: process.env.GAME_5_SOCIALBUZZ_TOKEN
    }
].filter(game => game.universeId && game.apiKey);

// Validasi
if (GAMES.length === 0) {
    console.error('❌ Minimal 1 game harus dikonfigurasi!');
    process.exit(1);
}

// Check for duplicate webhook secrets
const secrets = GAMES.map(g => g.webhookSecret);
const duplicates = secrets.filter((item, index) => secrets.indexOf(item) !== index);
if (duplicates.length > 0) {
    console.error('❌ Duplicate webhook secrets found:', duplicates);
    console.error('   Each game must have a unique GAME_X_WEBHOOK_SECRET!');
    process.exit(1);
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎮 Archie Donation IDR - Secure Multi Game');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📋 Configured Games:', GAMES.length);
GAMES.forEach((game) => {
    console.log(`\n  🎮 ${game.name}:`);
    console.log(`     Universe: ${game.universeId}`);
    console.log(`     🔑 Webhook Path: /${game.webhookSecret}/...`);
    console.log(`     🔐 Security: Saweria ${game.saweriaToken ? '✅' : '⚠️'} | SocialBuzz ${game.socialbuzzToken ? '✅' : '⚠️'}`);
});
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// 🔐 Auth Middleware
function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    const password = req.query.password || req.body?.password;
    
    if (authHeader) {
        const token = authHeader.replace('Bearer ', '').replace('Basic ', '');
        if (token === ADMIN_PASSWORD) {
            return next();
        }
    }
    
    if (password === ADMIN_PASSWORD) {
        return next();
    }
    
    res.status(401).json({
        error: 'Unauthorized',
        message: 'Valid password required',
        hint: 'Add ?password=your_password or use Authorization header'
    });
}

// Helper Functions
function verifyWebhookToken(req, expectedToken, platform) {
    if (!expectedToken) return true;
    
    const authHeader = req.headers['authorization'];
    const webhookToken = req.headers['x-webhook-token'];
    const customToken = req.headers['x-token'];
    const bearerToken = authHeader?.replace('Bearer ', '');
    const receivedToken = webhookToken || customToken || bearerToken || req.body?.token;
    
    if (!receivedToken) {
        console.log(`❌ ${platform} token not found`);
        return false;
    }
    
    const isValid = receivedToken === expectedToken;
    console.log(`🔐 ${platform} token: ${isValid ? '✅ Valid' : '❌ Invalid'}`);
    return isValid;
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
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0
    }).format(amount);
}

async function sendToRoblox(game, donationData) {
    const apiUrl = `https://apis.roblox.com/messaging-service/v1/universes/${game.universeId}/topics/${encodeURIComponent(game.topic)}`;
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📤 Sending to Roblox:');
    console.log(`  • Game: ${game.name}`);
    console.log(`  • Username: ${donationData.username}`);
    console.log(`  • Amount: ${formatRupiah(donationData.amount)}`);
    console.log(`  • Source: ${donationData.source}`);
    
    try {
        const response = await axios.post(
            apiUrl,
            { message: JSON.stringify(donationData) },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': game.apiKey
                },
                timeout: 10000
            }
        );
        
        console.log('✅ SUCCESS - Message sent to Roblox');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        
        return { success: true, status: response.status, data: response.data };
    } catch (error) {
        console.error('❌ FAILED - Could not send to Roblox');
        if (error.response) {
            console.error('  Status:', error.response.status);
            console.error('  Response:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('  Error:', error.message);
        }
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        throw error;
    }
}

// 🔧 Dynamic Routes with SECRET PATHS
function createWebhookEndpoints() {
    GAMES.forEach(game => {
        // Saweria Webhook
        app.post(`/${game.webhookSecret}/saweria`, async (req, res) => {
            console.log(`\n📩 [${game.name.toUpperCase()}] [SAWERIA] Webhook received`);
            
            if (game.saweriaToken && !verifyWebhookToken(req, game.saweriaToken, 'Saweria')) {
                return res.status(401).json({ success: false, error: 'Unauthorized' });
            }
            
            const payload = req.body;
            if (!payload || payload.type !== 'donation') {
                return res.status(200).json({ success: true, message: 'OK - Ignored' });
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
                const result = await sendToRoblox(game, donationData);
                return res.status(200).json({
                    success: true,
                    message: 'Processed',
                    data: { username: donationData.username, amount: donationData.amount }
                });
            } catch (error) {
                return res.status(500).json({
                    success: false,
                    error: 'Failed to forward',
                    details: error.response?.data || error.message
                });
            }
        });
        
        // SocialBuzz Webhook
        app.post(`/${game.webhookSecret}/socialbuzz`, async (req, res) => {
            console.log(`\n📩 [${game.name.toUpperCase()}] [SOCIALBUZZ] Webhook received`);
            
            if (game.socialbuzzToken && !verifyWebhookToken(req, game.socialbuzzToken, 'SocialBuzz')) {
                return res.status(401).json({ success: false, error: 'Unauthorized' });
            }
            
            const payload = req.body;
            if (!payload) {
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
            
            try {
                const result = await sendToRoblox(game, donationData);
                return res.status(200).json({
                    success: true,
                    message: 'Processed',
                    data: { username: donationData.username, amount: donationData.amount }
                });
            } catch (error) {
                return res.status(500).json({
                    success: false,
                    error: 'Failed to forward',
                    details: error.response?.data || error.message
                });
            }
        });
        
        // Test Endpoint (requires auth)
        app.post(`/${game.webhookSecret}/test`, requireAuth, async (req, res) => {
            console.log(`\n🧪 [TEST] ${game.name}`);
            
            const testPayload = {
                username: req.body.username || 'TestUser123',
                displayName: req.body.displayName || 'Test Donator',
                amount: parseInt(req.body.amount) || 25000,
                timestamp: Math.floor(Date.now() / 1000),
                source: req.body.source || 'Test',
                message: req.body.message || 'Test donation'
            };
            
            try {
                const result = await sendToRoblox(game, testPayload);
                res.json({
                    success: true,
                    message: 'Test sent successfully',
                    game: game.name,
                    sentPayload: testPayload
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: 'Test failed',
                    message: error.response?.data || error.message
                });
            }
        });
        
        console.log(`✅ Endpoints: /${game.webhookSecret}/*`);
    });
}

createWebhookEndpoints();

// 🏠 Beautiful Homepage
app.get('/', (req, res) => {
    const html = `
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Archie Donation Webhook - Secure Multi Game</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 800px;
            width: 100%;
            overflow: hidden;
        }
        
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
        }
        
        .header p {
            font-size: 1.1em;
            opacity: 0.9;
        }
        
        .status {
            display: inline-block;
            background: rgba(255,255,255,0.2);
            padding: 8px 20px;
            border-radius: 20px;
            margin-top: 15px;
            font-weight: bold;
        }
        
        .status.online {
            background: #10b981;
        }
        
        .content {
            padding: 40px;
        }
        
        .info-box {
            background: #f8fafc;
            border-left: 4px solid #667eea;
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 8px;
        }
        
        .info-box h3 {
            color: #667eea;
            margin-bottom: 10px;
            font-size: 1.2em;
        }
        
        .info-box p {
            color: #64748b;
            line-height: 1.6;
        }
        
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin: 30px 0;
        }
        
        .stat-card {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 25px;
            border-radius: 15px;
            text-align: center;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
        }
        
        .stat-card h2 {
            font-size: 2.5em;
            margin-bottom: 5px;
        }
        
        .stat-card p {
            opacity: 0.9;
            font-size: 0.9em;
        }
        
        .action-buttons {
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
            margin-top: 30px;
        }
        
        .btn {
            flex: 1;
            min-width: 150px;
            padding: 15px 30px;
            border: none;
            border-radius: 10px;
            font-size: 1em;
            font-weight: bold;
            cursor: pointer;
            text-decoration: none;
            text-align: center;
            transition: all 0.3s;
            display: inline-block;
        }
        
        .btn-primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        
        .btn-secondary {
            background: #f1f5f9;
            color: #475569;
        }
        
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0,0,0,0.2);
        }
        
        .footer {
            background: #f8fafc;
            padding: 20px;
            text-align: center;
            color: #64748b;
            font-size: 0.9em;
        }
        
        .security-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: #10b981;
            color: white;
            padding: 6px 15px;
            border-radius: 20px;
            font-size: 0.85em;
            font-weight: bold;
        }
        
        @media (max-width: 600px) {
            .header h1 { font-size: 1.8em; }
            .stats { grid-template-columns: 1fr; }
            .action-buttons { flex-direction: column; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎮 Archie Donation Webhook</h1>
            <p>Secure Multi-Game Donation System</p>
            <div class="status online">● ONLINE</div>
        </div>
        
        <div class="content">
            <div class="info-box">
                <h3>🔐 Secure Webhook Service</h3>
                <p>Protected webhook endpoints untuk menerima donasi dari Saweria & SocialBuzz, lalu mengirimkannya ke multiple Roblox games dengan aman.</p>
            </div>
            
            <div class="stats">
                <div class="stat-card">
                    <h2>${GAMES.length}</h2>
                    <p>Games Configured</p>
                </div>
                <div class="stat-card">
                    <h2>2</h2>
                    <p>Platforms Supported</p>
                </div>
                <div class="stat-card">
                    <h2>✓</h2>
                    <p>SSL Encrypted</p>
                </div>
            </div>
            
            <div class="info-box">
                <h3>✨ Features</h3>
                <p>
                    • 🔒 Password-protected dashboard<br>
                    • 🔑 Secret webhook paths untuk setiap game<br>
                    • 🛡️ Token verification untuk Saweria & SocialBuzz<br>
                    • 📊 Real-time monitoring & logs<br>
                    • 🚀 Auto username extraction dari donation message
                </p>
            </div>
            
            <div class="action-buttons">
                <a href="/dashboard" class="btn btn-primary">📊 Dashboard</a>
                <a href="/docs" class="btn btn-secondary">📖 Documentation</a>
            </div>
            
            <div style="margin-top: 30px; text-align: center;">
                <span class="security-badge">🔐 Protected by Password</span>
            </div>
        </div>
        
        <div class="footer">
            <p>Made with ❤️ for Roblox Developers • Version 2.0.0</p>
            <p style="margin-top: 8px; font-size: 0.85em;">Powered by Railway • ${new Date().getFullYear()}</p>
        </div>
    </div>
</body>
</html>
    `;
    res.send(html);
});

// 📊 Protected Dashboard
app.get('/dashboard', requireAuth, (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    const gamesHTML = GAMES.map(game => `
        <div class="game-card">
            <div class="game-header">
                <h3>🎮 ${game.name}</h3>
                <span class="badge ${game.apiKey ? 'badge-success' : 'badge-danger'}">
                    ${game.apiKey ? '✓ Active' : '✗ Inactive'}
                </span>
            </div>
            <div class="game-info">
                <p><strong>Universe ID:</strong> ${game.universeId}</p>
                <p><strong>Topic:</strong> ${game.topic}</p>
                <p><strong>Security:</strong></p>
                <ul>
                    <li>Saweria Token: ${game.saweriaToken ? '✅ Set' : '⚠️ Not Set'}</li>
                    <li>SocialBuzz Token: ${game.socialbuzzToken ? '✅ Set' : '⚠️ Not Set'}</li>
                </ul>
            </div>
            <div class="webhook-urls">
                <h4>🔗 Webhook URLs:</h4>
                <div class="url-box">
                    <strong>Saweria:</strong>
                    <code>${baseUrl}/${game.webhookSecret}/saweria</code>
                </div>
                <div class="url-box">
                    <strong>SocialBuzz:</strong>
                    <code>${baseUrl}/${game.webhookSecret}/socialbuzz</code>
                </div>
                <div class="url-box">
                    <strong>Test:</strong>
                    <code>${baseUrl}/${game.webhookSecret}/test?password=${ADMIN_PASSWORD}</code>
                </div>
            </div>
        </div>
    `).join('');
    
    const html = `
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dashboard - Archie Donation Webhook</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #f1f5f9;
            padding: 20px;
        }
        .navbar {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px 40px;
            border-radius: 15px;
            margin-bottom: 30px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .navbar h1 { font-size: 1.8em; }
        .navbar a {
            color: white;
            text-decoration: none;
            background: rgba(255,255,255,0.2);
            padding: 8px 20px;
            border-radius: 8px;
            transition: all 0.3s;
        }
        .navbar a:hover {
            background: rgba(255,255,255,0.3);
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        .game-card {
            background: white;
            border-radius: 15px;
            padding: 30px;
            margin-bottom: 25px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .game-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 2px solid #e2e8f0;
        }
        .game-header h3 {
            font-size: 1.5em;
            color: #1e293b;
        }
        .badge {
            padding: 6px 15px;
            border-radius: 20px;
            font-size: 0.85em;
            font-weight: bold;
        }
        .badge-success {
            background: #10b981;
            color: white;
        }
        .badge-danger {
            background: #ef4444;
            color: white;
        }
        .game-info {
            margin-bottom: 20px;
        }
        .game-info p {
            margin: 8px 0;
            color: #475569;
        }
        .game-info ul {
            margin-left: 20px;
            margin-top: 8px;
        }
        .game-info li {
            color: #64748b;
            margin: 5px 0;
        }
        .webhook-urls {
            background: #f8fafc;
            padding: 20px;
            border-radius: 10px;
            margin-top: 20px;
        }
        .webhook-urls h4 {
            color: #667eea;
            margin-bottom: 15px;
        }
        .url-box {
            background: white;
            padding: 12px;
            border-radius: 8px;
            margin: 10px 0;
            border-left: 3px solid #667eea;
        }
        .url-box strong {
            display: block;
            color: #475569;
            margin-bottom: 5px;
            font-size: 0.9em;
        }
        .url-box code {
            display: block;
            background: #1e293b;
            color: #10b981;
            padding: 10px;
            border-radius: 5px;
            font-size: 0.85em;
            overflow-x: auto;
            white-space: nowrap;
        }
        .warning-box {
            background: #fef3c7;
            border-left: 4px solid #f59e0b;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 25px;
            color: #92400e;
        }
        .warning-box strong {
            display: block;
            margin-bottom: 5px;
            font-size: 1.1em;
        }
        @media (max-width: 600px) {
            .navbar {
                flex-direction: column;
                gap: 15px;
            }
            .game-header {
                flex-direction: column;
                align-items: flex-start;
                gap: 10px;
            }
        }
    </style>
</head>
<body>
    <div class="navbar">
        <h1>📊 Dashboard</h1>
        <a href="/">← Back to Home</a>
    </div>
    
    <div class="container">
        <div class="warning-box">
            <strong>🔐 Security Notice</strong>
            Jangan share webhook URLs atau password ke siapapun! Webhook paths menggunakan secret key yang hanya Anda yang tahu.
        </div>
        
        ${gamesHTML}
    </div>
</body>
</html>
    `;
    res.send(html);
});

// 📖 Documentation
app.get('/docs', (req, res) => {
    const html = `
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Documentation - Archie Donation Webhook</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #f1f5f9;
            padding: 20px;
        }
        .navbar {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px 40px;
            border-radius: 15px;
            margin-bottom: 30px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .navbar h1 { font-size: 1.8em; }
        .navbar a {
            color: white;
            text-decoration: none;
            background: rgba(255,255,255,0.2);
            padding: 8px 20px;
            border-radius: 8px;
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
            background: white;
            border-radius: 15px;
            padding: 40px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h2 {
            color: #667eea;
            margin: 30px 0 15px;
            padding-bottom: 10px;
            border-bottom: 2px solid #e2e8f0;
        }
        h3 {
            color: #475569;
            margin: 20px 0 10px;
        }
        p, li {
            color: #64748b;
            line-height: 1.8;
            margin: 10px 0;
        }
        code {
            background: #1e293b;
            color: #10b981;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 0.9em;
        }
        pre {
            background: #1e293b;
            color: #10b981;
            padding: 20px;
            border-radius: 10px;
            overflow-x: auto;
            margin: 15px 0;
        }
        .note {
            background: #dbeafe;
            border-left: 4px solid #3b82f6;
            padding: 15px;
            margin: 15px 0;
            border-radius: 8px;
        }
        .warning {
            background: #fef3c7;
            border-left: 4px solid #f59e0b;
            padding: 15px;
            margin: 15px 0;
            border-radius: 8px;
        }
    </style>
</head>
<body>
    <div class="navbar">
        <h1>📖 Documentation</h1>
        <a href="/">← Back to Home</a>
    </div>
    
    <div class="container">
        <h2>🚀 Getting Started</h2>
        <p>Webhook system ini menerima donasi dari Saweria & SocialBuzz, lalu mengirimkannya ke Roblox game Anda via Messaging Service API.</p>
        
        <h2>🔐 Security Features</h2>
        <ul>
            <li><strong>Secret Webhook Paths:</strong> Setiap game punya path unik yang susah ditebak</li>
            <li><strong>Token Verification:</strong> Verify setiap request dari Saweria/SocialBuzz</li>
            <li><strong>Password Protection:</strong> Dashboard hanya bisa diakses dengan password</li>
            <li><strong>HTTPS Only:</strong> Semua traffic ter-enkripsi</li>
        </ul>
        
        <h2>📝 Format Donasi</h2>
        <p>Donatur bisa menulis Roblox username dengan format:</p>
        <pre>[RobloxUsername] Your message
@RobloxUsername Thank you!
RobloxUsername: Keep it up!</pre>
        <p>Jika tidak ada format di atas, sistem akan pakai nama donatur sebagai username.</p>
        
        <h2>🔗 Webhook URLs</h2>
        <p>Setiap game punya webhook URL dengan format:</p>
        <pre>https://your-domain.com/{SECRET_KEY}/saweria
https://your-domain.com/{SECRET_KEY}/socialbuzz</pre>
        
        <div class="warning">
            <strong>⚠️ Important:</strong> {SECRET_KEY} adalah GAME_X_WEBHOOK_SECRET yang Anda set di environment variables. Jangan share ke siapapun!
        </div>
        
        <h2>🧪 Testing</h2>
        <h3>Manual Test:</h3>
        <pre>curl -X POST https://your-domain.com/{SECRET_KEY}/test?password=your_password \\
  -H "Content-Type: application/json" \\
  -d '{"username":"TestPlayer","amount":50000}'</pre>
        
        <h2>📊 Access Dashboard</h2>
        <p>Dashboard URL:</p>
        <pre>https://your-domain.com/dashboard?password=your_password</pre>
        
        <div class="note">
            <strong>💡 Tip:</strong> Password bisa diset di environment variable <code>ADMIN_PASSWORD</code>
        </div>
        
        <h2>🎮 Roblox Script</h2>
        <pre>local MessagingService = game:GetService("MessagingService")
local TOPIC = "ArchieDonationIDR"

MessagingService:SubscribeAsync(TOPIC, function(message)
    local data = game:GetService("HttpService"):JSONDecode(message.Data)
    
    print("💰 Donasi diterima!")
    print("Username:", data.username)
    print("Amount:", data.amount)
    print("Source:", data.source)
    
    -- Your reward logic here
end)</pre>
        
        <h2>🔧 Environment Variables</h2>
        <p>Required variables untuk setiap game:</p>
        <pre>GAME_1_NAME=My Game Name
GAME_1_UNIVERSE_ID=1234567890
GAME_1_API_KEY=rbx-api-key-xxxxx
GAME_1_WEBHOOK_SECRET=abc123xyz789secret  ← IMPORTANT!
GAME_1_SAWERIA_TOKEN=saweria_token_here (optional)
GAME_1_SOCIALBUZZ_TOKEN=sbwhook-xxxxx (optional)

ADMIN_PASSWORD=your_secure_password_here</pre>
        
        <h2>💡 Best Practices</h2>
        <ul>
            <li>Gunakan webhook secret yang panjang dan random (minimal 16 karakter)</li>
            <li>Set webhook tokens untuk Saweria & SocialBuzz</li>
            <li>Ganti ADMIN_PASSWORD dari default</li>
            <li>Monitor Railway logs secara berkala</li>
            <li>Jangan commit .env file ke Git</li>
        </ul>
    </div>
</body>
</html>
    `;
    res.send(html);
});

// 🔍 Debug endpoint (protected)
app.get('/debug', requireAuth, (req, res) => {
    res.json({
        server: 'Archie Donation IDR Webhook - Secure',
        version: '2.0.0',
        timestamp: new Date().toISOString(),
        configuration: {
            gamesConfigured: GAMES.length,
            adminPasswordSet: ADMIN_PASSWORD !== 'changeme123'
        },
        games: GAMES.map(g => ({
            id: g.id,
            name: g.name,
            universeId: g.universeId,
            webhookPath: `/${g.webhookSecret}/*`,
            hasApiKey: !!g.apiKey,
            security: {
                saweriaToken: !!g.saweriaToken,
                socialbuzzToken: !!g.socialbuzzToken
            }
        })),
        environment: {
            nodeVersion: process.version,
            platform: process.platform,
            uptime: `${Math.floor(process.uptime())} seconds`,
            memory: {
                rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
                heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`
            }
        }
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        message: 'This endpoint does not exist or requires authentication',
        availableEndpoints: {
            public: ['/', '/docs'],
            protected: ['/dashboard', '/debug'],
            webhooks: '/{SECRET_KEY}/saweria or /{SECRET_KEY}/socialbuzz'
        }
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message
    });
});

// Start server
app.listen(port, () => {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Archie Donation IDR Webhook (Secure) Running!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🌐 Port: ${port}`);
    console.log(`🔐 Admin Password: ${ADMIN_PASSWORD === 'changeme123' ? '⚠️ DEFAULT (CHANGE IT!)' : '✅ Custom'}`);
    console.log(`📅 Started: ${new Date().toISOString()}\n`);
    console.log('📊 Access dashboard: /dashboard?password=your_password');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
