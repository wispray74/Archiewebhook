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
//  JSON flat-file fallback (users.json) — still used for admin credentials
// ─────────────────────────────────────────────────────────────────────────────
const VOLUME_PATH = process.env.VOLUME_PATH || __dirname;
const DB_FILE     = path.join(VOLUME_PATH, 'users.json');

if (process.env.VOLUME_PATH && !fs.existsSync(VOLUME_PATH)) {
    fs.mkdirSync(VOLUME_PATH, { recursive: true });
}

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
//  PostgreSQL helpers — passwords
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
        SELECT
            COUNT(*)            AS total_donations,
            COALESCE(SUM(amount),0) AS total_amount,
            COUNT(DISTINCT username) AS unique_donors
        FROM donations WHERE game_id = $1
    `, [gameId]);

    const byUser = await pool.query(`
        SELECT
            username,
            display_name,
            COUNT(*)            AS donation_count,
            SUM(amount)         AS total_amount,
            MAX(donated_at)     AS last_donation
        FROM donations
        WHERE game_id = $1
        GROUP BY username, display_name
        ORDER BY total_amount DESC
        LIMIT 20
    `, [gameId]);

    const recent7 = await pool.query(`
        SELECT
            DATE(donated_at) AS day,
            COUNT(*)         AS donations,
            SUM(amount)      AS amount
        FROM donations
        WHERE game_id = $1 AND donated_at >= NOW() - INTERVAL '7 days'
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
//  Game initialisation — passwords synced from env ➜ PostgreSQL on start
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
            id: `game${i}`,
            name:           process.env[`GAME_${i}_NAME`] || `Game ${i}`,
            universeId:     uid,
            apiKey:         key,
            topic:          process.env[`GAME_${i}_TOPIC`] || 'ArchieDonationIDR',
            webhookSecret:  sec,
            envPassword:    pwd,           // from env (fallback)
            saweriaToken:   process.env[`GAME_${i}_SAWERIA_TOKEN`],
            socialbuzzToken: process.env[`GAME_${i}_SOCIALBUZZ_TOKEN`]
        });
        i++;
    }
    return games;
}

// GAMES array — passwords loaded lazily from PostgreSQL
let GAMES = loadEnvGames();

// Passwords seeded after auto-migration (see autoMigrate() at bottom)

if (!GAMES.length) {
    console.error('❌ No games configured! Set GAME_1_UNIVERSE_ID, GAME_1_API_KEY, GAME_1_WEBHOOK_SECRET, GAME_1_PASSWORD');
    process.exit(1);
}
console.log(`🎮 Archie Webhook — ${GAMES.length} game(s) configured`);
GAMES.forEach(g => console.log(`   📌 ${g.id}: ${g.name} (Universe: ${g.universeId})`));

// ─────────────────────────────────────────────────────────────────────────────
//  Auth helpers
// ─────────────────────────────────────────────────────────────────────────────
async function authenticateGame(password) {
    for (const game of GAMES) {
        const pwd = await dbGetPassword(game.id).catch(() => game.envPassword);
        if (pwd && pwd === password) return game;
    }
    return null;
}

function authenticateAdmin(username, password) {
    const db = readDB();
    return db.admin.username === username && db.admin.password === password;
}

async function updateGameLastActive(gameId) {
    await pool.query(
        `UPDATE game_passwords SET updated_at = NOW() WHERE game_id = $1`,
        [gameId]
    ).catch(() => {});
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
//  Webhook routes
// ─────────────────────────────────────────────────────────────────────────────
GAMES.forEach(game => {

    // ── Saweria ──────────────────────────────────────────────────────────────
    app.post(`/${game.webhookSecret}/saweria`, async (req, res) => {
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

    // ── SocialBuzz ───────────────────────────────────────────────────────────
    app.post(`/${game.webhookSecret}/socialbuzz`, async (req, res) => {
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

    // ── Test ─────────────────────────────────────────────────────────────────
    app.post(`/${game.webhookSecret}/test`, async (req, res) => {
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
function adminFromToken(token) {
    try {
        const [u, p] = Buffer.from(token, 'base64').toString().split(':');
        return authenticateAdmin(u, p) ? { username: u } : null;
    } catch { return null; }
}

app.get('/api/admin/users', async (req, res) => {
    if (!adminFromToken(req.query.token || ''))
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    const users = await Promise.all(GAMES.map(async g => {
        const { rows } = await pool.query('SELECT updated_at FROM game_passwords WHERE game_id=$1', [g.id]).catch(() => ({ rows: [] }));
        const { rows: stats } = await pool.query('SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total FROM donations WHERE game_id=$1', [g.id]).catch(() => ({ rows: [{ cnt:0, total:0 }] }));
        return {
            id:         g.id,
            name:       g.name,
            universeId: g.universeId,
            lastActive: rows[0]?.updated_at || null,
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
    const game = GAMES.find(g => g.id === gameId);
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
    const game   = GAMES.find(g => g.id === gameId);
    if (!game) return res.json({ success: false, error: 'Game tidak ditemukan' });
    const [rows, total] = await Promise.all([
        dbGetDonations(gameId, { limit, offset, search }),
        dbCountDonations(gameId, search)
    ]);
    res.json({ success: true, donations: rows, total });
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
    /* ─ header ─ */
    .header{background:linear-gradient(135deg,rgba(139,92,246,.2),rgba(59,130,246,.2));border:1px solid rgba(139,92,246,.3);border-radius:20px;padding:28px 32px;margin-bottom:28px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px}
    .header h1{font-size:28px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .header p{color:#94a3b8;font-size:13px;margin-top:4px}
    .hbtns{display:flex;gap:10px;flex-wrap:wrap}
    /* ─ nav tabs ─ */
    .nav{display:flex;gap:10px;margin-bottom:24px;border-bottom:1px solid rgba(139,92,246,.15);padding-bottom:0}
    .ntab{padding:10px 20px;background:none;border:none;border-bottom:2px solid transparent;color:#94a3b8;font-size:14px;font-weight:600;cursor:pointer;transition:all .3s;border-radius:8px 8px 0 0}
    .ntab.active{color:#8b5cf6;border-bottom-color:#8b5cf6;background:rgba(139,92,246,.1)}
    .ntab:hover{color:#8b5cf6}
    .page{display:none}.page.active{display:block}
    /* ─ card ─ */
    .card{background:rgba(15,23,42,.8);border:1px solid rgba(139,92,246,.2);border-radius:16px;padding:24px;margin-bottom:20px;backdrop-filter:blur(10px)}
    .card h3{color:#8b5cf6;font-size:17px;margin-bottom:18px;display:flex;align-items:center;gap:8px}
    /* ─ stat grid ─ */
    .sgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:20px}
    .scard{background:rgba(15,23,42,.8);border:1px solid rgba(139,92,246,.2);border-radius:14px;padding:20px;text-align:center}
    .scard .sv{font-size:30px;font-weight:700;background:linear-gradient(135deg,#8b5cf6,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px}
    .scard .sl{color:#94a3b8;font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:.5px}
    /* ─ info row ─ */
    .ir{display:flex;justify-content:space-between;padding:11px 0;border-bottom:1px solid rgba(139,92,246,.08);align-items:center;font-size:14px}
    .ir:last-child{border:none}
    .il{color:#94a3b8}.iv{color:#fff;font-weight:500}
    /* ─ url box ─ */
    .ub{background:rgba(0,0,0,.3);border:1px solid rgba(139,92,246,.2);border-radius:10px;padding:14px;margin:10px 0}
    .ul{color:#8b5cf6;font-size:12px;font-weight:600;text-transform:uppercase;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}
    .ut{color:#10b981;font-family:'Courier New',monospace;font-size:12px;word-break:break-all;padding:10px;background:rgba(0,0,0,.4);border-radius:6px}
    /* ─ buttons ─ */
    .btn{padding:9px 18px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all .3s;display:inline-flex;align-items:center;gap:5px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:#fff}
    .btn:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(139,92,246,.4)}
    .btn-sm{padding:6px 14px;font-size:12px}
    .btn-sec{background:rgba(139,92,246,.2);border:1px solid rgba(139,92,246,.4)}
    .btn-sec:hover{background:rgba(139,92,246,.3)}
    /* ─ badge ─ */
    .badge{display:inline-block;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:600}
    .bs{background:rgba(16,185,129,.15);color:#10b981;border:1px solid rgba(16,185,129,.3)}
    .bw{background:rgba(245,158,11,.15);color:#f59e0b;border:1px solid rgba(245,158,11,.3)}
    .bp{background:rgba(139,92,246,.15);color:#8b5cf6;border:1px solid rgba(139,92,246,.3)}
    /* ─ table ─ */
    .tbl-wrap{overflow-x:auto}
    table{width:100%;border-collapse:collapse;font-size:13px}
    thead{background:rgba(139,92,246,.1)}
    th{padding:12px 14px;text-align:left;color:#8b5cf6;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.4px}
    td{padding:12px 14px;color:#cbd5e1;border-bottom:1px solid rgba(139,92,246,.08)}
    tr:last-child td{border:none}
    tr:hover td{background:rgba(139,92,246,.04)}
    /* ─ search bar ─ */
    .sbar{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap}
    .sbar input{flex:1;min-width:180px;padding:10px 14px;background:rgba(15,23,42,.6);border:1.5px solid rgba(139,92,246,.2);border-radius:8px;color:#fff;font-size:13px;outline:none}
    .sbar input:focus{border-color:#8b5cf6}
    /* ─ pagination ─ */
    .pag{display:flex;justify-content:center;align-items:center;gap:8px;margin-top:16px;font-size:13px}
    .pag button{padding:6px 14px;font-size:12px}
    .pag span{color:#94a3b8}
    /* ─ chart bar ─ */
    .chart{display:flex;align-items:flex-end;gap:6px;height:80px;margin-top:8px}
    .bar-wrap{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px}
    .bar{width:100%;background:linear-gradient(to top,#8b5cf6,#3b82f6);border-radius:4px 4px 0 0;min-height:2px;transition:height .5s}
    .bar-label{color:#64748b;font-size:10px;text-align:center}
    /* ─ modal ─ */
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
    /* ─ toast ─ */
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

<!-- Change Password Modal -->
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
    <div>
      <h1>🎮 ${game.name}</h1>
      <p>Webhook Integration Dashboard</p>
    </div>
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

  <!-- OVERVIEW -->
  <div class="page active" id="p-overview">
    <div class="sgrid" id="statCards">
      <div class="scard"><div class="sv" id="sTotalAmount">—</div><div class="sl">Total Donasi</div></div>
      <div class="scard"><div class="sv" id="sTotalCount">—</div><div class="sl">Jumlah Transaksi</div></div>
      <div class="scard"><div class="sv" id="sUniqueDonors">—</div><div class="sl">Donatur Unik</div></div>
    </div>
    <div class="card">
      <h3>📈 Donasi 7 Hari Terakhir</h3>
      <div class="chart" id="weekChart"><p style="color:#64748b;font-size:13px">Loading…</p></div>
    </div>
    <div class="card">
      <h3>📋 Informasi Game</h3>
      <div class="ir"><span class="il">Universe ID</span><span class="iv">${game.universeId}</span></div>
      <div class="ir"><span class="il">Topic</span><span class="iv">${game.topic}</span></div>
      <div class="ir"><span class="il">Saweria Token</span><span class="iv"><span class="badge ${game.saweriaToken ? 'bs' : 'bw'}">${game.saweriaToken ? '✓ Set' : '⚠ Optional'}</span></span></div>
      <div class="ir"><span class="il">SocialBuzz Token</span><span class="iv"><span class="badge ${game.socialbuzzToken ? 'bs' : 'bw'}">${game.socialbuzzToken ? '✓ Set' : '⚠ Optional'}</span></span></div>
    </div>
  </div>

  <!-- HISTORY -->
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

  <!-- LEADERBOARD -->
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

  <!-- SETTINGS -->
  <div class="page" id="p-settings">
    <div class="card">
      <h3>🔗 Webhook URLs</h3>
      <p style="color:#94a3b8;font-size:13px;margin-bottom:18px">Gunakan URL berikut di Saweria / SocialBuzz. Klik Copy untuk menyalin.</p>
      <div class="ub">
        <div class="ul"><span>📡 Saweria Webhook</span><button class="btn btn-sm" onclick="copy('sawURL')">📋 Copy</button></div>
        <div class="ut" id="sawURL">${baseUrl}/${game.webhookSecret}/saweria</div>
      </div>
      <div class="ub">
        <div class="ul"><span>📡 SocialBuzz Webhook</span><button class="btn btn-sm" onclick="copy('sbURL')">📋 Copy</button></div>
        <div class="ut" id="sbURL">${baseUrl}/${game.webhookSecret}/socialbuzz</div>
      </div>
      <div class="ub">
        <div class="ul"><span>🧪 Test Endpoint</span><button class="btn btn-sm" onclick="copy('testURL')">📋 Copy</button></div>
        <div class="ut" id="testURL">${baseUrl}/${game.webhookSecret}/test?password=${encodeURIComponent(password)}</div>
      </div>
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
</div><!-- /container -->

<script>
const PWD = ${JSON.stringify(password)};
let donPage = 0, donTotal = 0, donLimit = 50, searchTimer = null;

// ─ navigation ─
function switchPage(id) {
  document.querySelectorAll('.ntab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  const idx = {overview:0,history:1,leaderboard:2,settings:3}[id];
  document.querySelectorAll('.ntab')[idx].classList.add('active');
  document.getElementById('p-'+id).classList.add('active');
  if(id==='history' && document.getElementById('donTbody').innerHTML.includes('Loading')) loadDonations(0);
  if(id==='leaderboard' && document.getElementById('lbTbody').innerHTML.includes('Loading')) loadLeaderboard();
  if(id==='overview' && document.getElementById('sTotalAmount').textContent==='—') loadStats();
}

// ─ utils ─
function fmt(n){return new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',minimumFractionDigits:0}).format(n)}
function fmtDate(s){return new Date(s).toLocaleString('id-ID',{dateStyle:'short',timeStyle:'short'})}
function toast(msg,ok=true){const el=document.getElementById(ok?'tOk':'tErr');el.textContent=msg;el.style.display='block';setTimeout(()=>el.style.display='none',3000)}
function copy(id){navigator.clipboard.writeText(document.getElementById(id).textContent).then(()=>toast('URL disalin!')).catch(()=>toast('Gagal copy','err'))}
function sourceBadge(s){const m={Saweria:'bs',SocialBuzz:'bp',Test:'bw'};return '<span class="badge '+(m[s]||'bw')+'">'+s+'</span>'}
function closeModal(){document.getElementById('cpModal').classList.remove('active')}
function debounceSearch(){clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadDonations(0),400)}

// ─ stats ─
async function loadStats() {
  try {
    const r = await fetch('/api/user/donations/stats?password='+encodeURIComponent(PWD));
    const d = await r.json();
    if(!d.success) return;
    document.getElementById('sTotalAmount').textContent = fmt(d.totals.total_amount||0);
    document.getElementById('sTotalCount').textContent  = (d.totals.total_donations||0).toLocaleString();
    document.getElementById('sUniqueDonors').textContent= (d.totals.unique_donors||0).toLocaleString();
    // week chart
    const days = d.recent7 || [];
    if(days.length===0){document.getElementById('weekChart').innerHTML='<p style="color:#64748b;font-size:13px">Belum ada data minggu ini</p>';return;}
    const max = Math.max(...days.map(x=>parseInt(x.amount)||0), 1);
    document.getElementById('weekChart').innerHTML = days.map(day=>{
      const pct = Math.max(4, Math.round((parseInt(day.amount)||0)/max*100));
      const label = new Date(day.day).toLocaleDateString('id-ID',{weekday:'short',day:'numeric'});
      return \`<div class="bar-wrap"><div class="bar" style="height:\${pct}%" title="\${fmt(day.amount)}"></div><div class="bar-label">\${label}</div></div>\`;
    }).join('');
  } catch(e){ console.error(e); }
}

// ─ donations table ─
async function loadDonations(offset=0) {
  donPage = offset;
  const search = document.getElementById('searchInput').value.trim();
  const tbody = document.getElementById('donTbody');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:#64748b">Loading…</td></tr>';
  try {
    const url = \`/api/user/donations?password=\${encodeURIComponent(PWD)}&limit=\${donLimit}&offset=\${offset}&search=\${encodeURIComponent(search)}\`;
    const r = await fetch(url);
    const d = await r.json();
    if(!d.success){tbody.innerHTML='<tr><td colspan="7" style="text-align:center;color:#ef4444">Error loading data</td></tr>';return;}
    donTotal = d.total;
    if(!d.donations.length){tbody.innerHTML='<tr><td colspan="7" style="text-align:center;padding:30px;color:#64748b">Belum ada donasi</td></tr>';renderPagination();return;}
    tbody.innerHTML = d.donations.map((don,i)=>\`
      <tr>
        <td style="color:#64748b">\${offset+i+1}</td>
        <td style="white-space:nowrap">\${fmtDate(don.donated_at)}</td>
        <td><strong style="color:#10b981">\${don.username}</strong></td>
        <td style="color:#94a3b8">\${don.display_name||'—'}</td>
        <td>\${sourceBadge(don.source||'?')}</td>
        <td><strong>\${fmt(don.amount)}</strong></td>
        <td style="color:#94a3b8;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${(don.message||'').replace(/"/g,'&quot;')}">\${don.message||'—'}</td>
      </tr>\`).join('');
    renderPagination();
  } catch(e){ tbody.innerHTML='<tr><td colspan="7" style="text-align:center;color:#ef4444">Connection error</td></tr>'; }
}

function renderPagination() {
  const total = donTotal, pages = Math.ceil(total/donLimit), cur = Math.floor(donPage/donLimit);
  const el = document.getElementById('pagination');
  if(pages<=1){el.innerHTML='';return;}
  el.innerHTML = \`
    <button class="btn btn-sm btn-sec" \${cur===0?'disabled':''} onclick="loadDonations(\${(cur-1)*donLimit})">‹ Prev</button>
    <span>\${cur+1} / \${pages} (Total: \${total.toLocaleString()})</span>
    <button class="btn btn-sm btn-sec" \${cur>=pages-1?'disabled':''} onclick="loadDonations(\${(cur+1)*donLimit})">Next ›</button>
  \`;
}

// ─ leaderboard ─
async function loadLeaderboard() {
  const tbody = document.getElementById('lbTbody');
  try {
    const r = await fetch('/api/user/donations/stats?password='+encodeURIComponent(PWD));
    const d = await r.json();
    if(!d.success||!d.byUser.length){tbody.innerHTML='<tr><td colspan="6" style="text-align:center;padding:30px;color:#64748b">Belum ada data</td></tr>';return;}
    const medals = ['🥇','🥈','🥉'];
    tbody.innerHTML = d.byUser.map((u,i)=>\`
      <tr>
        <td><strong style="font-size:18px">\${medals[i]||('#'+(i+1))}</strong></td>
        <td><strong style="color:#10b981">\${u.username}</strong></td>
        <td style="color:#94a3b8">\${u.display_name||'—'}</td>
        <td><span class="badge bp">\${u.donation_count}×</span></td>
        <td><strong style="color:#f59e0b">\${fmt(u.total_amount)}</strong></td>
        <td style="color:#64748b;font-size:12px">\${fmtDate(u.last_donation)}</td>
      </tr>\`).join('');
  } catch(e){ tbody.innerHTML='<tr><td colspan="6" style="text-align:center;color:#ef4444">Error</td></tr>'; }
}

// ─ export CSV ─
async function exportCSV() {
  try {
    toast('Mengambil data untuk export…');
    const r = await fetch(\`/api/user/donations?password=\${encodeURIComponent(PWD)}&limit=5000&offset=0\`);
    const d = await r.json();
    if(!d.success) return toast('Gagal export','err');
    const header = 'No,Waktu,Username,Nama,Platform,Jumlah,Pesan';
    const rows = d.donations.map((x,i)=>[i+1,new Date(x.donated_at).toISOString(),x.username,x.display_name,x.source,x.amount,(x.message||'').replace(/,/g,' ')].join(','));
    const csv = [header,...rows].join('\\n');
    const blob = new Blob([csv],{type:'text/csv'});
    const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='donasi_'+Date.now()+'.csv'; a.click();
    toast('Export berhasil!');
  } catch(e){ toast('Gagal export','err'); }
}

// ─ change password ─
document.getElementById('cpForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const cur = document.getElementById('cpCur').value;
  const nw  = document.getElementById('cpNew').value;
  const con = document.getElementById('cpCon').value;
  if(nw!==con) return toast('Password baru tidak cocok','err');
  if(nw.length<6) return toast('Minimal 6 karakter','err');
  const r = await fetch('/api/user/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:cur,newPassword:nw})});
  const d = await r.json();
  if(d.success){toast('Password berhasil diubah! Redirecting…');setTimeout(()=>location.href='/dashboard?password='+encodeURIComponent(nw),2000);}
  else toast(d.error||'Gagal','err');
});
document.getElementById('cpModal').addEventListener('click',e=>{if(e.target.id==='cpModal')closeModal();});

// init
loadStats();
</script>
</body></html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Admin Dashboard
// ─────────────────────────────────────────────────────────────────────────────
app.get('/admin/dashboard', (req, res) => {
    const token = req.query.token;
    if (!token || !adminFromToken(token)) return res.redirect('/');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin Dashboard — Archie Webhook</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0e27;color:#fff;min-height:100vh;padding:20px}
    .container{max-width:1200px;margin:0 auto}
    .header{background:linear-gradient(135deg,rgba(139,92,246,.2),rgba(59,130,246,.2));border:1px solid rgba(139,92,246,.3);border-radius:20px;padding:28px 32px;margin-bottom:28px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px}
    .header h1{font-size:28px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .header p{color:#94a3b8;font-size:13px;margin-top:4px}
    .sgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
    .scard{background:rgba(15,23,42,.8);border:1px solid rgba(139,92,246,.2);border-radius:14px;padding:20px;text-align:center}
    .scard .sv{font-size:32px;font-weight:700;background:linear-gradient(135deg,#8b5cf6,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px}
    .scard .sl{color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
    .card{background:rgba(15,23,42,.8);border:1px solid rgba(139,92,246,.2);border-radius:16px;padding:24px;margin-bottom:20px}
    .card h2{color:#8b5cf6;font-size:20px;margin-bottom:20px}
    .tbl-wrap{overflow-x:auto}
    table{width:100%;border-collapse:collapse;font-size:13px}
    thead{background:rgba(139,92,246,.1)}
    th{padding:12px 14px;text-align:left;color:#8b5cf6;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.4px}
    td{padding:12px 14px;color:#cbd5e1;border-bottom:1px solid rgba(139,92,246,.08)}
    tr:last-child td{border:none}
    tr:hover td{background:rgba(139,92,246,.04)}
    .btn{padding:8px 16px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all .3s;display:inline-flex;align-items:center;gap:5px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:#fff}
    .btn:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(139,92,246,.4)}
    .btn-d{background:linear-gradient(135deg,#ef4444,#dc2626)}
    .btn-sec{background:rgba(139,92,246,.2);border:1px solid rgba(139,92,246,.4)}
    .badge{display:inline-block;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:600}
    .bs{background:rgba(16,185,129,.15);color:#10b981;border:1px solid rgba(16,185,129,.3)}
    .bp{background:rgba(139,92,246,.15);color:#8b5cf6;border:1px solid rgba(139,92,246,.3)}
    .modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(5px);z-index:1000;justify-content:center;align-items:center;padding:20px}
    .modal.active{display:flex}
    .mc{background:rgba(15,23,42,.95);border:1px solid rgba(139,92,246,.3);border-radius:20px;padding:32px;max-width:480px;width:100%}
    .mh{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}
    .mh h2{color:#8b5cf6;font-size:22px}
    .xbtn{background:none;border:none;color:#94a3b8;font-size:22px;cursor:pointer;width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:6px;transition:all .3s}
    .xbtn:hover{background:rgba(139,92,246,.2);color:#8b5cf6}
    .fg{margin-bottom:16px}
    .fg label{display:block;color:#cbd5e1;font-size:14px;font-weight:500;margin-bottom:7px}
    .fg input{width:100%;padding:11px 14px;background:rgba(15,23,42,.6);border:2px solid rgba(139,92,246,.2);border-radius:9px;color:#fff;font-size:14px;outline:none;transition:all .3s}
    .fg input:focus{border-color:#8b5cf6}
    .mf{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}
    .toast{position:fixed;top:20px;right:20px;padding:14px 22px;border-radius:12px;font-weight:600;display:none;z-index:2000}
    .tOk{background:rgba(16,185,129,.9);color:#fff}
    .tErr{background:rgba(239,68,68,.9);color:#fff}
    /* donation panel */
    .don-panel{background:rgba(15,23,42,.6);border:1px solid rgba(139,92,246,.15);border-radius:12px;padding:20px;margin-top:12px}
    .don-panel table th{font-size:11px}
  </style>
</head>
<body>
<div class="toast tOk" id="tOk"></div>
<div class="toast tErr" id="tErr"></div>

<!-- Reset Password Modal -->
<div class="modal" id="rpModal">
  <div class="mc">
    <div class="mh"><h2>🔐 Reset Password</h2><button class="xbtn" onclick="closeModal()">×</button></div>
    <form id="rpForm">
      <input type="hidden" id="rpId">
      <div class="fg"><label>Game</label><input type="text" id="rpName" readonly style="opacity:.7"></div>
      <div class="fg"><label>Password Baru</label><input type="text" id="rpPwd" minlength="6" placeholder="Min. 6 karakter" required></div>
      <div class="mf">
        <button type="button" class="btn btn-sec" onclick="closeModal()">Batal</button>
        <button type="submit" class="btn btn-d">Reset</button>
      </div>
    </form>
  </div>
</div>

<div class="container">
  <div class="header">
    <div><h1>🔐 Admin Dashboard</h1><p>User Management & System Overview</p></div>
    <button class="btn btn-sec" onclick="location.href='/'">🚪 Logout</button>
  </div>

  <div class="sgrid">
    <div class="scard"><div class="sv" id="aTotal">0</div><div class="sl">Total Games</div></div>
    <div class="scard"><div class="sv" id="aAllDon">0</div><div class="sl">Total Donasi Masuk</div></div>
    <div class="scard"><div class="sv" id="aAllAmt">—</div><div class="sl">Total Amount</div></div>
    <div class="scard"><div class="sv" style="font-size:22px">🟢 Online</div><div class="sl">System Status</div></div>
  </div>

  <div class="card">
    <h2>👥 User Management</h2>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>ID</th><th>Nama Game</th><th>Universe ID</th><th>Donasi</th><th>Total Amount</th><th>Last Active</th><th>Actions</th></tr></thead>
        <tbody id="uTbody"><tr><td colspan="7" style="text-align:center;padding:30px;color:#64748b">Loading…</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- Donation preview per game -->
  <div class="card" id="donCard" style="display:none">
    <h2 id="donCardTitle">📜 Donasi — </h2>
    <div id="donCardContent"></div>
  </div>
</div>

<script>
const TOKEN = ${JSON.stringify(token)};
function toast(msg,ok=true){const e=document.getElementById(ok?'tOk':'tErr');e.textContent=msg;e.style.display='block';setTimeout(()=>e.style.display='none',3000)}
function fmt(n){return new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',minimumFractionDigits:0}).format(n)}
function fmtDate(s){return s?new Date(s).toLocaleString('id-ID',{dateStyle:'short',timeStyle:'short'}):'—'}
function closeModal(){document.getElementById('rpModal').classList.remove('active')}
function openReset(id,name){document.getElementById('rpId').value=id;document.getElementById('rpName').value=name;document.getElementById('rpPwd').value='';document.getElementById('rpModal').classList.add('active');document.getElementById('rpPwd').focus()}

async function loadUsers() {
  const r = await fetch('/api/admin/users?token='+encodeURIComponent(TOKEN));
  const d = await r.json();
  if(!d.success) return;
  const users = d.users;
  document.getElementById('aTotal').textContent = users.length;
  const allDon = users.reduce((a,u)=>a+u.donationCount,0);
  const allAmt = users.reduce((a,u)=>a+u.donationTotal,0);
  document.getElementById('aAllDon').textContent = allDon.toLocaleString();
  document.getElementById('aAllAmt').textContent = fmt(allAmt);
  const tbody = document.getElementById('uTbody');
  if(!users.length){tbody.innerHTML='<tr><td colspan="7" style="text-align:center;padding:30px;color:#64748b">No users</td></tr>';return;}
  tbody.innerHTML = users.map(u=>\`
    <tr>
      <td><span class="badge bp">\${u.id}</span></td>
      <td><strong>\${u.name}</strong></td>
      <td style="font-family:monospace;font-size:12px">\${u.universeId}</td>
      <td><span class="badge bs">\${u.donationCount.toLocaleString()} tx</span></td>
      <td><strong style="color:#f59e0b">\${fmt(u.donationTotal)}</strong></td>
      <td style="font-size:12px;color:#64748b">\${fmtDate(u.lastActive)}</td>
      <td style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" style="font-size:12px;padding:6px 12px" onclick="viewDonations('\${u.id}','\${u.name}')">📜 History</button>
        <button class="btn btn-d" style="font-size:12px;padding:6px 12px" onclick="openReset('\${u.id}','\${u.name}')">🔑 Reset</button>
      </td>
    </tr>\`).join('');
}

async function viewDonations(gameId, gameName) {
  const card = document.getElementById('donCard');
  const title = document.getElementById('donCardTitle');
  const content = document.getElementById('donCardContent');
  card.style.display='block';
  title.textContent = '📜 Donasi — '+gameName;
  content.innerHTML='<p style="color:#64748b;padding:16px 0">Loading…</p>';
  card.scrollIntoView({behavior:'smooth',block:'start'});
  const r = await fetch(\`/api/admin/donations?token=\${encodeURIComponent(TOKEN)}&gameId=\${gameId}&limit=50&offset=0\`);
  const d = await r.json();
  if(!d.success||!d.donations.length){content.innerHTML='<p style="color:#64748b;padding:16px 0">Belum ada donasi</p>';return;}
  content.innerHTML=\`<div class="don-panel"><div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Waktu</th><th>Username</th><th>Nama</th><th>Platform</th><th>Jumlah</th><th>Pesan</th></tr></thead>
    <tbody>\${d.donations.map((x,i)=>\`
      <tr>
        <td style="color:#64748b">\${i+1}</td>
        <td style="white-space:nowrap">\${fmtDate(x.donated_at)}</td>
        <td><strong style="color:#10b981">\${x.username}</strong></td>
        <td style="color:#94a3b8">\${x.display_name||'—'}</td>
        <td>\${x.source||'?'}</td>
        <td><strong>\${fmt(x.amount)}</strong></td>
        <td style="color:#94a3b8;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${x.message||'—'}</td>
      </tr>\`).join('')}
    </tbody></table></div><p style="color:#64748b;font-size:12px;margin-top:12px">Menampilkan 50 terbaru. Total: \${d.total}</p></div>\`;
}

document.getElementById('rpForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const id=document.getElementById('rpId').value, pwd=document.getElementById('rpPwd').value;
  if(pwd.length<6) return toast('Min. 6 karakter','err');
  const r=await fetch('/api/admin/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:TOKEN,gameId:id,newPassword:pwd})});
  const d=await r.json();
  if(d.success){toast('Password berhasil direset!');closeModal();}else toast(d.error||'Gagal','err');
});
document.getElementById('rpModal').addEventListener('click',e=>{if(e.target.id==='rpModal')closeModal();});

loadUsers();
setInterval(loadUsers,30000);
</script>
</body></html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
//  404
// ─────────────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─────────────────────────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────────────────────────
async function autoMigrate() {
    const client = await pool.connect();
    try {
        console.log('🔄 Auto-migration running...');
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
        console.log('✅ Migration done');
    } catch (err) {
        console.error('❌ Migration error:', err.message);
        throw err;
    } finally {
        client.release();
    }
}

autoMigrate()
    .then(() => Promise.all(GAMES.map(async g => {
        const existing = await dbGetPassword(g.id).catch(() => null);
        if (!existing) await dbSetPassword(g.id, g.envPassword).catch(() => {});
    })))
    .then(() => {
        app.listen(port, () => {
            console.log(`✅ Server running on port ${port}`);
            console.log(`🎮 Games: ${GAMES.map(g => g.name).join(', ')}`);
            const db = readDB();
            console.log(`👑 Admin: ${db.admin.username}`);
        });
    })
    .catch(err => {
        console.error('❌ Startup failed:', err.message);
        process.exit(1);
    });
