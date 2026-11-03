// Builds one snapshot of the FLOP devnet miner economy from public sources only:
//   - the chain itself (wss RPC): registered miners, sponsored stake, calibration caps, compute channels
//   - the hosted FLOP MCP indexer: realized settlements (who got paid, how much)
//   - the faucet /health and the gateway /v1/models (which miners the gateway quotes)
import { ApiPromise, WsProvider } from '@polkadot/api';

export const RPC = process.env.FLOP_RPC || 'wss://rpc.devnet.flop.network';
const MCP = process.env.FLOP_MCP_URL || 'https://mcp.flop.network/mcp';
const FAUCET = process.env.FLOP_FAUCET_URL || 'https://faucet.flop.network';
const GATEWAY = process.env.FLOP_GATEWAY_URL || 'https://api.flop.network/v1';
export const GENESIS = '0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631';
const DAY_MS = 86_400_000;
const WEI = 10n ** 18n;

const toFlop = (raw) => {
  const v = BigInt(raw ?? 0);
  return Number(v / WEI) + Number(v % WEI) / 1e18;
};
const stateName = (s) => (typeof s === 'string' ? s : Object.keys(s || {})[0] || 'unknown').toLowerCase();

async function getJson(url, init = {}, ms = 15_000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text.slice(0, 300) }; }
}

async function mcpTool(name, args) {
  const r = await fetch(MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await r.text();
  const lines = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  const msg = JSON.parse(lines.length ? lines[lines.length - 1] : raw);
  if (msg.error) throw new Error(`${name}: ${msg.error.message || JSON.stringify(msg.error)}`);
  const res = msg.result || {};
  if (res.structuredContent) return res.structuredContent;
  return JSON.parse(res.content?.[0]?.text ?? '{}');
}

async function allSettlements(max = 3000) {
  const first = await mcpTool('flop_list_settlements', { limit: 100, offset: 0 });
  const total = Math.min(max, Number(first.pagination?.total || 0));
  const offsets = [];
  for (let o = 100; o < total; o += 100) offsets.push(o);
  const pages = await Promise.all(offsets.map((offset) => mcpTool('flop_list_settlements', { limit: 100, offset })));
  const seen = new Set();
  return [first, ...pages].flatMap((p) => p.data || []).filter((s) => {
    const key = `${s.channelId}|${s.extrinsicHash}|${s.eventIndex}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// Block number -> unix ms, from three timestamp anchors (block 1, ~1 day ago, head).
async function clock(api, head) {
  const at = async (n) => (await (await api.at(await api.rpc.chain.getBlockHash(n))).query.timestamp.now()).toNumber();
  const tHead = (await api.query.timestamp.now()).toNumber();
  const dayBack = Math.max(2, head - 86_400);
  const [t1, tDay] = await Promise.all([at(1), at(dayBack)]);
  const recent = (tHead - tDay) / (head - dayBack);
  const older = dayBack > 1 ? (tDay - t1) / (dayBack - 1) : recent;
  return {
    head, tHead, msPerBlockRecent: recent,
    toMs: (b) => (b >= dayBack ? tHead - (head - b) * recent : tDay - (dayBack - b) * older),
  };
}

export async function buildSnapshot() {
  const started = Date.now();
  const api = await ApiPromise.create({ provider: new WsProvider(RPC), noInitWarn: true, throwOnConnect: true });
  try {
    const genesis = api.genesisHash.toHex();
    if (genesis !== GENESIS) throw new Error(`unexpected chain genesis ${genesis}`);

    const [header, chainName, nodeVersion] = await Promise.all([
      api.rpc.chain.getHeader(), api.rpc.system.chain(), api.rpc.system.version(),
    ]);
    const head = header.number.toNumber();
    const q = api.query;

    const [clk, minersE, sponsoredE, capsE, busyE, channelsE, totalStake, totalMinerPaid,
      settlements, faucet, models, stats] = await Promise.all([
      clock(api, head),
      q.minerStaking.miners.entries(),
      q.minerStaking.sponsoredStakeByMiner.entries(),
      q.hwCalibration.benchmarkBurstCaps.entries(),
      q.minerStaking.minerBusyCount.entries(),
      q.computeChannel.channels.entries(),
      q.minerStaking.totalStake(),
      q.computeChannel.totalMinerPaid(),
      allSettlements().catch((e) => ({ error: String(e.message || e) })),
      getJson(`${FAUCET}/health`).catch((e) => ({ status: 0, body: String(e.message || e) })),
      getJson(`${GATEWAY}/models`).catch((e) => ({ status: 0, body: String(e.message || e) })),
      mcpTool('flop_get_stats', {}).catch(() => null),
    ]);

    const now = clk.tHead;
    const since24 = now - DAY_MS;

    // Which account is "the gateway": the agent that opened the most channels overall.
    const agentCount = {};
    const channels = channelsE.map(([k, v]) => {
      const c = v.toJSON();
      agentCount[c.agent] = (agentCount[c.agent] || 0) + 1;
      return {
        id: k.args[0].toHex(), agent: c.agent, miner: c.miner, state: stateName(c.state),
        openedAt: Number(c.openedAt), openedMs: clk.toMs(Number(c.openedAt)), escrow: toFlop(c.escrow),
      };
    });
    const gatewayAgent = Object.entries(agentCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    const quoted = new Set();
    const modelList = [];
    if (models.status === 200 && Array.isArray(models.body?.data)) {
      for (const m of models.body.data) {
        const src = m['x-flop']?.price_sources || [];
        src.forEach((s) => quoted.add(s.miner_address));
        modelList.push({ id: m.id, registry: m['x-flop']?.registry_model || null, quotedBy: src.map((s) => s.miner_address) });
      }
    }

    const sponsored = Object.fromEntries(sponsoredE.map(([k, v]) => [k.args[0].toString(), toFlop(v.toString())]));
    const caps = Object.fromEntries(capsE.map(([k, v]) => [k.args[0].toString(), v.toJSON()]));
    const busy = Object.fromEntries(busyE.map(([k, v]) => [k.args[0].toString(), Number(v.toString())]));

    const settled = Array.isArray(settlements) ? settlements : [];
    const pay = {};
    for (const s of settled) {
      const p = (pay[s.miner] ||= { count: 0, paid: 0, last: 0, gateway: 0 });
      p.count += 1; p.paid += toFlop(s.minerPaid); p.last = Math.max(p.last, s.settledAt || 0);
      if (s.agent === gatewayAgent) p.gateway += 1;
    }

    const miners = minersE.map(([k, v]) => {
      const address = k.args[0].toString();
      const m = v.toJSON();
      const cap = caps[address];
      const mine = channels.filter((c) => c.miner === address);
      const recent = mine.filter((c) => c.openedMs >= since24);
      const p = pay[address] || { count: 0, paid: 0, last: 0, gateway: 0 };
      return {
        address,
        registeredAt: Number(m.registeredAt), registeredMs: clk.toMs(Number(m.registeredAt)),
        active: !!m.isActive,
        selfStake: toFlop(m.selfStake), delegatedStake: toFlop(m.delegatedStake),
        sponsoredStake: sponsored[address] ?? 0,
        calibrated: !!cap,
        capGflops: cap ? Number(cap.capGflopsPerSec) : null,
        tier: cap?.assuranceTier ?? null,
        calibratedMs: cap ? clk.toMs(Number(cap.acceptedAt)) : null,
        verifiedJobs: cap ? Number(cap.verifiedJobs) : null,
        busy: busy[address] || 0,
        quotedByGateway: quoted.has(address),
        channels: mine.length,
        channels24h: recent.length,
        gatewayChannels24h: recent.filter((c) => c.agent === gatewayAgent).length,
        openChannels: mine.filter((c) => c.state === 'open').length,
        lastChannelMs: mine.length ? Math.max(...mine.map((c) => c.openedMs)) : null,
        settlements: p.count, paidFlop: p.paid, lastPaidMs: p.last || null,
      };
    }).sort((a, b) => b.channels24h - a.channels24h || b.paidFlop - a.paidFlop || (b.capGflops ?? -1) - (a.capGflops ?? -1));

    const registered = new Set(miners.map((m) => m.address));
    const sponsoredGone = Object.keys(sponsored).filter((a) => !registered.has(a));

    // 24 hourly buckets of channel opens, gateway vs everyone else.
    const hourly = Array.from({ length: 24 }, (_, i) => ({ start: since24 + i * 3_600_000, gateway: 0, other: 0 }));
    for (const c of channels) {
      if (c.openedMs < since24) continue;
      const i = Math.min(23, Math.floor((c.openedMs - since24) / 3_600_000));
      hourly[i][c.agent === gatewayAgent ? 'gateway' : 'other'] += 1;
    }

    const recentAll = channels.filter((c) => c.openedMs >= since24);
    const stateCount = channels.reduce((o, c) => ((o[c.state] = (o[c.state] || 0) + 1), o), {});
    const fb = typeof faucet.body === 'object' ? faucet.body : null;

    return {
      generatedAt: new Date().toISOString(),
      buildMs: Date.now() - started,
      chain: { name: chainName.toString(), node: nodeVersion.toString(), genesis, head, headTime: new Date(now).toISOString(), msPerBlock: Math.round(clk.msPerBlockRecent) },
      gatewayAgent,
      totals: {
        sponsored: Object.keys(sponsored).length,
        registered: miners.length,
        sponsoredGone: sponsoredGone.length,
        calibrated: miners.filter((m) => m.calibrated).length,
        quotedByGateway: miners.filter((m) => m.quotedByGateway).length,
        withChannels24h: miners.filter((m) => m.channels24h > 0).length,
        paidEver: miners.filter((m) => m.settlements > 0).length,
        idleCalibrated24h: miners.filter((m) => m.calibrated && m.channels24h === 0).length,
        totalStakeFlop: toFlop(totalStake.toString()),
        totalMinerPaidFlop: toFlop(totalMinerPaid.toString()),
      },
      traffic24h: {
        channels: recentAll.length,
        gateway: recentAll.filter((c) => c.agent === gatewayAgent).length,
        otherAgents: new Set(recentAll.filter((c) => c.agent !== gatewayAgent).map((c) => c.agent)).size,
        hourly,
      },
      channelsAllTime: { total: channels.length, byState: stateCount, gateway: agentCount[gatewayAgent] || 0, agents: Object.keys(agentCount).length },
      settlements: Array.isArray(settlements)
        ? { count: settled.length, last: settled.length ? new Date(Math.max(...settled.map((s) => s.settledAt))).toISOString() : null }
        : { error: settlements.error },
      miners,
      sponsoredGone,
      faucet: fb ? { status: fb.status, balanceFlop: toFlop(fb.freeBalanceRaw), limits: fb.limits, version: fb.image?.version } : { status: 'unreachable', detail: faucet.body },
      gateway: { modelsStatus: models.status, models: modelList },
      network: stats?.stats || null,
      sources: { rpc: RPC, mcp: MCP, faucet: `${FAUCET}/health`, gateway: `${GATEWAY}/models` },
    };
  } finally {
    await api.disconnect().catch(() => {});
  }
}
