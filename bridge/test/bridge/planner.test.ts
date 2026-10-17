import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceStore } from '../../src/bridge/transfer-record.js';
import { route, qualifies } from '../../src/bridge/source-registry.js';
import { destination, wallet, event, approveFixture, settleFixture } from './support.js';

test('FND-011,012,013 individual raw threshold: boundaries and $10+$10 including same transaction', async () => {
  assert.equal(qualifies(19_999999n, route('base')), false);
  assert.equal(qualifies(20_000000_000000000000n - 1n, route('arc')), false);
  assert.equal(qualifies(20_000000n, route('base')), true);
  assert.equal(qualifies(20_000000_000000000000n, route('arc')), true);
  const d = await destination();
  for (const chain of ['base', 'arc'] as const) {
    const store = new SourceStore(), scale = chain === 'arc' ? 10n ** 12n : 1n;
    const a = event(chain, 10_000000n * scale, 1), b = event(chain, 10_000000n * scale, 2);
    b.tx_hash = a.tx_hash; b.id = `${chain}:${wallet}:${a.tx_hash}:2`;
    store.ingest(chain, wallet, 2n, [a, b]);
    assert.equal(store.plan(route(chain), wallet, 'person', d, '2026-10-02T12:00:00Z'), undefined); store.close();
  }
});

test('FND-014,015,016,017,019,022,047 $5+$2+$20 sweeps $27 once; pause, covered triggers, late dust and per-chain serialization', async () => {
  const store = new SourceStore(), d = await destination();
  try {
    store.ingest('base', wallet, 4n, [event('base', 5_000000n, 1), event('base', 2_000000n, 2), event('base', 20_000000n, 3)]);
    store.ingest('arc', wallet, 1n, [event('arc', 7_000000_000000000000n, 1)]);
    store.pause('base', true); assert.equal(store.plan(route('base'), wallet, 'person', d, 'now'), undefined);
    store.pause('base', false);
    const s = store.plan(route('base'), wallet, 'person', d, 'now')!; assert.equal(s.amount_6, '27000000');
    assert.equal(store.events('base', wallet).every(e => e.covered_by === s.id), true);
    store.ingest('base', wallet, 4n, [event('base', 20_000000n, 3), event('base', 5_000000n, 1)]);
    assert.equal(store.events('base', wallet).length, 3);
    approveFixture(store, s.id); store.setState(s.id, 'approved', 'burn_pending'); assert.equal(store.plan(route('base'), wallet, 'person', d, 'now'), undefined);
    store.setState(s.id, 'burn_pending', 'burn_uncertain');
    store.ingest('base', wallet, 5n, [event('base', 20_000000n, 5)]);
    assert.equal(store.plan(route('base'), wallet, 'person', d, 'now'), undefined);
    settleFixture(store, s.id);
    const next = store.plan(route('base'), wallet, 'person', d, 'now')!; assert.equal(next.amount_6, '20000000');
    settleFixture(store, next.id);
    store.ingest('base', wallet, 6n, [event('base', 1_000000n, 6)]);
    assert.equal(store.plan(route('base'), wallet, 'person', d, 'now'), undefined);
    assert.equal(store.plan(route('arc'), wallet, 'person', d, 'now'), undefined);
    store.ingest('arc', wallet, 2n, [event('arc', 20_000000_000000000001n, 2)]);
    assert.equal(store.plan(route('arc'), wallet, 'person', d, 'now')!.amount_6, '27000000');
  } finally { store.close(); }
});

test('FND-015 two qualifying events covered, gas excluded; Arc remainder included in later principal', async () => {
  const store = new SourceStore(), d = await destination();
  const gas = { ...event('arc', 20_000000_000000000000n, 3), classification: 'folio_gas' as const };
  store.ingest('arc', wallet, 3n, [event('arc', 20_000000_999999999999n, 1), event('arc', 20_000000_000000000002n, 2), gas]);
  const s = store.plan(route('arc'), wallet, 'person', d, 'now')!; assert.equal(s.amount_6, '40000001');
  assert.equal(store.events('arc', wallet).filter(e => e.covered_by === s.id).length, 2);
  settleFixture(store, s.id);
  store.ingest('arc', wallet, 4n, [event('arc', 20_000000_999999999999n, 4)]);
  assert.equal(store.plan(route('arc'), wallet, 'person', d, 'now')!.amount_6, '20000001'); store.close();
});

test('FND-020,047 sequential planning across two SQLite connections creates one sweep; reopen preserves cursor and immutable intent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctp-source-')), path = join(dir, 'source.sqlite');
  const first = new SourceStore(path), second = new SourceStore(path), d = await destination();
  try {
    first.ingest('base', wallet, 10n, [event('base', 20_000000n, 1)]);
    const plans = await Promise.all([Promise.resolve().then(() => first.plan(route('base'), wallet, 'person', d, 'now')),
      Promise.resolve().then(() => second.plan(route('base'), wallet, 'person', d, 'now'))]);
    assert.equal(plans.filter(Boolean).length, 1); assert.equal(second.cursor('base', wallet), 10n);
    assert.throws(() => second.ingest('base', wallet, 10n, [{ ...event('base', 20_000000n, 1), amount_6: '1' }]), /CHANGED|INVALID/);
    assert.equal(second.sweep(plans.find(Boolean)!.id).amount_6, '20000000');
  } finally { first.close(); second.close(); }
  const restarted = new SourceStore(path); assert.equal(restarted.cursor('base', wallet), 10n); assert.equal(restarted.sweeps('base', wallet).length, 1); restarted.close(); rmSync(dir, { recursive: true });
});
