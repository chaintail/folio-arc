import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { address } from '@solana/kit';
import { sourceSignerDiagnostic } from '../../src/shims/capabilities.js';
import { namespaceKey } from '../../src/shims/namespace.js';
import { personNamespaceOf } from '../../src/shims/person-scope.js';
import { obligationAddress as accountAddress } from '../../src/shims/obligation.js';
import { associatedTokenAddress } from '../../src/shims/associated-token.js';
import { readAccountChunks, rpcMultiAccountCap, type MultiAccountResult } from '../../src/shims/multi-account.js';
import { evmAuthorizationKey, provenEvmEnv } from '../permission-proof-support.js';
import { owner } from '../bridge/support.js';
import { CCTP } from '../../src/bridge/registry.js';

test('destination address derivations match fixed independent vectors', async () => {
  assert.equal(await associatedTokenAddress(owner, CCTP.usdc, CCTP.tokenProgram), '3wvJdyFnGvaMWpbq93NU91SggiVRveULUXL6iX5VZDGP');
  const expected = { spot: '27DkSxXJkDeRKs4gNFMRoK7bLEdjMwSwRovtyL79kzGJ', margin: '63GPoC9dGsgneWKpnCjzoEUKopS9R3Hh3TEU6gLtY5PY', crypto: '3eezUXu95fsNzDGBTGnb1MXqzemwrC4mQ8SRN5FVgGTK' };
  for (const key of ['spot', 'margin', 'crypto'] as const) assert.equal(await accountAddress(key, owner), address(expected[key]));
  await assert.rejects(accountAddress('spot', 'invalid-address'));
});

test('person namespace preserves identity hashing and rejects malformed live keys', () => {
  const user = 'did:privy:fixture-person';
  assert.equal(namespaceKey(personNamespaceOf(user)), `live:${createHash('sha256').update(user).digest('hex')}`);
  assert.throws(() => namespaceKey({ kind: 'live', person_id: 'unbound' }), /Invalid person namespace/);
  assert.equal(namespaceKey({ kind: 'live' }), 'live');
  assert.equal(namespaceKey({ kind: 'simulation', branch_id: 'branch', seed_ref: 'seed' }), '["simulation","branch","seed"]');
});

test('signing diagnostics bind proofs to each chain and reject shared authority', () => {
  const env: NodeJS.ProcessEnv = { PRIVY_APP_ID: 'fixture-app', PRIVY_APP_SECRET: 'fixture-only', ...provenEvmEnv('quorum') };
  for (const chain of ['base', 'arc'] as const) assert.deepEqual(sourceSignerDiagnostic(env, chain).missing_inputs, []);
  const missing = sourceSignerDiagnostic({ ...env, FOLIO_EVM_PERMISSION_PROOF_BASE: undefined }, 'base').missing_inputs;
  assert.deepEqual(missing, ['FOLIO_EVM_PERMISSION_PROOF_BASE']);
  const rotated = { ...env, FOLIO_EVM_BASE_AUTHORIZATION_KEY: evmAuthorizationKey() };
  assert.ok(sourceSignerDiagnostic(rotated, 'base').missing_inputs.includes('FOLIO_EVM_PERMISSION_PROOF_BASE'));
  assert.deepEqual(sourceSignerDiagnostic(rotated, 'arc').missing_inputs, []);
  for (const patch of [
    { PRIVY_AUTHORIZATION_KEY: env.FOLIO_EVM_BASE_AUTHORIZATION_KEY },
    { FOLIO_EVM_ARC_AUTHORIZATION_KEY: env.FOLIO_EVM_BASE_AUTHORIZATION_KEY },
  ]) assert.ok(sourceSignerDiagnostic({ ...env, ...patch }, 'base').missing_inputs.includes('FOLIO_EVM_BASE_AUTHORIZATION_KEY'));
  assert.ok(sourceSignerDiagnostic({ ...env, PRIVY_KEY_QUORUM_ID: env.FOLIO_EVM_BASE_KEY_QUORUM_ID }, 'base').missing_inputs.includes('FOLIO_EVM_BASE_KEY_QUORUM_ID'));
  assert.ok(sourceSignerDiagnostic({ ...env, FOLIO_POLICY_ADMIN_KEY: evmAuthorizationKey() }, 'base').missing_inputs.includes('FOLIO_POLICY_ADMIN_PUBLIC_KEY'));
});

test('batched reads align slots without changing key order', async () => {
  const seen: [string[], Record<string, unknown>][] = [];
  const result = await readAccountChunks(['a', 'b', 'c'], { commitment: 'finalized' }, 2, async (keys, options) => {
    seen.push([keys, options]);
    return { context: { slot: seen.length === 1 ? 10 : 11, blockTime: 42 }, value: keys };
  }, reply => reply);
  assert.deepEqual(result.result, { context: { slot: 11, blockTime: 42 }, value: ['a', 'b', 'c'] });
  assert.deepEqual(seen.map(([keys]) => keys), [['a', 'b'], ['c'], ['a', 'b']]);
  assert.equal(seen[2][1].minContextSlot, 11);
});

test('batched reads reject incomplete replies, invalid caps, and nonconverging slots', async () => {
  for (const cap of [0, 101, 1.5, NaN]) assert.throws(() => rpcMultiAccountCap(cap));
  const reply = (slot: number, value: unknown[]): MultiAccountResult => ({ context: { slot }, value });
  await assert.rejects(readAccountChunks(['a'], {}, 1, async () => reply(1, []), r => r), /incomplete chunk/);
  await assert.rejects(readAccountChunks(['a'], { minContextSlot: 5 }, 1, async () => reply(4, ['a']), r => r), /below minContextSlot/);
  let slot = 0;
  await assert.rejects(readAccountChunks(['a', 'b'], {}, 1, async keys => reply(++slot, keys), r => r), /did not converge/);
  assert.equal(slot, 5);
});
