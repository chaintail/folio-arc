import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, parseTransaction } from 'viem';
import { route, assertRoute, ARC_EMITTER, TOKEN_MESSENGER, normalise } from '../../src/bridge/source-registry.js';
import { sourceCalls, decodeSource, recipientBytes, recipientAddress, verifyDestination, ZERO32 } from '../../src/bridge/source-calls.js';
import { build7702Comparison, require7702Ready, CALIBUR_CANDIDATE, caliburAbi } from '../../src/bridge/source-7702.js';
import { owner, wallet, sender, destination, ataData, hash } from './support.js';
import { PROGRAMS } from '../../src/shims/programs.js';

test('FND-003,010 chain/domain mismatch and precision', () => {
  assert.throws(() => assertRoute(route('arc'), 26, 5042), /MISMATCH/);
  assert.throws(() => assertRoute({ ...route('base'), usdc: wallet }, 8453, 6), /MISMATCH/);
  assert.equal(route('arc').emitter, ARC_EMITTER);
  assert.deepEqual(normalise(20_000000_000000000001n, 18), { amount: 20_000000n, remainder: 1n });
  assert.equal(route('base', 1_000000n).minimum, 1_000000n);
});

test('FND-027,028,029 round-trip and all exact approval/Standard burn fields on both chains', async () => {
  const d = await destination();
  assert.equal(recipientAddress(recipientBytes(d.ata)), d.ata);
  assert.notEqual(recipientBytes(owner), d.bytes32);
  assert.throws(() => sourceCalls(route('base'), 20_000000n, { owner, ata: owner, bytes32: recipientBytes(owner) }, 0n), /NOT_VERIFIED/);
  assert.throws(() => sourceCalls(route('base'), 20_000000n, { ...d, owner: d.ata }, 0n), /NOT_VERIFIED/);
  for (const chain of ['base', 'arc'] as const) {
    const r = route(chain), calls = sourceCalls(r, 27_000000n, d, 0n);
    assert.deepEqual(decodeSource(calls[0].data), { functionName: 'approve', args: [TOKEN_MESSENGER, 27_000000n] });
    assert.deepEqual(decodeSource(calls[1].data), { functionName: 'depositForBurn', args: [27_000000n, 5, d.bytes32, r.usdc, ZERO32, 0n, 2000] });
    assert.equal(calls[0].to, r.usdc); assert.equal(calls[1].to, TOKEN_MESSENGER); assert.equal(calls[1].value, 0n);
    for (const fee of [undefined, 1n]) assert.throws(() => sourceCalls(r, 27_000000n, d, fee), /FEE/);
  }
});

test('FND-024,026,031 missing/frozen/wrong owner/mint/program/length ATA and unknown fees rejected', async () => {
  for (const mutation of ['missing', 'program', 'mint', 'owner', 'frozen', 'short']) {
    const data = ataData(); if (mutation === 'mint') data[0] ^= 1; if (mutation === 'owner') data[32] ^= 1; if (mutation === 'frozen') data[108] = 2;
    await assert.rejects(verifyDestination(owner, async () => ({ exists: mutation !== 'missing', program: mutation === 'program' ? owner : PROGRAMS.token,
      data: mutation === 'short' ? data.subarray(0, 72) : data })), /DESTINATION_NOT_READY/);
  }
  assert.throws(() => recipientAddress('0x00'), /LENGTH/);
});

test('7702 wire format, Folio sender, auth scope and atomic approval/burn batch on both chains; readiness fails closed', async () => {
  const d = await destination();
  for (const chain of ['base', 'arc'] as const) {
    const input = { route: route(chain), wallet, gasWallet: sender, destination: d, amount: 20_000000n,
      authorization: { chainId: route(chain).chainId, address: CALIBUR_CANDIDATE, nonce: 1, r: hash(1), s: hash(1), yParity: 0 },
      delegate: CALIBUR_CANDIDATE, delegateCodeHash: undefined, expectedCodeHash: undefined,
      executionSignature: '0x' as const, executionNonce: 0n, deadline: 1000n, sponsorNonce: 0,
      gas: 300000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 0n };
    const result = build7702Comparison(input), decoded = parseTransaction(result.serialized);
    assert.equal(result.serialized.slice(0, 4), '0x04'); assert.equal(decoded.type, 'eip7702');
    assert.equal(decoded.chainId, route(chain).chainId); assert.equal(decoded.to?.toLowerCase(), wallet);
    assert.equal(result.from, sender); assert.equal(result.batch.batchedCall.revertOnFailure, true);
    assert.equal(result.batch.batchedCall.calls.length, 2);
    const batch = decodeFunctionData({ abi: caliburAbi, data: decoded.data! }); assert.equal(batch.functionName, 'execute');
    assert.deepEqual(decodeSource(result.batch.batchedCall.calls[1].data).args, [20_000000n, 5, d.bytes32, route(chain).usdc, ZERO32, 0n, 2000]);
    assert.throws(() => require7702Ready(input), /UNVERIFIED/);
    assert.throws(() => build7702Comparison({ ...input, authorization: { ...input.authorization, chainId: 1 } }), /MISMATCH/);
  }
});
