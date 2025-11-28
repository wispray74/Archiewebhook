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

const DB_FILE = path.join(__dirname, 'users.json');
const LICENSE_FILE = path.join(__dirname, 'licenses.json');

function readDB() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            const initialData = {
                admin: { username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD || 'admin123' },
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

function readLicenses() {
    try {
        if (!fs.existsSync(LICENSE_FILE)) {
            const initialData = { licenses: {}, scriptVersion: "1.0.0", forceUpdate: false };
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
            saweriaToken: process.env.GAME_1_SAWERIA_TOKEN || '',
            socialbuzzToken: process.env.GAME_1_SOCIALBUZZ_TOKEN || '',
            musicLicenseKey: process.env.GAME_1_MUSIC_LICENSE || ''
        }
    ].filter(game => game.universeId && game.apiKey && game.webhookSecret && game.password);

    const mergedGames = [];
    for (const envGame of envGames) {
        const dbGame = db.games.find(g => g.id === envGame.id);
        if (dbGame) {
            mergedGames.push({
                ...envGame,
                password: dbGame.password || envGame.password,
                saweriaToken: dbGame.saweriaToken !== undefined ? dbGame.saweriaToken : envGame.saweriaToken,
                socialbuzzToken: dbGame.socialbuzzToken !== undefined ? dbGame.socialbuzzToken : envGame.socialbuzzToken,
                musicLicenseKey: dbGame.musicLicenseKey !== undefined ? dbGame.musicLicenseKey : envGame.musicLicenseKey,
                lastActive: dbGame.lastActive || new Date().toISOString(),
                createdAt: dbGame.createdAt || new Date().toISOString()
            });
        } else {
            mergedGames.push({
                ...envGame,
                lastActive: new Date().toISOString(),
                createdAt: new Date().toISOString()
            });
        }
    }

    db.games = mergedGames;
    writeDB(db);
    return mergedGames;
}

let GAMES = initializeGames();

if (GAMES.length === 0) {
    console.error('❌ No games configured!');
    process.exit(1);
}

console.log('🎮 Multi-Feature System - ' + GAMES.length + ' games configured');

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
        const response = await axios.post(apiUrl, { message: JSON.stringify(donationData) }, {
            headers: { 'Content-Type': 'application/json', 'x-api-key': game.apiKey },
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

// LICENSE VERIFICATION
app.post('/api/license/verify', (req, res) => {
    const { licenseKey, universeId, placeId } = req.body;
    
    if (!licenseKey || !universeId) {
        return res.status(400).json({ valid: false, error: 'Missing parameters', forceStop: true });
    }
    
    const licensesData = readLicenses();
    const license = licensesData.licenses[licenseKey];
    
    if (!license) {
        console.log(`❌ Invalid license: ${licenseKey}`);
        return res.status(401).json({ valid: false, error: 'Invalid license key', forceStop: true });
    }
    
    if (!license.active) {
        return res.status(401).json({ valid: false, error: 'License disabled', forceStop: true });
    }
    
    if (license.expiryDate && new Date(license.expiryDate) < new Date()) {
        return res.status(401).json({ valid: false, error: 'License expired', forceStop: true });
    }
    
    if (!license.universeId) {
        license.universeId = universeId;
        license.firstActivation = new Date().toISOString();
        writeLicenses(licensesData);
        console.log(`🔒 License ${licenseKey} locked to Universe ${universeId}`);
    }
    
    if (license.universeId !== universeId) {
        console.log(`🚫 HWID mismatch: ${licenseKey}`);
        return res.status(401).json({ valid: false, error: 'License already used in another game', forceStop: true });
    }
    
    license.lastVerified = new Date().toISOString();
    license.verificationCount = (license.verificationCount || 0) + 1;
    if (placeId) license.placeId = placeId;
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

app.get('/api/script/version', (req, res) => {
    const licensesData = readLicenses();
    res.json({
        version: licensesData.scriptVersion,
        forceUpdate: licensesData.forceUpdate || false,
        updateMessage: licensesData.updateMessage || 'New update available'
    });
});

// WEBHOOK ROUTES
GAMES.forEach(game => {
    app.post(`/${game.webhookSecret}/saweria`, async (req, res) => {
        console.log(`\n📩 [${game.name}] Saweria webhook received`);
        
        if (game.saweriaToken && !verifyWebhookToken(req, game.saweriaToken)) {
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
    
    app.post(`/${game.webhookSecret}/socialbuzz`, async (req, res) => {
        console.log(`\n📩 [${game.name}] SocialBuzz webhook received`);
        
        if (game.socialbuzzToken && !verifyWebhookToken(req, game.socialbuzzToken)) {
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
});

// USER APIS
app.post('/api/auth', (req, res) => {
    const { password } = req.body;
    const game = authenticateGame(password);
    res.json({ success: !!game });
});

app.get('/api/user/dashboard', (req, res) => {
    const password = req.query.password;
    const game = authenticateGame(password);
    
    if (!game) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    const baseUrl = `https://${req.get('host')}`;
    
    res.json({
        success: true,
        game: {
            id: game.id,
            name: game.name,
            universeId: game.universeId,
            topic: game.topic,
            webhookSecret: game.webhookSecret,
            saweriaToken: game.saweriaToken || '',
            socialbuzzToken: game.socialbuzzToken || '',
            musicLicenseKey: game.musicLicenseKey || ''
        },
        baseUrl: baseUrl
    });
});

app.get('/api/user/music-license', (req, res) => {
    const password = req.query.password;
    const game = authenticateGame(password);
    
    if (!game || !game.musicLicenseKey) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    const licensesData = readLicenses();
    const license = licensesData.licenses[game.musicLicenseKey];
    
    if (!license) {
        return res.json({ success: false, error: 'License not found' });
    }
    
    res.json({
        success: true,
        license: {
            owner: license.owner,
            active: license.active,
            universeId: license.universeId,
            placeId: license.placeId,
            expiryDate: license.expiryDate,
            lastVerified: license.lastVerified,
            verificationCount: license.verificationCount || 0
        }
    });
});

app.post('/api/user/reset-hwid', (req, res) => {
    const { password, licenseKey } = req.body;
    const game = authenticateGame(password);
    
    if (!game || game.musicLicenseKey !== licenseKey) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    const licensesData = readLicenses();
    const license = licensesData.licenses[licenseKey];
    
    if (!license) {
        return res.json({ success: false, error: 'License not found' });
    }
    
    license.universeId = null;
    license.placeId = null;
    license.firstActivation = null;
    
    if (writeLicenses(licensesData)) {
        console.log(`🔓 [USER] HWID reset: ${licenseKey}`);
        res.json({ success: true, message: 'HWID reset successfully' });
    } else {
        res.json({ success: false, error: 'Failed to save' });
    }
});

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

// ADMIN APIS
app.post('/api/admin/auth', (req, res) => {
    const { username, password } = req.body;
    
    if (authenticateAdmin(username, password)) {
        const token = Buffer.from(`${username}:${password}`).toString('base64');
        res.json({ success: true, token });
    } else {
        res.json({ success: false });
    }
});

app.get('/api/admin/licenses', (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(401).json({ success: false });
    
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [username, password] = decoded.split(':');
        
        if (!authenticateAdmin(username, password)) {
            return res.status(401).json({ success: false });
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
        res.status(401).json({ success: false });
    }
});

app.post('/api/admin/licenses/create', (req, res) => {
    const { token, owner, expiryDays, notes } = req.body;
    
    if (!token) return res.status(401).json({ success: false });
    
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [username, password] = decoded.split(':');
        
        if (!authenticateAdmin(username, password)) {
            return res.status(401).json({ success: false });
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
        console.log(`✅ License created: ${licenseKey}`);
        
        res.json({ success: true, licenseKey, message: 'License created' });
    } catch (error) {
        res.status(401).json({ success: false });
    }
});

app.post('/api/admin/licenses/toggle', (req, res) => {
    const { token, licenseKey } = req.body;
    
    if (!token) return res.status(401).json({ success: false });
    
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [username, password] = decoded.split(':');
        
        if (!authenticateAdmin(username, password)) {
            return res.status(401).json({ success: false });
        }
        
        const licensesData = readLicenses();
        
        if (!licensesData.licenses[licenseKey]) {
            return res.json({ success: false, error: 'License not found' });
        }
        
        licensesData.licenses[licenseKey].active = !licensesData.licenses[licenseKey].active;
        writeLicenses(licensesData);
        
        const status = licensesData.licenses[licenseKey].active ? 'enabled' : 'disabled';
        console.log(`🔄 License ${licenseKey} ${status}`);
        
        res.json({ success: true, active: licensesData.licenses[licenseKey].active, message: `License ${status}` });
    } catch (error) {
        res.status(401).json({ success: false });
    }
});

app.post('/api/admin/licenses/delete', (req, res) => {
    const { token, licenseKey } = req.body;
    
    if (!token) return res.status(401).json({ success: false });
    
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [username, password] = decoded.split(':');
        
        if (!authenticateAdmin(username, password)) {
            return res.status(401).json({ success: false });
        }
        
        const licensesData = readLicenses();
        
        if (!licensesData.licenses[licenseKey]) {
            return res.json({ success: false, error: 'License not found' });
        }
        
        delete licensesData.licenses[licenseKey];
        writeLicenses(licensesData);
        
        console.log(`🗑️ License deleted: ${licenseKey}`);
        res.json({ success: true, message: 'License deleted' });
    } catch (error) {
        res.status(401).json({ success: false });
    }
});

app.post('/api/admin/version/update', (req, res) => {
    const { token, version, forceUpdate, updateMessage } = req.body;
    
    if (!token) return res.status(401).json({ success: false });
    
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [username, password] = decoded.split(':');
        
        if (!authenticateAdmin(username, password)) {
            return res.status(401).json({ success: false });
        }
        
        const licensesData = readLicenses();
        licensesData.scriptVersion = version;
        licensesData.forceUpdate = forceUpdate || false;
        licensesData.updateMessage = updateMessage || 'New update available';
        writeLicenses(licensesData);
        
        console.log(`📦 Version updated: ${version}`);
        res.json({ success: true, message: 'Version updated' });
    } catch (error) {
        res.status(401).json({ success: false });
    }
});

app.post('/api/admin/licenses/reset-hwid', (req, res) => {
    const { token, licenseKey } = req.body;
    
    if (!token) return res.status(401).json({ success: false });
    
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [username, password] = decoded.split(':');
        
        if (!authenticateAdmin(username, password)) {
            return res.status(401).json({ success: false });
        }
        
        const licensesData = readLicenses();
        
        if (!licensesData.licenses[licenseKey]) {
            return res.json({ success: false, error: 'License not found' });
        }
        
        licensesData.licenses[licenseKey].universeId = null;
        licensesData.licenses[licenseKey].placeId = null;
        licensesData.licenses[licenseKey].firstActivation = null;
        writeLicenses(licensesData);
        
        console.log(`🔓 HWID reset: ${licenseKey}`);
        res.json({ success: true, message: 'HWID reset' });
    } catch (error) {
        res.status(401).json({ success: false });
    }
});

// HOMEPAGE
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// DASHBOARD
app.get('/dashboard', (req, res) => {
    const password = req.query.password;
    if (!authenticateGame(password)) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ADMIN DASHBOARD
app.get('/admin/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

app.listen(port, () => {
    console.log(`✅ Server running on port ${port}`);
    console.log(`🎮 Games: ${GAMES.map(g => g.name).join(', ')}`);
    console.log(`🔐 License system: ACTIVE`);
});
