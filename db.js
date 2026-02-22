const { Pool } = require('pg');

// Debug: cetak semua env vars yg berhubungan PG/POSTGRES/DATABASE
const pgKeys = Object.keys(process.env).filter(k => /^(PG|POSTGRES|DATABASE)/i.test(k));
console.log('🔍 PG-related env vars:', pgKeys.length ? pgKeys.join(', ') : '(none)');

// Railway kadang inject dengan nama berbeda — coba semua kemungkinan
const host     = process.env.PGHOST         || process.env.POSTGRES_HOST     || process.env.DB_HOST;
const port     = process.env.PGPORT         || process.env.POSTGRES_PORT     || process.env.DB_PORT     || '5432';
const user     = process.env.PGUSER         || process.env.POSTGRES_USER     || process.env.POSTGRES_USERNAME || process.env.DB_USER;
const password = process.env.PGPASSWORD     || process.env.POSTGRES_PASSWORD || process.env.DB_PASSWORD;
const database = process.env.PGDATABASE     || process.env.POSTGRES_DB       || process.env.POSTGRES_DATABASE || process.env.DB_NAME;
const dbUrl    = process.env.DATABASE_URL   || process.env.DATABASE_PRIVATE_URL || process.env.POSTGRES_URL;

let pool;

if (dbUrl) {
    console.log('🔌 PostgreSQL: using connection URL');
    pool = new Pool({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false }
    });
} else if (host && user && password && database) {
    console.log(`🔌 PostgreSQL: ${user}@${host}:${port}/${database}`);
    pool = new Pool({
        host,
        port:     parseInt(port),
        user,
        password,
        database,
        ssl:      { rejectUnauthorized: false }
    });
} else {
    console.error('❌ PostgreSQL config tidak lengkap!');
    console.error(`   host=${host}, user=${user}, password=${password ? '***set***' : 'MISSING'}, database=${database}`);
    console.error('');
    console.error('   CARA FIX di Railway:');
    console.error('   1. Buka service PostgreSQL kamu di Railway Dashboard');
    console.error('   2. Klik tab "Connect"');
    console.error('   3. Copy salah satu dari:');
    console.error('      - DATABASE_URL  (recommended)');
    console.error('      - Atau PGHOST + PGUSER + PGPASSWORD + PGDATABASE');
    console.error('   4. Tambahkan ke Variables di service Node.js kamu');
    process.exit(1);
}

pool.on('error', (err) => {
    console.error('❌ PostgreSQL pool error:', err.message);
});

pool.query('SELECT NOW()', (err, res) => {
    if (err) console.error('❌ PostgreSQL connection failed:', err.message);
    else     console.log('✅ PostgreSQL connected:', res.rows[0].now);
});

module.exports = pool;
