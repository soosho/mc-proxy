const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

/**
 * STRATUM PROXY - DATABASE INITIALIZATION & MIGRATIONS
 * --------------------------------------------------
 * Handles the Proxy Cluster Stats database (PROXY_DB_URL).
 * Ensures all tables, columns, and indices are present.
 */

async function runMigrations() {
    const db = new Client({ connectionString: process.env.PROXY_DB_URL });

    try {
        await db.connect();
        console.log('[MIGRATION] Connected to Stats Database.');

        // 1. Table: proxy_stats (Node health and aggregate counts)
        await db.query(`
            CREATE TABLE IF NOT EXISTS proxy_stats (
                id VARCHAR(255) PRIMARY KEY,
                hostname VARCHAR(255),
                miners_connected INT DEFAULT 0,
                shares_submitted BIGINT DEFAULT 0,
                shares_accepted BIGINT DEFAULT 0,
                shares_rejected BIGINT DEFAULT 0,
                uptime_seconds BIGINT DEFAULT 0,
                last_beat TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        console.log('[MIGRATION] Table "proxy_stats" verified.');

        // 2. Table: worker_stats (Per-worker live tracking for the dashboard)
        await db.query(`
            CREATE TABLE IF NOT EXISTS worker_stats (
                worker_name VARCHAR(255),
                proxy_id VARCHAR(255),
                pool_id VARCHAR(50),
                shares BIGINT DEFAULT 0,
                difficulty DOUBLE PRECISION DEFAULT 0,
                last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                PRIMARY KEY (worker_name, proxy_id)
            );
        `);
        console.log('[MIGRATION] Table "worker_stats" verified.');

        // 3. Columns: Ensure all required columns exist (Manual Migration Logic)
        const columns = [
            { table: 'worker_stats', col: 'pool_id', type: 'VARCHAR(50)' }
        ];

        for (const c of columns) {
            const res = await db.query(`
                SELECT column_name FROM information_schema.columns 
                WHERE table_name=$1 AND column_name=$2
            `, [c.table, c.col]);

            if (res.rowCount === 0) {
                console.log(`[MIGRATION] Adding column ${c.col} to ${c.table}...`);
                await db.query(`ALTER TABLE ${c.table} ADD COLUMN ${c.col} ${c.type}`);
            }
        }

        // 4. Indices: Performance for the dashboard
        await db.query(`CREATE INDEX IF NOT EXISTS idx_proxy_stats_beat ON proxy_stats(last_beat);`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_worker_last_seen ON worker_stats(last_seen);`);

        console.log('[SUCCESS] Database Infrastructure is up to date.');
        await db.end();
        process.exit(0);
    } catch (err) {
        console.error('[CRITICAL] Migration Failed:', err.message);
        process.exit(1);
    }
}

runMigrations();
