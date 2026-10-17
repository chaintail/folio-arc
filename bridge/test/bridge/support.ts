import { address, getAddressEncoder } from '@solana/kit';
import { encodeEventTopics, encodeAbiParameters, type Hex } from 'viem';
import { verifyDestination } from '../../src/bridge/source-calls.js';
import { USDC_MINT } from '../../src/shims/usdc.js';
import { PROGRAMS } from '../../src/shims/programs.js';
import { transferAbi, canonicalEvent, type SourceLog } from '../../src/bridge/source-observer.js';
import { route, type SourceChain } from '../../src/bridge/source-registry.js';
export const owner = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
export const wallet = '0x1111111111111111111111111111111111111111' as const;
export const sender = '0x2222222222222222222222222222222222222222' as const;
export const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
export function ataData() {
  const data = new Uint8Array(165); data.set(getAddressEncoder().encode(address(USDC_MINT))); data.set(getAddressEncoder().encode(address(owner)), 32); data[108] = 1;
  return data;
}
export const readAta = async (_ata: string) => ({ exists: true, program: PROGRAMS.token, data: ataData() });
export const destination = () => verifyDestination(owner, readAta);
export function log(chain: SourceChain, raw: bigint, n = 1, overrides: Partial<SourceLog> = {}): SourceLog {
  return { address: route(chain).emitter, data: encodeAbiParameters([{ type: 'uint256' }], [raw]),
    topics: encodeEventTopics({ abi: transferAbi, eventName: 'Transfer', args: { from: sender, to: wallet } }) as Hex[],
    transactionHash: hash(n), logIndex: n, blockNumber: BigInt(n), blockHash: hash(100 + n), ...overrides };
}
export function event(chain: SourceChain, raw: bigint, n: number) { return canonicalEvent(route(chain), wallet, log(chain, raw, n), [])!; }

// Planner-only state setup; destination-worker.test.ts exercises real delivery verification and settlement.
export function approveFixture(store: import('../../src/bridge/transfer-record.js').SourceStore, id: string) {
  store.setState(id, 'planned', 'approval_pending'); store.setState(id, 'approval_pending', 'approved');
}
export function settleFixture(store: import('../../src/bridge/transfer-record.js').SourceStore, id: string) {
  const proof={kind:'receipt' as const,reference:'synthetic finalized fixture'};
  if (store.sweep(id).state === 'planned') approveFixture(store,id);
  if (store.sweep(id).state === 'approved') store.setState(id,'approved','burn_pending');
  const current=store.sweep(id).state;
  if(current==='burn_pending' || current==='burn_uncertain') store.setState(id,current,'burn_confirmed',proof);
  if(!store.shared.getTransfer(id))store.shared.addTransfer({sweep_id:id,source_domain:store.sweep(id).chain==='base'?6:26,burn_tx_hash:hash(500)});
  store.shared.saveAttestation(id,{message_nonce:id,message_hash:hash(500),message:'0x01',attestation:'0x02'});
  store.setState(id,'burn_confirmed','attested');store.shared.destination(id,'fixture-signature',true);
  store.setState(id,'attested','delivery_submitted');store.setState(id,'delivery_submitted','settled',proof);
}
