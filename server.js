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
        INSERT INTO games (id, name, universe_id, api_key, topic, webhook_secret, saweria_token, socialbuzz_token)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [game.id, game.name, game.universeId, game.apiKey, game.topic, game.webhookSecret, game.saweriaToken || null, game.socialbuzzToken || null]);
}

async function dbUpdateGame(gameId, fields) {
    const sets = [];
    const params = [];
    let i = 1;
    const allowed = ['name','universe_id','api_key','topic','webhook_secret','saweria_token','socialbuzz_token'];
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
        id:              row.id,
        name:            row.name,
        universeId:      row.universe_id,
        apiKey:          row.api_key,
        topic:           row.topic || 'ArchieDonationIDR',
        webhookSecret:   row.webhook_secret,
        saweriaToken:    row.saweria_token || null,
        socialbuzzToken: row.socialbuzz_token || null
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
            id:              `game${i}`,
            name:            process.env[`GAME_${i}_NAME`] || `Game ${i}`,
            universeId:      uid,
            apiKey:          key,
            topic:           process.env[`GAME_${i}_TOPIC`] || 'ArchieDonationIDR',
            webhookSecret:   sec,
            saweriaToken:    process.env[`GAME_${i}_SAWERIA_TOKEN`] || null,
            socialbuzzToken: process.env[`GAME_${i}_SOCIALBUZZ_TOKEN`] || null,
            envPassword:     pwd
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
        // Simpan ke DB dulu untuk dapat ID unik
        const donationId = await dbSaveDonation(game.id, donation);
        // Sertakan donationId di payload agar Roblox bisa idempotency check
        const payload = { ...donation, donationId: String(donationId) };
        await sendToRoblox(game, payload);
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
        const payload = { ...donation, donationId: String(donationId) };
        await sendToRoblox(game, payload);
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
        const payload = { ...donation, donationId: String(donationId) };
        await sendToRoblox(game, payload);
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
            id:              g.id,
            name:            g.name,
            universeId:      g.universeId,
            topic:           g.topic,
            webhookSecret:   g.webhookSecret,
            saweriaToken:    !!g.saweriaToken,
            socialbuzzToken: !!g.socialbuzzToken,
            lastActive:      rows[0]?.updated_at || null,
            donationCount:   parseInt(stats[0]?.cnt || 0),
            donationTotal:   parseInt(stats[0]?.total || 0)
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
    const { token, name, universeId, apiKey, topic, webhookSecret, password, saweriaToken, socialbuzzToken } = req.body;
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
        id:              gameId,
        name:            name.trim(),
        universeId:      universeId.trim(),
        apiKey:          apiKey.trim(),
        topic:           topic?.trim() || 'ArchieDonationIDR',
        webhookSecret:   secret,
        saweriaToken:    saweriaToken?.trim() || null,
        socialbuzzToken: socialbuzzToken?.trim() || null
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
    const { token, name, universeId, apiKey, topic, saweriaToken, socialbuzzToken } = req.body;
    if (!adminFromToken(token || '')) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const game = await dbGetGameById(req.params.gameId);
    if (!game) return res.json({ success: false, error: 'Game tidak ditemukan' });
    try {
        await dbUpdateGame(req.params.gameId, {
            name:             name?.trim()           || game.name,
            universe_id:      universeId?.trim()     || game.universeId,
            api_key:          apiKey?.trim()          || game.apiKey,
            topic:            topic?.trim()           || game.topic,
            saweria_token:    saweriaToken?.trim()    || null,
            socialbuzz_token: socialbuzzToken?.trim() || null
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
        success: true,
        name:    game.name,
        uid:     game.universeId,
        topic:   game.topic,
        hasSaw:  !!game.saweriaToken,
        hasSb:   !!game.socialbuzzToken,
        sawUrl:  base + '/' + game.webhookSecret + '/saweria',
        sbUrl:   base + '/' + game.webhookSecret + '/socialbuzz',
        testUrl: base + '/' + game.webhookSecret + '/test'
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
    res.send(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('</body>', '') || `<!DOCTYPE html><html><body><h1>Archie Webhook</h1></body></html>`);
});

app.get('/admin/dashboard', (req, res) => {
    const token = req.query.token;
    if (!token || !adminFromToken(token)) return res.redirect('/');
    res.type('html').send(fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8').replace('TOKEN_PLACEHOLDER', token));
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

async function autoMigrate() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`
            CREATE TABLE IF NOT EXISTS games (
                id               VARCHAR(50)  PRIMARY KEY,
                name             TEXT         NOT NULL,
                universe_id      TEXT         NOT NULL,
                api_key          TEXT         NOT NULL,
                topic            TEXT         DEFAULT 'ArchieDonationIDR',
                webhook_secret   TEXT         NOT NULL UNIQUE,
                saweria_token    TEXT,
                socialbuzz_token TEXT,
                created_at       TIMESTAMPTZ  DEFAULT NOW()
            )
        `);
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
        games.forEach(g => console.log(`   📌 ${g.id}: ${g.name}`));
        const db = readDB();
        app.listen(port, () => {
            console.log(`✅ Server on port ${port} | Admin: ${db.admin.username}`);
        });
    })
    .catch(err => {
        console.error('❌ Startup failed:', err.message);
        process.exit(1);
    });
