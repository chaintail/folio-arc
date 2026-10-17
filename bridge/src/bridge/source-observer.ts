import { errorFields, reasonCode } from '../shims/log-fields.js';
import { logDebug, logError, logInfo } from '../shims/log.js';
import { decodeEventLog, parseAbi, type Hex } from 'viem';
import { assertRoute, normalise, type SourceRoute } from './source-registry.js';
import type { DepositEvent } from './transfer-record.js';
import { SourceStore } from './transfer-record.js';
import { SCAN_PAGE_BLOCKS_MAX } from './config.js';
import { effectivePageSize, pageLogs } from './source-rpc.js';
export const transferAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
export interface SourceLog { address: Hex; topics: readonly Hex[]; data: Hex; transactionHash: Hex;
  logIndex: number; blockNumber: bigint; blockHash: Hex; removed?: boolean; }
export interface SourceReceipt { transactionHash: Hex; blockNumber: bigint; blockHash: Hex; status: 'success' | 'reverted'; logs: readonly SourceLog[]; }
export interface ObserverRpc {
  chainId(): Promise<number>;
  finalizedBlock(): Promise<bigint>;
  logs(r: SourceRoute, wallet: Hex, from: bigint, to: bigint): Promise<readonly SourceLog[]>;
  receipt(tx: Hex): Promise<SourceReceipt>;
  blockHash(block: bigint): Promise<Hex>;
}
export interface TopupMatch { readonly attemptId: string; readonly txHash: Hex; readonly chain: string;
  readonly wallet: string; readonly from: string; readonly rawAmount: bigint; readonly confirmed: boolean; }
/** Recipient attribution wins: a mint and a send by the Folio sender without a matching
 * top-up attempt are customer receipts. Sender exclusions alone are insufficient. */
export function canonicalEvent(r: SourceRoute, wallet: Hex, log: SourceLog, topups: readonly TopupMatch[]): DepositEvent | undefined {
  if (log.removed || log.address.toLowerCase() !== r.emitter.toLowerCase() || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) return;
  let decoded;
  try { decoded = decodeEventLog({ abi: transferAbi, data: log.data, topics: [...log.topics] as [Hex, ...Hex[]], strict: true }); }
  catch (e) { logDebug('bridge_event_decode_failed', { chain: r.chain, ...errorFields(e) }); return; }
  const { from, to, value } = decoded.args;
  if (to.toLowerCase() !== wallet.toLowerCase() || value <= 0n) return;
  const matches = topups.filter(t => t.confirmed && t.chain === r.chain && t.wallet.toLowerCase() === wallet.toLowerCase()
    && t.txHash.toLowerCase() === log.transactionHash.toLowerCase() && t.from.toLowerCase() === from.toLowerCase() && t.rawAmount === value);
  if (matches.length > 1) throw loggedRefusal('AMBIGUOUS_TOPUP');
  const classification: DepositEvent['classification'] = matches.length === 1 ? 'folio_gas' : from.toLowerCase() === to.toLowerCase() ? 'self' : 'customer';
  const n = normalise(value, r.eventDecimals);
  return { id: `${r.chain}:${wallet.toLowerCase()}:${log.transactionHash.toLowerCase()}:${log.logIndex}`, chain: r.chain,
    wallet: wallet.toLowerCase(), tx_hash: log.transactionHash.toLowerCase() as Hex, event_index: log.logIndex, raw_amount: String(value),
    amount_6: String(n.amount), remainder: String(n.remainder), block: String(log.blockNumber), block_hash: log.blockHash.toLowerCase() as Hex,
    sender: from.toLowerCase(), classification, covered_by: null };
}
/** The wallet's on-chain balance at a block and the ledger's accounted balance, in the same raw units. */
export interface BalanceProbe { read(block: bigint): Promise<bigint>; accounted(): bigint; }
/** equal: nothing arrived, the cursor moved to the head without logs; explained: logs in the window
 * account for the difference; unexplained: they do not (or the balance fell); pending: the window
 * is not fully scanned yet. */
export type BalanceVerdict = 'equal' | 'explained' | 'unexplained' | 'pending';
/** Balance first: with a probe, one balance read at the finalized head decides whether logs are read
 * at all. Equal to the ledger: the cursor moves to the head with no log read. Higher: logs over
 * (cursor, head] attribute the difference. Lower, or higher with no explaining logs: unexplained.
 * The cursor advances only on a fully ingested page or a verified-equal balance. */
export async function observe(store: SourceStore, rpc: ObserverRpc, r: SourceRoute, wallet: Hex,
  startBlock: bigint, topups: readonly TopupMatch[] = [], pageSize = 1000n, confirmTopups = true, maxChunks = 8,
  onBehind?: (behindBlocks: bigint) => void, balance?: BalanceProbe):
  Promise<{ behindBlocks: bigint; remainingBlocks: bigint; balance?: BalanceVerdict }> {
  store.db.exec('CREATE TABLE IF NOT EXISTS bridge_event_verification(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL)');
  assertRoute(r, await rpc.chainId(), r.domain);
  if (startBlock < 0n || pageSize <= 0n || pageSize > BigInt(SCAN_PAGE_BLOCKS_MAX) || !Number.isSafeInteger(maxChunks) || maxChunks <= 0) throw loggedRefusal('INVALID_SCAN_RANGE');
  const head = await rpc.finalizedBlock();
  const cursor = store.cursor(r.chain, wallet) ?? startBlock - 1n;
  let from = cursor + 1n;
  const behindBlocks = from <= head ? head - from + 1n : 0n;
  let actual: bigint | undefined;
  if (balance) {
    // A cursor already past the head (a boundary or recovery ahead of this tick's head) is checked where it is.
    const at = from <= head ? head : cursor;
    actual = await balance.read(at);
    const accounted = balance.accounted();
    logDebug('bridge_rpc', { chain: r.chain, method: 'balance', stage: 'balance_check', block: String(at), cursor: String(cursor),
      balance: String(actual), accounted: String(accounted), outcome: actual === accounted ? 'equal' : actual > accounted ? 'higher' : 'lower' });
    if (actual === accounted) {
      if (from <= head) {
        store.ingest(r.chain, wallet, head, [], confirmTopups);
        logDebug('bridge_rpc', { chain: r.chain, stage: 'balance_fastforward', from: String(from), to: String(head), balance: String(actual), reason: 'equal' });
      }
      return { behindBlocks, remainingBlocks: 0n, balance: 'equal' };
    }
    // Less than accounted is an outflow Folio did not make; more with no window left has nothing to explain it.
    if (actual < accounted || from > head) return { behindBlocks, remainingBlocks: behindBlocks, balance: 'unexplained' };
  }
  if (behindBlocks > effectivePageSize(r.chain, pageSize)) onBehind?.(behindBlocks);
  // One receipt per transaction and one canonical hash per block, however many logs share them.
  const hashes = new Map<bigint, Promise<Hex>>();
  const blockHash = (block: bigint) => { let hash = hashes.get(block); if (!hash) hashes.set(block, hash = rpc.blockHash(block)); return hash; };
  for (let chunk = 0; from <= head && chunk < maxChunks; chunk++) {
    // The page is the configured size unless a provider range refusal lowered it for this process.
    const page = effectivePageSize(r.chain, pageSize), end = from + page - 1n < head ? from + page - 1n : head;
    logDebug('bridge_rpc',{chain:r.chain,method:'logs',range_from:String(from),range_to:String(end),finalized_block:String(head)});
    const read = await pageLogs(rpc, r, wallet, from, end), logs = read.logs, to = read.to, events: DepositEvent[] = [];
    const receipts = new Map<string, SourceReceipt>();
    for (const log of logs) {
      if (log.blockNumber < from || log.blockNumber > to || log.removed) throw loggedRefusal('NONCANONICAL_LOG');
      const key=`${r.chain}:${log.transactionHash}:${log.logIndex}`,fingerprint=JSON.stringify(log,(_k,v)=>typeof v==='bigint'?String(v):v);
      const cached=store.db.prepare('SELECT fingerprint FROM bridge_event_verification WHERE id=?').get(key);
      if(cached && cached.fingerprint!==fingerprint)throw loggedRefusal('CANONICAL_EVENT_CHANGED');
      logDebug('bridge_rpc',{chain:r.chain,method:'receipt',stage:'canonicality',cache_decision:cached?'hit':'miss',range_from:String(from),range_to:String(to),finalized_block:String(head)});
      if(!cached) {
      let receipt = receipts.get(log.transactionHash);
      if (!receipt) { receipt = await rpc.receipt(log.transactionHash); receipts.set(log.transactionHash, receipt); }
      if (receipt.status !== 'success' || receipt.transactionHash !== log.transactionHash || receipt.blockNumber !== log.blockNumber
        || receipt.blockHash !== log.blockHash || await blockHash(log.blockNumber) !== log.blockHash
        || !receipt.logs.some(x => x.logIndex === log.logIndex && x.transactionHash === log.transactionHash && x.blockHash === log.blockHash
          && x.address.toLowerCase() === log.address.toLowerCase() && x.data === log.data && x.topics.join() === log.topics.join())) throw loggedRefusal('NONCANONICAL_RECEIPT');
      store.db.prepare('INSERT OR IGNORE INTO bridge_event_verification VALUES (?,?)').run(key,fingerprint);
      }
      const event = canonicalEvent(r, wallet, log, [...store.topupMatches(r.chain, wallet), ...topups]); if (event) events.push(event);
    }
    // No cursor advances on a failed page; replay after crash is safe.
    store.ingest(r.chain, wallet, to, events, confirmTopups); from = to + 1n;
    // Once ingested events account for the head balance, the rest of the window holds no net change.
    if (balance && from <= head && balance.accounted() === actual) {
      store.ingest(r.chain, wallet, head, [], confirmTopups);
      logDebug('bridge_rpc', { chain: r.chain, stage: 'balance_fastforward', from: String(from), to: String(head), balance: String(actual), reason: 'explained' });
      from = head + 1n;
    }
  }
  const remainingBlocks = from <= head ? head - from + 1n : 0n;
  if (remainingBlocks > 0n) logInfo('bridge_rpc', { chain: r.chain, stage: 'scan_lagging', cursor: String(from - 1n), finalized_block: String(head), remaining_blocks: String(remainingBlocks) });
  if (!balance) return { behindBlocks, remainingBlocks };
  return { behindBlocks, remainingBlocks, balance: remainingBlocks > 0n ? 'pending' : balance.accounted() === actual ? 'explained' : 'unexplained' };
}

function loggedRefusal(reason:string) { logError('bridge_rpc',{stage:'validation',reason:reason}); return new Error(reason); }
