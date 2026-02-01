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
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'bch.viabtc.io';
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT) || 3333;
const PROXY_USER = process.env.UPSTREAM_USER || 'imskaa.001';
const PROXY_PASS = process.env.UPSTREAM_PASS || '123';

const LISTEN_PORTS = [
    3062, 3072, 3082, 3092, 3102, 3112, 3122, 3132, // BTC
    3063, 3073, 3083, 3093, 3068, 3078, 3088, 3098  // BCH
];

const PORT_MAP = {
    3062: 'btc', 3072: 'btc', 3082: 'btc', 3092: 'btc',
    3102: 'btc-solo', 3112: 'btc-solo', 3122: 'btc-solo', 3132: 'btc-solo',
    3063: 'bch', 3073: 'bch', 3083: 'bch', 3093: 'bch',
    3068: 'bch-solo', 3078: 'bch-solo', 3088: 'bch-solo', 3098: 'bch-solo'
};

// State
let currentBlockHeight = 0;
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

// Block Height Sync
const https = require('https');
async function syncBlockHeight() {
    https.get('https://blockchain.info/q/getblockcount', (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
            const h = parseInt(data);
            if (!isNaN(h) && h > currentBlockHeight) currentBlockHeight = h;
        });
    }).on('error', () => { });
}
setInterval(syncBlockHeight, 60000);
syncBlockHeight();

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
        const poolId = PORT_MAP[port] || 'btc';
        let currentWorker = 'unknown';
        let diff = 1;
        const pending = new Set();

        LOCAL_STATS.miners++;
        const upstream = new net.Socket();
        upstream.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => { });

        socket.on('data', (data) => {
            data.toString().split('\n').forEach(chunk => {
                if (!chunk.trim()) return;
                try {
                    const json = JSON.parse(chunk);
                    if (json.method === 'mining.authorize') {
                        currentWorker = json.params[0] || 'unknown';
                        json.params = [PROXY_USER, PROXY_PASS];
                        upstream.write(JSON.stringify(json) + '\n');
                    }
                    else if (json.method === 'mining.submit') {
                        json.params[0] = PROXY_USER;
                        if (json.id) pending.add(json.id);
                        upstream.write(JSON.stringify(json) + '\n');

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
                    if (json.method === 'mining.set_difficulty') diff = parseFloat(json.params[0]);
                    if (json.id && pending.has(json.id)) {
                        pending.delete(json.id);
                        if (json.result === true) LOCAL_STATS.accepted++;
                        else LOCAL_STATS.rejected++;
                    }
                } catch (e) { }
            });
        });

        socket.on('error', () => upstream.destroy());
        socket.on('close', () => { LOCAL_STATS.miners--; upstream.destroy(); });
        upstream.on('error', () => socket.destroy());
        upstream.on('close', () => socket.destroy());
    });
};

LISTEN_PORTS.forEach(p => createProxy(p).listen(p));

// === SHARE RECORDING (REAL-TIME NO BATCHING) ===
async function recordShare(full, diff, ip, port) {
    const pid = PORT_MAP[port] || 'btc';
    let addr = full;
    let wrk = '';
    if (full.includes('.')) {
        const p = full.split('.');
        addr = p[0];
        wrk = p.slice(1).join('.') || '';
    }

    // 1. Miningcore DB Write
    const q1 = `
        INSERT INTO shares (poolid, blockheight, difficulty, networkdifficulty, miner, worker, useragent, ipaddress, source, created)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    `;
    const v1 = [pid, currentBlockHeight, diff, diff, addr, wrk, 'proxy', ip, 'port-' + port];

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
