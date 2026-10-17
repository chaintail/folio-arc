import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeTransaction, recoverTransactionAddress, type TransactionSerialized } from 'viem';
import { SourceStore } from '../../src/bridge/transfer-record.js';
import { GasLedger } from '../../src/bridge/source-gas.js';
import { prepareSource, submitSource, reconcileSource, type PreparedSource } from '../../src/bridge/source-executor.js';
import { route } from '../../src/bridge/source-registry.js';
import { destination, event, wallet, readAta, hash, ataData, approveFixture } from './support.js';
/** Synthetic r/s wire fixture only; no key, signing service or signing operation. */
function fixtureBytes(p: PreparedSource) { return serializeTransaction(p.unsignedTransactions[0], { r: hash(1), s: hash(1), yParity: 0 }); }
async function preparedFixture(kind: 'approve' | 'burn' = 'burn') {
  const store = new SourceStore(), d = await destination();
  const l = new GasLedger('base'); l.receiveCustomer(20_000000n); l.confirmTopup({ attemptId: 'gas', txHash: hash(1), contribution: 1_000_000_000n });
  store.ingest('base', wallet, 1n, [event('base', 20_000000n, 1)]);
  const s = store.plan(route('base'), wallet, 'person', d, 'now')!;
  if (kind === 'burn') approveFixture(store, s.id);
  const input = { person: 'person', wallet, attemptId: 'attempt', nonce: 0, gas: 200000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 0n, minFee: 0n, readAta };
  l.restore(store.readLedger('base', wallet)!); l.confirmTopup({ attemptId: 'gas', txHash: hash(1), contribution: 1_000_000_000n }); store.saveLedger('base', wallet, l.snapshot());
  const p = await prepareSource(store, l, s.id, kind, input), raw = fixtureBytes(p);
  // Recover the public fixture sender, then create a fresh intent for that identity. No real keys used.
  const sender = await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized });
  store.close();
  const actual = new SourceStore(); const e = event('base', 20_000000n, 1); e.wallet = sender.toLowerCase(); e.id = `base:${e.wallet}:${e.tx_hash}:1`;
  actual.ingest('base', sender, 1n, [e]); const intent = actual.plan(route('base'), sender, 'person', d, 'now')!;
  if (kind === 'burn') approveFixture(actual, intent.id);
  const ledger = new GasLedger('base'); ledger.receiveCustomer(20_000000n); ledger.confirmTopup({ attemptId: 'gas', txHash: hash(1), contribution: 1_000_000_000n });
  ledger.restore(actual.readLedger('base', sender)!); ledger.confirmTopup({ attemptId: 'gas', txHash: hash(1), contribution: 1_000_000_000n }); actual.saveLedger('base', sender, ledger.snapshot());
  const prepared = await prepareSource(actual, ledger, intent.id, kind, { ...input, wallet: sender });
  return { store: actual, ledger, s: intent, prepared, bytes: fixtureBytes(prepared), input: { ...input, wallet: sender } };
}

test('FND-039 approval receipt alone never starts a cross-chain leg', async () => {
  const f = await preparedFixture('approve');
  await submitSource(f.store, 'attempt', 'person', f.bytes, { dryRun: false, readAta, async fixtureBroadcast() { throw new Error('lost response'); } });
  const a = f.store.attempt('attempt')!;
  reconcileSource(f.store, f.ledger, a.id, { txHash: a.tx_hash! as `0x${string}`, success: true, gasUsed: 100n, effectiveGasPrice: 2n, finalized: true });
  assert.equal(f.store.sweep(f.s.id).state, 'approved'); assert.equal(f.ledger.customerPrincipal, 20_000000n); f.store.close();
});

test('FND-045,046,047 lost burn response persists uncertain, refuses retry, resolves from receipt fixture exactly once', async () => {
  const f = await preparedFixture(); let calls = 0;
  const broadcast = async () => { calls++; throw new Error('lost'); };
  const result = await submitSource(f.store, 'attempt', 'person', f.bytes, { dryRun: false, readAta, fixtureBroadcast: broadcast });
  assert.equal(result.uncertain, true); assert.equal(f.store.sweep(f.s.id).state, 'burn_uncertain');
  const restart = new GasLedger('base'); restart.restore(f.store.readLedger('base', f.input.wallet)!);
  await assert.rejects(submitSource(f.store, 'attempt', 'person', f.bytes, { dryRun: false, readAta, fixtureBroadcast: broadcast }), /BLOCKED/); assert.equal(calls, 1);
  const receipt = { txHash: result.txHash, success: true, gasUsed: 100n, effectiveGasPrice: 2n, finalized: true };
  reconcileSource(f.store, restart, 'attempt', receipt); reconcileSource(f.store, restart, 'attempt', receipt);
  assert.equal(f.store.sweep(f.s.id).state, 'burn_confirmed'); assert.equal(restart.customerPrincipal, 0n); assert.equal(restart.gasCharged, 200n);
  assert.equal(f.store.shared.getTransfer(f.s.id)!.burn_tx_hash, result.txHash);
  assert.equal(f.store.shared.getTransfer(f.s.id)!.source_domain, 6);
  assert.equal(f.store.shared.gasLedger(f.input.wallet.toLowerCase(), 'base').customer_principal, 0n);
  assert.throws(() => reconcileSource(f.store, restart, 'attempt', { ...receipt, success: false }), /CHANGED/); f.store.close();
});

test('FND-006,023,026,048 default dry-run, signed field tampering, identity, paused submit and lost ATA fail closed', async () => {
  const f = await preparedFixture();
  assert.equal((await submitSource(f.store, 'attempt', 'person', f.bytes, { readAta })).broadcast, false);
  assert.equal(f.store.attempt('attempt')!.state, 'prepared');
  await assert.rejects(submitSource(f.store, 'attempt', 'other', f.bytes, { readAta }), /BLOCKED/);
  const altered = serializeTransaction({ ...f.prepared.unsignedTransactions[0], value: 1n }, { r: hash(1), s: hash(1), yParity: 0 });
  await assert.rejects(submitSource(f.store, 'attempt', 'person', altered, { readAta }), /MISMATCH/);
  f.store.pause('base', true);
  await assert.rejects(submitSource(f.store, 'attempt', 'person', f.bytes, { dryRun: false, readAta, async fixtureBroadcast() { throw new Error('should not execute'); } }), /PAUSED/);
  f.store.pause('base', false);
  await assert.rejects(submitSource(f.store, 'attempt', 'person', f.bytes, { readAta: async () => ({ exists: false, program: '', data: ataData() }) }), /NOT_READY/);
  f.store.close();
});

test('FND-030 failed burn gas persists and returns to approved; a test cap blocks the full amount', async () => {
  const f = await preparedFixture();
  const result = await submitSource(f.store, 'attempt', 'person', f.bytes, { dryRun: false, readAta, async fixtureBroadcast() { throw new Error('lost'); } });
  reconcileSource(f.store, f.ledger, 'attempt', { txHash: result.txHash, success: false, gasUsed: 20n, effectiveGasPrice: 3n, finalized: true });
  assert.equal(f.store.sweep(f.s.id).state, 'approved'); assert.equal(f.ledger.customerPrincipal, 20_000000n); assert.equal(f.ledger.gasCharged, 60n);
  await assert.rejects(prepareSource(f.store, f.ledger, f.s.id, 'burn', { ...f.input, attemptId: 'retry', principalCap: 1_000000n }), /EXCEEDS_TEST_CAP/);
  const retry = await prepareSource(f.store, f.ledger, f.s.id, 'burn', { ...f.input, attemptId: 'retry', nonce: 1 }); assert.equal(retry.unsignedTransactions.length, 1); f.store.close();
});

test('customer deposit after signing stays in principal while failed and successful attempts reconcile', async () => {
  const f = await preparedFixture();
  const e = event('base', 5_000000n, 2); e.wallet = f.input.wallet.toLowerCase(); e.id = `base:${e.wallet}:${e.tx_hash}:2`;
  f.store.ingest('base', f.input.wallet, 2n, [e]);
  const result = await submitSource(f.store, 'attempt', 'person', f.bytes, { dryRun: false, readAta, async fixtureBroadcast() { throw new Error('lost'); } });
  reconcileSource(f.store, f.ledger, 'attempt', { txHash: result.txHash, success: true, gasUsed: 20n, effectiveGasPrice: 3n, finalized: true });
  assert.equal(f.ledger.customerPrincipal, 5_000000n); assert.equal(f.store.sweep(f.s.id).amount_6, '20000000'); f.store.close();
});
