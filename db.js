const { Pool } = require('pg');

// Railway bisa inject DATABASE_URL  — atau —  PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT secara terpisah
let pool;

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    console.log('🔌 PostgreSQL: using DATABASE_URL');
} else if (process.env.PGHOST) {
    pool = new Pool({
        host:     process.env.PGHOST,
        port:     parseInt(process.env.PGPORT || '5432'),
        user:     process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
        ssl:      { rejectUnauthorized: false }
    });
    console.log(`🔌 PostgreSQL: ${process.env.PGUSER}@${process.env.PGHOST}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE}`);
} else {
    console.error('❌ No PostgreSQL config found!');
    console.error('   Pastikan Railway PostgreSQL plugin sudah di-add dan di-link ke service ini.');
    console.error('   Env vars yang dibutuhkan: DATABASE_URL  —atau—  PGHOST + PGUSER + PGPASSWORD + PGDATABASE');
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
