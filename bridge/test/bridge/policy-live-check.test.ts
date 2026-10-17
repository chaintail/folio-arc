import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizationPublicKey, createPrivyAdmin, depositPolicy, depositPolicyDigest, type HttpRequest } from 'wallet-privy/server';
import type { DepositPolicyBuilder, PrivyPolicyBody } from '../../src/shims/permission-types.js';
import { createPolicyLiveCheck, PolicyReadUnavailable, receiptUsable } from '../../src/bridge/deposit-permission.js';
import { evmAuthorizationKey, verifiedReceipt } from '../permission-proof-support.js';

const did = 'did:privy:cmalice', admin = authorizationPublicKey(evmAuthorizationKey());
const wallet = { id: 'wallet-1', address: '0x1111111111111111111111111111111111111111' };
const ata = '3wvJdyFnGvaMWpbq93NU91SggiVRveULUXL6iX5VZDGP', person = `live:${'ab'.repeat(32)}`;
const receipt = verifiedReceipt({ chain: 'base', person, wallet, ata, quorum: 'base-quorum', policyId: 'policy-1', owner: 'owner-1' });

/** Privy as the live check reads it: the person's policy, owner quorum and wallet. Each piece can be changed or fail. */
function privy() {
  // The registry (S1) adds owner_id when it creates the person's policy.
  const body = { ...depositPolicy('base', person, ata), owner_id: 'owner-1' };
  const state = {
    policy: { id: 'policy-1', created_at: 1, ...body, rules: body.rules.map((r, i) => ({ id: `rule-${i}`, ...r })).reverse() } as Record<string, unknown>,
    quorum: { id: 'owner-1', display_name: null, authorization_threshold: 1, authorization_keys: [{ public_key: admin, display_name: null }], user_ids: [did], key_quorum_ids: [] } as Record<string, unknown>,
    wallet: { id: 'wallet-1', chain_type: 'ethereum', address: wallet.address, owner_id: 'wallet-owner',
      additional_signers: [{ signer_id: 'arc-quorum', override_policy_ids: ['arc-policy'] }, { signer_id: 'base-quorum', override_policy_ids: ['policy-1'] }] } as Record<string, unknown>,
    fail: {} as Partial<Record<'policies' | 'key_quorums' | 'wallets', number | Error>>,
    calls: [] as HttpRequest[],
  };
  const reads = createPrivyAdmin({ appId: 'app', appSecret: 'secret' }, { async request(r) {
    state.calls.push(r);
    const kind = r.url.split('/')[4] as 'policies' | 'key_quorums' | 'wallets', failure = state.fail[kind];
    if (failure instanceof Error) throw failure;
    if (failure) return { status: failure, body: { error: 'fixture' } };
    return { status: 200, body: structuredClone(kind === 'policies' ? state.policy : kind === 'key_quorums' ? state.quorum : state.wallet) };
  } });
  return { state, check: createPolicyLiveCheck({ reads, adminPublicKey: admin }) };
}

test('live check: the receipt matches Privy; three app-credential GETs, no signature, nothing written', async () => {
  const p = privy();
  assert.deepEqual(await p.check(receipt, did), { ok: true });
  assert.deepEqual(p.state.calls.map(c => `${c.method} ${c.url}`).sort(), ['GET https://api.privy.io/v1/key_quorums/owner-1',
    'GET https://api.privy.io/v1/policies/policy-1', 'GET https://api.privy.io/v1/wallets/wallet-1']);
  for (const c of p.state.calls) { assert.equal(c.body, undefined); assert.equal(c.headers['privy-authorization-signature'], undefined); assert.match(c.headers.authorization!, /^Basic /); }
  // The one-way switch to a person-only owner keeps the policy the person's.
  p.state.quorum = { ...p.state.quorum, authorization_keys: [] };
  assert.deepEqual(await p.check(receipt, did), { ok: true });
});

test('live check: a changed or deleted policy, or a changed wallet entry, is POLICY_DRIFT', async () => {
  const cases: [string, (s: ReturnType<typeof privy>['state']) => void][] = [
    ['policy_digest', s => { const rules = structuredClone(s.policy.rules) as { conditions: { value: unknown }[] }[]; rules[0]!.conditions[0]!.value = '1'; s.policy = { ...s.policy, rules }; }],
    ['policy_digest', s => { s.policy = { ...s.policy, rules: (s.policy.rules as unknown[]).slice(1) }; }],
    ['policy_digest', s => { s.policy = { ...s.policy, name: 'folio-deposit-base-0000000000000000' }; }],
    ['policy_gone', s => { s.fail.policies = 404; }],
    ['signer_entry', s => { s.wallet = { ...s.wallet, additional_signers: [] }; }],
    ['signer_entry', s => { s.wallet = { ...s.wallet, additional_signers: [{ signer_id: 'base-quorum', override_policy_ids: ['policy-1'] }, { signer_id: 'base-quorum', override_policy_ids: ['policy-1'] }] }; }],
    ['signer_entry', s => { s.wallet = { ...s.wallet, additional_signers: [{ signer_id: 'base-quorum', override_policy_ids: ['policy-1', 'wider'] }] }; }],
    ['signer_entry', s => { s.wallet = { ...s.wallet, additional_signers: [{ signer_id: 'base-quorum', override_policy_ids: ['arc-policy'] }] }; }],
    ['wallet', s => { s.wallet = { ...s.wallet, address: '0x2222222222222222222222222222222222222222' }; }],
    ['wallet', s => { s.fail.wallets = 404; }],
  ];
  for (const [cause, change] of cases) {
    const p = privy(); change(p.state);
    assert.deepEqual(await p.check(receipt, did), { ok: false, code: 'POLICY_DRIFT', cause }, cause);
  }
});

test('live check: a policy owned by anyone but the person\'s quorum, or a quorum that is not just the person and Folio\'s admin, is POLICY_OWNER_MISMATCH', async () => {
  const cases: [string, (s: ReturnType<typeof privy>['state']) => void][] = [
    ['policy_owner', s => { s.policy = { ...s.policy, owner_id: 'someone-else' }; }],
    ['policy_owner', s => { s.policy = { ...s.policy, owner_id: null }; }],
    ['owner_members', s => { s.quorum = { ...s.quorum, user_ids: ['did:privy:cmmallory'] }; }],
    ['owner_members', s => { s.quorum = { ...s.quorum, user_ids: [did, 'did:privy:cmmallory'] }; }],
    ['owner_members', s => { s.quorum = { ...s.quorum, user_ids: [] }; }],
    ['owner_members', s => { s.quorum = { ...s.quorum, authorization_keys: [{ public_key: authorizationPublicKey(evmAuthorizationKey()) }] }; }],
    ['owner_members', s => { s.quorum = { ...s.quorum, authorization_threshold: 2 }; }],
    ['owner_members', s => { s.quorum = { ...s.quorum, key_quorum_ids: ['nested'] }; }],
    ['owner_members', s => { s.fail.key_quorums = 404; }],
  ];
  for (const [cause, change] of cases) {
    const p = privy(); change(p.state);
    assert.deepEqual(await p.check(receipt, did), { ok: false, code: 'POLICY_OWNER_MISMATCH', cause }, cause);
  }
  // The same quorum checked for another person is foreign.
  assert.deepEqual(await privy().check(receipt, 'did:privy:cmbob'), { ok: false, code: 'POLICY_OWNER_MISMATCH', cause: 'owner_members' });
});

test('live check: any failed read other than 404 is PolicyReadUnavailable (retry later), never a verdict', async () => {
  for (const [kind, failure] of [['policies', 500], ['key_quorums', 429], ['wallets', 401], ['policies', new Error('socket hang up')], ['wallets', 403]] as const) {
    const p = privy(); p.state.fail[kind] = failure;
    await assert.rejects(p.check(receipt, did), (e: unknown) => e instanceof PolicyReadUnavailable && e.message === 'POLICY_READ_UNAVAILABLE', `${kind} ${failure}`);
  }
  const p = privy(); p.state.policy = null as never;
  await assert.rejects(p.check(receipt, did), (e: unknown) => e instanceof PolicyReadUnavailable && e.code === 'PRIVY_RESPONSE_INVALID');
});

test('receipt usability is local and per chain: template, wallet, quorum and the digest this code builds', () => {
  assert.equal(receiptUsable(receipt, { chain: 'base', wallet, quorumId: 'base-quorum' }), true);
  assert.equal(receiptUsable(receipt, { chain: 'base', wallet: { ...wallet, address: wallet.address.toUpperCase().replace('0X', '0x') }, quorumId: 'base-quorum' }), true);
  assert.equal(receiptUsable(receipt, { chain: 'arc', wallet, quorumId: 'base-quorum' }), false);
  assert.equal(receiptUsable(receipt, { chain: 'base', wallet, quorumId: 'arc-quorum' }), false);
  assert.equal(receiptUsable(receipt, { chain: 'base', wallet: { ...wallet, id: 'wallet-2' } }), false);
  assert.equal(receiptUsable({ ...receipt, ata: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' }, { chain: 'base', wallet }), false);
  assert.equal(receiptUsable({ ...receipt, hold: 'POLICY_OWNER_MISMATCH' }, { chain: 'base', wallet }), false);
  assert.equal(receiptUsable({ ...receipt, revoked_at: '2026-10-14T03:00:00.000Z' }, { chain: 'base', wallet }), false);
  assert.equal(receiptUsable({ ...receipt, policy_owner: '' }, { chain: 'base', wallet }), false);
  assert.equal(receiptUsable(null, { chain: 'base', wallet }), false);
});

test('the per-chain builder is C0\'s DepositPolicyBuilder: no owner in the body, template digest exported per chain', () => {
  const builder: DepositPolicyBuilder = depositPolicy;
  const body: PrivyPolicyBody = builder('base', person, ata);
  assert.equal('owner' in body, false); assert.equal('owner_id' in body, false);
  assert.equal(body.name, depositPolicy('base', person, ata).name);
  assert.equal(receipt.template_digest, depositPolicyDigest('base'));
  assert.notEqual(depositPolicyDigest('base'), depositPolicyDigest('arc'));
});
