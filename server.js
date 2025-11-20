const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ verify: (req, res, buf, encoding) => {
    if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf8');
    }
}}));

// 🎮 KONFIGURASI MULTIPLE GAMES - SETIAP GAME PUNYA API KEY SENDIRI
const GAMES = [
    {
        id: 'game1',
        name: process.env.GAME_1_NAME || 'Game 1',
        universeId: process.env.GAME_1_UNIVERSE_ID,
        apiKey: process.env.GAME_1_API_KEY,
        topic: process.env.GAME_1_TOPIC || 'ArchieDonationIDR'
    },
    {
        id: 'game2',
        name: process.env.GAME_2_NAME || 'Game 2',
        universeId: process.env.GAME_2_UNIVERSE_ID,
        apiKey: process.env.GAME_2_API_KEY,
        topic: process.env.GAME_2_TOPIC || 'ArchieDonationIDR'
    },
    {
        id: 'game3',
        name: process.env.GAME_3_NAME || 'Game 3',
        universeId: process.env.GAME_3_UNIVERSE_ID,
        apiKey: process.env.GAME_3_API_KEY,
        topic: process.env.GAME_3_TOPIC || 'ArchieDonationIDR'
    },
    {
        id: 'game4',
        name: process.env.GAME_4_NAME || 'Game 4',
        universeId: process.env.GAME_4_UNIVERSE_ID,
        apiKey: process.env.GAME_4_API_KEY,
        topic: process.env.GAME_4_TOPIC || 'ArchieDonationIDR'
    },
    {
        id: 'game5',
        name: process.env.GAME_5_NAME || 'Game 5',
        universeId: process.env.GAME_5_UNIVERSE_ID,
        apiKey: process.env.GAME_5_API_KEY,
        topic: process.env.GAME_5_TOPIC || 'ArchieDonationIDR'
    }
].filter(game => game.universeId && game.apiKey);

// Validasi minimal 1 game terkonfigurasi
if (GAMES.length === 0) {
    console.error('❌ Minimal 1 game harus dikonfigurasi dengan lengkap!');
    console.error('   Set environment variables:');
    console.error('   GAME_1_NAME=My Game Name');
    console.error('   GAME_1_UNIVERSE_ID=1234567890');
    console.error('   GAME_1_API_KEY=your_api_key_here');
    console.error('   GAME_1_TOPIC=ArchieDonationIDR (optional)');
    process.exit(1);
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎮 Archie Donation IDR Webhook - Multi Game Mode');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📋 Configured Games:', GAMES.length);
GAMES.forEach((game, index) => {
    console.log(`\n  🎮 ${game.name} (${game.id}):`);
    console.log(`     Universe ID: ${game.universeId}`);
    console.log(`     API Key: ${game.apiKey.substring(0, 8)}...****`);
    console.log(`     Topic: ${game.topic}`);
});
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ✅ Helper: Extract username
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

// ✅ Helper: Format Rupiah
function formatRupiah(amount) {
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0
    }).format(amount);
}

// ✅ Helper: Send ke Roblox (menggunakan API key per game)
async function sendToRoblox(game, donationData) {
    const apiUrl = `https://apis.roblox.com/messaging-service/v1/universes/${game.universeId}/topics/${encodeURIComponent(game.topic)}`;
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📤 Sending to Roblox:');
    console.log(`  • Game: ${game.name}`);
    console.log(`  • Universe: ${game.universeId}`);
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
                    'x-api-key': game.apiKey // ⭐ Menggunakan API key per game
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

// 🔧 Dynamic Route Generator
function createWebhookEndpoints() {
    GAMES.forEach(game => {
        // 📥 Saweria Webhook untuk game ini
        app.post(`/${game.id}/saweria-webhook`, async (req, res) => {
            console.log(`\n📩 [${game.name.toUpperCase()}] [SAWERIA] Webhook received`);
            
            const payload = req.body;
            
            if (!payload || payload.type !== 'donation') {
                return res.status(200).json({ 
                    success: true, 
                    message: 'OK - Ignored non-donation event',
                    game: game.name
                });
            }
            
            const donatorName = payload.donator_name || 'Anonymous';
            const amountRaw = payload.amount_raw || 0;
            const message = payload.message || '';
            
            const robloxUsername = extractUsername(message, donatorName);
            
            const donationData = {
                username: robloxUsername,
                displayName: donatorName,
                amount: Math.floor(amountRaw),
                timestamp: Math.floor(Date.now() / 1000),
                source: 'Saweria',
                message: message,
                email: payload.donator_email || ''
            };
            
            try {
                const result = await sendToRoblox(game, donationData);
                return res.status(200).json({
                    success: true,
                    message: 'Saweria donation processed',
                    game: game.name,
                    data: {
                        username: robloxUsername,
                        amount: amountRaw,
                        source: 'Saweria'
                    },
                    robloxResponse: result.data
                });
            } catch (error) {
                return res.status(500).json({
                    success: false,
                    error: 'Failed to forward to Roblox',
                    game: game.name,
                    details: error.response?.data || error.message
                });
            }
        });
        
        // 📥 SocialBuzz Webhook untuk game ini
        app.post(`/${game.id}/socialbuzz-webhook`, async (req, res) => {
            console.log(`\n📩 [${game.name.toUpperCase()}] [SOCIALBUZZ] Webhook received`);
            
            const payload = req.body;
            
            if (!payload) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Payload tidak ditemukan',
                    game: game.name
                });
            }
            
            const donatorName = payload.supporter_name || payload.name || payload.donator_name || 'Anonymous';
            const amountRaw = payload.amount || payload.donation_amount || payload.amount_raw || 0;
            const message = payload.message || payload.supporter_message || payload.note || '';
            
            const robloxUsername = extractUsername(message, donatorName);
            
            const donationData = {
                username: robloxUsername,
                displayName: donatorName,
                amount: Math.floor(amountRaw),
                timestamp: Math.floor(Date.now() / 1000),
                source: 'SocialBuzz',
                message: message,
                email: payload.supporter_email || payload.email || ''
            };
            
            try {
                const result = await sendToRoblox(game, donationData);
                return res.status(200).json({
                    success: true,
                    message: 'SocialBuzz donation processed',
                    game: game.name,
                    data: {
                        username: robloxUsername,
                        amount: amountRaw,
                        source: 'SocialBuzz'
                    },
                    robloxResponse: result.data
                });
            } catch (error) {
                return res.status(500).json({
                    success: false,
                    error: 'Failed to forward to Roblox',
                    game: game.name,
                    details: error.response?.data || error.message
                });
            }
        });
        
        console.log(`✅ Endpoints created for ${game.name}:`);
        console.log(`   • /${game.id}/saweria-webhook`);
        console.log(`   • /${game.id}/socialbuzz-webhook`);
    });
}

// Generate all endpoints
createWebhookEndpoints();

// 🏥 Health check
app.get('/', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    const endpoints = {};
    GAMES.forEach(game => {
        endpoints[game.name] = {
            saweria: `${baseUrl}/${game.id}/saweria-webhook`,
            socialbuzz: `${baseUrl}/${game.id}/socialbuzz-webhook`
        };
    });
    
    res.json({
        status: 'online',
        service: 'Archie Donation IDR Webhook - Multi Game',
        version: '1.0.0',
        games: GAMES.map(g => ({
            id: g.id,
            name: g.name,
            universeId: g.universeId,
            hasConfig: !!(g.universeId && g.apiKey)
        })),
        endpoints: endpoints,
        usage: {
            format: 'Send donation message with format: [RobloxUsername] Your message',
            saweria: `POST /{gameId}/saweria-webhook`,
            socialbuzz: `POST /{gameId}/socialbuzz-webhook`
        }
    });
});

// 🧪 Test endpoint
app.post('/:gameId/test', async (req, res) => {
    const gameId = req.params.gameId;
    const game = GAMES.find(g => g.id === gameId);
    
    if (!game) {
        return res.status(404).json({
            success: false,
            error: 'Game not found',
            availableGames: GAMES.map(g => g.id)
        });
    }
    
    console.log(`\n🧪 [TEST] ${game.name}`);
    
    const testPayload = {
        username: req.body.username || 'TestUser123',
        displayName: req.body.displayName || 'Test Donator',
        amount: parseInt(req.body.amount) || 25000,
        timestamp: Math.floor(Date.now() / 1000),
        source: req.body.source || 'Test',
        message: req.body.message || 'Test donation from Archie Webhook'
    };
    
    try {
        const result = await sendToRoblox(game, testPayload);
        res.json({
            success: true,
            message: 'Test donation sent successfully',
            game: game.name,
            status: result.status,
            sentPayload: testPayload,
            robloxResponse: result.data
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Test failed',
            game: game.name,
            message: error.response?.data || error.message,
            sentPayload: testPayload
        });
    }
});

// 🔍 Debug endpoint
app.get('/debug', (req, res) => {
    res.json({
        server: 'Archie Donation IDR Webhook - Multi Game',
        version: '1.0.0',
        configuration: {
            gamesConfigured: GAMES.length
        },
        games: GAMES.map(g => ({
            id: g.id,
            name: g.name,
            universeId: g.universeId,
            hasApiKey: !!g.apiKey,
            apiKeyPrefix: g.apiKey ? g.apiKey.substring(0, 8) + '...' : '❌ NOT SET',
            topic: g.topic
        })),
        environment: {
            nodeVersion: process.version,
            platform: process.platform,
            uptime: Math.floor(process.uptime()),
            memory: {
                rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
                heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`
            }
        }
    });
});

// 404 handler
app.use((req, res) => {
    const availableEndpoints = {};
    GAMES.forEach(game => {
        availableEndpoints[game.id] = {
            saweria: `/${game.id}/saweria-webhook`,
            socialbuzz: `/${game.id}/socialbuzz-webhook`,
            test: `/${game.id}/test`
        };
    });
    
    res.status(404).json({
        error: 'Endpoint not found',
        availableGames: GAMES.map(g => g.id),
        endpoints: availableEndpoints,
        general: {
            root: '/',
            debug: '/debug'
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

// ▶️ Start server
app.listen(port, () => {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Archie Donation IDR Webhook (Multi Game) Running!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🌐 Port: ${port}\n`);
    
    GAMES.forEach(game => {
        console.log(`🎮 ${game.name} (${game.id}):`);
        console.log(`   📡 Saweria:    http://localhost:${port}/${game.id}/saweria-webhook`);
        console.log(`   📡 SocialBuzz: http://localhost:${port}/${game.id}/socialbuzz-webhook`);
        console.log(`   🧪 Test:       http://localhost:${port}/${game.id}/test\n`);
    });
    
    console.log('📊 General:');
    console.log(`   🏠 Home:  http://localhost:${port}/`);
    console.log(`   🔍 Debug: http://localhost:${port}/debug`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
