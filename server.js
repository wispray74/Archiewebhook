const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const pool    = require('./db');

const app  = express();
const port = process.env.PORT || 3000;

app.use(express.json({ verify: (req, _res, buf, encoding) => {
    if (buf && buf.length) req.rawBody = buf.toString(encoding || 'utf8');
}}));
app.use(express.urlencoded({ extended: true }));

const VOLUME_PATH = process.env.VOLUME_PATH || __dirname;
const DB_FILE     = path.join(VOLUME_PATH, 'users.json');

if (process.env.VOLUME_PATH && !fs.existsSync(VOLUME_PATH))
    fs.mkdirSync(VOLUME_PATH, { recursive: true });

function readDB() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            const init = { admin: { username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD || 'admin123' }, games: [] };
            fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
            return init;
        }
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch { return { admin: { username: 'admin', password: 'admin123' }, games: [] }; }
}
function writeDB(data) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); return true; } catch { return false; }
}

async function dbGetPassword(gameId) {
    const { rows } = await pool.query('SELECT password FROM game_passwords WHERE game_id = $1', [gameId]);
    return rows[0]?.password || null;
}
async function dbSetPassword(gameId, password) {
    await pool.query(`
        INSERT INTO game_passwords (game_id, password, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (game_id) DO UPDATE SET password = $2, updated_at = NOW()
    `, [gameId, password]);
}

async function dbGetAllGames() {
    const { rows } = await pool.query('SELECT * FROM games ORDER BY created_at ASC');
    return rows.map(rowToGame);
}

async function dbGetGameBySecret(webhookSecret) {
    const { rows } = await pool.query('SELECT * FROM games WHERE webhook_secret = $1', [webhookSecret]);
    return rows[0] ? rowToGame(rows[0]) : null;
}

async function dbGetGameById(gameId) {
    const { rows } = await pool.query('SELECT * FROM games WHERE id = $1', [gameId]);
    return rows[0] ? rowToGame(rows[0]) : null;
}

async function dbAddGame(game) {
    await pool.query(`
        INSERT INTO games (id, name, universe_id, api_key, topic, webhook_secret, saweria_token, socialbuzz_token, discord_webhook_url)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [game.id, game.name, game.universeId, game.apiKey, game.topic, game.webhookSecret, game.saweriaToken || null, game.socialbuzzToken || null, game.discordWebhookUrl || null]);
}

async function dbUpdateGame(gameId, fields) {
    const sets = [];
    const params = [];
    let i = 1;
    const allowed = ['name','universe_id','api_key','topic','webhook_secret','saweria_token','socialbuzz_token','discord_webhook_url'];
    for (const [k, v] of Object.entries(fields)) {
        if (allowed.includes(k)) { sets.push(`${k} = $${i++}`); params.push(v); }
    }
    if (!sets.length) return;
    params.push(gameId);
    await pool.query(`UPDATE games SET ${sets.join(', ')} WHERE id = $${i}`, params);
}

async function dbDeleteGame(gameId) {
    await pool.query('DELETE FROM games WHERE id = $1', [gameId]);
    await pool.query('DELETE FROM game_passwords WHERE game_id = $1', [gameId]);
}

function rowToGame(row) {
    return {
        id:                 row.id,
        name:               row.name,
        universeId:         row.universe_id,
        apiKey:             row.api_key,
        topic:              row.topic || 'ArchieDonationIDR',
        webhookSecret:      row.webhook_secret,
        saweriaToken:       row.saweria_token || null,
        socialbuzzToken:    row.socialbuzz_token || null,
        discordWebhookUrl:  row.discord_webhook_url || null
    };
}

function generateGameId() {
    return 'game_' + Date.now().toString(36);
}

function generateSecret(name) {
    const clean = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return clean + '_' + Math.random().toString(36).slice(2, 8);
}

// Save donation to DB first, return the generated ID
async function dbSaveDonation(gameId, data) {
    const { rows } = await pool.query(`
        INSERT INTO donations (game_id, username, display_name, amount, source, message, email)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING id
    `, [gameId, data.username, data.displayName, data.amount, data.source, data.message, data.email]);
    return rows[0].id;
}

async function dbGetDonations(gameId, { limit = 50, offset = 0, search = '' } = {}) {
    let q = `SELECT * FROM donations WHERE game_id = $1`;
    const params = [gameId];
    if (search) { params.push(`%${search}%`); q += ` AND (username ILIKE $${params.length} OR display_name ILIKE $${params.length})`; }
    q += ` ORDER BY donated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const { rows } = await pool.query(q, params);
    return rows;
}

async function dbGetDonationStats(gameId) {
    const totals = await pool.query(`
        SELECT COUNT(*) AS total_donations, COALESCE(SUM(amount),0) AS total_amount, COUNT(DISTINCT username) AS unique_donors
        FROM donations WHERE game_id = $1
    `, [gameId]);
    const byUser = await pool.query(`
        SELECT username, display_name, COUNT(*) AS donation_count, SUM(amount) AS total_amount, MAX(donated_at) AS last_donation
        FROM donations WHERE game_id = $1
        GROUP BY username, display_name ORDER BY total_amount DESC LIMIT 20
    `, [gameId]);
    const recent7 = await pool.query(`
        SELECT DATE(donated_at) AS day, COUNT(*) AS donations, SUM(amount) AS amount
        FROM donations WHERE game_id = $1 AND donated_at >= NOW() - INTERVAL '7 days'
        GROUP BY day ORDER BY day ASC
    `, [gameId]);
    return { totals: totals.rows[0], byUser: byUser.rows, recent7: recent7.rows };
}

async function dbCountDonations(gameId, search = '') {
    let q = `SELECT COUNT(*) FROM donations WHERE game_id = $1`;
    const params = [gameId];
    if (search) { params.push(`%${search}%`); q += ` AND (username ILIKE $${params.length} OR display_name ILIKE $${params.length})`; }
    const { rows } = await pool.query(q, params);
    return parseInt(rows[0].count, 10);
}

function loadEnvGames() {
    const games = [];
    let i = 1;
    while (i <= 100) {
        const uid = process.env[`GAME_${i}_UNIVERSE_ID`];
        const key = process.env[`GAME_${i}_API_KEY`];
        const sec = process.env[`GAME_${i}_WEBHOOK_SECRET`];
        const pwd = process.env[`GAME_${i}_PASSWORD`];
        if (!uid || !key || !sec || !pwd) break;
        games.push({
            id:                `game${i}`,
            name:              process.env[`GAME_${i}_NAME`] || `Game ${i}`,
            universeId:        uid,
            apiKey:            key,
            topic:             process.env[`GAME_${i}_TOPIC`] || 'ArchieDonationIDR',
            webhookSecret:     sec,
            saweriaToken:      process.env[`GAME_${i}_SAWERIA_TOKEN`] || null,
            socialbuzzToken:   process.env[`GAME_${i}_SOCIALBUZZ_TOKEN`] || null,
            discordWebhookUrl: process.env[`GAME_${i}_DISCORD_WEBHOOK_URL`] || null,
            envPassword:       pwd
        });
        i++;
    }
    return games;
}

async function authenticateGame(password) {
    if (!password) return null;
    try {
        const { rows } = await pool.query(`
            SELECT g.*
            FROM games g
            JOIN game_passwords gp ON gp.game_id = g.id
            WHERE gp.password = $1
            LIMIT 1
        `, [password]);
        return rows[0] ? rowToGame(rows[0]) : null;
    } catch (e) {
        console.error('authenticateGame error:', e.message);
        return null;
    }
}

function authenticateAdmin(username, password) {
    const db = readDB();
    return db.admin.username === username && db.admin.password === password;
}

function adminFromToken(token) {
    try {
        const [u, p] = Buffer.from(token, 'base64').toString().split(':');
        return authenticateAdmin(u, p) ? { username: u } : null;
    } catch { return null; }
}

async function updateGameLastActive(gameId) {
    await pool.query(`UPDATE game_passwords SET updated_at = NOW() WHERE game_id = $1`, [gameId]).catch(() => {});
}

function verifyWebhookToken(req, expected) {
    if (!expected) return true;
    const t = req.headers['x-webhook-token'] || req.headers['authorization']?.replace('Bearer ','') || req.body?.token;
    return t === expected;
}

function extractUsername(message, donatorName) {
    if (!message || !message.trim()) return donatorName;
    const msg = message.trim();
    const br = msg.match(/^\[([^\]]+)\]/);  if (br?.[1]?.trim()) return br[1].trim();
    const at = msg.match(/^@([^\s]+)/);     if (at?.[1]?.trim()) return at[1].trim();
    const co = msg.match(/^([^\s:]+):/);    if (co?.[1]?.trim()) return co[1].trim();
    const fw = msg.split(/\s+/)[0];
    if (fw && fw.length >= 3 && fw.length <= 20 && /^[a-zA-Z0-9_]+$/.test(fw) && /[0-9_]/.test(fw)) return fw;
    return donatorName;
}

function formatRupiah(n) {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Discord Webhook
// ─────────────────────────────────────────────────────────────────────────────
const SOURCE_COLORS = {
    Saweria:    0x10b981,   // green
    SocialBuzz: 0x6366f1,   // indigo
    Test:       0xfbbf24,   // yellow
};

const SOURCE_ICONS = {
    Saweria:    '🟢',
    SocialBuzz: '🔵',
    Test:       '🟡',
};

async function sendToDiscord(game, donation, donationId) {
    if (!game.discordWebhookUrl) return;
    try {
        const color  = SOURCE_COLORS[donation.source] || 0x8b5cf6;
        const icon   = SOURCE_ICONS[donation.source]  || '💸';
        const amount = formatRupiah(donation.amount);
        const embed  = {
            title:       `${icon} Donasi Baru — ${game.name}`,
            color,
            fields: [
                { name: '👤 Username',     value: donation.username    || '-', inline: true  },
                { name: '🏷️ Nama',         value: donation.displayName || '-', inline: true  },
                { name: '💰 Jumlah',       value: `**${amount}**`,              inline: true  },
                { name: '📡 Platform',     value: donation.source      || '-', inline: true  },
                { name: '🎮 Game',         value: game.name,                    inline: true  },
                { name: '🆔 Donation ID',  value: `#${donationId}`,             inline: true  },
                { name: '💬 Pesan',        value: donation.message    || '*(tidak ada)*', inline: false },
            ],
            footer:    { text: 'Archie Webhook System' },
            timestamp: new Date().toISOString(),
        };
        await axios.post(game.discordWebhookUrl, { embeds: [embed] }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 8000,
        });
        console.log(`💬 [${game.name}] Discord notif sent`);
    } catch (e) {
        // Non-fatal — log but don't throw
        console.warn(`⚠️  [${game.name}] Discord notif failed: ${e.response?.status || e.message}`);
    }
}

async function sendToRoblox(game, data) {
    const url = `https://apis.roblox.com/messaging-service/v1/universes/${game.universeId}/topics/${encodeURIComponent(game.topic)}`;
    console.log(`📤 [${game.name}] ${formatRupiah(data.amount)} → ${data.username} (donationId=${data.donationId})`);
    const res = await axios.post(url, { message: JSON.stringify(data) }, {
        headers: { 'Content-Type': 'application/json', 'x-api-key': game.apiKey },
        timeout: 10000
    });
    console.log(`✅ [${game.name}] Roblox status: ${res.status}`);
    await updateGameLastActive(game.id);
    return res;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Saweria
// ─────────────────────────────────────────────────────────────────────────────
app.post('/:webhookSecret/saweria', async (req, res) => {
    const game = await dbGetGameBySecret(req.params.webhookSecret);
    if (!game) return res.status(404).json({ error: 'Not found' });
    console.log(`\n📩 [${game.name}] Saweria webhook`);
    if (game.saweriaToken && !verifyWebhookToken(req, game.saweriaToken))
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    const p = req.body;
    if (!p || p.type !== 'donation') return res.status(200).json({ success: true, message: 'OK' });

    const donation = {
        username:    extractUsername(p.message || '', p.donator_name || 'Anonymous'),
        displayName: p.donator_name || 'Anonymous',
        amount:      Math.floor(p.amount_raw || 0),
        timestamp:   Math.floor(Date.now() / 1000),
        source:      'Saweria',
        message:     p.message || '',
        email:       p.donator_email || ''
    };

    try {
        const donationId = await dbSaveDonation(game.id, donation);
        const payload    = { ...donation, donationId: String(donationId) };
        await sendToRoblox(game, payload);
        // Fire-and-forget Discord (non-blocking)
        sendToDiscord(game, donation, donationId);
        return res.status(200).json({ success: true });
    } catch (e) {
        console.error(`❌ [${game.name}]`, e.message);
        return res.status(500).json({ success: false, error: 'Failed' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SocialBuzz
// ─────────────────────────────────────────────────────────────────────────────
app.post('/:webhookSecret/socialbuzz', async (req, res) => {
    const game = await dbGetGameBySecret(req.params.webhookSecret);
    if (!game) return res.status(404).json({ error: 'Not found' });
    console.log(`\n📩 [${game.name}] SocialBuzz webhook`);
    console.log('📦 Payload:', JSON.stringify(req.body, null, 2));
    if (game.socialbuzzToken && !verifyWebhookToken(req, game.socialbuzzToken))
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    const p = req.body;
    if (!p) return res.status(400).json({ success: false, error: 'No payload' });

    const rawMsg  = p.message || p.supporter_message || p.note || p.comment || '';
    const rawName = p.supporter_name || p.name || p.donator_name || 'Anonymous';
    const donation = {
        username:    extractUsername(rawMsg, rawName),
        displayName: rawName,
        amount:      Math.floor(p.amount || p.donation_amount || p.amount_raw || 0),
        timestamp:   Math.floor(Date.now() / 1000),
        source:      'SocialBuzz',
        message:     rawMsg,
        email:       p.supporter_email || p.email || ''
    };

    try {
        const donationId = await dbSaveDonation(game.id, donation);
        const payload    = { ...donation, donationId: String(donationId) };
        await sendToRoblox(game, payload);
        sendToDiscord(game, donation, donationId);
        return res.status(200).json({ success: true });
    } catch (e) {
        console.error(`❌ [${game.name}]`, e.message);
        return res.status(500).json({ success: false, error: 'Failed' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Test
// ─────────────────────────────────────────────────────────────────────────────
app.post('/:webhookSecret/test', async (req, res) => {
    const game = await dbGetGameBySecret(req.params.webhookSecret);
    if (!game) return res.status(404).json({ error: 'Not found' });
    const password = req.query.password || req.body?.password;
    const authGame = await authenticateGame(password);
    if (!authGame || authGame.id !== game.id)
        return res.status(401).json({ success: false, error: 'Unauthorized' });

    const donation = {
        username:    req.body.username || 'TestUser',
        displayName: 'Test Donator',
        amount:      parseInt(req.body.amount) || 25000,
        timestamp:   Math.floor(Date.now() / 1000),
        source:      'Test',
        message:     'Test donation',
        email:       ''
    };

    try {
        const donationId = await dbSaveDonation(game.id, donation);
        const payload    = { ...donation, donationId: String(donationId) };
        await sendToRoblox(game, payload);
        sendToDiscord(game, donation, donationId);
        return res.json({ success: true, message: 'Test sent', game: game.name, donationId });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  API — auth
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/auth', async (req, res) => {
    const game = await authenticateGame(req.body.password);
    res.json({ success: !!game });
});

app.post('/api/admin/auth', (req, res) => {
    const { username, password } = req.body;
    if (authenticateAdmin(username, password)) {
        const token = Buffer.from(`${username}:${password}`).toString('base64');
        res.json({ success: true, token });
    } else {
        res.json({ success: false });
    }
});

app.post('/api/user/change-password', async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!newPassword || newPassword.length < 6)
            return res.json({ success: false, error: 'Password minimal 6 karakter' });
        const game = await authenticateGame(currentPassword);
        if (!game) return res.json({ success: false, error: 'Password saat ini salah' });
        await dbSetPassword(game.id, newPassword);
        res.json({ success: true, message: 'Password berhasil diubah' });
    } catch (e) {
        console.error('❌ change-password error:', e.message);
        res.status(500).json({ success: false, error: 'Server error: ' + e.message });
    }
});

app.get('/api/user/donations', async (req, res) => {
    try {
        const game = await authenticateGame(req.query.password);
        if (!game) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
        const offset = parseInt(req.query.offset) || 0;
        const search = req.query.search || '';
        const [rows, total] = await Promise.all([
            dbGetDonations(game.id, { limit, offset, search }),
            dbCountDonations(game.id, search)
        ]);
        res.json({ success: true, donations: rows, total, limit, offset });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Server error: ' + e.message });
    }
});

app.get('/api/user/donations/stats', async (req, res) => {
    try {
        const game = await authenticateGame(req.query.password);
        if (!game) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const stats = await dbGetDonationStats(game.id);
        res.json({ success: true, ...stats });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Server error: ' + e.message });
    }
});

app.get('/api/admin/users', async (req, res) => {
    if (!adminFromToken(req.query.token || ''))
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    const games = await dbGetAllGames();
    const users = await Promise.all(games.map(async g => {
        const { rows } = await pool.query('SELECT updated_at FROM game_passwords WHERE game_id=$1', [g.id]).catch(() => ({ rows: [] }));
        const { rows: stats } = await pool.query('SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total FROM donations WHERE game_id=$1', [g.id]).catch(() => ({ rows: [{ cnt:0, total:0 }] }));
        return {
            id:                g.id,
            name:              g.name,
            universeId:        g.universeId,
            topic:             g.topic,
            webhookSecret:     g.webhookSecret,
            saweriaToken:      !!g.saweriaToken,
            socialbuzzToken:   !!g.socialbuzzToken,
            discordWebhookUrl: !!g.discordWebhookUrl,
            lastActive:        rows[0]?.updated_at || null,
            donationCount:     parseInt(stats[0]?.cnt || 0),
            donationTotal:     parseInt(stats[0]?.total || 0)
        };
    }));
    res.json({ success: true, users });
});

app.post('/api/admin/reset-password', async (req, res) => {
    const { token, gameId, newPassword } = req.body;
    if (!adminFromToken(token || '')) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (!newPassword || newPassword.length < 6) return res.json({ success: false, error: 'Password minimal 6 karakter' });
    const game = await dbGetGameById(gameId);
    if (!game) return res.json({ success: false, error: 'Game tidak ditemukan' });
    await dbSetPassword(gameId, newPassword);
    res.json({ success: true, message: 'Password berhasil direset' });
});

app.get('/api/admin/donations', async (req, res) => {
    if (!adminFromToken(req.query.token || ''))
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    const gameId = req.query.gameId;
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const search = req.query.search || '';
    const game   = await dbGetGameById(gameId);
    if (!game) return res.json({ success: false, error: 'Game tidak ditemukan' });
    const [rows, total] = await Promise.all([
        dbGetDonations(gameId, { limit, offset, search }),
        dbCountDonations(gameId, search)
    ]);
    res.json({ success: true, donations: rows, total });
});

app.post('/api/admin/games', async (req, res) => {
    const { token, name, universeId, apiKey, topic, webhookSecret, password, saweriaToken, socialbuzzToken, discordWebhookUrl } = req.body;
    if (!adminFromToken(token || '')) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (!name || !universeId || !apiKey || !password)
        return res.json({ success: false, error: 'Field wajib: name, universeId, apiKey, password' });
    if (password.length < 6)
        return res.json({ success: false, error: 'Password minimal 6 karakter' });
    const gameId = generateGameId();
    const secret = webhookSecret?.trim() || generateSecret(name);
    const existing = await dbGetGameBySecret(secret).catch(() => null);
    if (existing) return res.json({ success: false, error: 'Webhook secret sudah dipakai' });
    const game = {
        id:                gameId,
        name:              name.trim(),
        universeId:        universeId.trim(),
        apiKey:            apiKey.trim(),
        topic:             topic?.trim() || 'ArchieDonationIDR',
        webhookSecret:     secret,
        saweriaToken:      saweriaToken?.trim()      || null,
        socialbuzzToken:   socialbuzzToken?.trim()   || null,
        discordWebhookUrl: discordWebhookUrl?.trim() || null,
    };
    try {
        await dbAddGame(game);
        await dbSetPassword(gameId, password);
        console.log(`✅ Game baru: ${game.name} (${gameId})`);
        res.json({ success: true, game: { ...game, webhookSecret: secret } });
    } catch (e) {
        if (e.code === '23505') return res.json({ success: false, error: 'ID atau webhook secret duplikat' });
        res.json({ success: false, error: 'Gagal menyimpan game' });
    }
});

app.put('/api/admin/games/:gameId', async (req, res) => {
    const { token, name, universeId, apiKey, topic, saweriaToken, socialbuzzToken, discordWebhookUrl } = req.body;
    if (!adminFromToken(token || '')) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const game = await dbGetGameById(req.params.gameId);
    if (!game) return res.json({ success: false, error: 'Game tidak ditemukan' });
    try {
        await dbUpdateGame(req.params.gameId, {
            name:               name?.trim()              || game.name,
            universe_id:        universeId?.trim()        || game.universeId,
            api_key:            apiKey?.trim()             || game.apiKey,
            topic:              topic?.trim()              || game.topic,
            saweria_token:      saweriaToken?.trim()      || null,
            socialbuzz_token:   socialbuzzToken?.trim()   || null,
            discord_webhook_url: discordWebhookUrl !== undefined
                ? (discordWebhookUrl?.trim() || null)
                : game.discordWebhookUrl,
        });
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: 'Gagal update game' });
    }
});

app.delete('/api/admin/games/:gameId', async (req, res) => {
    const token = req.query.token || req.body?.token;
    if (!adminFromToken(token || '')) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const game = await dbGetGameById(req.params.gameId);
    if (!game) return res.json({ success: false, error: 'Game tidak ditemukan' });
    try {
        await dbDeleteGame(req.params.gameId);
        console.log(`🗑️ Game dihapus: ${game.name}`);
        res.json({ success: true, message: `Game "${game.name}" berhasil dihapus` });
    } catch (e) {
        res.json({ success: false, error: 'Gagal menghapus game' });
    }
});

app.get('/api/user/config', async (req, res) => {
    const game = await authenticateGame(req.query.password);
    if (!game) return res.status(401).json({success:false});
    const base = 'https://' + req.headers.host;
    res.json({
        success:    true,
        name:       game.name,
        uid:        game.universeId,
        topic:      game.topic,
        hasSaw:     !!game.saweriaToken,
        hasSb:      !!game.socialbuzzToken,
        hasDiscord: !!game.discordWebhookUrl,
        sawUrl:     base + '/' + game.webhookSecret + '/saweria',
        sbUrl:      base + '/' + game.webhookSecret + '/socialbuzz',
        testUrl:    base + '/' + game.webhookSecret + '/test'
    });
});

app.get('/dashboard', async (req, res) => {
    const password = req.query.password;
    const game = await authenticateGame(password);
    if (!game) return res.redirect('/');
    res.type('html').send(fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'));
});

app.get('/api/debug/auth', async (req, res) => {
    const { password } = req.query;
    if (!password) return res.json({ ok: false, error: 'No password provided' });
    try {
        const game = await authenticateGame(password);
        if (!game) return res.json({ ok: false, error: 'Auth failed' });
        const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM donations WHERE game_id = $1', [game.id]);
        res.json({ ok: true, gameId: game.id, gameName: game.name, donationCount: parseInt(rows[0].cnt) });
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});

app.get('/', (_req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Archie Webhook Integration</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0e27;min-height:100vh;display:flex;justify-content:center;align-items:center;overflow:hidden;position:relative}
    body::before{content:'';position:absolute;width:200%;height:200%;background:radial-gradient(circle at 20% 50%,rgba(120,119,198,.3),transparent 50%),radial-gradient(circle at 80% 80%,rgba(88,166,255,.3),transparent 50%),radial-gradient(circle at 40% 20%,rgba(139,92,246,.2),transparent 50%);animation:float 20s ease-in-out infinite}
    @keyframes float{0%,100%{transform:translate(0,0) rotate(0)}33%{transform:translate(30px,-50px) rotate(120deg)}66%{transform:translate(-20px,20px) rotate(240deg)}}
    .grid-bg{position:absolute;width:100%;height:100%;background-image:linear-gradient(rgba(139,92,246,.1) 1px,transparent 1px),linear-gradient(90deg,rgba(139,92,246,.1) 1px,transparent 1px);background-size:50px 50px;opacity:.3}
    .container{position:relative;z-index:10;width:90%;max-width:450px}
    .box{background:rgba(15,23,42,.8);backdrop-filter:blur(20px);border:1px solid rgba(139,92,246,.3);border-radius:24px;padding:48px 40px;box-shadow:0 20px 60px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.1);animation:fadeIn .6s ease-out}
    @keyframes fadeIn{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:translateY(0)}}
    .logo{text-align:center;margin-bottom:40px}
    .logo-icon{width:80px;height:80px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);border-radius:20px;display:inline-flex;align-items:center;justify-content:center;font-size:40px;margin-bottom:16px;box-shadow:0 10px 30px rgba(139,92,246,.4);animation:pulse 2s ease-in-out infinite}
    @keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
    h1{color:#fff;font-size:28px;font-weight:700;margin-bottom:8px}
    .sub{color:#94a3b8;font-size:14px}
    .tabs{display:flex;gap:12px;margin-bottom:32px}
    .tab{flex:1;padding:12px;background:rgba(15,23,42,.5);border:1px solid rgba(139,92,246,.2);border-radius:12px;color:#94a3b8;font-size:14px;font-weight:600;cursor:pointer;transition:all .3s;text-align:center}
    .tab.active{background:rgba(139,92,246,.2);border-color:#8b5cf6;color:#8b5cf6}
    .tc{display:none}.tc.active{display:block}
    .fg{margin-bottom:24px}
    label{display:block;color:#cbd5e1;font-size:14px;font-weight:500;margin-bottom:8px}
    .iw{position:relative}
    input{width:100%;padding:16px 48px 16px 16px;background:rgba(15,23,42,.6);border:2px solid rgba(139,92,246,.2);border-radius:12px;color:#fff;font-size:15px;transition:all .3s;outline:none}
    input:focus{border-color:#8b5cf6;background:rgba(15,23,42,.9);box-shadow:0 0 0 4px rgba(139,92,246,.1)}
    .ii{position:absolute;right:16px;top:50%;transform:translateY(-50%);color:#64748b;font-size:20px}
    button{width:100%;padding:16px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);border:none;border-radius:12px;color:#fff;font-size:16px;font-weight:600;cursor:pointer;transition:all .3s;box-shadow:0 8px 24px rgba(139,92,246,.4)}
    button:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(139,92,246,.5)}
    .err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#fca5a5;padding:12px 16px;border-radius:8px;font-size:14px;margin-top:16px;display:none}
    .footer{text-align:center;margin-top:32px;padding-top:24px;border-top:1px solid rgba(139,92,246,.1)}
    .ft{color:#64748b;font-size:13px;margin-bottom:12px}
    .dl{display:inline-flex;align-items:center;gap:8px;color:#8b5cf6;text-decoration:none;font-size:14px;font-weight:500;padding:8px 16px;border-radius:8px;background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.2);transition:all .3s}
    .dl:hover{background:rgba(139,92,246,.2);transform:translateY(-2px)}
  </style>
</head>
<body>
  <div class="grid-bg"></div>
  <div class="container"><div class="box">
    <div class="logo">
      <div class="logo-icon">🎮</div>
      <h1>Archie Webhook</h1>
      <p class="sub">Secure Integration Portal</p>
    </div>
    <div class="tabs">
      <div class="tab active" onclick="sw('user')">👤 User Login</div>
      <div class="tab" onclick="sw('admin')">🔐 Admin Login</div>
    </div>
    <div id="uT" class="tc active">
      <form id="uF">
        <div class="fg"><label>Access Password</label>
          <div class="iw"><input type="password" id="uP" placeholder="Enter your password" required><span class="ii">🔐</span></div>
        </div>
        <button type="submit">Access Dashboard</button>
        <div class="err" id="uE">Invalid password. Please try again.</div>
      </form>
    </div>
    <div id="aT" class="tc">
      <form id="aF">
        <div class="fg"><label>Username</label>
          <div class="iw"><input type="text" id="aU" placeholder="Admin username" required><span class="ii">👤</span></div>
        </div>
        <div class="fg"><label>Password</label>
          <div class="iw"><input type="password" id="aP" placeholder="Admin password" required><span class="ii">🔐</span></div>
        </div>
        <button type="submit">Admin Access</button>
        <div class="err" id="aE">Invalid credentials.</div>
      </form>
    </div>
    <div class="footer">
      <p class="ft">Need assistance?</p>
      <a href="https://discord.com/users/wispray" target="_blank" class="dl">💬 Contact on Discord</a>
    </div>
  </div></div>
  <script>
    function sw(t){document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.tc').forEach(x=>x.classList.remove('active'));if(t==='user'){document.querySelectorAll('.tab')[0].classList.add('active');document.getElementById('uT').classList.add('active')}else{document.querySelectorAll('.tab')[1].classList.add('active');document.getElementById('aT').classList.add('active')}}
    document.getElementById('uF').addEventListener('submit',async e=>{e.preventDefault();const p=document.getElementById('uP').value.trim();if(!p)return;try{const r=await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});const d=await r.json();if(d.success)window.location.href='/dashboard?password='+encodeURIComponent(p);else{document.getElementById('uE').style.display='block';document.getElementById('uP').value='';}}catch(e){document.getElementById('uE').textContent='Connection error.';document.getElementById('uE').style.display='block';}});
    document.getElementById('aF').addEventListener('submit',async e=>{e.preventDefault();const u=document.getElementById('aU').value.trim();const p=document.getElementById('aP').value.trim();if(!u||!p)return;try{const r=await fetch('/api/admin/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});const d=await r.json();if(d.success)window.location.href='/admin/dashboard?token='+encodeURIComponent(d.token);else{document.getElementById('aE').style.display='block';document.getElementById('aP').value='';}}catch(e){document.getElementById('aE').textContent='Connection error.';document.getElementById('aE').style.display='block';}});
  </script>
</body></html>`);
});

app.get('/admin/dashboard', (req, res) => {
    const token = req.query.token;
    if (!adminFromToken(token || '')) return res.redirect('/');
    res.type('html').send(fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8'));
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

async function autoMigrate() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`
            CREATE TABLE IF NOT EXISTS games (
                id                  VARCHAR(50)  PRIMARY KEY,
                name                TEXT         NOT NULL,
                universe_id         TEXT         NOT NULL,
                api_key             TEXT         NOT NULL,
                topic               TEXT         DEFAULT 'ArchieDonationIDR',
                webhook_secret      TEXT         NOT NULL UNIQUE,
                saweria_token       TEXT,
                socialbuzz_token    TEXT,
                discord_webhook_url TEXT,
                created_at          TIMESTAMPTZ  DEFAULT NOW()
            )
        `);
        // Ensure discord_webhook_url column exists on older installs
        await client.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS discord_webhook_url TEXT`).catch(()=>{});
        await client.query(`ALTER TABLE games ALTER COLUMN name             TYPE TEXT`).catch(()=>{});
        await client.query(`ALTER TABLE games ALTER COLUMN universe_id      TYPE TEXT`).catch(()=>{});
        await client.query(`ALTER TABLE games ALTER COLUMN api_key          TYPE TEXT`).catch(()=>{});
        await client.query(`ALTER TABLE games ALTER COLUMN topic            TYPE TEXT`).catch(()=>{});
        await client.query(`ALTER TABLE games ALTER COLUMN webhook_secret   TYPE TEXT`).catch(()=>{});
        await client.query(`ALTER TABLE games ALTER COLUMN saweria_token    TYPE TEXT`).catch(()=>{});
        await client.query(`ALTER TABLE games ALTER COLUMN socialbuzz_token TYPE TEXT`).catch(()=>{});
        await client.query(`
            CREATE TABLE IF NOT EXISTS game_passwords (
                game_id    VARCHAR(50)  PRIMARY KEY,
                password   VARCHAR(255) NOT NULL,
                updated_at TIMESTAMPTZ  DEFAULT NOW()
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS donations (
                id           SERIAL       PRIMARY KEY,
                game_id      VARCHAR(50)  NOT NULL,
                username     VARCHAR(255) NOT NULL,
                display_name VARCHAR(255),
                amount       BIGINT       NOT NULL DEFAULT 0,
                source       VARCHAR(50),
                message      TEXT,
                email        VARCHAR(255),
                donated_at   TIMESTAMPTZ  DEFAULT NOW()
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_don_game      ON donations(game_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_don_game_date ON donations(game_id, donated_at DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_don_user      ON donations(game_id, username)`);
        await client.query('COMMIT');
        console.log('✅ Migration done');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function seedEnvGames() {
    const envGames = loadEnvGames();
    if (!envGames.length) return;
    for (const g of envGames) {
        const exists = await dbGetGameById(g.id).catch(() => null);
        if (!exists) {
            try {
                await dbAddGame(g);
                await dbSetPassword(g.id, g.envPassword);
                console.log(`🌱 Seeded: ${g.name}`);
            } catch (e) {
                console.error(`⚠️ Seed failed ${g.id}:`, e.message);
            }
        } else {
            const pwd = await dbGetPassword(g.id).catch(() => null);
            if (!pwd) await dbSetPassword(g.id, g.envPassword).catch(() => {});
        }
    }
}

autoMigrate()
    .then(seedEnvGames)
    .then(async () => {
        const games = await dbGetAllGames();
        console.log(`🎮 ${games.length} game(s) loaded`);
        games.forEach(g => console.log(`   📌 ${g.id}: ${g.name} ${g.discordWebhookUrl ? '💬' : ''}`));
        const db = readDB();
        app.listen(port, () => {
            console.log(`✅ Server on port ${port} | Admin: ${db.admin.username}`);
        });
    })
    .catch(err => {
        console.error('❌ Startup failed:', err.message);
        process.exit(1);
    });
