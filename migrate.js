require('dotenv').config();
const pool = require('./db');

async function migrate() {
    const client = await pool.connect();
    try {
        console.log('🔄 Running migrations...');
        await client.query('BEGIN');

        // ─── game_passwords ───────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS game_passwords (
                game_id     VARCHAR(50)  PRIMARY KEY,
                password    VARCHAR(255) NOT NULL,
                updated_at  TIMESTAMPTZ  DEFAULT NOW()
            )
        `);
        console.log('✅ Table game_passwords ready');

        // ─── donations ────────────────────────────────────────────────────
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
        console.log('✅ Table donations ready');

        // Indexes for faster lookups
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_donations_game_id
                ON donations(game_id)
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_donations_game_donated
                ON donations(game_id, donated_at DESC)
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_donations_username
                ON donations(game_id, username)
        `);
        console.log('✅ Indexes ready');

        await client.query('COMMIT');
        console.log('🎉 Migration complete!');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed:', err.message);
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

migrate().catch(() => process.exit(1));
