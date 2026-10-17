import { type Address } from 'viem';
export type SourceChain = 'base' | 'arc';
export const SOLANA_DOMAIN = 5;
export const TOKEN_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d' as const;
export const MESSAGE_TRANSMITTER = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64' as const;
export const ARC_EMITTER = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE' as const;
export interface SourceRoute { readonly chain: SourceChain; readonly chainId: number; readonly domain: number;
  readonly usdc: Address; readonly emitter: Address; readonly eventDecimals: 6 | 18; readonly minimum: bigint; }
const routes = {
  base: { chain: 'base', chainId: 8453, domain: 6, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', emitter: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', eventDecimals: 6 },
  arc: { chain: 'arc', chainId: 5042, domain: 26, usdc: '0x3600000000000000000000000000000000000000', emitter: ARC_EMITTER, eventDecimals: 18 },
} as const;
export function route(chain: SourceChain, minimum = 20_000000n): SourceRoute {
  if (!(chain in routes) || minimum <= 0n) throw new Error('SOURCE_ROUTE_INVALID');
  return Object.freeze({ ...routes[chain], minimum });
}
export function assertRoute(r: SourceRoute, chainId: number, domain: number) {
  const expected = route(r.chain, r.minimum);
  if (chainId !== expected.chainId || domain !== expected.domain || r.chainId !== chainId || r.domain !== domain
    || r.usdc.toLowerCase() !== expected.usdc.toLowerCase() || r.emitter.toLowerCase() !== expected.emitter.toLowerCase()
    || r.eventDecimals !== expected.eventDecimals) throw new Error('SOURCE_ROUTE_MISMATCH');
}
export function normalise(raw: bigint, decimals: 6 | 18) {
  if (raw < 0n) throw new Error('NEGATIVE_AMOUNT');
  const scale = decimals === 18 ? 1_000_000_000_000n : 1n;
  return { amount: raw / scale, remainder: raw % scale };
}
export function qualifies(raw: bigint, r: SourceRoute) {
  return raw >= r.minimum * (r.eventDecimals === 18 ? 1_000_000_000_000n : 1n);
}
