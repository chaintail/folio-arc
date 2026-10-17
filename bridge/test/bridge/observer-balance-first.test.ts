/** Balance-first observer contract: scanners never fall behind. Each pass reads the wallet balance at the
 * finalized head first; logs are read only when that balance exceeds what the ledger accounts for,
 * and only over (cursor, head]. Equal moves the cursor to the head without a log read; lower, or
 * higher with no explaining logs, holds as SOURCE_OPENING_BALANCE_UNEXPLAINED. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { namespaceKey } from '../../src/shims/namespace.js';
import type { Address, Hex } from 'viem';
import { readBridgeConfig } from '../../src/bridge/config.js';
import { observe, type BalanceProbe, type ObserverRpc } from '../../src/bridge/source-observer.js';
import { createSourceRpc, resetPageShrink, type SourceRpc } from '../../src/bridge/source-rpc.js';
import { createSourceService } from '../../src/bridge/source-service.js';
import { bridgeReadBudget } from '../../src/bridge/read-budget.js';
import { GasLedger } from '../../src/bridge/source-gas.js';
import { SourceStore } from '../../src/bridge/transfer-record.js';
import { route, type SourceChain } from '../../src/bridge/source-registry.js';
import { personNamespaceOf, type PersonScope } from '../../src/shims/person-scope.js';
import { event, log, wallet, owner, readAta, hash } from './support.js';

function capture(t: import('node:test').TestContext) {
  const lines: Record<string, any>[] = [];
  t.mock.method(console, 'log', (line: string) => { if (typeof line === 'string' && line.startsWith('{')) lines.push(JSON.parse(line)); });
  return { events: (event: string, stage?: string) => lines.filter(l => l.event === event && (stage === undefined || l.stage === stage)) };
}
/** The source service's accounted balance: customer principal, plus the Folio residual on Arc. */
function probe(store: SourceStore, chain: SourceChain, read: BalanceProbe['read']): BalanceProbe {
  return { read, accounted: () => { const l = new GasLedger(chain), saved = store.readLedger(chain, wallet); if (saved) l.restore(saved);
    return l.customerPrincipal + (chain === 'arc' ? l.folioResidual : 0n); } };
}
/** A Base observer RPC whose logs answer from `deposits` and are recorded. */
function baseRpc(head: () => bigint, deposits: ReturnType<typeof log>[], reads: [bigint, bigint][]): ObserverRpc {
  return { async chainId() { return 8453; }, async finalizedBlock() { return head(); },
    async logs(_r, _w, from, to) { reads.push([from, to]); return deposits.filter(d => d.blockNumber >= from && d.blockNumber <= to); },
    async receipt(tx) { const d = deposits.find(x => x.transactionHash === tx)!;
      return { transactionHash: tx, blockNumber: d.blockNumber, blockHash: d.blockHash, status: 'success', logs: [d] }; },
    async blockHash(block) { return deposits.find(x => x.blockNumber === block)!.blockHash; } };
}

test('(a) balance equal, cursor 224,000 blocks behind: one balance read at the head, no getLogs, cursor at the head', async t => {
  resetPageShrink(); t.after(resetPageShrink);
  const out = capture(t), store = new SourceStore(), reads: [bigint, bigint][] = [], balances: bigint[] = [];
  store.ingest('base', wallet, 5n, [event('base', 20_000000n, 5)]);
  const rpc = baseRpc(() => 224_005n, [], reads);
  const progress = await observe(store, rpc, route('base'), wallet, 1n, [], 1000n, false, 8, undefined,
    probe(store, 'base', async block => { balances.push(block); return 20_000000n; }));
  assert.deepEqual(progress, { behindBlocks: 224_000n, remainingBlocks: 0n, balance: 'equal' });
  assert.deepEqual(balances, [224_005n]);
  assert.deepEqual(reads, []);
  assert.equal(store.cursor('base', wallet), 224_005n);
  assert.equal(store.events('base', wallet).length, 1);
  const [ff, ...more] = out.events('bridge_rpc', 'balance_fastforward');
  assert.equal(more.length, 0);
  assert.deepEqual([ff.from, ff.to, ff.balance, ff.reason], ['6', '224005', '20000000', 'equal']);
  assert.equal(out.events('bridge_rpc', 'scan_lagging').length, 0);
  store.close();
});

test('(b) balance higher by a deposit: logs only over (cursor, head], the event is ingested, the equation holds, cursor at head', async t => {
  resetPageShrink(); t.after(resetPageShrink);
  const out = capture(t), store = new SourceStore(), reads: [bigint, bigint][] = [];
  store.ingest('base', wallet, 100n, []);
  let head = 5100n;
  const deposit = log('base', 20_000000n, 3050), rpc = baseRpc(() => head, [deposit], reads);
  const p = probe(store, 'base', async () => 20_000000n);
  const progress = await observe(store, rpc, route('base'), wallet, 1n, [], 1000n, false, 8, undefined, p);
  assert.deepEqual(progress, { behindBlocks: 5000n, remainingBlocks: 0n, balance: 'explained' });
  // The window starts after the cursor; once the deposit explains the balance the rest is skipped.
  assert.deepEqual(reads, [[101n, 1100n], [1101n, 2100n], [2101n, 3100n]]);
  assert.deepEqual(store.events('base', wallet).map(e => [e.block, e.amount_6, e.classification]), [['3050', '20000000', 'customer']]);
  assert.equal(p.accounted(), 20_000000n);
  assert.equal(store.cursor('base', wallet), 5100n);
  assert.deepEqual(out.events('bridge_rpc', 'balance_fastforward').map(l => [l.from, l.to, l.reason]), [['3101', '5100', 'explained']]);
  // The next pass finds the balance equal: no logs at all.
  head = 9000n;
  assert.equal((await observe(store, rpc, route('base'), wallet, 1n, [], 1000n, false, 8, undefined, p)).balance, 'equal');
  assert.equal(reads.length, 3);
  assert.equal(store.cursor('base', wallet), 9000n);
  store.close();
});

test('(b) a window longer than maxChunks pages stays pending, logs scan_lagging and resumes from the committed cursor', async t => {
  resetPageShrink(); t.after(resetPageShrink);
  const out = capture(t), store = new SourceStore(), reads: [bigint, bigint][] = [];
  store.ingest('base', wallet, 0n, []);
  const rpc = baseRpc(() => 5000n, [log('base', 20_000000n, 3000)], reads), p = probe(store, 'base', async () => 20_000000n);
  assert.deepEqual(await observe(store, rpc, route('base'), wallet, 1n, [], 1000n, false, 2, undefined, p),
    { behindBlocks: 5000n, remainingBlocks: 3000n, balance: 'pending' });
  assert.equal(store.cursor('base', wallet), 2000n);
  const [lag] = out.events('bridge_rpc', 'scan_lagging');
  assert.deepEqual([lag.level, lag.cursor, lag.finalized_block, lag.remaining_blocks], ['info', '2000', '5000', '3000']);
  assert.deepEqual(await observe(store, rpc, route('base'), wallet, 1n, [], 1000n, false, 2, undefined, p),
    { behindBlocks: 3000n, remainingBlocks: 0n, balance: 'explained' });
  assert.deepEqual(reads, [[1n, 1000n], [1001n, 2000n], [2001n, 3000n]]);
  assert.equal(store.cursor('base', wallet), 5000n);
  store.close();
});

test('(c) balance higher but no logs in the window: unexplained; every page was ingested so the cursor is at the head', async t => {
  resetPageShrink(); t.after(resetPageShrink); capture(t);
  const store = new SourceStore(), reads: [bigint, bigint][] = [];
  store.ingest('base', wallet, 0n, []);
  const progress = await observe(store, baseRpc(() => 1500n, [], reads), route('base'), wallet, 1n, [], 1000n, false, 8, undefined,
    probe(store, 'base', async () => 1n));
  assert.deepEqual(progress, { behindBlocks: 1500n, remainingBlocks: 0n, balance: 'unexplained' });
  assert.deepEqual(reads, [[1n, 1000n], [1001n, 1500n]]);
  store.close();
});

test('(d) balance lower than the ledger: unexplained without a log read; the cursor stays', async t => {
  resetPageShrink(); t.after(resetPageShrink); capture(t);
  const store = new SourceStore(), reads: [bigint, bigint][] = [];
  store.ingest('base', wallet, 5n, [event('base', 20_000000n, 5)]);
  const progress = await observe(store, baseRpc(() => 9000n, [], reads), route('base'), wallet, 1n, [], 1000n, false, 8, undefined,
    probe(store, 'base', async () => 10_000000n));
  assert.equal(progress.balance, 'unexplained');
  assert.deepEqual(reads, []);
  assert.equal(store.cursor('base', wallet), 5n);
  store.close();
});

test('the balance read is one read-budget call, through the real adapter', async t => {
  resetPageShrink(); t.after(resetPageShrink); capture(t);
  const store = new SourceStore(), methods: string[] = [];
  store.ingest('base', wallet, 0n, []);
  const provider: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body)); methods.push(body.method);
    const result = body.method === 'eth_call' ? `0x${(0n).toString(16).padStart(64, '0')}` : null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const live = createSourceRpc('base', 'https://base.example', bridgeReadBudget(store.db)('base', provider));
  const rpc: ObserverRpc = { ...live, chainId: async () => 8453, finalizedBlock: async () => 400_000n };
  const progress = await observe(store, rpc, route('base'), wallet, 1n, [], 1000n, false, 1, undefined,
    probe(store, 'base', block => live.tokenBalance(wallet, block)));
  assert.equal(progress.balance, 'equal');
  assert.deepEqual(methods, ['eth_call']);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM bridge_rpc_read WHERE lane='base'").get() as { n: number }).n, 1);
  assert.equal(store.cursor('base', wallet), 400_000n);
  store.close();
});

const scope: PersonScope = { user: 'person-1', namespace: personNamespaceOf('person-1'), wallet_address: owner,
  evm_wallet: { id: 'evm-1', address: wallet as Address } };
/** A waiting intent on `chain` driven by the live source service; unlisted RPC methods throw. */
function service(chain: SourceChain, rpc: Partial<SourceRpc>, opening?: ReturnType<typeof event>) {
  const store = new SourceStore(), clock = Date.parse('2026-10-10T12:00:00Z'), calls: string[] = [];
  const counted = new Proxy(rpc, { get: (target, key) => { const f = (target as any)[key];
    return typeof f === 'function' ? (...a: unknown[]) => { calls.push(String(key)); return f(...a); } : () => { throw new Error(`unexpected ${String(key)}`); }; } }) as SourceRpc;
  const svc = createSourceService({ store, config: readBridgeConfig({ FOLIO_BRIDGE_SOURCE: '1' }, 'live'), rpc: { [chain]: counted },
    people: () => [scope], readAta, credited: () => false, log: () => {}, now: () => clock });
  const i = svc.intents.create({ person: namespaceKey(scope.namespace), chain, wallet, owner }, clock);
  svc.intents.update(i.id, { state: 'waiting', boundary: '0' });
  store.ingest(chain, wallet, opening ? BigInt(opening.block) : 0n, opening ? [opening] : []);
  return { store, svc, calls, intent: () => svc.intents.get(i.id)! };
}

test('(c) service: a higher Base balance that the window logs do not explain holds as SOURCE_OPENING_BALANCE_UNEXPLAINED', async t => {
  resetPageShrink(); t.after(resetPageShrink); capture(t);
  const h = service('base', { chainId: async () => route('base').chainId, finalizedBlock: async () => 800n, logs: async () => [],
    tokenBalance: async () => 1n, blockHash: async () => hash(1), receipt: async () => { throw new Error('unused'); } });
  await h.svc.tick();
  assert.equal(h.intent().state, 'held');
  assert.equal(h.intent().hold_reason, 'SOURCE_OPENING_BALANCE_UNEXPLAINED');
  assert.deepEqual(h.calls.filter(c => c !== 'chainId' && c !== 'finalizedBlock'), ['tokenBalance', 'logs']);
  h.store.close();
});

test('(d) service: a Base balance below the ledger holds as SOURCE_OPENING_BALANCE_UNEXPLAINED without reading logs', async t => {
  resetPageShrink(); t.after(resetPageShrink); capture(t);
  const h = service('base', { chainId: async () => route('base').chainId, finalizedBlock: async () => 800n,
    tokenBalance: async () => 10_000000n }, event('base', 20_000000n, 5));
  await h.svc.tick();
  assert.equal(h.intent().hold_reason, 'SOURCE_OPENING_BALANCE_UNEXPLAINED');
  assert.deepEqual(h.calls.filter(c => c !== 'chainId' && c !== 'finalizedBlock'), ['tokenBalance']);
  assert.equal(h.store.cursor('base', wallet), 5n);
  h.store.close();
});

test('(e) service: Arc reads the native balance (18 decimals, 10^12 per ledger unit) at the head; never the token balance', async t => {
  resetPageShrink(); t.after(resetPageShrink); capture(t);
  const raw = 25n * 10n ** 18n, deposit = log('arc', raw, 40), balanceBlocks: (bigint | undefined)[] = [];
  const head = 900n;
  const rpc: Partial<SourceRpc> = { chainId: async () => route('arc').chainId, finalizedBlock: async () => head,
    balance: async (_w, block) => { balanceBlocks.push(block); return raw; },
    logs: async (_r, _w, from, to) => from <= 40n && to >= 40n ? [deposit] : [],
    receipt: async tx => ({ transactionHash: tx, blockNumber: 40n, blockHash: deposit.blockHash, status: 'success', logs: [deposit] }),
    blockHash: async () => deposit.blockHash };
  const h = service('arc', rpc);
  await h.svc.tick();
  assert.deepEqual(balanceBlocks, [900n]);
  assert.equal(h.calls.includes('tokenBalance'), false);
  assert.deepEqual(h.store.events('arc', wallet).map(e => [e.raw_amount, e.amount_6]), [[String(raw), '25000000']]);
  assert.equal(BigInt(h.store.events('arc', wallet)[0]!.amount_6) * 10n ** 12n, raw);
  assert.equal(h.store.cursor('arc', wallet), 900n);
  assert.notEqual(h.intent().hold_reason, 'SOURCE_OPENING_BALANCE_UNEXPLAINED');
  // One wei of native dust beyond the ledger is unexplained on Arc.
  const dust = service('arc', { ...rpc, balance: async () => raw + 1n });
  await dust.svc.tick();
  assert.equal(dust.intent().hold_reason, 'SOURCE_OPENING_BALANCE_UNEXPLAINED');
  h.store.close(); dust.store.close();
});
