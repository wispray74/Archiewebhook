const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ verify: (req, res, buf, encoding) => {
    if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf8');
    }
}}));
app.use(express.urlencoded({ extended: true }));

// 📁 Database file paths
const DB_FILE = path.join(__dirname, 'users.json');
const LICENSE_FILE = path.join(__dirname, 'licenses.json');

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

// 🔐 License System Functions
function readLicenses() {
    try {
        if (!fs.existsSync(LICENSE_FILE)) {
            const initialData = {
                licenses: {},
                scriptVersion: "1.0.0",
                forceUpdate: false
            };
            fs.writeFileSync(LICENSE_FILE, JSON.stringify(initialData, null, 2));
            return initialData;
        }
        return JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
    } catch (error) {
        console.error('❌ Error reading licenses:', error);
        return { licenses: {}, scriptVersion: "1.0.0", forceUpdate: false };
    }
}

function writeLicenses(data) {
    try {
        fs.writeFileSync(LICENSE_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('❌ Error writing licenses:', error);
        return false;
    }
}

function generateLicenseKey() {
    const prefix = 'MUSIC';
    const random1 = crypto.randomBytes(4).toString('hex').toUpperCase();
    const random2 = crypto.randomBytes(4).toString('hex').toUpperCase();
    const random3 = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}-${random1}-${random2}-${random3}`;
}

// 🎮 Initialize games from environment variables and database
function initializeGames() {
    const db = readDB();
    const envGames = [
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
console.log('🔐 License system: ACTIVE');

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

// ============================================
// 🔐 LICENSE SYSTEM ENDPOINTS (NEW)
// ============================================

// Verify License (Called from Roblox)
app.post('/api/license/verify', (req, res) => {
    const { licenseKey, universeId, placeId } = req.body;
    
    if (!licenseKey || !universeId) {
        return res.status(400).json({ 
            valid: false, 
            error: 'Missing parameters',
            forceStop: true 
        });
    }
    
    const licensesData = readLicenses();
    const license = licensesData.licenses[licenseKey];
    
    if (!license) {
        console.log(`❌ Invalid license: ${licenseKey} from Universe ${universeId}`);
        return res.status(401).json({ 
            valid: false, 
            error: 'Invalid license key',
            forceStop: true 
        });
    }
    
    if (!license.active) {
        console.log(`⚠️ Disabled license: ${licenseKey}`);
        return res.status(401).json({ 
            valid: false, 
            error: 'License has been disabled',
            forceStop: true 
        });
    }
    
    if (license.expiryDate) {
        const expiryDate = new Date(license.expiryDate);
        if (expiryDate < new Date()) {
            console.log(`⏰ Expired license: ${licenseKey}`);
            return res.status(401).json({ 
                valid: false, 
                error: 'License has expired',
                forceStop: true 
            });
        }
    }
    
    // HWID Lock
    if (!license.universeId) {
        license.universeId = universeId;
        license.firstActivation = new Date().toISOString();
        writeLicenses(licensesData);
        console.log(`🔒 License ${licenseKey} locked to Universe ${universeId}`);
    }
    
    if (license.universeId !== universeId) {
        console.log(`🚫 HWID mismatch: ${licenseKey} | Expected: ${license.universeId} | Got: ${universeId}`);
        return res.status(401).json({ 
            valid: false, 
            error: 'License already used in another game',
            forceStop: true 
        });
    }
    
    license.lastVerified = new Date().toISOString();
    license.verificationCount = (license.verificationCount || 0) + 1;
    if (placeId) {
        license.placeId = placeId;
    }
    writeLicenses(licensesData);
    
    res.json({ 
        valid: true,
        owner: license.owner,
        expiryDate: license.expiryDate || null,
        scriptVersion: licensesData.scriptVersion,
        forceUpdate: licensesData.forceUpdate || false,
        message: 'License verified successfully'
    });
});

// Check for updates
app.get('/api/script/version', (req, res) => {
    const licensesData = readLicenses();
    res.json({
        version: licensesData.scriptVersion,
        forceUpdate: licensesData.forceUpdate || false,
        updateMessage: licensesData.updateMessage || 'New update available'
    });
});

// ============================================
// 🔐 ADMIN LICENSE MANAGEMENT (NEW)
// ============================================

// Get all licenses
app.get('/api/admin/licenses', (req, res) => {
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
        
        const licensesData = readLicenses();
        const licenses = Object.entries(licensesData.licenses).map(([key, data]) => ({
            licenseKey: key,
            ...data
        }));
        
        res.json({ 
            success: true, 
            licenses,
            scriptVersion: licensesData.scriptVersion,
            forceUpdate: licensesData.forceUpdate
        });
    } catch (error) {
        res.status(401).json({ success: false, error: 'Invalid token' });
    }
});

// Create new license
app.post('/api/admin/licenses/create', (req, res) => {
    const { token, owner, expiryDays, notes } = req.body;
    
    if (!token) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [username, password] = decoded.split(':');
        
        if (!authenticateAdmin(username, password)) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        const licenseKey = generateLicenseKey();
        const licensesData = readLicenses();
        
        let expiryDate = null;
        if (expiryDays && expiryDays > 0) {
            expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + parseInt(expiryDays));
            expiryDate = expiryDate.toISOString();
        }
        
        licensesData.licenses[licenseKey] = {
            owner: owner || 'Unknown',
            active: true,
            createdAt: new Date().toISOString(),
            expiryDate: expiryDate,
            universeId: null,
            placeId: null,
            firstActivation: null,
            lastVerified: null,
            verificationCount: 0,
            notes: notes || ''
        };
        
        writeLicenses(licensesData);
        
        console.log(`✅ New license created: ${licenseKey} for ${owner}`);
        
        res.json({ 
            success: true, 
            licenseKey,
            message: 'License created successfully'
        });
    } catch (error) {
        res.status(401).json({ success: false, error: 'Invalid token' });
    }
});

// Toggle license active status
app.post('/api/admin/licenses/toggle', (req, res) => {
    const { token, licenseKey } = req.body;
    
    if (!token) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [username, password] = decoded.split(':');
        
        if (!authenticateAdmin(username, password)) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        const licensesData = readLicenses();
        
        if (!licensesData.licenses[licenseKey]) {
            return res.json({ success: false, error: 'License not found' });
        }
        
        licensesData.licenses[licenseKey].active = !licensesData.licenses[licenseKey].active;
        writeLicenses(licensesData);
        
        const status = licensesData.licenses[licenseKey].active ? 'enabled' : 'disabled';
        console.log(`🔄 License ${licenseKey} ${status}`);
        
        res.json({ 
            success: true,
            active: licensesData.licenses[licenseKey].active,
            message: `License ${status} successfully`
        });
    } catch (error) {
        res.status(401).json({ success: false, error: 'Invalid token' });
    }
});

// Delete license
app.post('/api/admin/licenses/delete', (req, res) => {
    const { token, licenseKey } = req.body;
    
    if (!token) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [username, password] = decoded.split(':');
        
        if (!authenticateAdmin(username, password)) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        const licensesData = readLicenses();
        
        if (!licensesData.licenses[licenseKey]) {
            return res.json({ success: false, error: 'License not found' });
        }
        
        delete licensesData.licenses[licenseKey];
        writeLicenses(licensesData);
        
        console.log(`🗑️ License deleted: ${licenseKey}`);
        
        res.json({ 
            success: true,
            message: 'License deleted successfully'
        });
    } catch (error) {
        res.status(401).json({ success: false, error: 'Invalid token' });
    }
});

// Update script version
app.post('/api/admin/version/update', (req, res) => {
    const { token, version, forceUpdate, updateMessage } = req.body;
    
    if (!token) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [username, password] = decoded.split(':');
        
        if (!authenticateAdmin(username, password)) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        const licensesData = readLicenses();
        licensesData.scriptVersion = version;
        licensesData.forceUpdate = forceUpdate || false;
        licensesData.updateMessage = updateMessage || 'New update available';
        writeLicenses(licensesData);
        
        console.log(`📦 Script version updated to ${version}`);
        
        res.json({ 
            success: true,
            message: 'Version updated successfully'
        });
    } catch (error) {
        res.status(401).json({ success: false, error: 'Invalid token' });
    }
});

// Reset HWID for license
app.post('/api/admin/licenses/reset-hwid', (req, res) => {
    const { token, licenseKey } = req.body;
    
    if (!token) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [username, password] = decoded.split(':');
        
        if (!authenticateAdmin(username, password)) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        const licensesData = readLicenses();
        
        if (!licensesData.licenses[licenseKey]) {
            return res.json({ success: false, error: 'License not found' });
        }
        
        licensesData.licenses[licenseKey].universeId = null;
        licensesData.licenses[licenseKey].placeId = null;
        licensesData.licenses[licenseKey].firstActivation = null;
        writeLicenses(licensesData);
        
        console.log(`🔓 HWID reset for license: ${licenseKey}`);
        
        res.json({ 
            success: true,
            message: 'HWID reset successfully'
        });
    } catch (error) {
        res.status(401).json({ success: false, error: 'Invalid token' });
    }
});

// ============================================
// 🔧 ORIGINAL WEBHOOK ROUTES (UNCHANGED)
// ============================================

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
    
    // SocialBuzz
    app.post(`/${game.webhookSecret}/socialbuzz`, async (req, res) => {
        console.log(`\n📩 [${game.name}] SocialBuzz webhook received`);
        
        if (game.socialbuzzToken && !verifyWebhookToken(req, game.socialbuzzToken)) {
            console.log(`❌ [${game.name}] Unauthorized - Invalid token`);
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

// ============================================
// 🏠 ORIGINAL HOMEPAGE & APIs (UNCHANGED)
// ============================================

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
        }
        .container { max-width: 450px; width: 90%; }
        .login-box {
            background: rgba(15, 23, 42, 0.8);
            backdrop-filter: blur(20px);
            border: 1px solid rgba(139, 92, 246, 0.3);
            border-radius: 24px;
            padding: 48px 40px;
        }
        h1 { color: #8b5cf6; font-size: 28px; text-align: center; margin-bottom: 30px; }
        .tabs {
            display: flex;
            gap: 12px;
            margin-bottom: 30px;
        }
        .tab {
            flex: 1;
            padding: 12px;
            background: rgba(139, 92, 246, 0.1);
            border: 1px solid rgba(139, 92, 246, 0.2);
            border-radius: 12px;
            color: #94a3b8;
            font-weight: 600;
            cursor: pointer;
            text-align: center;
        }
        .tab.active {
            background: rgba(139, 92, 246, 0.2);
            border-color: #8b5cf6;
            color: #8b5cf6;
        }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .form-group { margin-bottom: 20px; }
        label { display: block; color: #cbd5e1; font-size: 14px; margin-bottom: 8px; }
        input {
            width: 100%;
            padding: 12px 16px;
            background: rgba(15, 23, 42, 0.6);
            border: 2px solid rgba(139, 92, 246, 0.2);
            border-radius: 10px;
            color: #ffffff;
            font-size: 15px;
            outline: none;
        }
        input:focus { border-color: #8b5cf6; }
        button {
            width: 100%;
            padding: 14px;
            background: linear-gradient(135deg, #8b5cf6, #3b82f6);
            border: none;
            border-radius: 10px;
            color: white;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
        }
        button:hover { transform: translateY(-2px); }
        .error {
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.3);
            color: #fca5a5;
            padding: 12px;
            border-radius: 8px;
            margin-top: 12px;
            display: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="login-box">
            <h1>🎮 Archie Webhook</h1>
            
            <div class="tabs">
                <div class="tab active" onclick="switchTab('user')">User</div>
                <div class="tab" onclick="switchTab('admin')">Admin</div>
            </div>
            
            <div id="userTab" class="tab-content active">
                <form id="userForm">
                    <div class="form-group">
                        <label>Password</label>
                        <input type="password" id="userPassword" required>
                    </div>
                    <button type="submit">Login</button>
                    <div class="error" id="userError">Invalid password</div>
                </form>
            </div>
            
            <div id="adminTab" class="tab-content">
                <form id="adminForm">
                    <div class="form-group">
                        <label>Username</label>
                        <input type="text" id="adminUsername" required>
                    </div>
                    <div class="form-group">
                        <label>Password</label>
                        <input type="password" id="adminPassword" required>
                    </div>
                    <button type="submit">Login Admin</button>
                    <div class="error" id="adminError">Invalid credentials</div>
                </form>
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
        
        document.getElementById('userForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = document.getElementById('userPassword').value;
            
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
                    document.getElementById('userError').style.display = 'block';
                }
            } catch (err) {
                document.getElementById('userError').style.display = 'block';
            }
        });
        
        document.getElementById('adminForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('adminUsername').value;
            const password = document.getElementById('adminPassword').value;
            
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
                    document.getElementById('adminError').style.display = 'block';
                }
            } catch (err) {
                document.getElementById('adminError').style.display = 'block';
            }
        });
    </script>
</body>
</html>`;
    res.send(html);
});

// User Auth
app.post('/api/auth', (req, res) => {
    const { password } = req.body;
    const game = authenticateGame(password);
    
    if (game) {
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

// Admin Auth
app.post('/api/admin/auth', (req, res) => {
    const { username, password } = req.body;
    
    if (authenticateAdmin(username, password)) {
        const token = Buffer.from(`${username}:${password}`).toString('base64');
        res.json({ success: true, token });
    } else {
        res.json({ success: false });
    }
});

// Change User Password
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
            GAMES = initializeGames();
            res.json({ success: true, message: 'Password changed successfully' });
        } else {
            res.json({ success: false, error: 'Failed to save password' });
        }
    } else {
        res.json({ success: false, error: 'Game not found' });
    }
});

// Admin Get Users
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

// Admin Reset User Password
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
            GAMES = initializeGames();
            res.json({ success: true, message: 'Password reset successfully' });
        } else {
            res.json({ success: false, error: 'Failed to save password' });
        }
    } catch (error) {
        res.status(401).json({ success: false, error: 'Invalid token' });
    }
});

// User Dashboard (Original - unchanged)
app.get('/dashboard', (req, res) => {
    const password = req.query.password;
    const game = authenticateGame(password);
    
    if (!game) {
        return res.redirect('/');
    }
    
    const baseUrl = `https://${req.get('host')}`;
    
    res.send(`[DASHBOARD HTML - Keep your original dashboard.html here]`);
});

// Admin Dashboard (NEW - with license management)
app.get('/admin/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-license.html'));
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
