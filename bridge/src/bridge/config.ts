import { route, type SourceChain } from './source-registry.js';

export const sourceChains = ['base', 'arc'] as const;
/** eth_getLogs page bounds: providers cap the block range per call (Alchemy Free 10, public Base ~2,000). */
export const SCAN_PAGE_BLOCKS_MAX = 2000, SCAN_CHUNKS_MAX = 64;
export class BridgeConfigError extends Error {
  constructor(code: string, readonly detail: string) { super(code); }
}
/** A per-chain `${name}_${CHAIN}` overrides the global `${name}`; an empty value is unset. */
function scanBound(env: NodeJS.ProcessEnv, name: string, upper: string, fallback: number, max: number, code: string) {
  const own = env[`${name}_${upper}`]?.trim() ? `${name}_${upper}` : name, raw = env[own]?.trim() || String(fallback);
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > max) throw new BridgeConfigError(code, `${own} must be an integer from 1 to ${max}`);
  return Number(raw);
}
// KEEP: deployment identity.
export function readBridgeConfig(env: NodeJS.ProcessEnv = process.env, mode = env.FOLIO_NAMESPACE_MODE) {
  const source = mode === 'live' && env.FOLIO_BRIDGE_SOURCE === '1';
  // KEEP: sweep principal limit.
  const principal=env.FOLIO_BRIDGE_MAX_PRINCIPAL_6??'100000000';
  if(!/^[1-9]\d*$/.test(principal))throw new Error('SOURCE_PRINCIPAL_CAP_INVALID');
  return {
    // KEEP: global emergency stop for fund movement; independently stops bridge sends.
    source, execute: mode === 'live' && env.FOLIO_BRIDGE_EXECUTE === '1' && env.FOLIO_LIVE_BROADCAST === '1',
    principalCap: BigInt(principal),
    worker: mode === 'live' && env.FOLIO_BRIDGE_WORKER === '1',
    chains: Object.fromEntries(sourceChains.map(chain => {
      const upper = chain.toUpperCase();
      // KEEP: sweep route minimum.
      const minimum = env[`FOLIO_BRIDGE_MIN_${upper}_6`] ?? '20000000';
      if (!/^[1-9]\d*$/.test(minimum)) throw new Error('SOURCE_MINIMUM_INVALID');
      const rpcEnv = `FOLIO_${upper}_RPC_URL`, gasWalletEnv = `FOLIO_${upper}_GAS_WALLET`, gasKeyEnv = `FOLIO_${upper}_GAS_WALLET_KEY`;
      // KEEP: provider eth_getLogs block-range limit differs per RPC plan (Alchemy Free 10, public Base ~2,000).
      const scanPageBlocks = BigInt(scanBound(env, 'FOLIO_BRIDGE_SCAN_PAGE_BLOCKS', upper, 1000, SCAN_PAGE_BLOCKS_MAX, 'SOURCE_SCAN_PAGE_BLOCKS_INVALID'));
      // KEEP: pages per observation pass; lets a lagging cursor catch up within the read budget.
      const scanChunks = scanBound(env, 'FOLIO_BRIDGE_SCAN_CHUNKS', upper, 1, SCAN_CHUNKS_MAX, 'SOURCE_SCAN_CHUNKS_INVALID');
      return [chain, { route: route(chain, BigInt(minimum)), minimum_6:minimum, enabled: env[`FOLIO_BRIDGE_ENABLE_${upper}`] !== '0', scanPageBlocks, scanChunks,
        // KEEP: per-chain incident pause.
        paused: env[`FOLIO_BRIDGE_PAUSE_${upper}`] === '1', rpcEnv, gasWalletEnv, gasKeyEnv,
        // KEEP: expiring provider evidence.
        feeProof: env[`FOLIO_BRIDGE_FEE_PROOF_${upper}`]?.trim() || undefined }];
    })) as Record<SourceChain, { route: ReturnType<typeof route>; minimum_6:string; enabled: boolean; scanPageBlocks: bigint; scanChunks: number; paused: boolean;
      rpcEnv: string; gasWalletEnv: string; gasKeyEnv: string; feeProof?: string }>,
  };
}
export type BridgeConfig = ReturnType<typeof readBridgeConfig>;
/**
 * The bridge's gate for a deposit consent (permission grant) on [chain], for S1's grant route
 * (DA 7): the source on and the chain enabled. A pause is NOT checked: it stops moving money, not
 * consent, so the release order "deploy paused, a test person consents, prove, set the proofs,
 * unpause" can complete. (The cohort allowlist was removed by #440.) Undefined when the grant may proceed.
 */
export function consentRefusal(config: BridgeConfig, chain: SourceChain): 'SOURCE_DISABLED' | undefined {
  if (!config.source || !config.chains[chain]?.enabled) return 'SOURCE_DISABLED';
  return undefined;
}
