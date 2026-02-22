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

// ─────────────────────────────────────────────────────────────────────────────
//  JSON flat-file fallback — admin credentials
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
//  PostgreSQL helpers — game_passwords
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
//  PostgreSQL helpers — games table
// ─────────────────────────────────────────────────────────────────────────────
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
    // Keep donation history (just orphaned, for audit)
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

// ─────────────────────────────────────────────────────────────────────────────
//  PostgreSQL helpers — donations
// ─────────────────────────────────────────────────────────────────────────────
async function dbSaveDonation(gameId, data) {
    await pool.query(`
        INSERT INTO donations (game_id, username, display_name, amount, source, message, email)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [gameId, data.username, data.displayName, data.amount, data.source, data.message, data.email]);
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

// ─────────────────────────────────────────────────────────────────────────────
//  Load env-based games for seeding
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
//  Auth helpers
// ─────────────────────────────────────────────────────────────────────────────
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
        console.error('❌ authenticateGame error:', e.message);
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

// ─────────────────────────────────────────────────────────────────────────────
//  Shared helpers
// ─────────────────────────────────────────────────────────────────────────────
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
    console.log(`📤 [${game.name}] ${formatRupiah(data.amount)} → ${data.username}`);
    const res = await axios.post(url, { message: JSON.stringify(data) }, {
        headers: { 'Content-Type': 'application/json', 'x-api-key': game.apiKey },
        timeout: 10000
    });
    console.log(`✅ [${game.name}] Roblox status: ${res.status}`);
    await updateGameLastActive(game.id);
    return res;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Dynamic Webhook Routes
// ─────────────────────────────────────────────────────────────────────────────

// ── Saweria ──────────────────────────────────────────────────────────────────
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
        await sendToRoblox(game, donation);
        await dbSaveDonation(game.id, donation);
        return res.status(200).json({ success: true });
    } catch (e) {
        console.error(`❌ [${game.name}]`, e.message);
        return res.status(500).json({ success: false, error: 'Failed' });
    }
});

// ── SocialBuzz ───────────────────────────────────────────────────────────────
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
    console.log('✅ Donation:', JSON.stringify(donation, null, 2));
    try {
        await sendToRoblox(game, donation);
        await dbSaveDonation(game.id, donation);
        return res.status(200).json({ success: true });
    } catch (e) {
        console.error(`❌ [${game.name}]`, e.message);
        return res.status(500).json({ success: false, error: 'Failed' });
    }
});

// ── Test ─────────────────────────────────────────────────────────────────────
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
        await sendToRoblox(game, donation);
        await dbSaveDonation(game.id, donation);
        return res.json({ success: true, message: 'Test sent', game: game.name });
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

// ─────────────────────────────────────────────────────────────────────────────
//  API — user password change
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/user/change-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6)
        return res.json({ success: false, error: 'Password minimal 6 karakter' });
    const game = await authenticateGame(currentPassword);
    if (!game) return res.json({ success: false, error: 'Password saat ini salah' });
    try {
        await dbSetPassword(game.id, newPassword);
        res.json({ success: true, message: 'Password berhasil diubah' });
    } catch (e) {
        res.json({ success: false, error: 'Gagal menyimpan password' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  API — donation history (user)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/user/donations', async (req, res) => {
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
});

app.get('/api/user/donations/stats', async (req, res) => {
    const game = await authenticateGame(req.query.password);
    if (!game) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const stats = await dbGetDonationStats(game.id);
    res.json({ success: true, ...stats });
});

// ─────────────────────────────────────────────────────────────────────────────
//  API — admin users
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/admin/users', async (req, res) => {
    if (!adminFromToken(req.query.token || ''))
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    const games = await dbGetAllGames();
    const users = await Promise.all(games.map(async g => {
        const { rows } = await pool.query('SELECT updated_at FROM game_passwords WHERE game_id=$1', [g.id]).catch(() => ({ rows: [] }));
        const { rows: stats } = await pool.query('SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total FROM donations WHERE game_id=$1', [g.id]).catch(() => ({ rows: [{ cnt:0, total:0 }] }));
        return {
            id:            g.id,
            name:          g.name,
            universeId:    g.universeId,
            topic:         g.topic,
            webhookSecret: g.webhookSecret,
            saweriaToken:  !!g.saweriaToken,
            socialbuzzToken: !!g.socialbuzzToken,
            lastActive:    rows[0]?.updated_at || null,
            donationCount: parseInt(stats[0]?.cnt || 0),
            donationTotal: parseInt(stats[0]?.total || 0)
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

// ─────────────────────────────────────────────────────────────────────────────
//  API — admin game management (ADD / EDIT / DELETE)
// ─────────────────────────────────────────────────────────────────────────────

// Add new game
app.post('/api/admin/games', async (req, res) => {
    const { token, name, universeId, apiKey, topic, webhookSecret, password, saweriaToken, socialbuzzToken } = req.body;
    if (!adminFromToken(token || '')) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (!name || !universeId || !apiKey || !password)
        return res.json({ success: false, error: 'Field wajib: name, universeId, apiKey, password' });
    if (password.length < 6)
        return res.json({ success: false, error: 'Password minimal 6 karakter' });

    const gameId = generateGameId();
    const secret = webhookSecret?.trim() || generateSecret(name);

    // Check duplicate secret
    const existing = await dbGetGameBySecret(secret).catch(() => null);
    if (existing) return res.json({ success: false, error: 'Webhook secret sudah dipakai, gunakan yang lain' });

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
        console.log(`✅ Game baru ditambahkan: ${game.name} (${gameId})`);
        res.json({ success: true, game: { ...game, webhookSecret: secret } });
    } catch (e) {
        console.error('❌ Gagal tambah game:', e.message);
        if (e.code === '23505') return res.json({ success: false, error: 'ID atau webhook secret duplikat' });
        res.json({ success: false, error: 'Gagal menyimpan game' });
    }
});

// Edit game
app.put('/api/admin/games/:gameId', async (req, res) => {
    const { token, name, universeId, apiKey, topic, saweriaToken, socialbuzzToken } = req.body;
    if (!adminFromToken(token || '')) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const game = await dbGetGameById(req.params.gameId);
    if (!game) return res.json({ success: false, error: 'Game tidak ditemukan' });
    try {
        await dbUpdateGame(req.params.gameId, {
            name:             name?.trim()            || game.name,
            universe_id:      universeId?.trim()      || game.universeId,
            api_key:          apiKey?.trim()           || game.apiKey,
            topic:            topic?.trim()            || game.topic,
            saweria_token:    saweriaToken?.trim()     || null,
            socialbuzz_token: socialbuzzToken?.trim()  || null
        });
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: 'Gagal update game' });
    }
});

// Delete game
app.delete('/api/admin/games/:gameId', async (req, res) => {
    const token = req.query.token || req.body?.token;
    if (!adminFromToken(token || '')) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const game = await dbGetGameById(req.params.gameId);
    if (!game) return res.json({ success: false, error: 'Game tidak ditemukan' });
    try {
        await dbDeleteGame(req.params.gameId);
        console.log(`🗑️ Game dihapus: ${game.name} (${req.params.gameId})`);
        res.json({ success: true, message: `Game "${game.name}" berhasil dihapus` });
    } catch (e) {
        res.json({ success: false, error: 'Gagal menghapus game' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Homepage
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
//  User Dashboard
// ─────────────────────────────────────────────────────────────────────────────
app.get('/dashboard', async (req, res) => {
    const password = req.query.password;
    const game = await authenticateGame(password);
    if (!game) return res.redirect('/');
    const baseUrl = `https://${req.get('host')}`;

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${game.name} — Dashboard</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0e27;color:#fff;min-height:100vh;padding:20px}
    .container{max-width:1100px;margin:0 auto}
    .header{background:linear-gradient(135deg,rgba(139,92,246,.2),rgba(59,130,246,.2));border:1px solid rgba(139,92,246,.3);border-radius:20px;padding:28px 32px;margin-bottom:28px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px}
    .header h1{font-size:28px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .header p{color:#94a3b8;font-size:13px;margin-top:4px}
    .hbtns{display:flex;gap:10px;flex-wrap:wrap}
    .nav{display:flex;gap:10px;margin-bottom:24px;border-bottom:1px solid rgba(139,92,246,.15);padding-bottom:0}
    .ntab{padding:10px 20px;background:none;border:none;border-bottom:2px solid transparent;color:#94a3b8;font-size:14px;font-weight:600;cursor:pointer;transition:all .3s;border-radius:8px 8px 0 0}
    .ntab.active{color:#8b5cf6;border-bottom-color:#8b5cf6;background:rgba(139,92,246,.1)}
    .ntab:hover{color:#8b5cf6}
    .page{display:none}.page.active{display:block}
    .card{background:rgba(15,23,42,.8);border:1px solid rgba(139,92,246,.2);border-radius:16px;padding:24px;margin-bottom:20px;backdrop-filter:blur(10px)}
    .card h3{color:#8b5cf6;font-size:17px;margin-bottom:18px;display:flex;align-items:center;gap:8px}
    .sgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:20px}
    .scard{background:rgba(15,23,42,.8);border:1px solid rgba(139,92,246,.2);border-radius:14px;padding:20px;text-align:center}
    .scard .sv{font-size:30px;font-weight:700;background:linear-gradient(135deg,#8b5cf6,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px}
    .scard .sl{color:#94a3b8;font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:.5px}
    .ir{display:flex;justify-content:space-between;padding:11px 0;border-bottom:1px solid rgba(139,92,246,.08);align-items:center;font-size:14px}
    .ir:last-child{border:none}
    .il{color:#94a3b8}.iv{color:#fff;font-weight:500}
    .ub{background:rgba(0,0,0,.3);border:1px solid rgba(139,92,246,.2);border-radius:10px;padding:14px;margin:10px 0}
    .ul{color:#8b5cf6;font-size:12px;font-weight:600;text-transform:uppercase;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}
    .ut{color:#10b981;font-family:'Courier New',monospace;font-size:12px;word-break:break-all;padding:10px;background:rgba(0,0,0,.4);border-radius:6px}
    .btn{padding:9px 18px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all .3s;display:inline-flex;align-items:center;gap:5px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:#fff}
    .btn:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(139,92,246,.4)}
    .btn-sm{padding:6px 14px;font-size:12px}
    .btn-sec{background:rgba(139,92,246,.2);border:1px solid rgba(139,92,246,.4)}
    .btn-sec:hover{background:rgba(139,92,246,.3)}
    .badge{display:inline-block;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:600}
    .bs{background:rgba(16,185,129,.15);color:#10b981;border:1px solid rgba(16,185,129,.3)}
    .bw{background:rgba(245,158,11,.15);color:#f59e0b;border:1px solid rgba(245,158,11,.3)}
    .bp{background:rgba(139,92,246,.15);color:#8b5cf6;border:1px solid rgba(139,92,246,.3)}
    .tbl-wrap{overflow-x:auto}
    table{width:100%;border-collapse:collapse;font-size:13px}
    thead{background:rgba(139,92,246,.1)}
    th{padding:12px 14px;text-align:left;color:#8b5cf6;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.4px}
    td{padding:12px 14px;color:#cbd5e1;border-bottom:1px solid rgba(139,92,246,.08)}
    tr:last-child td{border:none}
    tr:hover td{background:rgba(139,92,246,.04)}
    .sbar{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap}
    .sbar input{flex:1;min-width:180px;padding:10px 14px;background:rgba(15,23,42,.6);border:1.5px solid rgba(139,92,246,.2);border-radius:8px;color:#fff;font-size:13px;outline:none}
    .sbar input:focus{border-color:#8b5cf6}
    .pag{display:flex;justify-content:center;align-items:center;gap:8px;margin-top:16px;font-size:13px}
    .pag button{padding:6px 14px;font-size:12px}
    .pag span{color:#94a3b8}
    .chart{display:flex;align-items:flex-end;gap:6px;height:80px;margin-top:8px}
    .bar-wrap{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px}
    .bar{width:100%;background:linear-gradient(to top,#8b5cf6,#3b82f6);border-radius:4px 4px 0 0;min-height:2px;transition:height .5s}
    .bar-label{color:#64748b;font-size:10px;text-align:center}
    .modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(5px);z-index:1000;justify-content:center;align-items:center;padding:20px}
    .modal.active{display:flex}
    .mc{background:rgba(15,23,42,.95);border:1px solid rgba(139,92,246,.3);border-radius:20px;padding:32px;max-width:480px;width:100%;animation:mfade .3s}
    @keyframes mfade{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}}
    .mh{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}
    .mh h2{color:#8b5cf6;font-size:22px}
    .xbtn{background:none;border:none;color:#94a3b8;font-size:22px;cursor:pointer;width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:6px;transition:all .3s}
    .xbtn:hover{background:rgba(139,92,246,.2);color:#8b5cf6}
    .fg{margin-bottom:18px}
    .fg label{display:block;color:#cbd5e1;font-size:14px;font-weight:500;margin-bottom:7px}
    .fg input{width:100%;padding:11px 14px;background:rgba(15,23,42,.6);border:2px solid rgba(139,92,246,.2);border-radius:9px;color:#fff;font-size:14px;outline:none;transition:all .3s}
    .fg input:focus{border-color:#8b5cf6}
    .mf{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}
    .toast{position:fixed;top:20px;right:20px;padding:14px 22px;border-radius:12px;font-weight:600;display:none;z-index:2000;animation:slideIn .3s}
    @keyframes slideIn{from{transform:translateX(400px);opacity:0}to{transform:translateX(0);opacity:1}}
    .tOk{background:rgba(16,185,129,.9);color:#fff}
    .tErr{background:rgba(239,68,68,.9);color:#fff}
    @media(max-width:600px){.header{padding:20px;flex-direction:column}.card{padding:16px}}
  </style>
</head>
<body>
<div class="toast tOk" id="tOk"></div>
<div class="toast tErr" id="tErr"></div>

<div class="modal" id="cpModal">
  <div class="mc">
    <div class="mh"><h2>🔐 Ganti Password</h2><button class="xbtn" onclick="closeModal()">×</button></div>
    <form id="cpForm">
      <div class="fg"><label>Password Saat Ini</label><input type="password" id="cpCur" required></div>
      <div class="fg"><label>Password Baru</label><input type="password" id="cpNew" minlength="6" required></div>
      <div class="fg"><label>Konfirmasi Password Baru</label><input type="password" id="cpCon" minlength="6" required></div>
      <div class="mf">
        <button type="button" class="btn btn-sec" onclick="closeModal()">Batal</button>
        <button type="submit" class="btn">Simpan</button>
      </div>
    </form>
  </div>
</div>

<div class="container">
  <div class="header">
    <div><h1>🎮 ${game.name}</h1><p>Webhook Integration Dashboard</p></div>
    <div class="hbtns">
      <button class="btn btn-sec" onclick="document.getElementById('cpModal').classList.add('active')">🔑 Ganti Password</button>
      <button class="btn btn-sec" onclick="location.href='/'">🚪 Logout</button>
    </div>
  </div>
  <div class="nav">
    <button class="ntab active" onclick="switchPage('overview')">📊 Overview</button>
    <button class="ntab" onclick="switchPage('history')">📜 History Donasi</button>
    <button class="ntab" onclick="switchPage('leaderboard')">🏆 Leaderboard</button>
    <button class="ntab" onclick="switchPage('settings')">⚙️ Settings</button>
  </div>
  <div class="page active" id="p-overview">
    <div class="sgrid" id="statCards">
      <div class="scard"><div class="sv" id="sTotalAmount">—</div><div class="sl">Total Donasi</div></div>
      <div class="scard"><div class="sv" id="sTotalCount">—</div><div class="sl">Jumlah Transaksi</div></div>
      <div class="scard"><div class="sv" id="sUniqueDonors">—</div><div class="sl">Donatur Unik</div></div>
    </div>
    <div class="card"><h3>📈 Donasi 7 Hari Terakhir</h3><div class="chart" id="weekChart"><p style="color:#64748b;font-size:13px">Loading…</p></div></div>
    <div class="card">
      <h3>📋 Informasi Game</h3>
      <div class="ir"><span class="il">Universe ID</span><span class="iv">${game.universeId}</span></div>
      <div class="ir"><span class="il">Topic</span><span class="iv">${game.topic}</span></div>
      <div class="ir"><span class="il">Saweria Token</span><span class="iv"><span class="badge ${game.saweriaToken ? 'bs' : 'bw'}">${game.saweriaToken ? '✓ Set' : '⚠ Optional'}</span></span></div>
      <div class="ir"><span class="il">SocialBuzz Token</span><span class="iv"><span class="badge ${game.socialbuzzToken ? 'bs' : 'bw'}">${game.socialbuzzToken ? '✓ Set' : '⚠ Optional'}</span></span></div>
    </div>
  </div>
  <div class="page" id="p-history">
    <div class="card">
      <h3>📜 History Donasi</h3>
      <div class="sbar">
        <input type="text" id="searchInput" placeholder="🔍 Cari username / nama…" oninput="debounceSearch()">
        <button class="btn btn-sm" onclick="loadDonations(0)">Cari</button>
        <button class="btn btn-sm btn-sec" onclick="exportCSV()">⬇ Export CSV</button>
      </div>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>#</th><th>Waktu</th><th>Username</th><th>Nama</th><th>Platform</th><th>Jumlah</th><th>Pesan</th></tr></thead>
          <tbody id="donTbody"><tr><td colspan="7" style="text-align:center;padding:30px;color:#64748b">Loading…</td></tr></tbody>
        </table>
      </div>
      <div class="pag" id="pagination"></div>
    </div>
  </div>
  <div class="page" id="p-leaderboard">
    <div class="card">
      <h3>🏆 Top Donatur</h3>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>Rank</th><th>Username</th><th>Nama</th><th>Jumlah Donasi</th><th>Total Amount</th><th>Terakhir Donasi</th></tr></thead>
          <tbody id="lbTbody"><tr><td colspan="6" style="text-align:center;padding:30px;color:#64748b">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
  <div class="page" id="p-settings">
    <div class="card">
      <h3>🔗 Webhook URLs</h3>
      <p style="color:#94a3b8;font-size:13px;margin-bottom:18px">Gunakan URL berikut di Saweria / SocialBuzz.</p>
      <div class="ub"><div class="ul"><span>📡 Saweria Webhook</span><button class="btn btn-sm" onclick="copy('sawURL')">📋 Copy</button></div><div class="ut" id="sawURL">${baseUrl}/${game.webhookSecret}/saweria</div></div>
      <div class="ub"><div class="ul"><span>📡 SocialBuzz Webhook</span><button class="btn btn-sm" onclick="copy('sbURL')">📋 Copy</button></div><div class="ut" id="sbURL">${baseUrl}/${game.webhookSecret}/socialbuzz</div></div>
      <div class="ub"><div class="ul"><span>🧪 Test Endpoint</span><button class="btn btn-sm" onclick="copy('testURL')">📋 Copy</button></div><div class="ut" id="testURL">${baseUrl}/${game.webhookSecret}/test?password=${encodeURIComponent(password)}</div></div>
    </div>
    <div class="card">
      <h3>💡 Format Username</h3>
      <div style="color:#94a3b8;font-size:13px;line-height:2">
        <p>• <code style="color:#10b981">[RobloxUsername] Pesan</code></p>
        <p>• <code style="color:#10b981">@RobloxUsername Pesan</code></p>
        <p>• <code style="color:#10b981">RobloxUsername: Pesan</code></p>
        <p>• <code style="color:#10b981">RobloxUsername123</code> (kata pertama yg mengandung angka/underscore)</p>
      </div>
    </div>
  </div>
</div>

<script>
const PWD = ${JSON.stringify(password)};
let donPage=0,donTotal=0,donLimit=50,searchTimer=null;
function switchPage(id){document.querySelectorAll('.ntab').forEach(t=>t.classList.remove('active'));document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));const idx={overview:0,history:1,leaderboard:2,settings:3}[id];document.querySelectorAll('.ntab')[idx].classList.add('active');document.getElementById('p-'+id).classList.add('active');if(id==='history'&&document.getElementById('donTbody').innerHTML.includes('Loading'))loadDonations(0);if(id==='leaderboard'&&document.getElementById('lbTbody').innerHTML.includes('Loading'))loadLeaderboard();if(id==='overview'&&document.getElementById('sTotalAmount').textContent==='—')loadStats();}
function fmt(n){return new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',minimumFractionDigits:0}).format(n)}
function fmtDate(s){return new Date(s).toLocaleString('id-ID',{dateStyle:'short',timeStyle:'short'})}
function toast(msg,ok=true){const el=document.getElementById(ok?'tOk':'tErr');el.textContent=msg;el.style.display='block';setTimeout(()=>el.style.display='none',3000)}
function copy(id){navigator.clipboard.writeText(document.getElementById(id).textContent).then(()=>toast('URL disalin!')).catch(()=>toast('Gagal copy','err'))}
function sourceBadge(s){const m={Saweria:'bs',SocialBuzz:'bp',Test:'bw'};return '<span class="badge '+(m[s]||'bw')+'">'+s+'</span>'}
function closeModal(){document.getElementById('cpModal').classList.remove('active')}
function debounceSearch(){clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadDonations(0),400)}
async function loadStats(){try{const r=await fetch('/api/user/donations/stats?password='+encodeURIComponent(PWD));const d=await r.json();if(!d.success)return;document.getElementById('sTotalAmount').textContent=fmt(d.totals.total_amount||0);document.getElementById('sTotalCount').textContent=(d.totals.total_donations||0).toLocaleString();document.getElementById('sUniqueDonors').textContent=(d.totals.unique_donors||0).toLocaleString();const days=d.recent7||[];if(!days.length){document.getElementById('weekChart').innerHTML='<p style="color:#64748b;font-size:13px">Belum ada data minggu ini</p>';return;}const max=Math.max(...days.map(x=>parseInt(x.amount)||0),1);document.getElementById('weekChart').innerHTML=days.map(day=>{const pct=Math.max(4,Math.round((parseInt(day.amount)||0)/max*100));const label=new Date(day.day).toLocaleDateString('id-ID',{weekday:'short',day:'numeric'});return \`<div class="bar-wrap"><div class="bar" style="height:\${pct}%" title="\${fmt(day.amount)}"></div><div class="bar-label">\${label}</div></div>\`;}).join('');}catch(e){console.error(e);}}
async function loadDonations(offset=0){donPage=offset;const search=document.getElementById('searchInput').value.trim();const tbody=document.getElementById('donTbody');tbody.innerHTML='<tr><td colspan="7" style="text-align:center;padding:24px;color:#64748b">Loading…</td></tr>';try{const url=\`/api/user/donations?password=\${encodeURIComponent(PWD)}&limit=\${donLimit}&offset=\${offset}&search=\${encodeURIComponent(search)}\`;const r=await fetch(url);const d=await r.json();if(!d.success){tbody.innerHTML='<tr><td colspan="7" style="text-align:center;color:#ef4444">Error loading data</td></tr>';return;}donTotal=d.total;if(!d.donations.length){tbody.innerHTML='<tr><td colspan="7" style="text-align:center;padding:30px;color:#64748b">Belum ada donasi</td></tr>';renderPagination();return;}tbody.innerHTML=d.donations.map((don,i)=>\`<tr><td style="color:#64748b">\${offset+i+1}</td><td style="white-space:nowrap">\${fmtDate(don.donated_at)}</td><td><strong style="color:#10b981">\${don.username}</strong></td><td style="color:#94a3b8">\${don.display_name||'—'}</td><td>\${sourceBadge(don.source||'?')}</td><td><strong>\${fmt(don.amount)}</strong></td><td style="color:#94a3b8;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${(don.message||'').replace(/"/g,'&quot;')}">\${don.message||'—'}</td></tr>\`).join('');renderPagination();}catch(e){tbody.innerHTML='<tr><td colspan="7" style="text-align:center;color:#ef4444">Connection error</td></tr>';}}
function renderPagination(){const total=donTotal,pages=Math.ceil(total/donLimit),cur=Math.floor(donPage/donLimit);const el=document.getElementById('pagination');if(pages<=1){el.innerHTML='';return;}el.innerHTML=\`<button class="btn btn-sm btn-sec" \${cur===0?'disabled':''} onclick="loadDonations(\${(cur-1)*donLimit})">‹ Prev</button><span>\${cur+1} / \${pages} (Total: \${total.toLocaleString()})</span><button class="btn btn-sm btn-sec" \${cur>=pages-1?'disabled':''} onclick="loadDonations(\${(cur+1)*donLimit})">Next ›</button>\`;}
async function loadLeaderboard(){const tbody=document.getElementById('lbTbody');try{const r=await fetch('/api/user/donations/stats?password='+encodeURIComponent(PWD));const d=await r.json();if(!d.success||!d.byUser.length){tbody.innerHTML='<tr><td colspan="6" style="text-align:center;padding:30px;color:#64748b">Belum ada data</td></tr>';return;}const medals=['🥇','🥈','🥉'];tbody.innerHTML=d.byUser.map((u,i)=>\`<tr><td><strong style="font-size:18px">\${medals[i]||('#'+(i+1))}</strong></td><td><strong style="color:#10b981">\${u.username}</strong></td><td style="color:#94a3b8">\${u.display_name||'—'}</td><td><span class="badge bp">\${u.donation_count}×</span></td><td><strong style="color:#f59e0b">\${fmt(u.total_amount)}</strong></td><td style="color:#64748b;font-size:12px">\${fmtDate(u.last_donation)}</td></tr>\`).join('');}catch(e){tbody.innerHTML='<tr><td colspan="6" style="text-align:center;color:#ef4444">Error</td></tr>';}}
async function exportCSV(){try{toast('Mengambil data untuk export…');const r=await fetch(\`/api/user/donations?password=\${encodeURIComponent(PWD)}&limit=5000&offset=0\`);const d=await r.json();if(!d.success)return toast('Gagal export','err');const header='No,Waktu,Username,Nama,Platform,Jumlah,Pesan';const rows=d.donations.map((x,i)=>[i+1,new Date(x.donated_at).toISOString(),x.username,x.display_name,x.source,x.amount,(x.message||'').replace(/,/g,' ')].join(','));const csv=[header,...rows].join('\n');const blob=new Blob([csv],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='donasi_'+Date.now()+'.csv';a.click();toast('Export berhasil!');}catch(e){toast('Gagal export','err');}}
document.getElementById('cpForm').addEventListener('submit',async e=>{e.preventDefault();const cur=document.getElementById('cpCur').value;const nw=document.getElementById('cpNew').value;const con=document.getElementById('cpCon').value;if(nw!==con)return toast('Password baru tidak cocok','err');if(nw.length<6)return toast('Minimal 6 karakter','err');const r=await fetch('/api/user/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:cur,newPassword:nw})});const d=await r.json();if(d.success){toast('Password berhasil diubah! Redirecting…');setTimeout(()=>location.href='/dashboard?password='+encodeURIComponent(nw),2000);}else toast(d.error||'Gagal','err');});
document.getElementById('cpModal').addEventListener('click',e=>{if(e.target.id==='cpModal')closeModal();});
loadStats();
</script>
</body></html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Admin Dashboard
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
//  Admin Dashboard
// ─────────────────────────────────────────────────────────────────────────────
app.get('/admin/dashboard', (req, res) => {
    const token = req.query.token;
    if (!token || !adminFromToken(token)) return res.redirect('/');
    const ARCH_LICENSE_URL = process.env.ARCH_LICENSE_URL || '';

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin Dashboard — Archie Webhook</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0e27;color:#fff;min-height:100vh;padding:20px}
    .container{max-width:1300px;margin:0 auto}
    .header{background:linear-gradient(135deg,rgba(139,92,246,.2),rgba(59,130,246,.2));border:1px solid rgba(139,92,246,.3);border-radius:20px;padding:28px 32px;margin-bottom:28px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px}
    .header h1{font-size:28px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .header p{color:#94a3b8;font-size:13px;margin-top:4px}
    /* ─ top tabs ─ */
    .top-tabs{display:flex;gap:6px;margin-bottom:28px;border-bottom:1px solid rgba(139,92,246,.15)}
    .ttab{padding:11px 22px;background:none;border:none;border-bottom:3px solid transparent;color:#94a3b8;font-size:14px;font-weight:600;cursor:pointer;transition:all .3s;border-radius:8px 8px 0 0}
    .ttab.active{color:#8b5cf6;border-bottom-color:#8b5cf6;background:rgba(139,92,246,.1)}
    .ttab:hover{color:#8b5cf6}
    .tpage{display:none}.tpage.active{display:block}
    /* ─ stats ─ */
    .sgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
    .scard{background:rgba(15,23,42,.8);border:1px solid rgba(139,92,246,.2);border-radius:14px;padding:20px;text-align:center}
    .scard .sv{font-size:32px;font-weight:700;background:linear-gradient(135deg,#8b5cf6,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px}
    .scard .sl{color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
    /* ─ card ─ */
    .card{background:rgba(15,23,42,.8);border:1px solid rgba(139,92,246,.2);border-radius:16px;padding:24px;margin-bottom:20px}
    .card h2{color:#8b5cf6;font-size:20px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
    .card h3{color:#8b5cf6;font-size:16px;margin-bottom:16px}
    /* ─ table ─ */
    .tbl-wrap{overflow-x:auto}
    table{width:100%;border-collapse:collapse;font-size:13px}
    thead{background:rgba(139,92,246,.1)}
    th{padding:12px 14px;text-align:left;color:#8b5cf6;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.4px}
    td{padding:12px 14px;color:#cbd5e1;border-bottom:1px solid rgba(139,92,246,.08)}
    tr:last-child td{border:none}
    tr:hover td{background:rgba(139,92,246,.04)}
    /* ─ buttons ─ */
    .btn{padding:8px 16px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all .3s;display:inline-flex;align-items:center;gap:5px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:#fff}
    .btn:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(139,92,246,.4)}
    .btn-d{background:linear-gradient(135deg,#ef4444,#dc2626)}
    .btn-d:hover{box-shadow:0 4px 12px rgba(239,68,68,.4)}
    .btn-g{background:linear-gradient(135deg,#10b981,#059669)}
    .btn-g:hover{box-shadow:0 4px 12px rgba(16,185,129,.4)}
    .btn-sec{background:rgba(139,92,246,.2);border:1px solid rgba(139,92,246,.4)}
    .btn-warn{background:linear-gradient(135deg,#f59e0b,#d97706)}
    .btn-sm{padding:5px 11px;font-size:12px}
    /* ─ badge ─ */
    .badge{display:inline-block;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:600}
    .bs{background:rgba(16,185,129,.15);color:#10b981;border:1px solid rgba(16,185,129,.3)}
    .bp{background:rgba(139,92,246,.15);color:#8b5cf6;border:1px solid rgba(139,92,246,.3)}
    .bw{background:rgba(245,158,11,.15);color:#f59e0b;border:1px solid rgba(245,158,11,.3)}
    .br{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.3)}
    .bg{background:rgba(100,116,139,.15);color:#94a3b8;border:1px solid rgba(100,116,139,.3)}
    /* ─ modal ─ */
    .modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);z-index:1000;justify-content:center;align-items:center;padding:20px;overflow-y:auto}
    .modal.active{display:flex}
    .mc{background:rgba(10,14,39,.97);border:1px solid rgba(139,92,246,.35);border-radius:20px;padding:32px;max-width:560px;width:100%;margin:auto;animation:mfade .3s}
    @keyframes mfade{from{opacity:0;transform:scale(.93)}to{opacity:1;transform:scale(1)}}
    .mh{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
    .mh h2{color:#8b5cf6;font-size:20px}
    .xbtn{background:none;border:none;color:#94a3b8;font-size:22px;cursor:pointer;width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:6px;transition:all .3s}
    .xbtn:hover{background:rgba(139,92,246,.2);color:#8b5cf6}
    .fg{margin-bottom:16px}
    .fg label{display:block;color:#cbd5e1;font-size:13px;font-weight:600;margin-bottom:6px}
    .fg label span{color:#64748b;font-weight:400;font-size:12px}
    .fg input,.fg select{width:100%;padding:11px 14px;background:rgba(15,23,42,.7);border:2px solid rgba(139,92,246,.2);border-radius:9px;color:#fff;font-size:14px;outline:none;transition:all .3s}
    .fg input:focus,.fg select:focus{border-color:#8b5cf6;box-shadow:0 0 0 3px rgba(139,92,246,.12)}
    .fg input::placeholder{color:#475569}
    .fg select option{background:#0a0e27}
    .fgrow{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    .divider{border:none;border-top:1px solid rgba(139,92,246,.12);margin:18px 0}
    .section-label{color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;margin-bottom:12px}
    .mf{display:flex;gap:10px;justify-content:flex-end;margin-top:22px;flex-wrap:wrap}
    /* ─ toast ─ */
    .toast{position:fixed;top:20px;right:20px;padding:14px 22px;border-radius:12px;font-weight:600;display:none;z-index:2000;max-width:340px;line-height:1.4}
    .tOk{background:rgba(16,185,129,.95);color:#fff}
    .tErr{background:rgba(239,68,68,.95);color:#fff}
    /* ─ confirm ─ */
    .confirm{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:2000;justify-content:center;align-items:center;padding:20px}
    .confirm.active{display:flex}
    .confirm-box{background:rgba(10,14,39,.97);border:1px solid rgba(239,68,68,.3);border-radius:16px;padding:28px;max-width:380px;width:100%;text-align:center}
    .confirm-box h3{color:#ef4444;margin-bottom:10px;font-size:18px}
    .confirm-box p{color:#94a3b8;font-size:14px;margin-bottom:20px;line-height:1.5}
    .confirm-box .cf{display:flex;gap:10px;justify-content:center}
    /* ─ actions cell ─ */
    .ac{display:flex;gap:6px;flex-wrap:wrap}
    /* ─ arch login box ─ */
    .arch-login{background:rgba(15,23,42,.9);border:1px solid rgba(139,92,246,.3);border-radius:16px;padding:32px;max-width:420px;margin:0 auto}
    .arch-login h3{color:#8b5cf6;font-size:18px;margin-bottom:6px;text-align:center}
    .arch-login p{color:#94a3b8;font-size:13px;margin-bottom:24px;text-align:center}
    .arch-no-url{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:12px;padding:20px;text-align:center;color:#f59e0b}
    /* ─ inner tabs (for license panel) ─ */
    .itabs{display:flex;gap:6px;margin-bottom:20px}
    .itab{padding:8px 16px;background:rgba(15,23,42,.5);border:1px solid rgba(139,92,246,.15);border-radius:8px;color:#94a3b8;font-size:13px;font-weight:600;cursor:pointer;transition:all .3s}
    .itab.active{background:rgba(139,92,246,.15);border-color:#8b5cf6;color:#8b5cf6}
    .ipage{display:none}.ipage.active{display:block}
    /* ─ mono ─ */
    .mono{font-family:'Courier New',monospace;font-size:12px;color:#a78bfa}
    .event-tag{display:inline-flex;padding:2px 8px;border-radius:4px;font-size:11px;font-family:monospace;font-weight:600}
    .ev-ok{background:rgba(34,197,94,.1);color:#22c55e}
    .ev-err{background:rgba(239,68,68,.1);color:#ef4444}
    .ev-warn{background:rgba(245,158,11,.1);color:#f59e0b}
    .ev-info{background:rgba(139,92,246,.1);color:#a78bfa}
    .fg .hint{color:#475569;font-size:11px;margin-top:4px}
  </style>
</head>
<body>
<div class="toast tOk" id="tOk"></div>
<div class="toast tErr" id="tErr"></div>

<!-- Add / Edit Game Modal -->
<div class="modal" id="gameModal">
  <div class="mc">
    <div class="mh"><h2 id="gmTitle">➕ Tambah Game Baru</h2><button class="xbtn" onclick="closeModal('gameModal')">×</button></div>
    <form id="gmForm">
      <input type="hidden" id="gmId"><input type="hidden" id="gmMode">
      <p class="section-label">📌 Informasi Dasar</p>
      <div class="fgrow">
        <div class="fg"><label>Nama Game <span>*</span></label><input id="gmName" placeholder="Contoh: My Roblox Game" required></div>
        <div class="fg"><label>Universe ID <span>*</span></label><input id="gmUid" placeholder="1234567890" required></div>
      </div>
      <div class="fg"><label>Roblox API Key <span>*</span></label><input id="gmApiKey" placeholder="roblox_xxxxx..." required></div>
      <div class="fgrow">
        <div class="fg"><label>Topic</label><input id="gmTopic" placeholder="ArchieDonationIDR"><p class="hint">Default: ArchieDonationIDR</p></div>
        <div class="fg" id="gmSecretFg"><label>Webhook Secret <span>(auto jika kosong)</span></label><input id="gmSecret" placeholder="Kosongkan = auto-generate"></div>
      </div>
      <hr class="divider">
      <p class="section-label">🔐 Password Akses</p>
      <div class="fgrow">
        <div class="fg" id="gmPwdFg"><label>Password <span id="gmPwdLabel">*</span></label><input type="text" id="gmPwd" placeholder="Min. 6 karakter"><p class="hint" id="gmPwdHint">Password login user dashboard</p></div>
        <div class="fg" style="display:flex;align-items:flex-end;padding-bottom:4px"><button type="button" class="btn btn-sec" style="width:100%;justify-content:center" onclick="generatePwd()">🎲 Generate</button></div>
      </div>
      <hr class="divider">
      <p class="section-label">🔗 Token Webhook (Opsional)</p>
      <div class="fgrow">
        <div class="fg"><label>Saweria Token <span>(opsional)</span></label><input id="gmSaweria" placeholder="Kosongkan jika tidak pakai"></div>
        <div class="fg"><label>SocialBuzz Token <span>(opsional)</span></label><input id="gmSocialbuzz" placeholder="Kosongkan jika tidak pakai"></div>
      </div>
      <div class="mf">
        <button type="button" class="btn btn-sec" onclick="closeModal('gameModal')">Batal</button>
        <button type="submit" class="btn btn-g" id="gmSubmit">✅ Simpan</button>
      </div>
    </form>
  </div>
</div>

<!-- Reset Password Modal -->
<div class="modal" id="rpModal">
  <div class="mc" style="max-width:400px">
    <div class="mh"><h2>🔑 Reset Password</h2><button class="xbtn" onclick="closeModal('rpModal')">×</button></div>
    <form id="rpForm">
      <input type="hidden" id="rpId">
      <div class="fg"><label>Game</label><input id="rpName" readonly style="opacity:.6"></div>
      <div class="fg"><label>Password Baru</label><input type="text" id="rpPwd" minlength="6" placeholder="Min. 6 karakter" required></div>
      <div class="mf">
        <button type="button" class="btn btn-sec" onclick="closeModal('rpModal')">Batal</button>
        <button type="submit" class="btn btn-warn">🔑 Reset</button>
      </div>
    </form>
  </div>
</div>

<!-- Confirm Delete Game -->
<div class="confirm" id="confirmDel">
  <div class="confirm-box">
    <h3>⚠️ Hapus Game?</h3>
    <p id="confirmDelMsg">Yakin menghapus game ini?</p>
    <div class="cf">
      <button class="btn btn-sec" onclick="closeConfirm()">Batal</button>
      <button class="btn btn-d" onclick="confirmDeleteGame()">🗑️ Hapus</button>
    </div>
  </div>
</div>

<!-- ARCH: Create License Modal -->
<div class="modal" id="archCreateModal">
  <div class="mc" style="max-width:420px">
    <div class="mh"><h2>🔑 Buat License</h2><button class="xbtn" onclick="closeModal('archCreateModal')">×</button></div>
    <form id="archCreateForm">
      <div class="fg"><label>Roblox Owner User ID <span>*</span></label><input type="number" id="acOwnerId" placeholder="contoh: 1234567890" required></div>
      <div class="fg"><label>Roblox Group ID <span>*</span></label><input type="number" id="acGroupId" placeholder="contoh: 9876543" required></div>
      <div class="mf">
        <button type="button" class="btn btn-sec" onclick="closeModal('archCreateModal')">Batal</button>
        <button type="submit" class="btn btn-g">✅ Buat License</button>
      </div>
    </form>
  </div>
</div>

<!-- ARCH: Edit License Modal -->
<div class="modal" id="archEditModal">
  <div class="mc" style="max-width:420px">
    <div class="mh"><h2>✏️ Edit License</h2><button class="xbtn" onclick="closeModal('archEditModal')">×</button></div>
    <form id="archEditForm">
      <input type="hidden" id="aeId">
      <div class="fg"><label>License Key</label><input type="text" id="aeKey" readonly style="opacity:.5"></div>
      <div class="fgrow">
        <div class="fg"><label>Owner User ID</label><input type="number" id="aeOwnerId"></div>
        <div class="fg"><label>Group ID</label><input type="number" id="aeGroupId"></div>
      </div>
      <div class="fg"><label>Status</label>
        <select id="aeEnabled"><option value="true">Enabled</option><option value="false">Disabled</option></select>
      </div>
      <div class="mf">
        <button type="button" class="btn btn-sec" onclick="closeModal('archEditModal')">Batal</button>
        <button type="submit" class="btn btn-g">✅ Simpan</button>
      </div>
    </form>
  </div>
</div>

<div class="container">
  <div class="header">
    <div><h1>🔐 Admin Dashboard</h1><p>Game & License Management</p></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-sec" onclick="location.reload()">🔄 Refresh</button>
      <button class="btn btn-sec" onclick="location.href='/'">🚪 Logout</button>
    </div>
  </div>

  <!-- TOP TABS -->
  <div class="top-tabs">
    <button class="ttab active" onclick="switchTop('webhook')">🎮 Webhook Games</button>
    <button class="ttab" onclick="switchTop('license')">🔑 ARCH License</button>
  </div>

  <!-- ════════════ WEBHOOK TAB ════════════ -->
  <div class="tpage active" id="tp-webhook">
    <div class="sgrid">
      <div class="scard"><div class="sv" id="aTotal">0</div><div class="sl">Total Games</div></div>
      <div class="scard"><div class="sv" id="aAllDon">0</div><div class="sl">Total Donasi</div></div>
      <div class="scard"><div class="sv" id="aAllAmt">—</div><div class="sl">Total Amount</div></div>
      <div class="scard"><div class="sv" style="font-size:22px">🟢 Online</div><div class="sl">Status</div></div>
    </div>
    <div class="card">
      <h2>👥 Game Management <button class="btn btn-g" onclick="openAddGame()">➕ Tambah Game</button></h2>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>ID</th><th>Nama Game</th><th>Universe ID</th><th>Webhook Secret</th><th>Donasi</th><th>Total</th><th>Last Active</th><th>Actions</th></tr></thead>
          <tbody id="uTbody"><tr><td colspan="8" style="text-align:center;padding:30px;color:#64748b">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>
    <div class="card" id="donCard" style="display:none">
      <h2 id="donCardTitle">📜 Donasi</h2>
      <div id="donCardContent"></div>
    </div>
  </div>

  <!-- ════════════ ARCH LICENSE TAB ════════════ -->
  <div class="tpage" id="tp-license">
    ${ARCH_LICENSE_URL ? `
    <!-- ARCH Auth State: hidden by default, shown after login -->
    <div id="archLoginBox" style="margin:40px auto;max-width:420px">
      <div class="arch-login">
        <h3>🔑 ARCH License System</h3>
        <p>Login ke ARCH backend untuk mengelola license</p>
        <div class="fg"><label>Username</label><input type="text" id="archUser" placeholder="admin"></div>
        <div class="fg"><label>Password</label><input type="password" id="archPass" placeholder="••••••••"></div>
        <p id="archLoginErr" style="color:#ef4444;font-size:13px;margin-bottom:10px;display:none"></p>
        <button class="btn" style="width:100%;justify-content:center" onclick="archLogin()">Sign In ke ARCH</button>
        <p style="color:#64748b;font-size:12px;margin-top:12px;text-align:center">ARCH Backend: <span style="color:#8b5cf6">${ARCH_LICENSE_URL}</span></p>
      </div>
    </div>
    <div id="archPanel" style="display:none">
      <!-- inner stats -->
      <div class="sgrid" style="grid-template-columns:repeat(4,1fr)">
        <div class="scard"><div class="sv" id="lsTotalLic">—</div><div class="sl">Total License</div></div>
        <div class="scard"><div class="sv" id="lsActiveLic" style="color:#10b981">—</div><div class="sl">Active</div></div>
        <div class="scard"><div class="sv" id="lsLiveSess" style="color:#a78bfa">—</div><div class="sl">Live Sessions</div></div>
        <div class="scard"><div class="sv" id="lsEvents" style="color:#f59e0b">—</div><div class="sl">Recent Events</div></div>
      </div>
      <!-- inner tabs -->
      <div class="itabs">
        <button class="itab active" onclick="switchArch('licenses')">⬡ Licenses</button>
        <button class="itab" onclick="switchArch('sessions')">◎ Sessions</button>
        <button class="itab" onclick="switchArch('logs')">≡ Logs</button>
      </div>
      <!-- Licenses -->
      <div class="ipage active" id="ip-licenses">
        <div class="card">
          <h2>⬡ Licenses <button class="btn btn-g" onclick="openArchCreate()">＋ Buat License</button></h2>
          <div class="tbl-wrap">
            <table>
              <thead><tr><th>License Key</th><th>Owner ID</th><th>Group ID</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
              <tbody id="licTbody"><tr><td colspan="6" style="text-align:center;padding:24px;color:#64748b">Loading…</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
      <!-- Sessions -->
      <div class="ipage" id="ip-sessions">
        <div class="card">
          <h2>◎ Sessions <button class="btn btn-sec btn-sm" onclick="archLoadSessions()">↻ Refresh</button></h2>
          <div class="tbl-wrap">
            <table>
              <thead><tr><th>License Key</th><th>Server ID</th><th>Token</th><th>Place ID</th><th>Expires</th><th>Status</th></tr></thead>
              <tbody id="sessTbody"><tr><td colspan="6" style="text-align:center;padding:24px;color:#64748b">Loading…</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
      <!-- Logs -->
      <div class="ipage" id="ip-logs">
        <div class="card">
          <h2>≡ Event Logs <button class="btn btn-sec btn-sm" onclick="archLoadLogs()">↻ Refresh</button></h2>
          <div class="tbl-wrap">
            <table>
              <thead><tr><th>Event</th><th>License ID</th><th>IP</th><th>Meta</th><th>Waktu</th></tr></thead>
              <tbody id="logsTbody"><tr><td colspan="5" style="text-align:center;padding:24px;color:#64748b">Loading…</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
    ` : `
    <div class="arch-no-url" style="margin:40px auto;max-width:500px">
      <div style="font-size:32px;margin-bottom:12px">⚠️</div>
      <p style="font-size:15px;font-weight:600;margin-bottom:8px">ARCH_LICENSE_URL belum diset</p>
      <p style="font-size:13px;color:#94a3b8">Tambahkan env var <code style="color:#f59e0b">ARCH_LICENSE_URL</code> di Railway service webhook ini dengan URL backend ARCH kamu.</p>
      <p style="font-size:12px;color:#64748b;margin-top:12px">Contoh: <code>https://archlicense-production.up.railway.app</code></p>
    </div>
    `}
  </div>
</div>

<script>
const TOKEN = ${JSON.stringify(token)};
const ARCH_URL = ${JSON.stringify(ARCH_LICENSE_URL)};
let pendingDeleteId = null;
let archToken = null;

// ─ toast ─────────────────────────────────────────────────────────────────────
function toast(msg, ok=true) {
  const e = document.getElementById(ok?'tOk':'tErr');
  e.textContent = msg; e.style.display = 'block';
  setTimeout(() => e.style.display = 'none', 4000);
}

// ─ utils ─────────────────────────────────────────────────────────────────────
function fmt(n){return new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',minimumFractionDigits:0}).format(n)}
function fmtDate(s){return s?new Date(s).toLocaleString('id-ID',{dateStyle:'short',timeStyle:'short'}):'—'}
function relTime(s){const d=Date.now()-new Date(s).getTime();if(d<60000)return'just now';if(d<3600000)return Math.floor(d/60000)+'m ago';if(d<86400000)return Math.floor(d/3600000)+'h ago';return Math.floor(d/86400000)+'d ago';}

// ─ top tab switch ─────────────────────────────────────────────────────────────
function switchTop(id) {
  document.querySelectorAll('.ttab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tpage').forEach(p=>p.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('tp-'+id).classList.add('active');
  if (id==='webhook') loadUsers();
  if (id==='license' && archToken) archLoadAll();
}

// ─ modal ─────────────────────────────────────────────────────────────────────
function closeModal(id){document.getElementById(id).classList.remove('active')}
function closeConfirm(){document.getElementById('confirmDel').classList.remove('active');pendingDeleteId=null}
['rpModal','gameModal','archCreateModal','archEditModal'].forEach(id=>{
  document.getElementById(id)?.addEventListener('click',e=>{if(e.target.id===id)closeModal(id)});
});
document.getElementById('confirmDel').addEventListener('click',e=>{if(e.target.id==='confirmDel')closeConfirm()});

// ══════════════════════════════════════════════════════════════════════════════
//  WEBHOOK GAMES
// ══════════════════════════════════════════════════════════════════════════════
async function loadUsers() {
  const r = await fetch('/api/admin/users?token='+encodeURIComponent(TOKEN));
  const d = await r.json();
  if (!d.success) return toast('Gagal load data', false);
  const users = d.users;
  document.getElementById('aTotal').textContent = users.length;
  document.getElementById('aAllDon').textContent = users.reduce((a,u)=>a+u.donationCount,0).toLocaleString();
  document.getElementById('aAllAmt').textContent = fmt(users.reduce((a,u)=>a+u.donationTotal,0));
  const tbody = document.getElementById('uTbody');
  if (!users.length){tbody.innerHTML='<tr><td colspan="8" style="text-align:center;padding:30px;color:#64748b">Belum ada game. Klik "Tambah Game".</td></tr>';return;}
  tbody.innerHTML = users.map(u=>\`
    <tr>
      <td><span class="badge bp" style="font-size:11px">\${u.id}</span></td>
      <td><strong>\${u.name}</strong></td>
      <td style="font-family:monospace;font-size:11px">\${u.universeId}</td>
      <td><span class="mono">\${u.webhookSecret}</span></td>
      <td><span class="badge bs">\${u.donationCount.toLocaleString()} tx</span></td>
      <td><strong style="color:#f59e0b">\${fmt(u.donationTotal)}</strong></td>
      <td style="font-size:12px;color:#64748b">\${fmtDate(u.lastActive)}</td>
      <td><div class="ac">
        <button class="btn btn-sm" style="font-size:11px;padding:5px 10px" onclick="viewDonations('\${u.id}','\${u.name}')">📜</button>
        <button class="btn btn-sec btn-sm" style="font-size:11px;padding:5px 10px" onclick="openEditGame('\${u.id}')">✏️</button>
        <button class="btn btn-warn btn-sm" style="font-size:11px;padding:5px 10px" onclick="openReset('\${u.id}','\${u.name}')">🔑</button>
        <button class="btn btn-d btn-sm" style="font-size:11px;padding:5px 10px" onclick="askDelete('\${u.id}','\${u.name}')">🗑️</button>
      </div></td>
    </tr>\`).join('');
}

function openAddGame(){
  document.getElementById('gmTitle').textContent='➕ Tambah Game Baru';
  document.getElementById('gmMode').value='add';document.getElementById('gmId').value='';
  document.getElementById('gmForm').reset();
  document.getElementById('gmSecretFg').style.display='';
  document.getElementById('gmPwdFg').style.display='';
  document.getElementById('gmPwdLabel').textContent='*';
  document.getElementById('gmPwd').required=true;
  document.getElementById('gmSubmit').textContent='✅ Tambah Game';
  document.getElementById('gameModal').classList.add('active');
}

async function openEditGame(gameId){
  const r=await fetch('/api/admin/users?token='+encodeURIComponent(TOKEN));
  const d=await r.json();
  if(!d.success)return toast('Gagal load data',false);
  const game=d.users.find(u=>u.id===gameId);
  if(!game)return toast('Game tidak ditemukan',false);
  document.getElementById('gmTitle').textContent='✏️ Edit: '+game.name;
  document.getElementById('gmMode').value='edit';document.getElementById('gmId').value=gameId;
  document.getElementById('gmName').value=game.name;document.getElementById('gmUid').value=game.universeId;
  document.getElementById('gmApiKey').value='';document.getElementById('gmTopic').value=game.topic||'';
  document.getElementById('gmSecretFg').style.display='none';
  document.getElementById('gmPwdFg').style.display='none';document.getElementById('gmPwd').required=false;
  document.getElementById('gmSaweria').value='';document.getElementById('gmSocialbuzz').value='';
  document.getElementById('gmSubmit').textContent='✅ Simpan Perubahan';
  document.getElementById('gameModal').classList.add('active');
}

function closeGameModal(){document.getElementById('gameModal').classList.remove('active');document.getElementById('gmForm').reset();}
function generatePwd(){const c='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';let p='';for(let i=0;i<10;i++)p+=c[Math.floor(Math.random()*c.length)];document.getElementById('gmPwd').value=p;document.getElementById('gmPwd').type='text';}

document.getElementById('gmForm').addEventListener('submit',async e=>{
  e.preventDefault();const mode=document.getElementById('gmMode').value;const btn=document.getElementById('gmSubmit');btn.disabled=true;btn.textContent='⏳ Menyimpan…';
  if(mode==='add'){
    const payload={token:TOKEN,name:document.getElementById('gmName').value.trim(),universeId:document.getElementById('gmUid').value.trim(),apiKey:document.getElementById('gmApiKey').value.trim(),topic:document.getElementById('gmTopic').value.trim(),webhookSecret:document.getElementById('gmSecret').value.trim(),password:document.getElementById('gmPwd').value,saweriaToken:document.getElementById('gmSaweria').value.trim(),socialbuzzToken:document.getElementById('gmSocialbuzz').value.trim()};
    const r=await fetch('/api/admin/games',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d=await r.json();
    if(d.success){toast('Game berhasil ditambahkan! 🎮');closeGameModal();loadUsers();}else toast(d.error||'Gagal',false);
  }else{
    const gameId=document.getElementById('gmId').value;
    const payload={token:TOKEN,name:document.getElementById('gmName').value.trim(),universeId:document.getElementById('gmUid').value.trim(),apiKey:document.getElementById('gmApiKey').value.trim(),topic:document.getElementById('gmTopic').value.trim(),saweriaToken:document.getElementById('gmSaweria').value.trim(),socialbuzzToken:document.getElementById('gmSocialbuzz').value.trim()};
    const r=await fetch('/api/admin/games/'+gameId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d=await r.json();
    if(d.success){toast('Game berhasil diupdate! ✅');closeGameModal();loadUsers();}else toast(d.error||'Gagal',false);
  }
  btn.disabled=false;btn.textContent=mode==='add'?'✅ Tambah Game':'✅ Simpan Perubahan';
});

function askDelete(gameId,name){pendingDeleteId=gameId;document.getElementById('confirmDelMsg').innerHTML='Yakin hapus <strong>"'+name+'"</strong>? Password dihapus, data donasi tetap tersimpan.';document.getElementById('confirmDel').classList.add('active');}
async function confirmDeleteGame(){if(!pendingDeleteId)return;const r=await fetch('/api/admin/games/'+pendingDeleteId+'?token='+encodeURIComponent(TOKEN),{method:'DELETE'});const d=await r.json();if(d.success){toast(d.message||'Game dihapus');closeConfirm();loadUsers();document.getElementById('donCard').style.display='none';}else{toast(d.error||'Gagal hapus',false);closeConfirm();}}

function openReset(id,name){document.getElementById('rpId').value=id;document.getElementById('rpName').value=name;document.getElementById('rpPwd').value='';document.getElementById('rpModal').classList.add('active');document.getElementById('rpPwd').focus();}
document.getElementById('rpForm').addEventListener('submit',async e=>{e.preventDefault();const id=document.getElementById('rpId').value,pwd=document.getElementById('rpPwd').value;if(pwd.length<6)return toast('Min. 6 karakter',false);const r=await fetch('/api/admin/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:TOKEN,gameId:id,newPassword:pwd})});const d=await r.json();if(d.success){toast('Password berhasil direset!');closeModal('rpModal');}else toast(d.error||'Gagal',false);});

async function viewDonations(gameId,gameName){
  const card=document.getElementById('donCard'),title=document.getElementById('donCardTitle'),content=document.getElementById('donCardContent');
  card.style.display='block';title.textContent='📜 Donasi — '+gameName;content.innerHTML='<p style="color:#64748b;padding:16px 0">Loading…</p>';card.scrollIntoView({behavior:'smooth',block:'start'});
  const r=await fetch('/api/admin/donations?token='+encodeURIComponent(TOKEN)+'&gameId='+gameId+'&limit=50&offset=0');
  const d=await r.json();
  if(!d.success||!d.donations.length){content.innerHTML='<p style="color:#64748b;padding:16px 0">Belum ada donasi</p>';return;}
  content.innerHTML=\`<div style="background:rgba(15,23,42,.6);border:1px solid rgba(139,92,246,.15);border-radius:12px;padding:20px"><div class="tbl-wrap"><table><thead><tr><th>#</th><th>Waktu</th><th>Username</th><th>Nama</th><th>Platform</th><th>Jumlah</th><th>Pesan</th></tr></thead><tbody>\${d.donations.map((x,i)=>\`<tr><td style="color:#64748b">\${i+1}</td><td style="white-space:nowrap">\${fmtDate(x.donated_at)}</td><td><strong style="color:#10b981">\${x.username}</strong></td><td style="color:#94a3b8">\${x.display_name||'—'}</td><td>\${x.source||'?'}</td><td><strong>\${fmt(x.amount)}</strong></td><td style="color:#94a3b8;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${x.message||'—'}</td></tr>\`).join('')}</tbody></table></div><p style="color:#64748b;font-size:12px;margin-top:12px">50 terbaru. Total: \${d.total}</p></div>\`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  ARCH LICENSE
// ══════════════════════════════════════════════════════════════════════════════
async function archApi(path, method='GET', body=null){
  const headers={'Content-Type':'application/json'};
  if(archToken)headers['Authorization']='Bearer '+archToken;
  const res=await fetch(ARCH_URL+path,{method,headers,body:body?JSON.stringify(body):undefined});
  const data=await res.json();
  if(!res.ok)throw new Error(data.error||'HTTP '+res.status);
  return data;
}

async function archLogin(){
  const u=document.getElementById('archUser').value.trim();
  const p=document.getElementById('archPass').value;
  const errEl=document.getElementById('archLoginErr');
  errEl.style.display='none';
  try{
    const d=await archApi('/api/admin/login','POST',{username:u,password:p});
    if(!d.token)throw new Error('No token returned');
    archToken=d.token;
    document.getElementById('archLoginBox').style.display='none';
    document.getElementById('archPanel').style.display='block';
    archLoadAll();
  }catch(e){errEl.textContent=e.message;errEl.style.display='block';}
}
document.getElementById('archPass')?.addEventListener('keydown',e=>{if(e.key==='Enter')archLogin();});

function switchArch(id){
  document.querySelectorAll('.itab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.ipage').forEach(p=>p.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('ip-'+id).classList.add('active');
  if(id==='licenses')archLoadLicenses();
  if(id==='sessions')archLoadSessions();
  if(id==='logs')archLoadLogs();
}

async function archLoadAll(){
  archLoadLicenses();
  try{
    const [lic,sess,logs]=await Promise.all([archApi('/api/admin/licenses'),archApi('/api/admin/sessions'),archApi('/api/admin/logs?limit=10')]);
    document.getElementById('lsTotalLic').textContent=lic.length;
    document.getElementById('lsActiveLic').textContent=lic.filter(l=>l.enabled).length;
    document.getElementById('lsLiveSess').textContent=sess.filter(s=>!s.revoked&&new Date(s.expires_at)>new Date()).length;
    document.getElementById('lsEvents').textContent=logs.length;
  }catch(e){console.error(e);}
}

async function archLoadLicenses(){
  const tbody=document.getElementById('licTbody');
  try{
    const lic=await archApi('/api/admin/licenses');
    if(!lic.length){tbody.innerHTML='<tr><td colspan="6" style="text-align:center;padding:24px;color:#64748b">Belum ada license. Klik "Buat License".</td></tr>';return;}
    tbody.innerHTML=lic.map(l=>\`<tr>
      <td><span class="mono">\${l.license_key}</span></td>
      <td style="font-family:monospace">\${l.owner_user_id}</td>
      <td style="font-family:monospace">\${l.group_id}</td>
      <td>\${l.enabled?'<span class="badge bs">Active</span>':'<span class="badge br">Disabled</span>'}</td>
      <td style="color:#64748b;font-size:12px">\${fmtDate(l.created_at)}</td>
      <td><div class="ac">
        <button class="btn btn-sec btn-sm" onclick='openArchEdit(\${JSON.stringify(l)})'>✏️ Edit</button>
        <button class="btn btn-d btn-sm" onclick="archDeleteLicense('\${l.id}')">🗑️</button>
      </div></td>
    </tr>\`).join('');
  }catch(e){toast('Gagal load licenses: '+e.message,false);}
}

async function archLoadSessions(){
  const tbody=document.getElementById('sessTbody');
  try{
    const sess=await archApi('/api/admin/sessions');
    if(!sess.length){tbody.innerHTML='<tr><td colspan="6" style="text-align:center;padding:24px;color:#64748b">Tidak ada session</td></tr>';return;}
    tbody.innerHTML=sess.map(s=>{
      const live=!s.revoked&&new Date(s.expires_at)>new Date();
      return \`<tr>
        <td><span class="mono">\${s.license_key}</span></td>
        <td style="font-size:11px;color:#64748b;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${s.server_id}</td>
        <td style="font-size:11px;color:#64748b">\${s.session_token.slice(0,12)}…</td>
        <td style="color:#94a3b8">\${s.place_id||'—'}</td>
        <td style="color:#94a3b8;font-size:12px">\${fmtDate(s.expires_at)}</td>
        <td>\${live?'<span class="badge bs">Live</span>':s.revoked?'<span class="badge br">Revoked</span>':'<span class="badge bg">Expired</span>'}</td>
      </tr>\`;
    }).join('');
  }catch(e){toast('Gagal load sessions: '+e.message,false);}
}

async function archLoadLogs(){
  const tbody=document.getElementById('logsTbody');
  try{
    const logs=await archApi('/api/admin/logs?limit=100');
    if(!logs.length){tbody.innerHTML='<tr><td colspan="5" style="text-align:center;padding:24px;color:#64748b">Belum ada log</td></tr>';return;}
    tbody.innerHTML=logs.map(l=>\`<tr>
      <td>\${archEventTag(l.event)}</td>
      <td style="font-size:11px;color:#64748b">\${l.license_id?l.license_id.slice(0,8)+'…':'—'}</td>
      <td style="color:#94a3b8">\${l.ip||'—'}</td>
      <td style="color:#94a3b8;font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${l.meta?JSON.stringify(l.meta):'—'}</td>
      <td style="color:#64748b;font-size:12px">\${relTime(l.created_at)}</td>
    </tr>\`).join('');
  }catch(e){toast('Gagal load logs: '+e.message,false);}
}

function archEventTag(ev){
  if(!ev)return'—';
  if(ev.includes('success'))return\`<span class="event-tag ev-ok">\${ev}</span>\`;
  if(ev.includes('reject')||ev.includes('revok'))return\`<span class="event-tag ev-err">\${ev}</span>\`;
  if(ev.includes('tamper')||ev.includes('warn'))return\`<span class="event-tag ev-warn">\${ev}</span>\`;
  return\`<span class="event-tag ev-info">\${ev}</span>\`;
}

function openArchCreate(){document.getElementById('acOwnerId').value='';document.getElementById('acGroupId').value='';document.getElementById('archCreateModal').classList.add('active');}
document.getElementById('archCreateForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const ownerUserId=parseInt(document.getElementById('acOwnerId').value);
  const groupId=parseInt(document.getElementById('acGroupId').value);
  if(!ownerUserId||!groupId)return toast('Kedua field wajib diisi',false);
  try{await archApi('/api/admin/licenses','POST',{ownerUserId,groupId});closeModal('archCreateModal');toast('License berhasil dibuat! 🎉');archLoadLicenses();archLoadAll();}
  catch(e){toast(e.message,false);}
});

function openArchEdit(l){
  document.getElementById('aeId').value=l.id;document.getElementById('aeKey').value=l.license_key;
  document.getElementById('aeOwnerId').value=l.owner_user_id;document.getElementById('aeGroupId').value=l.group_id;
  document.getElementById('aeEnabled').value=String(l.enabled);
  document.getElementById('archEditModal').classList.add('active');
}
document.getElementById('archEditForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const id=document.getElementById('aeId').value;
  try{
    await archApi('/api/admin/licenses/'+id,'PATCH',{ownerUserId:parseInt(document.getElementById('aeOwnerId').value),groupId:parseInt(document.getElementById('aeGroupId').value),enabled:document.getElementById('aeEnabled').value==='true'});
    closeModal('archEditModal');toast('License berhasil diupdate! ✅');archLoadLicenses();
  }catch(e){toast(e.message,false);}
});

async function archDeleteLicense(id){
  if(!confirm('Hapus license ini? Semua session terkait juga akan dihapus.'))return;
  try{await archApi('/api/admin/licenses/'+id,'DELETE');toast('License dihapus.');archLoadLicenses();archLoadAll();}
  catch(e){toast(e.message,false);}
}

// Init
loadUsers();
setInterval(loadUsers, 30000);
</script>
</body></html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
//  404
// ─────────────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─────────────────────────────────────────────────────────────────────────────
//  Auto-migrate & start
// ─────────────────────────────────────────────────────────────────────────────
async function autoMigrate() {
    const client = await pool.connect();
    try {
        console.log('🔄 Auto-migration running...');
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
        // Alter existing columns if table was already created with VARCHAR(255)
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
        console.error('❌ Migration error:', err.message);
        throw err;
    } finally {
        client.release();
    }
}

async function seedEnvGames() {
    const envGames = loadEnvGames();
    if (!envGames.length) {
        console.log('ℹ️  No env-based games to seed');
        return;
    }
    for (const g of envGames) {
        const exists = await dbGetGameById(g.id).catch(() => null);
        if (!exists) {
            try {
                await dbAddGame(g);
                await dbSetPassword(g.id, g.envPassword);
                console.log(`🌱 Seeded game from env: ${g.name} (${g.id})`);
            } catch (e) {
                console.error(`⚠️  Failed to seed ${g.id}:`, e.message);
            }
        } else {
            // Ensure password exists
            const pwd = await dbGetPassword(g.id).catch(() => null);
            if (!pwd) await dbSetPassword(g.id, g.envPassword).catch(() => {});
        }
    }
}

autoMigrate()
    .then(seedEnvGames)
    .then(async () => {
        const games = await dbGetAllGames();
        console.log(`🎮 Archie Webhook — ${games.length} game(s) in database`);
        games.forEach(g => console.log(`   📌 ${g.id}: ${g.name} (Universe: ${g.universeId})`));
        const db = readDB();
        app.listen(port, () => {
            console.log(`✅ Server running on port ${port}`);
            console.log(`👑 Admin: ${db.admin.username}`);
        });
    })
    .catch(err => {
        console.error('❌ Startup failed:', err.message);
        process.exit(1);
    });
