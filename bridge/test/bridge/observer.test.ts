import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalEvent, observe, type ObserverRpc, type SourceLog } from '../../src/bridge/source-observer.js';
import { SourceStore } from '../../src/bridge/transfer-record.js';
import { route } from '../../src/bridge/source-registry.js';
import { log, wallet, sender, event, destination } from './support.js';

test('FND-007,008,009,018 recipient attribution includes mints; Arc native only; topup matched by attempt hash', () => {
  const r = route('arc'), raw = 20_000000_000000000001n, native = log('arc', raw);
  const erc20 = { ...native, address: r.usdc, logIndex: 2 };
  assert.equal(canonicalEvent(r, wallet, erc20, []), undefined);
  assert.equal(canonicalEvent(r, wallet, native, [])!.remainder, '1');
  const topup = { attemptId: 'topup', txHash: native.transactionHash, chain: 'arc', wallet, from: sender, rawAmount: raw, confirmed: true };
  assert.equal(canonicalEvent(r, wallet, native, [topup])!.classification, 'folio_gas');
  assert.equal(canonicalEvent(r, wallet, native, [{ ...topup, txHash: `0x${'aa'.repeat(32)}` }])!.classification, 'customer');
  assert.equal(canonicalEvent(r, wallet, native, [{ ...topup, wallet: sender }])!.classification, 'customer');
  assert.equal(canonicalEvent(route('base'), wallet, log('base', 20_000000n), [])!.classification, 'customer');
  const mint = log('base', 20_000000n); mint.topics = [mint.topics[0], `0x${'00'.repeat(32)}`, mint.topics[2]];
  assert.equal(canonicalEvent(route('base'), wallet, mint, [])!.classification, 'customer');
  const self = { ...native, topics: [native.topics[0], native.topics[2], native.topics[2]] };
  assert.equal(canonicalEvent(r, wallet, self, [])!.classification, 'self');
  assert.equal(canonicalEvent(r, sender, native, []), undefined);
});

test('FND-019,020,021 page commit, overlap replay and restart; failed/noncanonical receipts never advance cursor', async () => {
  const store = new SourceStore(), logs = [log('base', 20_000000n, 1), log('base', 2_000000n, 2)];
  let failed = true;
  const rpc: ObserverRpc = {
    async chainId() { return 8453; }, async finalizedBlock() { return 2n; },
    async logs(_r, _w, from, to) { return logs.filter(l => l.blockNumber >= from && l.blockNumber <= to).reverse(); },
    async receipt(tx) { const l = logs.find(l => l.transactionHash === tx)!; return { transactionHash: tx, blockNumber: l.blockNumber,
      blockHash: l.blockHash, status: failed ? 'reverted' : 'success', logs: [l] }; },
    async blockHash(block) { return logs.find(l => l.blockNumber === block)!.blockHash; },
  };
  await assert.rejects(observe(store, rpc, route('base'), wallet, 1n), /NONCANONICAL/); assert.equal(store.cursor('base', wallet), undefined);
  failed = false; await observe(store, rpc, route('base'), wallet, 1n, [], 1n);
  assert.equal(store.cursor('base', wallet), 2n); assert.equal(store.events('base', wallet).length, 2);
  await observe(store, rpc, route('base'), wallet, 1n); assert.equal(store.events('base', wallet).length, 2);
  const bad: SourceLog = { ...logs[0], removed: true }; assert.equal(canonicalEvent(route('base'), wallet, bad, []), undefined); store.close();
});

test('Base scans five 1,000-block chunks, commits every cursor, and observes a middle deposit once', async () => {
  const store = new SourceStore(), deposit = log('base', 20_000000n, 2500), reads: [bigint,bigint,bigint | undefined][] = [];
  store.ingest('base', wallet, 0n, []);
  const rpc: ObserverRpc = {
    async chainId() { return 8453; }, async finalizedBlock() { return 5000n; },
    async logs(_r, _w, from, to) {
      reads.push([from, to, store.cursor('base', wallet)]);
      if (to - from + 1n > 2000n) throw Object.assign(new Error('eth_getLogs range exceeds 2,000 blocks'), {code: -32005});
      return from <= deposit.blockNumber && to >= deposit.blockNumber ? [deposit] : [];
    },
    async receipt(tx) { return {transactionHash: tx, blockNumber: deposit.blockNumber, blockHash: deposit.blockHash,
      status: 'success', logs: [deposit]}; },
    async blockHash() { return deposit.blockHash; },
  };
  const progress = await observe(store, rpc, route('base'), wallet, 1n);
  assert.deepEqual(reads, [
    [1n, 1000n, 0n], [1001n, 2000n, 1000n], [2001n, 3000n, 2000n],
    [3001n, 4000n, 3000n], [4001n, 5000n, 4000n],
  ]);
  assert.deepEqual(progress, {behindBlocks: 5000n, remainingBlocks: 0n});
  assert.equal(store.cursor('base', wallet), 5000n);
  assert.equal(store.events('base', wallet).length, 1);
  await observe(store, rpc, route('base'), wallet, 1n);
  assert.equal(reads.length, 5);
  assert.equal(store.events('base', wallet).length, 1);
  store.close();
});

test('observer chunk limit leaves a durable cursor for the next tick', async () => {
  const store = new SourceStore(), reads: bigint[] = [];
  const rpc: ObserverRpc = {async chainId() { return 8453; }, async finalizedBlock() { return 5000n; },
    async logs(_r, _w, from) { reads.push(from); return []; },
    async receipt() { throw new Error('no deposit'); }, async blockHash() { throw new Error('no deposit'); }};
  assert.deepEqual(await observe(store, rpc, route('base'), wallet, 1n, [], 1000n, true, 2),
    {behindBlocks: 5000n, remainingBlocks: 3000n});
  assert.equal(store.cursor('base', wallet), 2000n);
  await observe(store, rpc, route('base'), wallet, 1n, [], 1000n, true, 2);
  assert.equal(store.cursor('base', wallet), 4000n);
  await observe(store, rpc, route('base'), wallet, 1n, [], 1000n, true, 2);
  assert.deepEqual(reads, [1n, 1001n, 2001n, 3001n, 4001n]);
  assert.equal(store.cursor('base', wallet), 5000n); store.close();
});

test('durable Arc top-up attempt hash excludes Folio funds and credits contribution once on finalized receipt', async () => {
  const store = new SourceStore(), raw = 30_000_000_000_000_000n, movement = log('arc', raw, 1);
  store.ingest('arc', wallet, 0n, [{...event('arc',1n,0),block:'0'}]);
  const d=await destination();
  store.shared.plan({id:'sweep',chain:'arc',wallet,person:'person',trigger_event_id:store.events('arc',wallet)[0].id,amount_6:'1',mint_recipient:d.ata,mint_recipient_bytes32:d.bytes32,destination_owner:d.owner,created_at:'now'});
  store.putAttempt({ id: 'topup', sweep_id: 'sweep', kind: 'gas_topup', chain: 'arc', request_id: 'topup',
    tx_hash: movement.transactionHash, nonce: '1', state: 'uncertain', gas_paid_raw: '0',
    evidence_json: JSON.stringify({ wallet, from: sender, rawAmount: String(raw) }) });
  const rpc: ObserverRpc = { async chainId() { return 5042; }, async finalizedBlock() { return 1n; },
    async logs() { return [movement]; }, async receipt() { return { transactionHash: movement.transactionHash, blockNumber: 1n,
      blockHash: movement.blockHash, status: 'success', logs: [movement] }; }, async blockHash() { return movement.blockHash; } };
  await observe(store, rpc, route('arc'), wallet, 1n);
  assert.equal(store.events('arc', wallet)[1].classification, 'folio_gas');
  assert.equal(store.attempt('topup')!.state, 'confirmed');
  const { GasLedger } = await import('../../src/bridge/source-gas.js');
  const l = new GasLedger('arc'); l.restore(store.readLedger('arc', wallet)!);
  assert.equal(l.folioContribution, raw); assert.equal(l.customerPrincipal, 1n);
  await observe(store, rpc, route('arc'), wallet, 1n);
  assert.equal(store.events('arc', wallet).length, 2); store.close();
});
