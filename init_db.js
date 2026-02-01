const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const db = new Client({
    connectionString: process.env.PROXY_DB_URL,
});

const createTableQuery = `
CREATE TABLE IF NOT EXISTS proxy_stats (
    id VARCHAR(255) PRIMARY KEY,
    hostname VARCHAR(255),
    miners_connected INT DEFAULT 0,
    shares_submitted BIGINT DEFAULT 0,
    shares_accepted BIGINT DEFAULT 0,
    shares_rejected BIGINT DEFAULT 0,
    uptime_seconds BIGINT DEFAULT 0,
    last_beat TIMESTAMP DEFAULT NOW()
);
`;

(async () => {
    try {
        await db.connect();
        console.log('Connected to Database...');

        await db.query(createTableQuery);
        console.log('Table "proxy_stats" created successfully (if it didn\'t exist).');

        await db.end();
        console.log('Database Initialization Complete.');
        process.exit(0);
    } catch (err) {
        console.error('Error initializing database:', err);
        process.exit(1);
    }
})();
