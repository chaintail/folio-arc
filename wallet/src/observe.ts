import { createHash } from 'node:crypto';
import type { PrivyEvent } from './observation.js';
export { observe } from './observation.js';
export type { PrivyEvent, PrivyObservation, JwtMetadata } from './observation.js';
export const hashRef = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 8);
export function requestEvent(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, rpc?: unknown, idem?: string): PrivyEvent {
  const kind = path.startsWith('/v1/policies') ? 'policies'
    : path.startsWith('/v1/key_quorums') ? 'key_quorums' : path.endsWith('/rpc') ? 'wallets_rpc'
    : method === 'GET' ? 'wallets_get' : method === 'PATCH' ? 'wallets_patch' : 'wallets';
  const wallet = /^\/v1\/wallets\/([^/]+)(?:\/rpc)?$/.exec(path)?.[1];
  return { op: kind, method, path_kind: kind,
    ...(['signTransaction', 'signAndSendTransaction', 'eth_signTransaction', 'signMessage'].includes(String(rpc)) ? { rpc_method: rpc as PrivyEvent['rpc_method'] } : {}),
    ...(wallet ? { wallet_ref: hashRef(wallet) } : {}), ...(idem ? { idem_ref: hashRef(idem) } : {}) };
}
