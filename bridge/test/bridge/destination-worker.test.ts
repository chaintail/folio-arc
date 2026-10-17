import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBase58Decoder } from '@solana/kit';
import { createDestinationWorker } from '../../src/bridge/worker.js';
import { SourceStore } from '../../src/bridge/transfer-record.js';
import { expectationFor, assertVerifiedDelivery, type DeliveryTransaction, type VerifiedDelivery } from '../../src/bridge/delivery.js';
import { addressBytes32, hexBytes, messageDigest } from '../../src/bridge/message.js';
import { discriminator, receiveInstruction, receivePdas, type ReadRpc } from '../../src/bridge/solana.js';
import { CCTP } from '../../src/bridge/registry.js';
import { route } from '../../src/bridge/source-registry.js';
import { approveFixture, ataData, destination, event, hash, owner, wallet } from './support.js';

/** Only chain reads and application credit are injected; worker, verifier and SQLite are real. */
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'folio-destination-'));
  const path = join(dir, 'bridge.sqlite');
  let store = new SourceStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true }); });
  const d = await destination();
  store.ingest('base', wallet, 1n, [event('base', 20_000000n, 1)]);
  const sweep = store.plan(route('base'), wallet, 'fixture-person', d, '2026-10-02T12:00:00Z')!;
  approveFixture(store, sweep.id);
  store.setState(sweep.id, 'approved', 'burn_pending');
  store.setState(sweep.id, 'burn_pending', 'burn_confirmed', { kind: 'receipt', reference: hash(500) });
  store.shared.addTransfer({ sweep_id: sweep.id, source_domain: 6, burn_tx_hash: hash(500) });

  // Encode the protocol's fixed-width V2 layout, including a public fixture nonce.
  const bytes = Buffer.alloc(376), nonce = hash(700);
  const word = (offset: number, value: string) => bytes.set(hexBytes(value), offset);
  bytes.writeUInt32BE(1, 0); bytes.writeUInt32BE(6, 4); bytes.writeUInt32BE(5, 8);
  word(12, nonce); word(44, CCTP.base.tokenMessenger); word(76, addressBytes32(CCTP.tokenMessengerMinter));
  bytes.writeUInt32BE(2000, 140); bytes.writeUInt32BE(2000, 144); bytes.writeUInt32BE(1, 148);
  word(152, CCTP.base.burnToken); word(184, sweep.mint_recipient_bytes32);
  word(216, hash(Number(sweep.amount_6))); word(248, `0x${'0'.repeat(24)}${wallet.slice(2)}`);
  const message = `0x${bytes.toString('hex')}`, attestation = `0x${'11'.repeat(65)}`;
  store.shared.saveAttestation(sweep.id, { message_nonce: nonce, message_hash: messageDigest(message), message, attestation });
  store.shared.transition(sweep.id, 'attested');
  const signature = 'fixture-finalized-receive';
  store.shared.destination(sweep.id, signature);
  store.shared.transition(sweep.id, 'delivery_submitted');

  const payer = CCTP.systemProgram, pdas = await receivePdas(message);
  const instruction = await receiveInstruction(message, attestation, payer, payer);
  const goodTx: DeliveryTransaction = {
    slot: 900,
    transaction: { signatures: [signature], message: {
      accountKeys: [payer, pdas.custody, d.ata],
      instructions: [{ programId: instruction.programAddress, data: getBase58Decoder().decode(instruction.data!),
        accounts: instruction.accounts!.map(a => a.address) }],
    } },
    meta: { err: null, fee: 5000, preBalances: [100000], postBalances: [95000],
      preTokenBalances: [{ accountIndex: 1, mint: CCTP.usdc, owner: pdas.tokenMinter }],
      postTokenBalances: [{ accountIndex: 2, mint: CCTP.usdc, owner }],
      innerInstructions: [{ index: 0, instructions: [{ programId: CCTP.tokenProgram, parsed: {
        type: 'transferChecked', info: { source: pdas.custody, destination: d.ata, authority: pdas.tokenMinter,
          mint: CCTP.usdc, tokenAmount: { amount: sweep.amount_6, decimals: 6 } },
      } }] }],
    },
  };
  let tx = structuredClone(goodTx), finalized = true, consumed = true, offline = false;
  let at = Date.parse('2026-10-02T12:00:00Z');
  const calls: string[] = [];
  const rpc: ReadRpc = { async call<T>(method: string, params: unknown[]): Promise<T> {
    calls.push(method);
    if (offline) throw new Error('RPC_FORBIDDEN_DURING_REPLAY');
    let value: unknown;
    if (method === 'getSignatureStatuses') {
      assert.deepEqual(params, [[signature], { searchTransactionHistory: true }]);
      value = { value: [{ confirmationStatus: finalized ? 'finalized' : 'confirmed', err: null, slot: 900 }] };
    } else if (method === 'getAccountInfo') {
      assert.deepEqual(params[1], { encoding: 'base64', commitment: 'finalized' });
      assert.ok(params[0] === d.ata || params[0] === pdas.usedNonce, 'only the bound token and nonce accounts may be read');
      const token = params[0] === d.ata;
      value = { value: { owner: token ? CCTP.tokenProgram : CCTP.messageTransmitter, executable: false, lamports: 1,
        data: [Buffer.from(token ? ataData() : Buffer.concat([discriminator('account:UsedNonce'), Buffer.from([consumed ? 1 : 0])])).toString('base64'), 'base64'] } };
    } else if (method === 'getTransaction') {
      assert.deepEqual(params, [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' }]);
      value = structuredClone(tx);
    } else throw new Error(`UNEXPECTED_RPC_${method}`);
    return value as T;
  } };
  const worker = (credit: (delivery: VerifiedDelivery) => Promise<unknown>) => createDestinationWorker({
    store: store.shared, rpc, payer, expected: expectationFor, credit, now: () => at,
  });
  return {
    get store() { return store; }, sweep, signature, calls, worker,
    get tx() { return tx; },
    unfinalized() { finalized = false; }, failed() { tx.meta.err = { InstructionError: [0, 'fixture'] }; },
    unconsumed() { consumed = false; },
    restore() { tx = structuredClone(goodTx); finalized = true; consumed = true; },
    advance() { at += 600_001; },
    restartOffline() { store.close(); store = new SourceStore(path); offline = true; at += 600_001; },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const invalid: [string, (f: Fixture) => void][] = [
  ['unfinalized signature', f => f.unfinalized()],
  ['failed transaction receipt', f => f.failed()],
  ['unconsumed nonce', f => f.unconsumed()],
  ['different nonce account', f => { f.tx.transaction.message.instructions[0]!.accounts![4] = owner; }],
  ['different recipient account', f => { f.tx.transaction.message.instructions[0]!.accounts![15] = owner; }],
  ['incorrect delivered principal', f => { f.tx.meta.innerInstructions[0]!.instructions[0]!.parsed!.info.tokenAmount = { amount: '1', decimals: 6 }; }],
];
for (const [name, alter] of invalid) test(`destination worker withholds credit for ${name}, then settles matching finalized evidence`, async t => {
  const f = await fixture(t), credits: VerifiedDelivery[] = [];
  const worker = f.worker(async delivery => { assertVerifiedDelivery(delivery); credits.push(delivery); });
  alter(f);
  assert.deepEqual(await worker.tick(), [{ sweepId: f.sweep.id, outcome: 'waiting' }]);
  assert.equal(f.store.sweep(f.sweep.id).state, 'delivery_submitted');
  assert.equal(f.store.shared.receipt(f.sweep.id), undefined);
  assert.equal(f.store.shared.acknowledged(f.sweep.id), false);
  assert.equal(credits.length, 0);
  f.restore(); f.advance();
  assert.deepEqual(await worker.tick(), [{ sweepId: f.sweep.id, outcome: 'settled' }]);
  assert.equal(credits.length, 1);
  assert.equal(credits[0]!.amount6, f.sweep.amount_6);
  assert.equal(credits[0]!.totalExternalAmount6, f.sweep.amount_6);
  assert.equal(credits[0]!.recipient, f.sweep.mint_recipient);
  assert.equal(f.store.sweep(f.sweep.id).state, 'settled');
  assert.equal(f.store.shared.acknowledged(f.sweep.id), true);
  assert.deepEqual(await worker.tick(), []);
  assert.equal(credits.length, 1);
});

test('destination worker retains settled evidence after credit failure and retries locally after database reopen', async t => {
  const f = await fixture(t);
  let attempts = 0;
  const credit = async (delivery: VerifiedDelivery) => {
    assertVerifiedDelivery(delivery);
    assert.equal(f.store.sweep(f.sweep.id).state, 'settled', 'settlement precedes asynchronous credit');
    assert.ok(f.store.shared.receipt(f.sweep.id));
    assert.equal(f.store.shared.acknowledged(f.sweep.id), false);
    if (++attempts === 1) throw new Error('CREDIT_UNAVAILABLE');
    assert.equal(delivery.signature, f.signature);
    assert.equal(delivery.amount6, f.sweep.amount_6);
  };
  assert.deepEqual(await f.worker(credit).tick(), [{ sweepId: f.sweep.id, outcome: 'retry' }]);
  assert.equal(f.store.sweep(f.sweep.id).state, 'settled');
  assert.equal(f.store.shared.acknowledged(f.sweep.id), false);
  const reads = f.calls.length;
  f.restartOffline();
  const restarted = f.worker(credit);
  assert.deepEqual(await restarted.tick(), [{ sweepId: f.sweep.id, outcome: 'credited' }]);
  assert.equal(f.calls.length, reads, 'replay uses retained evidence, without even attempting RPC');
  assert.equal(attempts, 2);
  assert.equal(f.store.shared.acknowledged(f.sweep.id), true);
  assert.deepEqual(await restarted.tick(), []);
  assert.equal(attempts, 2);
});

test('destination worker replays successful credit after lost acknowledgment; application deduplicates by sweep ID', async t => {
  const f = await fixture(t);
  f.store.db.exec(`CREATE TABLE fixture_credit(sweep_id TEXT PRIMARY KEY, amount6 TEXT NOT NULL);
    CREATE TRIGGER fixture_ack_failure BEFORE UPDATE OF acknowledged_at ON bridge_credit_completion
    BEGIN SELECT RAISE(ABORT, 'ACK_UNAVAILABLE'); END;`);
  let attempts = 0;
  const credit = async (delivery: VerifiedDelivery) => {
    assertVerifiedDelivery(delivery); attempts++;
    f.store.db.prepare('INSERT OR IGNORE INTO fixture_credit VALUES (?,?)').run(delivery.sweepId, delivery.amount6);
  };
  assert.deepEqual(await f.worker(credit).tick(), [{ sweepId: f.sweep.id, outcome: 'retry' }]);
  assert.equal(f.store.shared.acknowledged(f.sweep.id), false);
  assert.equal(attempts, 1);
  const reads = f.calls.length;
  f.restartOffline();
  f.store.db.exec('DROP TRIGGER fixture_ack_failure');
  const restarted = f.worker(credit);
  assert.deepEqual(await restarted.tick(), [{ sweepId: f.sweep.id, outcome: 'credited' }]);
  assert.equal(attempts, 2);
  assert.equal(f.calls.length, reads);
  const rows = f.store.db.prepare('SELECT * FROM fixture_credit').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.sweep_id, f.sweep.id);
  assert.equal(rows[0]!.amount6, f.sweep.amount_6);
  assert.equal(f.store.shared.acknowledged(f.sweep.id), true);
  assert.deepEqual(await restarted.tick(), []);
  assert.equal(attempts, 2);
});
