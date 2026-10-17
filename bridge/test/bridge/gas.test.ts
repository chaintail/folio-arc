import test from 'node:test';
import assert from 'node:assert/strict';
import { GasLedger, prepareTopup } from '../../src/bridge/source-gas.js';
import { wallet, sender, hash } from './support.js';

test('FND-023,030 Arc $20 principal, $0.03 Folio contribution, approve + failed burn + burn, exact residual', () => {
  const l = new GasLedger('arc'); l.receiveCustomer(20_000000_000000000000n);
  assert.equal(l.topupRequired(10_000_000_000_000_000n), 10_000_000_000_000_000n);
  assert.throws(() => l.beforeSigning('approve', 10_000_000_000_000_000n), /TOPUP/);
  const topup = { attemptId: 'topup', txHash: hash(1), contribution: 30_000_000_000_000_000n };
  l.confirmTopup(topup); l.confirmTopup(topup);
  assert.equal(prepareTopup(wallet, sender, topup.contribution).value, topup.contribution);
  for (const [id, n, paid, failed] of [
    ['approve', 2, 4_000_000_000_000_001n, false], ['failed-burn', 3, 5_000_000_000_000_002n, true], ['burn', 4, 6_000_000_000_000_003n, false],
  ] as const) {
    l.beforeSigning(id, 10_000_000_000_000_000n); const c = { attemptId: id, txHash: hash(n), paid, failed }; l.reconcile(c); l.reconcile(c);
  }
  l.sweep(20_000000n);
  assert.equal(l.customerPrincipal, 0n); assert.equal(l.gasCharged, 15_000_000_000_000_006n);
  assert.equal(l.folioResidual, 14_999_999_999_999_994n);
  const restored = new GasLedger('arc'); restored.restore(l.snapshot()); assert.equal(restored.snapshot(), l.snapshot());
  assert.throws(() => l.confirmTopup({ ...topup, contribution: 1n }), /CHANGED/);
});

test('gas reservations protect principal during concurrency, failure and restart; Base keeps ETH separate', () => {
  for (const chain of ['base', 'arc'] as const) {
    const l = new GasLedger(chain); l.receiveCustomer(chain === 'arc' ? 20_000000_000000000007n : 20_000000n);
    l.confirmTopup({ attemptId: 'topup', txHash: hash(1), contribution: 100n });
    l.beforeSigning('one', 75n);
    assert.throws(() => l.beforeSigning('two', 50n), /TOPUP/);
    const restarted = new GasLedger(chain); restarted.restore(l.snapshot());
    assert.equal(restarted.availableResidual, 25n);
    assert.throws(() => restarted.reconcile({ attemptId: 'one', txHash: hash(2), paid: 76n, failed: true }), /VIOLATION/);
    restarted.reconcile({ attemptId: 'one', txHash: hash(2), paid: 70n, failed: true });
    restarted.sweep(20_000000n); assert.equal(restarted.customerPrincipal, chain === 'arc' ? 7n : 0n); assert.equal(restarted.folioResidual, 30n);
  }
});
