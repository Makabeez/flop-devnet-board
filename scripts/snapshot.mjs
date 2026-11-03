// Local run: node scripts/snapshot.mjs > snapshot.json
import { buildSnapshot } from '../lib/snapshot.js';
const snap = await buildSnapshot();
process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
process.exit(0);
