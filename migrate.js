require('dotenv').config();
const pool = require('./db');

async function migrate() {
    const client = await pool.connect();
    try {
        console.log('🔄 Running migrations...');
        await client.query('BEGIN');

        // ─── games ────────────────────────────────────────────────────────────
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
        // Alter existing columns if already created with VARCHAR(255)
        await client.query(`ALTER TABLE games ALTER COLUMN name             TYPE TEXT`).catch(()=>{});
        await client.query(`ALTER TABLE games ALTER COLUMN universe_id      TYPE TEXT`).catch(()=>{});
        await client.query(`ALTER TABLE games ALTER COLUMN api_key          TYPE TEXT`).catch(()=>{});
        await client.query(`ALTER TABLE games ALTER COLUMN topic            TYPE TEXT`).catch(()=>{});
        await client.query(`ALTER TABLE games ALTER COLUMN webhook_secret   TYPE TEXT`).catch(()=>{});
        await client.query(`ALTER TABLE games ALTER COLUMN saweria_token    TYPE TEXT`).catch(()=>{});
        await client.query(`ALTER TABLE games ALTER COLUMN socialbuzz_token TYPE TEXT`).catch(()=>{});
        console.log('✅ Table games ready');

        // ─── game_passwords ───────────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS game_passwords (
                game_id     VARCHAR(50)  PRIMARY KEY,
                password    VARCHAR(255) NOT NULL,
                updated_at  TIMESTAMPTZ  DEFAULT NOW()
            )
        `);
        console.log('✅ Table game_passwords ready');

        // ─── donations ────────────────────────────────────────────────────────
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

        await client.query(`CREATE INDEX IF NOT EXISTS idx_donations_game_id      ON donations(game_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_donations_game_donated  ON donations(game_id, donated_at DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_donations_username      ON donations(game_id, username)`);
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
