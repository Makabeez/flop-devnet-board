# flop-devnet-board

A live board of the FLOP devnet miner economy: how many miners the stake sponsor funded, how many are registered and calibrated, which ones the hosted gateway actually routes inference to, and who got paid.

Everything is read from public sources, every 5 minutes:

| Data | Source |
|---|---|
| Sponsored stake, registered miners, self/delegated stake | chain: `minerStaking.sponsoredStakeByMiner`, `minerStaking.miners` |
| Calibration (accepted GFLOP/s cap, tier, verified jobs) | chain: `hwCalibration.benchmarkBurstCaps` |
| Compute channels (miner, opening agent, state, block) | chain: `computeChannel.channels` |
| Realized settlements and miner pay | hosted FLOP MCP indexer: `flop_list_settlements` |
| Miners the gateway prices from | `api.flop.network/v1/models` → `x-flop.price_sources` |
| Faucet health and grant limits | `faucet.flop.network/health` |

The chain's genesis is checked on every read (`0x99c172c0…d631`), so the board never mixes in data from another network.

> Devnet only. Devnet FLOP has no value and earns no rewards or airdrop weight; the chain may be reset. Not affiliated with Flop Labs.

## What it showed on launch (3 Nov 2026, 22:25 UTC)

- 28 accounts got sponsored stake; 26 are registered miners; 25 have passed calibration.
- In the last 24 h, **5 of 26** miners got any compute channel. **82%** of the 104 channels were opened by one account, the hosted gateway's shared agent `5GsXb3…F98S`, and the top two miners took **84%** of all channels.
- The gateway's `/v1/models` quoted prices from only **2** miners. Six miners calibrated at 130 to 200 GFLOP/s had no channel in the last 24 h, while the two busiest are calibrated at 46 and 7 GFLOP/s.
- 2 sponsored accounts are no longer registered.

## Layout

```
index.html            the board (static, no build step, refreshes every 5 min)
vercel.json           rewrites /api/snapshot to the snapshot server
lib/snapshot.js       all the reading and aggregation
scripts/serve.mjs     snapshot server: one persistent chain connection, rebuilds every 5 min
scripts/snapshot.mjs  run one snapshot locally
```

The JSON is public and CORS-open at `/api/snapshot`, so anyone can build on it.

## Run locally

```bash
npm install
npm run snapshot > snapshot.json
```

Node 20 or newer. One snapshot takes about 70 s as of 11 Nov 2026 (it reads every compute channel, about 29k, and pages through the indexer).

## Deploy

The page is static on Vercel; the snapshot is built by a small long-running server instead of a Vercel function. A snapshot decodes every compute channel on the chain, so its cost grows with network activity, and rebuilding it inside a serverless function on every cache miss burned through the Fluid CPU quota.

1. Run the server on any always-on box (Node 20+):
   ```bash
   npm install
   PORT=8098 REFRESH_MS=300000 npm run serve
   ```
   It serves `/snapshot` (JSON, CORS open) and `/health`, bound to 127.0.0.1 by default (`HOST` to change).
2. Expose it over HTTPS (a Cloudflare tunnel works) and point the rewrite in `vercel.json` at that URL.
3. Import the repo in Vercel (framework preset: Other, no build command). `/api/snapshot` keeps working for anyone building on it.

Optional environment overrides: `FLOP_RPC`, `FLOP_MCP_URL`, `FLOP_FAUCET_URL`, `FLOP_GATEWAY_URL`.

## Method notes

- The **gateway account** is the agent that opened the most channels overall; today that is `5GsXb3TmNGixuEsbtixqHnqWr9UQJ2M8bkqBQWteNekgF98S`.
- **Got traffic** means at least one compute channel opened with that miner in the last 24 h, by any agent.
- Block times are converted with on-chain timestamps at block 1, about one day back, and the head; older dates are approximate.

## Related

- [flop-devnet-starter](https://github.com/Makabeez/flop-devnet-starter): one script from key to inference call on the devnet, with the CLI issues found along the way.

## License

MIT
