const net = require('net');
const http = require('http');
const { Client } = require('pg');
const os = require('os');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

/**
 * STRATUM PROXY - SHA256 (BTC/BCH) STABLE VERSION
 * ----------------------------------------------
 * - Focused ONLY on BTC and BCH (SHA256).
 * - Ports match share-relay.json (30xx series).
 * - Routes all upstream hash to ViaBTC as 'imskaa.001'.
 */

// === CONFIGURATION ===
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'bch.viabtc.io';
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT) || 3333;
const PROXY_USER = process.env.UPSTREAM_USER || 'imskaa.001';
const PROXY_PASS = process.env.UPSTREAM_PASS || '123';

// Correct Ports from share-relay.json (BTC and BCH ONLY)
const LISTEN_PORTS = [
    3062, 3072, 3082, 3092, 3102, 3112, 3122, 3132, // BTC & BTC-Solo
    3063, 3073, 3083, 3093, 3068, 3078, 3088, 3098  // BCH & BCH-Solo
];

const PORT_MAP = {
    // BTC
    3062: 'btc', 3072: 'btc', 3082: 'btc', 3092: 'btc',
    3102: 'btc-solo', 3112: 'btc-solo', 3122: 'btc-solo', 3132: 'btc-solo',
    // BCH
    3063: 'bch', 3073: 'bch', 3083: 'bch', 3093: 'bch',
    3068: 'bch-solo', 3078: 'bch-solo', 3088: 'bch-solo', 3098: 'bch-solo'
};

// State
let currentBlockHeight = 0;
const PROXY_ID = os.hostname() + '-' + crypto.randomBytes(4).toString('hex');
const STATS = {
    miners: 0,
    shares: 0,
    accepted: 0,
    rejected: 0,
    start: Date.now(),
    workers: {} // Tracking: { "address.worker": { s: 0, d: 0, t: 0 } }
};

// === DATABASE CONNECTIONS ===
const dbShares = new Client({ connectionString: process.env.MININGCORE_DB_URL });
const dbStats = new Client({ connectionString: process.env.PROXY_DB_URL });

async function connectDBs() {
    try {
        await dbShares.connect();
        await dbStats.connect();
        console.log('[DB] Connected: Shares & Stats');
    } catch (err) {
        console.error('[DB ERROR] Authentication or Connection failed:', err.message);
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

// Heartbeat to Stats DB
async function heartbeat() {
    const uptime = Math.floor((Date.now() - STATS.start) / 1000);
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
    const values = [PROXY_ID, os.hostname(), STATS.miners, STATS.shares, STATS.accepted, STATS.rejected, uptime];
    try { await dbStats.query(query, values); } catch (e) { }
}
setInterval(heartbeat, 5000);

// === PROXY ENGINE ===
const createProxy = (port) => {
    return net.createServer((socket) => {
        const ip = socket.remoteAddress;
        let currentWorker = 'unknown';
        let diff = 1;
        const pending = new Set();

        const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] [${port}] ${m}`);

        STATS.miners++;
        const upstream = new net.Socket();
        upstream.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => { });

        socket.on('data', (data) => {
            const chunks = data.toString().split('\n');
            chunks.forEach(chunk => {
                if (!chunk.trim()) return;
                try {
                    const json = JSON.parse(chunk);
                    if (json.method === 'mining.authorize') {
                        currentWorker = json.params[0] || 'unknown';
                        log(`Auth: ${currentWorker}`);
                        // REDIRECT TO VIABTC
                        json.params = [PROXY_USER, PROXY_PASS];
                        upstream.write(JSON.stringify(json) + '\n');
                    }
                    else if (json.method === 'mining.submit') {
                        json.params[0] = PROXY_USER;
                        if (json.id) pending.add(json.id);
                        upstream.write(JSON.stringify(json) + '\n');

                        STATS.shares++;
                        if (!STATS.workers[currentWorker]) STATS.workers[currentWorker] = { s: 0, d: 0, t: 0 };
                        STATS.workers[currentWorker].s++;
                        STATS.workers[currentWorker].d += diff;
                        STATS.workers[currentWorker].t = Date.now();

                        recordShare(currentWorker, diff, ip, port);
                    }
                    else {
                        upstream.write(JSON.stringify(json) + '\n');
                    }
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
                    }
                    if (json.id && pending.has(json.id)) {
                        pending.delete(json.id);
                        if (json.result === true) {
                            STATS.accepted++;
                        } else {
                            STATS.rejected++;
                        }
                    }
                } catch (e) { }
            });
        });

        socket.on('error', () => upstream.destroy());
        socket.on('close', () => { STATS.miners--; upstream.destroy(); });
        upstream.on('error', () => socket.destroy());
        upstream.on('close', () => socket.destroy());
    });
};

LISTEN_PORTS.forEach(p => createProxy(p).listen(p));

// === DASHBOARD API ===
http.createServer(async (req, res) => {
    if (req.url === '/api/stats') {
        const workers = [];
        const now = Date.now();
        for (const [name, w] of Object.entries(STATS.workers)) {
            if (now - w.t < 600000) {
                const th = (w.d * Math.pow(2, 32)) / 300 / 1e12;
                workers.push({ name, s: w.s, h: th.toFixed(2) });
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
            miners: STATS.miners,
            acc: STATS.accepted,
            rej: STATS.rejected,
            uptime: Math.floor((Date.now() - STATS.start) / 1000),
            workers: workers.sort((a, b) => b.s - a.s)
        }));
    } else if (req.url === '/' || req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>SHA256 Proxy</title><style>body{background:#0f172a;color:#fff;font-family:sans-serif;padding:2rem}h1{color:#3b82f6}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem}.card{background:#1e293b;padding:1.5rem;border-radius:12px;border:1px solid #334155}.val{font-size:2rem;font-weight:bold}table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden}th,td{padding:1rem;text-align:left;border-bottom:1px solid #334155}th{color:#94a3b8;font-size:.8rem;text-transform:uppercase}</style></head><body><h1>SHA256 PROXY DASHBOARD</h1><div class="grid"><div class="card">Miners<div class="val" id="m">0</div></div><div class="card">Accepted<div class="val" style="color:#22c55e" id="a">0</div></div><div class="card">Rejected<div class="val" style="color:#ef4444" id="r">0</div></div><div class="card">Uptime<div class="val" id="u">0s</div></div></div><table><thead><tr><th>Worker</th><th>Shares</th><th>TH/s</th></tr></thead><tbody id="list"></tbody></table><script>function u(){fetch('/api/stats').then(r=>r.json()).then(d=>{document.getElementById('m').textContent=d.miners;document.getElementById('a').textContent=d.acc;document.getElementById('r').textContent=d.rej;document.getElementById('u').textContent=d.uptime+'s';let h='';d.workers.forEach(w=>{h+='<tr><td>'+w.name+'</td><td>'+w.s+'</td><td>'+w.h+'</td></tr>'});document.getElementById('list').innerHTML=h})}setInterval(u,2000);u()</script></body></html>`);
    } else { res.writeHead(404); res.end(); }
}).listen(3344);

// === SHARE RECORDING ===
async function recordShare(full, diff, ip, port) {
    const pid = PORT_MAP[port] || 'btc';
    let addr = full;
    let wrk = '';
    if (full.includes('.')) {
        const p = full.split('.');
        addr = p[0];
        wrk = p.slice(1).join('.') || '';
    }
    const query = `
        INSERT INTO shares (poolid, blockheight, difficulty, networkdifficulty, miner, worker, useragent, ipaddress, source, created)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    `;
    const vals = [pid, currentBlockHeight, diff, diff, addr, wrk, 'proxy', ip, 'port-' + port];
    try { await dbShares.query(query, vals); } catch (e) { }
}
