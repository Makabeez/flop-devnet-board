// Snapshot server for the Home VPS: keeps one chain connection open, rebuilds the
// snapshot every REFRESH_MS, and serves the last good copy. Vercel rewrites
// /api/snapshot here, so the board costs no Vercel function CPU.
//   PORT=8098 REFRESH_MS=300000 node scripts/serve.mjs
import http from 'node:http';
import { connect, buildSnapshot } from '../lib/snapshot.js';

const PORT = Number(process.env.PORT || 8098);
const HOST = process.env.HOST || '127.0.0.1';
const REFRESH_MS = Number(process.env.REFRESH_MS || 300_000);
const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS || 240_000);

const withTimeout = (p, ms) => Promise.race([
  p,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms).unref()),
]);

let api = null;
let body = null;      // last good snapshot, serialized
let builtAt = 0;
let lastError = null;
let failures = 0;
let running = false;

async function refresh() {
  if (running) return;
  running = true;
  const t0 = Date.now();
  try {
    const snap = await withTimeout((async () => {
      api ||= await connect();
      return buildSnapshot({ api });
    })(), BUILD_TIMEOUT_MS);
    body = JSON.stringify(snap);
    builtAt = Date.now();
    lastError = null;
    failures = 0;
    console.log(`${new Date().toISOString()} snapshot ok in ${Date.now() - t0} ms, ${snap.miners.length} miners, ${snap.channelsAllTime.total} channels`);
  } catch (e) {
    failures += 1;
    lastError = String(e?.message || e?.error?.message || (e?.type && `websocket ${e.type}`) || e).slice(0, 300);
    console.error(`${new Date().toISOString()} snapshot failed (${failures}): ${lastError}`);
    // Drop the connection on a timeout or repeated failures; the next round opens a fresh one.
    if (api && (failures >= 2 || /timed out/.test(lastError))) {
      await api.disconnect().catch(() => {});
      api = null;
    }
  } finally {
    running = false;
  }
}

function send(res, status, payload, cache) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': cache,
  });
  res.end(payload);
}

http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '{"error":"method_not_allowed"}', 'no-store');
  if (path === '/snapshot' || path === '/api/snapshot') {
    if (!body) return send(res, 503, JSON.stringify({ error: 'snapshot_not_ready', message: lastError || 'first snapshot still building' }), 'no-store');
    return send(res, 200, body, 'public, max-age=60, s-maxage=120, stale-while-revalidate=600');
  }
  if (path === '/health') {
    const ageS = builtAt ? Math.round((Date.now() - builtAt) / 1000) : null;
    const ok = !!body && ageS < (REFRESH_MS / 1000) * 3;
    return send(res, ok ? 200 : 503, JSON.stringify({ ok, ageS, failures, lastError }), 'no-store');
  }
  send(res, 404, '{"error":"not_found"}', 'no-store');
}).listen(PORT, HOST, () => console.log(`flop-devnet-board snapshot server on http://${HOST}:${PORT}, refresh every ${REFRESH_MS / 1000}s`));

refresh();
setInterval(refresh, REFRESH_MS);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await api?.disconnect().catch(() => {}); process.exit(0); });
}
