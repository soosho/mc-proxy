const net = require('net');
const http = require('http');
const { Client } = require('pg');
const os = require('os');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

// Configuration
// Configuration
const POOL_ID = process.env.POOL_ID || 'btc';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://miningcore:password@localhost:5432/miningcore';

// Current Network State
let currentBlockHeight = 0;

// Global Stats
const PROXY_ID = os.hostname() + '-' + crypto.randomBytes(4).toString('hex');
const STATS = {
    connectedMiners: 0,
    sharesSubmitted: 0,
    sharesAccepted: 0,
    sharesRejected: 0,
    startTime: Date.now()
};

// Database Connections
// 1. Connection for SHARES (Miningcore DB)
const dbShares = new Client({
    connectionString: process.env.MININGCORE_DB_URL,
});

// 2. Connection for STATS (Proxy Cluster DB)
const dbStats = new Client({
    connectionString: process.env.PROXY_DB_URL,
});

// Connect to both
Promise.all([dbShares.connect(), dbStats.connect()]).then(() => {
    console.log('[DB] Connected to Miningcore DB (Shares) and Proxy DB (Stats)');
}).catch(err => {
    console.error('[DB] Connection Error:', err);
});

// Update Block Height Periodically (Mocking a node or public API)
// For simplicity, we just increment or fetch from an API in a real scenario.
// Here we will default to a static reasonable height if we can't fetch it, 
// or maybe just accept that stats might show 0 height.
// Better: Fetch from a public API like blockchain.info
// But to keep it simple and dependency-free, let's just use a hardcoded base + time
// or try to fetch from the upstream if they send it (unlikely).
// Strategy: Use a fixed height or 0. Miningcore dashboard might behave oddly with 0.
// Let's try to fetch from a public API.
const https = require('https');
function updateBlockHeight() {
    https.get('https://blockchain.info/q/getblockcount', (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
            const height = parseInt(data);
            if (!isNaN(height)) {
                currentBlockHeight = height;
                // console.log('Updated Block Height:', currentBlockHeight);
            }
        });
    }).on('error', (err) => {
        // console.error('Error fetching block height:', err.message);
    });
}
setInterval(updateBlockHeight, 60000); // Update every minute
updateBlockHeight(); // Initial fetch

// === HEARTBEAT ===
async function sendHeartbeat() {
    const uptime = Math.floor((Date.now() - STATS.startTime) / 1000);
    const query = `
        INSERT INTO proxy_stats (id, hostname, miners_connected, shares_submitted, shares_accepted, shares_rejected, uptime_seconds, last_beat)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (id) DO UPDATE SET
            miners_connected = EXCLUDED.miners_connected,
            shares_submitted = EXCLUDED.shares_submitted,
            shares_accepted = EXCLUDED.shares_accepted,
            shares_rejected = EXCLUDED.shares_rejected,
            uptime_seconds = EXCLUDED.uptime_seconds,
            last_beat = NOW();
    `;
    const values = [
        PROXY_ID, os.hostname(),
        STATS.connectedMiners,
        STATS.sharesSubmitted, STATS.sharesAccepted, STATS.sharesRejected,
        uptime
    ];
    try {
        await dbStats.query(query, values); // Use dbStats
    } catch (e) {
        console.error('Heartbeat Error:', e.message);
    }
}
setInterval(sendHeartbeat, 5000);

// Multi-Port Configuration
// BTC Ports (Normal & Solo) + BCH Ports (Normal & Solo)
const LISTEN_PORTS = [
    // BTC Ports
    3062, 3072, 3082, 3092,
    // BTC Solo Ports
    3102, 3112, 3122, 3132,
    // BCH Ports
    3063, 3073, 3083, 3093,
    // BCH Solo Ports
    3068, 3078, 3088, 3098
];

const PORT_MAP = {
    // BTC
    3062: 'btc', 3072: 'btc', 3082: 'btc', 3092: 'btc',
    // BTC Solo
    3102: 'btc-solo', 3112: 'btc-solo', 3122: 'btc-solo', 3132: 'btc-solo',
    // BCH
    3063: 'bch', 3073: 'bch', 3083: 'bch', 3093: 'bch',
    // BCH Solo
    3068: 'bch-solo', 3078: 'bch-solo', 3088: 'bch-solo', 3098: 'bch-solo'
};

// Hardcoded Upstream Configuration (ViaBTC)
const UPSTREAM_HOST = 'bch.viabtc.io';
const UPSTREAM_PORT = 3333;
const PROXY_USER = 'imskaa.001';
const PROXY_PASS = '123';

const serverFactory = (port) => {
    return net.createServer((socket) => {
        const clientAddress = socket.remoteAddress;
        const poolName = PORT_MAP[port] || 'unknown';

        // Console Helper
        const log = (msg) => {
            const time = new Date().toLocaleTimeString();
            console.log(`[${time}] [${poolName.toUpperCase()}] ${msg}`);
        };

        log(`New Connection from ${clientAddress} on port ${port}`);
        STATS.connectedMiners++; // Increment Miner Count

        const upstream = new net.Socket();
        upstream.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
            // log(`Connected to Upstream ${UPSTREAM_HOST}`);
        });

        // Valid Share Tracking per connection
        let workerName = 'unknown';
        let currentDifficulty = 1;
        const pendingShareIds = new Set(); // Track share submission IDs

        // Downstream (Miner) -> Upstream
        socket.on('data', (data) => {
            const payload = data.toString();

            const lines = payload.split('\n');
            lines.forEach(line => {
                if (!line.trim()) return;
                try {
                    const json = JSON.parse(line);

                    if (json.method === 'mining.authorize') {
                        if (json.params && json.params.length > 0) {
                            workerName = json.params[0];
                            log(`Miner Logged In: ${workerName}`);
                        }

                        // Construct proper worker name: account.worker
                        // Assuming PROXY_USER is 'imskaa.001', we want 'imskaa.originalWorker'
                        const accountPart = PROXY_USER.split('.')[0];
                        const upstreamWorker = `${accountPart}.${workerName}`;

                        json.params = [upstreamWorker, PROXY_PASS];
                        const modifiedPayload = JSON.stringify(json) + '\n';
                        upstream.write(modifiedPayload);

                        // Update workerName context for logging/submit
                        // actually we keep 'workerName' as the original for local logging, 
                        // but we need to remember what we authorized as for 'submit'
                        socket.authorizedWorker = upstreamWorker;
                    }
                    else if (json.method === 'mining.submit') {
                        if (json.params && json.params.length > 0) {
                            // Use the same worker name we authorized with
                            json.params[0] = socket.authorizedWorker || PROXY_USER;
                        }

                        // Track ID using the request ID
                        if (json.id) {
                            pendingShareIds.add(json.id);
                        }

                        const modifiedPayload = JSON.stringify(json) + '\n';
                        upstream.write(modifiedPayload);

                        STATS.sharesSubmitted++; // Track Submission
                        log(`Share Submitted by ${workerName} (as ${socket.authorizedWorker}) (Diff: ${currentDifficulty.toFixed(2)})`);
                        recordShare(workerName, currentDifficulty, clientAddress, port);
                    }
                    else {
                        upstream.write(data);
                    }

                } catch (e) {
                    upstream.write(data);
                }
            });
        });

        // Upstream -> Downstream (Miner)
        upstream.on('data', (data) => {
            const payload = data.toString();
            socket.write(data);

            const lines = payload.split('\n');
            lines.forEach(line => {
                if (!line.trim()) return;
                try {
                    const json = JSON.parse(line);

                    if (json.method === 'mining.set_difficulty') {
                        if (json.params && json.params.length > 0) {
                            currentDifficulty = parseFloat(json.params[0]);
                        }
                    }

                    // Check for Share Acceptance
                    // Response to submit: {"id": ID, "result": true, ...}
                    if (json.id && pendingShareIds.has(json.id)) {
                        pendingShareIds.delete(json.id);
                        if (json.result === true) {
                            STATS.sharesAccepted++;
                            log(`Share Accepted!`);
                        } else {
                            STATS.sharesRejected++;
                            log(`Share REJECTED: ${JSON.stringify(json.error)}`);
                        }
                    }

                } catch (e) {
                    // Ignore
                }
            });
        });

        // Error Handling
        socket.on('error', (err) => {
            log(`Miner Socket Error: ${err.message}`);
            upstream.destroy();
        });

        socket.on('close', () => {
            STATS.connectedMiners--; // Decrement Miner Count
            upstream.destroy();
        });

        upstream.on('error', (err) => {
            // log(`Upstream Socket Error: ${err.message}`); // Optional
            socket.destroy();
        });

        upstream.on('close', () => {
            socket.destroy();
        });
    });
};

// Start Stats Server
const STATS_PORT = 3344;
http.createServer(async (req, res) => {
    // API Endpoint for JSON Data (AGGREGATED)
    if (req.url === '/api/stats') {
        try {
            // Fetch Aggregated Stats from Proxy DB
            const result = await dbStats.query(`
                SELECT
                    SUM(miners_connected) as miners,
                    SUM(shares_submitted) as submitted,
                    SUM(shares_accepted) as accepted,
                    SUM(shares_rejected) as rejected,
                    MAX(uptime_seconds) as max_uptime,
                    COUNT(*) as active_proxies
                FROM proxy_stats
                WHERE last_beat > NOW() - interval '30 seconds'
            `);

            const row = result.rows[0];

            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({
                uptime_seconds: parseInt(row.max_uptime || 0),
                miners_connected: parseInt(row.miners || 0),
                shares: {
                    submitted: parseInt(row.submitted || 0),
                    accepted: parseInt(row.accepted || 0),
                    rejected: parseInt(row.rejected || 0)
                },
                pools: {
                    active_ports: LISTEN_PORTS.length,
                    active_proxies: parseInt(row.active_proxies || 0)
                }
            }));
        } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
        }
    }
    // HTML Dashboard
    else if (req.url === '/stats' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Stratum Proxy Dashboard</title>
    <style>
        :root { --bg: #0f172a; --card: #1e293b; --text: #f8fafc; --accent: #3b82f6; --success: #22c55e; --danger: #ef4444; }
        body { margin: 0; font-family: 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 2rem; }
        h1 { font-weight: 300; letter-spacing: 2px; margin-bottom: 2rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem; width: 100%; max-width: 1000px; }
        .card { background: var(--card); padding: 1.5rem; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); border: 1px solid rgba(255,255,255,0.05); transition: transform 0.2s; }
        .card:hover { transform: translateY(-2px); }
        .label { font-size: 0.875rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; }
        .value { font-size: 2.5rem; font-weight: 700; margin-top: 0.5rem; }
        .success { color: var(--success); }
        .danger { color: var(--danger); }
        .accent { color: var(--accent); }
        .footer { margin-top: 3rem; color: #64748b; font-size: 0.875rem; }
        .blink { animation: pulse 2s infinite; }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
    </style>
</head>
<body>
    <h1>STRATUM <span class="accent">PROXY</span> DASHBOARD</h1>
    
    <div class="grid">
        <div class="card">
            <div class="label">Connected Miners</div>
            <div class="value accent" id="miners">0</div>
        </div>
        <div class="card">
            <div class="label">Uptime</div>
            <div class="value" id="uptime">0s</div>
        </div>
        <div class="card">
            <div class="label">Shares Accepted</div>
            <div class="value success" id="accepted">0</div>
        </div>
        <div class="card">
            <div class="label">Shares Rejected</div>
            <div class="value danger" id="rejected">0</div>
        </div>
    </div>

    <div class="footer">
        Upstream: <span class="accent">${UPSTREAM_HOST}</span> | <span class="blink">●</span> Live 
        | Cluster: <span class="accent" id="proxies">1</span> Node(s)
    </div>

    <script>
        function updateStats() {
            fetch('/api/stats')
                .then(res => res.json())
                .then(data => {
                    document.getElementById('miners').textContent = data.miners_connected;
                    document.getElementById('accepted').textContent = data.shares.accepted;
                    document.getElementById('rejected').textContent = data.shares.rejected;
                    document.getElementById('proxies').textContent = data.pools.active_proxies;
                    
                    // Format Uptime
                    const sec = data.uptime_seconds;
                    const h = Math.floor(sec / 3600);
                    const m = Math.floor((sec % 3600) / 60);
                    const s = sec % 60;
                    document.getElementById('uptime').textContent = \`\${h}h \${m}m \${s}s\`;
                })
                .catch(err => console.error('Stats fetch error:', err));
        }
        setInterval(updateStats, 2000);
        updateStats();
    </script>
</body>
</html>
        `;
        res.end(html);
    }
    else {
        res.writeHead(404);
        res.end('Not Found. Try /stats');
    }
}).listen(STATS_PORT, () => {
    console.log(`[STATS] Monitoring API and Dashboard running on http://localhost:${STATS_PORT}/stats`);
});

// Start Servers on all defined ports
LISTEN_PORTS.forEach(port => {
    const server = serverFactory(port);
    server.listen(port, () => {
        console.log(`Proxy listening on port ${port} -> Forwarding to ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
    });

    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.error(`[CRITICAL] Port ${port} is already in use! Did you stop Miningcore?`);
        } else {
            console.error(`[Error] Port ${port}:`, e);
        }
    });
});

async function recordShare(miner, difficulty, ipAddress, port) {
    const derivedPoolId = PORT_MAP[port] || 'btc';

    // Determine Miner vs Worker
    let address = miner;
    let worker = 'default';

    if (miner.includes('.')) {
        const parts = miner.split('.');
        address = parts[0];
        worker = parts[1];
    }

    const query = `
        INSERT INTO shares (
            poolid, blockheight, difficulty, networkdifficulty, 
            miner, worker, useragent, ipaddress, source, created
        ) VALUES (
            $1, $2, $3, $4, 
            $5, $6, $7, $8, $9, NOW()
        )
    `;

    const values = [
        derivedPoolId,
        currentBlockHeight,
        difficulty,
        difficulty, // Network diff (approximation)
        address,
        worker,
        'proxy',
        ipAddress,
        `port-${port}` // Store port in source for debugging
    ];

    try {
        await dbShares.query(query, values); // Use dbShares
    } catch (err) {
        console.error('Database Insert Error', err);
    }
}
