import { buildSnapshot } from '../lib/snapshot.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    const snap = await buildSnapshot();
    // Shared CDN cache: one chain read per minute at most, stale copy served while refreshing.
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(snap);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'snapshot_failed', message: String(e?.message || e).slice(0, 300) });
  }
}
