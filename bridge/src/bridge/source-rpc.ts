import { errorFields } from '../shims/log-fields.js';
import { logEvent, logDebug, logInfo } from '../shims/log.js';
import { createPublicClient, TransactionReceiptNotFoundError, http, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ObserverRpc, SourceLog } from './source-observer.js';
import type { SourceChain, SourceRoute } from './source-registry.js';
import { route } from './source-registry.js';
import type { PreparedTransaction } from './source-executor.js';
import { readBridgeConfig } from './config.js';
export interface SourceRpc extends ObserverRpc {
  nonce(wallet: Address, blockTag?: 'pending' | 'latest'): Promise<number>;
  /** At `block` when given (the finalized block the observer scanned to), else at the finalized tag. */
  balance(wallet: Address, block?: bigint): Promise<bigint>;
  tokenBalance(wallet: Address, block?: bigint): Promise<bigint>;
  minimumFee(amount: bigint): Promise<bigint>;
  deployment(): Promise<{implementation: Address; proxyCodeHash: Hex; implementationCodeHash: Hex; block: string}>;
  budget(wallet: Address, tx: Pick<PreparedTransaction, 'to' | 'data' | 'value'>, preSendGas?: bigint): Promise<{gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; maxAdditionalFee: bigint}>;
  transaction(hash: Hex): Promise<{from: Address; to: Address | null; value: bigint; input: Hex; nonce: number}>;
  charge(hash: Hex): Promise<{txHash: Hex; success: boolean; gasUsed: bigint; effectiveGasPrice: bigint; additionalFee: bigint; finalized: boolean} | null>;
  broadcast(bytes: Hex): Promise<Hex>;
}
/** Constructing this adapter never reads a key or opens a network connection. */
export function createSourceRpc(chain: SourceChain, url: string, request: typeof fetch = fetch,
  gate?: {env: NodeJS.ProcessEnv; mode: string}): SourceRpc {
  let calls=0;
  const observed: typeof fetch = async (input, init) => {
    let method = 'unknown';
    if (typeof init?.body === 'string') { try { const parsed = JSON.parse(init.body); if (typeof parsed.method === 'string' && /^[a-zA-Z_]{1,64}$/.test(parsed.method)) method = parsed.method; } catch (e) { logDebug('evm_rpc_decode_failed', errorFields(e)); } }
    const call_id=String(++calls),started = Date.now(); logDebug('evm_rpc', { chain, provider:chain, call_id, method, phase: 'start' });
    try { const response = await request(input, init); let rpc_code: number | undefined;
      try { const payload = await response.clone().json() as { error?: { code?: unknown } }; if (typeof payload.error?.code === 'number') rpc_code = payload.error.code; } catch (e) { logDebug('evm_rpc_decode_failed', errorFields(e)); }
      logEvent(response.ok && rpc_code === undefined ? 'debug' : 'info', response.ok && rpc_code === undefined ? 'evm_rpc' : 'evm_rpc_failed', { chain, provider:chain, call_id, method, status: response.status, rpc_code, class: rpc_code === undefined ? response.ok ? undefined : 'HTTP' : 'RPC', ms: Date.now() - started }); return response;
    } catch (e) { logInfo('evm_rpc_failed', { chain, provider:chain, call_id, method, ...errorFields(e), ms: Date.now() - started }); throw e; }
  };
  const r = route(chain), client = createPublicClient({transport: http(url, {fetchFn: observed, retryCount: 0, timeout: 15000})});
  const logs = (items: readonly unknown[]) => items as SourceLog[];
  return {
    chainId: () => client.getChainId(), finalizedBlock: async () => (await client.getBlock({blockTag: 'finalized'})).number,
    logs: async (_r, wallet, fromBlock, toBlock) => logs(await client.getLogs({address: r.emitter,
      event: parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])[0], args: {to: wallet}, fromBlock, toBlock})),
    receipt: async hash => { const x = await client.getTransactionReceipt({hash}); return {...x, transactionHash: hash, logs: logs(x.logs)}; },
    blockHash: async blockNumber => (await client.getBlock({blockNumber})).hash,
    nonce: (address, blockTag = 'pending') => client.getTransactionCount({address, blockTag}),
    balance: (address, block) => client.getBalance({address, ...(block === undefined ? {blockTag: 'finalized' as const} : {blockNumber: block})}),
    tokenBalance: (address, block) => client.readContract({address: r.usdc, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [address],
      ...(block === undefined ? {blockTag: 'finalized' as const} : {blockNumber: block})}),
    minimumFee: amount => client.readContract({address:'0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
      abi:parseAbi(['function getMinFeeAmount(uint256 amount) view returns (uint256)']),functionName:'getMinFeeAmount',args:[amount],blockTag:'finalized'}),
    async deployment() {
      const blockNumber=await this.finalizedBlock(),proxy='0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
      const word=await client.getStorageAt({address:proxy,slot:'0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',blockNumber});
      if(!word)throw new Error('SOURCE_DEPLOYMENT_UNAVAILABLE');const implementation=`0x${word.slice(-40)}` as Address;
      const code=await client.getCode({address:implementation,blockNumber}),proxyCode=await client.getCode({address:proxy,blockNumber});
      if(!code || code==='0x' || !proxyCode || proxyCode==='0x')throw new Error('SOURCE_DEPLOYMENT_UNAVAILABLE');
      return {implementation,implementationCodeHash:keccak256(code),proxyCodeHash:keccak256(proxyCode),block:String(blockNumber)};
    },
    async budget(wallet, tx, preSendGas) {
      // Estimate execution before the JIT contribution exists. Only native balance is overridden;
      // allowance, principal and deployment state are real. No override enters submitted wire.
      const gas = preSendGas ?? 3n * await client.estimateGas({account: wallet, ...tx,stateOverride:[{address:wallet,balance:10n**30n}]});
      const price = await client.getGasPrice();
      let maxAdditionalFee = 0n;
      if (chain === 'base') {
        // Upper bound with an intentionally large serialized envelope, never a zero L1 assumption.
        maxAdditionalFee = 3n * await client.readContract({address: '0x420000000000000000000000000000000000000F',
          abi: parseAbi(['function getL1Fee(bytes) view returns (uint256)']), functionName: 'getL1Fee',
          args: [`0x${'ff'.repeat(512)}${tx.data.slice(2)}`]});
      }
      return {gas, maxFeePerGas: chain === 'arc' ? (price > 20_000_000_000n ? price * 2n : 40_000_000_000n) : price * 2n,
        maxPriorityFeePerGas: 0n, maxAdditionalFee};
    },
    transaction: hash => client.getTransaction({hash}),
    async charge(hash) {
      const x = await client.getTransactionReceipt({hash}).catch(error => {
        logDebug('evm_receipt_unavailable', { chain, ...errorFields(error) });
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      });
      if (!x) return null;
      const head = await this.finalizedBlock();
      const raw = await client.request({method: 'eth_getTransactionReceipt', params: [hash]}) as unknown as {l1Fee?: Hex};
      if (chain === 'base' && raw.l1Fee === undefined) throw new Error('SOURCE_L1_FEE_MISSING');
      return {txHash: hash, success: x.status === 'success', gasUsed: x.gasUsed, effectiveGasPrice: x.effectiveGasPrice,
        additionalFee: BigInt(raw.l1Fee ?? '0x0'), finalized: x.blockNumber <= head && x.blockHash === await this.blockHash(x.blockNumber)};
    },
    broadcast: serializedTransaction => {
      if (!gate || !readBridgeConfig(gate.env,gate.mode).source || !readBridgeConfig(gate.env,gate.mode).execute) throw new Error('SOURCE_EXECUTION_DISABLED');
      return client.sendRawTransaction({serializedTransaction});
    },
  };
}
/** Called only after the live execution gate. Signed wire is persisted with the attempt before broadcast and never logged. */
export async function signGasTopup(key: Hex, expected: Address, tx: PreparedTransaction) {
  const account = privateKeyToAccount(key);
  if (account.address.toLowerCase() !== expected.toLowerCase()) throw new Error('GAS_WALLET_KEY_MISMATCH');
  // Local-account signing needs no transport: the prepared transaction already carries chainId and nonce.
  const bytes = await account.signTransaction({...tx});
  return {bytes, hash: keccak256(bytes)};
}
/** The provider's own message from an RPC error, bounded to 200 characters with URLs removed.
 * viem's top-level message embeds the endpoint URL (which may carry an API key) and request body,
 * so the JSON-RPC `details` text is preferred; otherwise the innermost cause's message. Undefined
 * for errors that are not RPC or HTTP failures (no numeric code, status or details anywhere). */
export function providerDetail(error: unknown): string | undefined {
  let details: string | undefined, innermost: string | undefined, rpc = false;
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === 'object' && !seen.has(current);) {
    seen.add(current);
    const item = current as {code?: unknown; status?: unknown; details?: unknown; message?: unknown; cause?: unknown};
    if (typeof item.code === 'number' || typeof item.status === 'number') rpc = true;
    if (details === undefined && typeof item.details === 'string' && item.details.trim()) { details = item.details; rpc = true; }
    if (typeof item.message === 'string' && item.message.trim()) innermost = item.message;
    current = item.cause;
  }
  const text = details ?? innermost;
  if (!rpc || !text) return undefined;
  const clean = text.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]').replace(/\b(?:URL|Request body):.*$/gims, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return clean && !/^[A-Z][A-Z0-9_]*$/.test(clean) ? clean : undefined;
}
const rangeCodes = new Set([-32600, -32602, -32005]);
const rangeText = /block range|blocks? (?:range|span)|range (?:is )?too (?:large|wide)|exceed[s]?[^.]{0,40}blocks?|max(?:imum)?[^.]{0,40}block|block[^.]{0,40}(?:limit|max)/i;
/** The block-range limit an eth_getLogs refusal names, or undefined when the error is not a range
 * refusal. JSON-RPC -32600/-32602/-32005 whose text names a block-range limit qualifies: "up to a N
 * block range" (Alchemy), a suggested `[0x…, 0x…]` range, or "exceeds N blocks"/"max N blocks".
 * `null` is a range refusal that names no usable number. */
export function blockRangeLimit(error: unknown): bigint | null | undefined {
  let coded = false; const texts: string[] = [];
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === 'object' && !seen.has(current);) {
    seen.add(current);
    const item = current as {code?: unknown; details?: unknown; shortMessage?: unknown; message?: unknown; cause?: unknown};
    if (typeof item.code === 'number' && rangeCodes.has(item.code)) coded = true;
    for (const text of [item.details, item.shortMessage, item.message]) if (typeof text === 'string') texts.push(text.replace(/\b(?:URL|Request body):.*$/gim, ''));
    current = item.cause;
  }
  const text = texts.find(t => rangeText.test(t));
  if (!coded || !text) return undefined;
  const number = (raw: string) => { const n = BigInt(raw.replace(/,/g, '')); return n > 0n ? n : undefined; };
  const upTo = /up to (?:a |an )?([\d,]+)[ -]?blocks?(?: range)?/i.exec(text);
  if (upTo) return number(upTo[1]) ?? null;
  const suggested = /\[\s*(0x[0-9a-f]+)\s*,\s*(0x[0-9a-f]+)\s*\]/i.exec(text);
  if (suggested && BigInt(suggested[2]) >= BigInt(suggested[1])) return BigInt(suggested[2]) - BigInt(suggested[1]) + 1n;
  const named = /(?:exceed[s]?|max(?:imum)?|limit(?:ed)?(?: to)?|greater than|more than)\D{0,30}?([\d,]+)\s*blocks?/i.exec(text)
    ?? /block range\D{0,30}?(?:limit|max(?:imum)?|is)\D{0,10}?([\d,]+)/i.exec(text);
  return named ? number(named[1]) ?? null : null;
}
/** Effective eth_getLogs page per chain for this process, lowered by provider range refusals.
 * Never persisted: the env page size is the durable setting and a restart starts from it. */
const shrunkPages = new Map<string, bigint>();
export const effectivePageSize = (chain: string, configured: bigint) => { const shrunk = shrunkPages.get(chain); return shrunk !== undefined && shrunk < configured ? shrunk : configured; };
/** Test seam: forget process-lifetime page shrinks. */
export const resetPageShrink = () => shrunkPages.clear();
/** eth_getLogs for [from, to]; on a provider block-range refusal narrower than the page, lowers the
 * chain's effective page to the provider's limit (half the page when none is named; never below 1)
 * and retries the same start once with the smaller range. Each attempt is one budgeted call.
 * Returns the logs and the last block actually covered. */
export async function pageLogs(rpc: Pick<ObserverRpc, 'logs'>, r: SourceRoute, wallet: Hex, from: bigint, to: bigint): Promise<{logs: readonly SourceLog[]; to: bigint}> {
  const shrink = (error: unknown, start: bigint, end: bigint) => {
    const limit = blockRangeLimit(error), width = end - start + 1n;
    if (limit === undefined) return undefined;
    const next = limit === null ? width / 2n : limit;
    if (next >= width) return undefined;
    const page = next < 1n ? 1n : next;
    shrunkPages.set(r.chain, page);
    logInfo('bridge_rpc', {stage: 'page_shrunk', chain: r.chain, from: String(start), to: String(end), old_page: String(width), new_page: String(page),
      provider_message: providerDetail(error)});
    return page;
  };
  try { return {logs: await rpc.logs(r, wallet, from, to), to}; }
  catch (error) {
    const page = shrink(error, from, to);
    if (page === undefined) throw error;
    const narrowed = from + page - 1n;
    try { return {logs: await rpc.logs(r, wallet, from, narrowed), to: narrowed}; }
    catch (again) { shrink(again, from, narrowed); throw again; }
  }
}
