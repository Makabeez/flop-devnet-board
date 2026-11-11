// Node 22+ ships a native WebSocket, and @polkadot/x-ws prefers it over the `ws` package.
// On the Home VPS (Node 24) the native one drops with 1006 on this RPC while `ws` works,
// so pin `ws` globally. Import this before anything that loads @polkadot/api.
import WS from 'ws';

Object.defineProperty(globalThis, 'WebSocket', { value: WS, writable: true, configurable: true });
