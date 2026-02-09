const net = require('net');
const http = require('http');
const { Client } = require('pg');
const os = require('os');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

/**
 * STRATUM PROXY - REAL-TIME DATABASE VERSION
 * -------------------------------------------
 * - SHA256 (BTC/BCH) ONLY.
 * - Immediate Double-Writes: Miningcore DB (for MC) & Proxy DB (for /stats).
 * - Real-time statistics aggregation directly from the Proxy Database.
 * - Routes all upstream hashrate to ViaBTC as 'imskaa.001'.
 */

// === CONFIGURATION ===
// SHA256 Upstream (BTC/BCH/BC2)
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'bch.viabtc.io';
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT) || 3333;

// Scrypt Upstream (LTC/DOGE)
const UPSTREAM_HOST_SCRYPT = process.env.UPSTREAM_HOST_SCRYPT || 'ltc.poolbinance.com';
const UPSTREAM_PORT_SCRYPT = parseInt(process.env.UPSTREAM_PORT_SCRYPT) || 3333;

// Proxy credentials (same for both algorithms on Binance)
const PROXY_USER = process.env.UPSTREAM_USER || 'imskaa.001';
const PROXY_PASS = process.env.UPSTREAM_PASS || '123';

const LISTEN_PORTS = [
    // SHA256 - BTC
    3062, 3072, 3082, 3092,
    3102, 3112, 3122, 3132,
    // SHA256 - BCH
    3063, 3073, 3083, 3093,
    3068, 3078, 3088, 3098,
    // SHA256 - BC2
    3264, 3274, 3284, 3294,
    // Scrypt - LTC
    3070, 3080, 3090, 3100,
    3110, 3120, 3130, 3140,
    // Scrypt - DOGE
    3069, 3079, 3089, 3099,
    3109, 3119, 3129, 3139
];

const PORT_MAP = {
    // SHA256 - BTC
    3062: { pool: 'btc', algo: 'sha256', diff: 1000 }, 3072: { pool: 'btc', algo: 'sha256', diff: 500 },
    3082: { pool: 'btc', algo: 'sha256', diff: 100 }, 3092: { pool: 'btc', algo: 'sha256', diff: 1 },
    3102: { pool: 'btc-solo', algo: 'sha256', diff: 25000 }, 3112: { pool: 'btc-solo', algo: 'sha256', diff: 20000 },
    3122: { pool: 'btc-solo', algo: 'sha256', diff: 15000 }, 3132: { pool: 'btc-solo', algo: 'sha256', diff: 10000 },
    // SHA256 - BCH
    3063: { pool: 'bch', algo: 'sha256', diff: 500 }, 3073: { pool: 'bch', algo: 'sha256', diff: 100 },
    3083: { pool: 'bch', algo: 'sha256', diff: 10 }, 3093: { pool: 'bch', algo: 'sha256', diff: 1 },
    3068: { pool: 'bch-solo', algo: 'sha256', diff: 25000 }, 3078: { pool: 'bch-solo', algo: 'sha256', diff: 20000 },
    3088: { pool: 'bch-solo', algo: 'sha256', diff: 15000 }, 3098: { pool: 'bch-solo', algo: 'sha256', diff: 10000 },
    // SHA256 - BC2
    3264: { pool: 'bc2-solo', algo: 'sha256', diff: 1000 }, 3274: { pool: 'bc2-solo', algo: 'sha256', diff: 500 },
    3284: { pool: 'bc2-solo', algo: 'sha256', diff: 100 }, 3294: { pool: 'bc2-solo', algo: 'sha256', diff: 1 },
    // Scrypt - LTC
    3070: { pool: 'ltc', algo: 'scrypt', diff: 1024 }, 3080: { pool: 'ltc', algo: 'scrypt', diff: 256 },
    3090: { pool: 'ltc', algo: 'scrypt', diff: 64 }, 3100: { pool: 'ltc', algo: 'scrypt', diff: 16 },
    3110: { pool: 'ltc-solo', algo: 'scrypt', diff: 1024 }, 3120: { pool: 'ltc-solo', algo: 'scrypt', diff: 256 },
    3130: { pool: 'ltc-solo', algo: 'scrypt', diff: 64 }, 3140: { pool: 'ltc-solo', algo: 'scrypt', diff: 16 },
    // Scrypt - DOGE
    3069: { pool: 'doge', algo: 'scrypt', diff: 1024 }, 3079: { pool: 'doge', algo: 'scrypt', diff: 256 },
    3089: { pool: 'doge', algo: 'scrypt', diff: 64 }, 3099: { pool: 'doge', algo: 'scrypt', diff: 16 },
    3109: { pool: 'doge-solo', algo: 'scrypt', diff: 1024 }, 3119: { pool: 'doge-solo', algo: 'scrypt', diff: 256 },
    3129: { pool: 'doge-solo', algo: 'scrypt', diff: 64 }, 3139: { pool: 'doge-solo', algo: 'scrypt', diff: 16 }
};

// State - Per-pool block heights and network difficulties
const blockHeights = {};
const networkDifficulties = {};
const PROXY_ID = os.hostname() + '-' + crypto.randomBytes(4).toString('hex');
const LOCAL_STATS = { miners: 0, accepted: 0, rejected: 0, start: Date.now() };

// === DATABASE CONNECTIONS ===
const dbShares = new Client({ connectionString: process.env.MININGCORE_DB_URL });
const dbStats = new Client({ connectionString: process.env.PROXY_DB_URL });

async function connectDBs() {
    try {
        await dbShares.connect();
        await dbStats.connect();
        console.log('[DB] Connected: Ready for Real-time Double-Writes.');
    } catch (err) {
        console.error('[DB ERROR] Connection failed:', err.message);
    }
}
connectDBs();

// Block Height & Network Difficulty Sync - Fetch from Pool API for all coins
const https = require('https');
const POOL_API_URL = process.env.POOL_API_URL || 'https://api.ourpool.xyz/api/pools';

async function syncPoolData() {
    https.get(POOL_API_URL, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
            try {
                const json = JSON.parse(data);
                if (json.pools && Array.isArray(json.pools)) {
                    json.pools.forEach(pool => {
                        if (pool.id && pool.networkStats) {
                            if (pool.networkStats.blockHeight) {
                                blockHeights[pool.id] = pool.networkStats.blockHeight;
                            }
                            if (pool.networkStats.networkDifficulty) {
                                networkDifficulties[pool.id] = pool.networkStats.networkDifficulty;
                            }
                        }
                    });
                    console.log('[SYNC] Updated', Object.keys(blockHeights).length, 'pools (heights + difficulties)');
                }
            } catch (e) {
                console.error('[SYNC] Failed to parse pool API:', e.message);
            }
        });
    }).on('error', (e) => {
        console.error('[SYNC] Failed to fetch pool API:', e.message);
    });
}
setInterval(syncPoolData, 30000); // Sync every 30 seconds
syncPoolData();

// Heartbeat for Cluster Health
async function heartbeat() {
    const uptime = Math.floor((Date.now() - LOCAL_STATS.start) / 1000);
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
    const values = [PROXY_ID, os.hostname(), LOCAL_STATS.miners, LOCAL_STATS.accepted + LOCAL_STATS.rejected, LOCAL_STATS.accepted, LOCAL_STATS.rejected, uptime];
    try { await dbStats.query(query, values); } catch (e) { }
}
setInterval(heartbeat, 5000);

// === PROXY ENGINE ===
const createProxy = (port) => {
    return net.createServer((socket) => {
        const ip = socket.remoteAddress;
        const portConfig = PORT_MAP[port] || { pool: 'btc', algo: 'sha256' };
        const poolId = portConfig.pool;
        const algo = portConfig.algo;
        let currentWorker = 'unknown';
        let diff = 1;
        const pending = new Set();

        // Determine upstream based on algorithm
        const upstreamHost = algo === 'scrypt' ? UPSTREAM_HOST_SCRYPT : UPSTREAM_HOST;
        const upstreamPort = algo === 'scrypt' ? UPSTREAM_PORT_SCRYPT : UPSTREAM_PORT;

        LOCAL_STATS.miners++;
        console.log(`[CONNECT] ${ip} -> port ${port} (${poolId}/${algo.toUpperCase()}) | Total miners: ${LOCAL_STATS.miners}`);

        const upstream = new net.Socket();
        upstream.connect(upstreamPort, upstreamHost, () => {
            console.log(`[UPSTREAM] ${ip} linked to ${upstreamHost}:${upstreamPort}`);
        });

        socket.on('data', (data) => {
            data.toString().split('\n').forEach(chunk => {
                if (!chunk.trim()) return;
                try {
                    const json = JSON.parse(chunk);
                    if (json.method === 'mining.authorize') {
                        currentWorker = json.params[0] || 'unknown';
                        console.log(`[AUTH] ${currentWorker} from ${ip} on ${poolId}`);
                        json.params = [PROXY_USER, PROXY_PASS];
                        upstream.write(JSON.stringify(json) + '\n');
                    }
                    else if (json.method === 'mining.submit') {
                        json.params[0] = PROXY_USER;
                        if (json.id) pending.add(json.id);
                        upstream.write(JSON.stringify(json) + '\n');
                        console.log(`[SHARE] ${currentWorker} submitted (diff: ${diff}) on ${poolId}`);

                        // IMMEDIATE DOUBLE-WRITE
                        recordShare(currentWorker, diff, ip, port);
                    }
                    else upstream.write(JSON.stringify(json) + '\n');
                } catch (e) { upstream.write(chunk + '\n'); }
            });
        });

        upstream.on('data', (data) => {
            socket.write(data);
            data.toString().split('\n').forEach(chunk => {
                if (!chunk.trim()) return;
                try {
                    const json = JSON.parse(chunk);
                    if (json.method === 'mining.set_difficulty') {
                        diff = parseFloat(json.params[0]);
                        console.log(`[DIFF] ${currentWorker} difficulty set to ${diff}`);
                    }
                    if (json.id && pending.has(json.id)) {
                        pending.delete(json.id);
                        if (json.result === true) {
                            LOCAL_STATS.accepted++;
                            console.log(`[ACCEPTED] ${currentWorker} | Total: ${LOCAL_STATS.accepted} accepted, ${LOCAL_STATS.rejected} rejected`);
                        } else {
                            LOCAL_STATS.rejected++;
                            console.log(`[REJECTED] ${currentWorker} | Reason: ${JSON.stringify(json.error || 'unknown')} | Total: ${LOCAL_STATS.rejected} rejected`);
                        }
                    }
                } catch (e) { }
            });
        });

        socket.on('error', (err) => { console.log(`[ERROR] ${currentWorker}: ${err.message}`); upstream.destroy(); });
        socket.on('close', () => {
            LOCAL_STATS.miners--;
            console.log(`[DISCONNECT] ${currentWorker} from ${ip} | Remaining: ${LOCAL_STATS.miners}`);
            upstream.destroy();
        });
        upstream.on('error', (err) => { console.log(`[UPSTREAM ERROR] ${currentWorker}: ${err.message}`); socket.destroy(); });
        upstream.on('close', () => socket.destroy());
    });
};

// Start all proxy servers
console.log('\n=== STRATUM PROXY STARTING ===');
console.log(`SHA256 Upstream: ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
console.log(`Scrypt Upstream: ${UPSTREAM_HOST_SCRYPT}:${UPSTREAM_PORT_SCRYPT}`);
console.log(`Proxy User: ${PROXY_USER}`);
console.log(`Listening on ${LISTEN_PORTS.length} ports...\n`);

LISTEN_PORTS.forEach(p => {
    createProxy(p).listen(p, () => {
        const config = PORT_MAP[p];
        console.log(`[LISTEN] Port ${p} -> ${config.pool} (${config.algo})`);
    });
});

// === SHARE RECORDING (REAL-TIME NO BATCHING) ===
async function recordShare(full, diff, ip, port) {
    const portConfig = PORT_MAP[port] || { pool: 'btc', algo: 'sha256', diff: 1 };
    const pid = portConfig.pool;
    const algo = portConfig.algo;

    // For SHA256: use actual upstream diff (accurate hashrate)
    // For Scrypt: use port's configured diff (Binance sends inflated values)
    const recordedDiff = (algo === 'sha256') ? diff : portConfig.diff;

    // Use the actual network difficulty from pool API
    const netDiff = networkDifficulties[pid] || networkDifficulties['btc'] || recordedDiff;

    let addr = full;
    let wrk = '';
    if (full.includes('.')) {
        const p = full.split('.');
        addr = p[0];
        wrk = p.slice(1).join('.') || '';
    }

    // 1. Miningcore DB Write - Use per-pool block height, port diff, and real network diff
    const poolBlockHeight = blockHeights[pid] || blockHeights['btc'] || 0;
    const q1 = `
        INSERT INTO shares (poolid, blockheight, difficulty, networkdifficulty, miner, worker, useragent, ipaddress, source, created)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    `;
    const v1 = [pid, poolBlockHeight, recordedDiff, netDiff, addr, wrk, 'proxy', ip, 'port-' + port];

    // 2. Proxy Stats DB Update (Real-time aggregation)
    const q2 = `
        INSERT INTO worker_stats (worker_name, proxy_id, pool_id, shares, difficulty, last_seen)
        VALUES ($1, $2, $3, 1, $4, NOW())
        ON CONFLICT (worker_name, proxy_id) DO UPDATE SET
            shares = worker_stats.shares + 1,
            difficulty = worker_stats.difficulty + EXCLUDED.difficulty,
            last_seen = EXCLUDED.last_seen;
    `;
    const v2 = [full, PROXY_ID, pid, diff];

    try {
        await Promise.all([
            dbShares.query(q1, v1).catch(() => { }),
            dbStats.query(q2, v2).catch(() => { })
        ]);
    } catch (e) { }
}

// === REAL-TIME DASHBOARD API ===
http.createServer(async (req, res) => {
    if (req.url === '/api/stats') {
        try {
            const workerRes = await dbStats.query(`
                SELECT worker_name as name, SUM(shares) as s, SUM(difficulty) as d, MAX(last_seen) as t
                FROM worker_stats 
                WHERE last_seen > NOW() - interval '10 minutes'
                GROUP BY worker_name ORDER BY s DESC
            `);
            const clusterRes = await dbStats.query(`
                SELECT SUM(miners_connected) as m, SUM(shares_submitted) as sub, SUM(shares_accepted) as a, SUM(shares_rejected) as r, COUNT(*) as nodes
                FROM proxy_stats WHERE last_beat > NOW() - interval '30 seconds'
            `);
            const c = clusterRes.rows[0];
            const workers = workerRes.rows.map(w => ({
                name: w.name,
                s: parseInt(w.s),
                h: ((w.d * Math.pow(2, 32)) / 300 / 1e12).toFixed(2)
            }));

            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({
                miners: parseInt(c.m || 0),
                acc: parseInt(c.a || 0),
                rej: parseInt(c.r || 0),
                nodes: parseInt(c.nodes || 1),
                workers: workers
            }));
        } catch (e) {
            res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
    } else if (req.url === '/' || req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>Proxy Cluster</title><style>body{background:#0f172a;color:#fff;font-family:sans-serif;padding:2rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin:2rem 0}.card{background:#1e293b;padding:1.5rem;border-radius:12px;border:1px solid #334155}.val{font-size:2rem;font-weight:bold}table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden}th,td{padding:1rem;text-align:left;border-bottom:1px solid #334155}th{color:#94a3b8;font-size:.8rem;text-transform:uppercase}h1{color:#3b82f6}.badge{background:#3b82f6;padding:.2rem .5rem;border-radius:4px;font-size:.8rem;margin-left:1rem}</style></head><body><h1>REAL-TIME CLUSTER <span class="badge" id="n">1 NODE</span></h1><div class="grid"><div class="card">Total Miners<div class="val" id="m">0</div></div><div class="card">Total Accepted<div class="val" style="color:#22c55e" id="a">0</div></div><div class="card">Total Rejected<div class="val" style="color:#ef4444" id="r">0</div></div></div><table><thead><tr><th>Worker Name</th><th>Shares</th><th>Hashrate (TH/s)</th></tr></thead><tbody id="list"></tbody></table><script>function u(){fetch('/api/stats').then(r=>r.json()).then(d=>{document.getElementById('m').textContent=d.miners;document.getElementById('a').textContent=d.acc;document.getElementById('r').textContent=d.rej;document.getElementById('n').textContent=d.nodes+' NODES ACTIVE';let h='';d.workers.forEach(w=>{h+='<tr><td>'+w.name+'</td><td>'+w.s+'</td><td>'+w.h+'</td></tr>'});document.getElementById('list').innerHTML=h})}setInterval(u,3000);u()</script></body></html>`);
    } else res.writeHead(404).end();
}).listen(3344);
