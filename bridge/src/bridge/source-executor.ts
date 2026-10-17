import { errorFields, reasonCode } from '../shims/log-fields.js';
import { logDebug, logError, logInfo } from '../shims/log.js';
import { parseTransaction, recoverTransactionAddress, keccak256, type Hex, type Address, type TransactionSerialized } from 'viem';
import { sourceCalls, assertPinnedDestination, type AtaRead, type Destination } from './source-calls.js';
import { route } from './source-registry.js';
import { GasLedger } from './source-gas.js';
import { SourceStore } from './transfer-record.js';
import type { Attempt } from './transfer-record.js';
export interface PreparedTransaction { type: 'eip1559'; chainId: number; to: Address; value: bigint; data: Hex;
  nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; }
export interface PreparedSource { sweepId: string; attemptId: string; wallet: Address;
  unsignedTransactions: readonly PreparedTransaction[]; }
function pinned(store: SourceStore, id: string): Destination {
  const s = store.sweep(id); return { owner: s.destination_owner, ata: s.mint_recipient, bytes32: s.mint_recipient_bytes32 as Hex };
}
/** Prepare one phone signature at a time so approve/burn each has a fresh residual/ATA/pause check. */
export async function prepareSource(store: SourceStore, ledger: GasLedger, sweepId: string, kind: 'approve' | 'burn', input: {
  person: string; wallet: Address; attemptId: string; nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
  maxAdditionalFee?: bigint; minFee: bigint | undefined; readAta: (ata: string) => Promise<AtaRead>; principalCap?: bigint;
}): Promise<PreparedSource> {
  const s = store.sweep(sweepId);
  if (s.person !== input.person || s.wallet !== input.wallet.toLowerCase() || ledger.chain !== s.chain as 'base' | 'arc') throw loggedRefusal('SOURCE_IDENTITY_MISMATCH');
  if (input.principalCap !== undefined && BigInt(s.amount_6) > input.principalCap) throw loggedRefusal('FULL_SWEEP_EXCEEDS_TEST_CAP');
  if (!Number.isSafeInteger(input.nonce) || input.nonce < 0 || input.gas <= 0n || input.maxFeePerGas <= 0n
    || input.maxPriorityFeePerGas < 0n || input.maxPriorityFeePerGas > input.maxFeePerGas) throw loggedRefusal('INVALID_TRANSACTION_BUDGET');
  const d = await assertPinnedDestination(pinned(store, sweepId), input.readAta);
  const calls = sourceCalls(route(s.chain as 'base' | 'arc'), BigInt(s.amount_6), d, input.minFee);
  const call = calls.find(c => c.kind === kind)!;
  const transaction: PreparedTransaction = { type: 'eip1559', chainId: route(s.chain as 'base' | 'arc').chainId, to: call.to, value: call.value,
    data: call.data, nonce: input.nonce, gas: input.gas, maxFeePerGas: input.maxFeePerGas, maxPriorityFeePerGas: input.maxPriorityFeePerGas };
  if (s.chain === 'arc' && input.maxFeePerGas < 20_000_000_000n) throw loggedRefusal('ARC_FEE_FLOOR');
  store.transaction(() => {
    if (store.paused(s.chain as 'base' | 'arc')) throw loggedRefusal('SOURCE_PAUSED');
    const current = store.sweep(sweepId);
    const expected = kind === 'approve' ? 'planned' : 'approved';
    if (current.state !== expected || store.attempt(input.attemptId)) throw loggedRefusal('SOURCE_ATTEMPT_BLOCKED');
    // An attempt cancelled unsigned at revoke (cancelled: REVOKED) never reached the chain: its nonce is unused.
    if (store.attempts(sweepId).some(a => a.kind !== 'gas_topup' && ['confirmed', 'failed'].includes(a.state) && a.nonce !== null && BigInt(a.nonce) >= BigInt(input.nonce)
      && JSON.parse(a.evidence_json).cancelled !== 'REVOKED')) throw loggedRefusal('SOURCE_NONCE_ALREADY_CONSUMED');
    const scale = s.chain === 'arc' ? 1_000_000_000_000n : 1n;
    if (BigInt(s.amount_6) * scale > ledger.customerPrincipal) throw loggedRefusal('PRINCIPAL_SHORT');
    if ((input.maxAdditionalFee ?? 0n) < 0n) throw loggedRefusal('INVALID_GAS_CAP');
    const saved = store.readLedger(s.chain, s.wallet);
    if (saved && saved !== ledger.snapshot()) throw loggedRefusal('STALE_GAS_LEDGER');
    ledger.beforeSigning(input.attemptId, input.gas * input.maxFeePerGas + (input.maxAdditionalFee ?? 0n));
    try {
      const attempt: Attempt = { id: input.attemptId, sweep_id: sweepId, kind, chain: s.chain, request_id: input.attemptId,
        tx_hash: null, nonce: String(input.nonce), state: 'prepared', gas_paid_raw: '0', evidence_json: JSON.stringify(transaction, (_k, v) => typeof v === 'bigint' ? String(v) : v) };
      store.putAttempt(attempt); store.setState(sweepId, expected, kind === 'approve' ? 'approval_pending' : 'burn_pending');
      store.saveLedger(s.chain, s.wallet, ledger.snapshot());
    } catch (e) { logDebug('source_executor_error', { stage: 'operation', ...errorFields(e) });  ledger.reservations.delete(input.attemptId); logError('bridge_source_transition',{chain:s.chain,sweep_id:sweepId.slice(0,12),attempt_id:input.attemptId.slice(0,12),stage:'reservation_rollback',...errorFields(e)}); throw e; }
  });
  return { sweepId, attemptId: input.attemptId, wallet: input.wallet, unsignedTransactions: [transaction] };
}
export async function validateSigned(prepared: PreparedSource, bytes: Hex) {
  try {
  const actual = parseTransaction(bytes), expected = prepared.unsignedTransactions[0];
  if (actual.type !== expected.type || actual.chainId !== expected.chainId || actual.to?.toLowerCase() !== expected.to.toLowerCase()
    || (actual.value ?? 0n) !== expected.value || actual.data !== expected.data || actual.nonce !== expected.nonce || actual.gas !== expected.gas
    || actual.maxFeePerGas !== expected.maxFeePerGas || (actual.maxPriorityFeePerGas ?? 0n) !== expected.maxPriorityFeePerGas
    || (actual.accessList?.length ?? 0) !== 0 || (await recoverTransactionAddress({ serializedTransaction: bytes as TransactionSerialized })).toLowerCase() !== prepared.wallet.toLowerCase()) throw loggedRefusal('SIGNED_SOURCE_MISMATCH');
  return keccak256(bytes);
  } catch (caughtError) { logError('source_executor_error', { stage: 'validateSigned', ...errorFields(caughtError) });  throw loggedRefusal('SIGNED_SOURCE_MISMATCH'); }
}
/** Default dry-run validates bytes and never broadcasts. Tests inject a fixture transport only.
 * The prepared object is reconstructed from the durable attempt, not accepted from the phone. */
export async function submitSource(store: SourceStore, attemptId: string, person: string, bytes: Hex,
  input: { beforeBroadcast?: () => void; dryRun?: boolean; recordDryRun?: boolean; broadcast?: (bytes: Hex) => Promise<Hex>; fixtureBroadcast?: (bytes: Hex) => Promise<Hex>; readAta: (ata: string) => Promise<AtaRead> }) {
  const a = store.attempt(attemptId); if (!a) throw loggedRefusal('ATTEMPT_NOT_FOUND');
  const s = store.sweep(a.sweep_id);
  if (s.person !== person || !['approve', 'burn'].includes(a.kind) || a.state !== 'prepared') throw loggedRefusal('SOURCE_ATTEMPT_BLOCKED');
  const raw = JSON.parse(a.evidence_json);
  const t: PreparedTransaction = { ...raw, value: BigInt(raw.value), gas: BigInt(raw.gas), maxFeePerGas: BigInt(raw.maxFeePerGas), maxPriorityFeePerGas: BigInt(raw.maxPriorityFeePerGas) };
  const prepared: PreparedSource = { sweepId: s.id, attemptId, wallet: s.wallet as Address, unsignedTransactions: [t] };
  const hash = await validateSigned(prepared, bytes);
  await assertPinnedDestination(pinned(store, s.id), input.readAta);
  if (store.paused(s.chain)) throw loggedRefusal('SOURCE_PAUSED');
  if (input.dryRun !== false) {
    if (input.recordDryRun) store.transaction(() => {
      if (store.attempt(attemptId)?.state !== 'prepared') throw loggedRefusal('SOURCE_ATTEMPT_BLOCKED');
      store.putAttempt({...a, tx_hash: hash, state: 'prepared_dry_run'});
    });
    logDebug('bridge_source_transition',{chain:s.chain,sweep_id:s.id.slice(0,12),attempt_id:attemptId.slice(0,12),stage:'dry_run',tx_ref:hash.slice(0,12)});
    return { dryRun: true, txHash: hash, broadcast: false };
  }
  const broadcast = input.broadcast ?? input.fixtureBroadcast;
  if (!broadcast) throw loggedRefusal('SOURCE_EXECUTION_DISABLED');
  store.persistSigned(attemptId, bytes, hash, s.wallet);
  input.beforeBroadcast?.();
  store.transaction(() => {
    if (store.paused(s.chain as 'base' | 'arc')) throw loggedRefusal('SOURCE_PAUSED');
    if (store.attempt(attemptId)?.state !== 'prepared') throw loggedRefusal('SOURCE_ATTEMPT_BLOCKED');
    // Reserve immutable hash BEFORE the network boundary; a crash here reconciles this exact transaction.
    store.putAttempt({ ...a, tx_hash: hash, state: 'submitted' });
  });
  try {
    const returned = await broadcast(bytes);
    if (returned !== hash) throw loggedRefusal('SUBMISSION_HASH_MISMATCH');
    logInfo('bridge_source_transition',{chain:s.chain,sweep_id:s.id.slice(0,12),attempt_id:attemptId.slice(0,12),stage:'broadcast',tx_ref:hash.slice(0,12),state_to:'submitted'});
    return { dryRun: false, txHash: hash, broadcast: true };
  } catch (caughtError) { logError('bridge_source_broadcast_uncertain', { attempt: attemptId.slice(0,12), tx12: hash.slice(0,12), ...errorFields(caughtError) });
    store.transaction(() => {
      store.putAttempt({ ...a, tx_hash: hash, state: 'uncertain' });
      if (a.kind === 'burn') store.setState(s.id, 'burn_pending', 'burn_uncertain');
    });
    return { dryRun: false, txHash: hash, uncertain: true };
  }
}
export function reconcileSource(store: SourceStore, ledger: GasLedger, attemptId: string, receipt: {
  txHash: Hex; success: boolean; gasUsed: bigint; effectiveGasPrice: bigint; additionalFee?: bigint; finalized: boolean;
}) {
  const a = store.attempt(attemptId); if (!a || a.tx_hash !== receipt.txHash || !receipt.finalized
    || receipt.gasUsed < 0n || receipt.effectiveGasPrice < 0n || (receipt.additionalFee ?? 0n) < 0n) throw loggedRefusal('RECEIPT_MISMATCH');
  if (!['submitted', 'uncertain', 'confirmed', 'failed'].includes(a.state)) throw loggedRefusal('ATTEMPT_NOT_SUBMITTED');
  const gas = receipt.gasUsed * receipt.effectiveGasPrice + (receipt.additionalFee ?? 0n);
  if (a.state === 'confirmed' || a.state === 'failed') {
    if (a.gas_paid_raw !== String(gas) || (a.state === 'confirmed') !== receipt.success) throw loggedRefusal('RECEIPT_CHANGED');
    return;
  }
  const before = ledger.snapshot();
  try {
    store.transaction(() => {
      const sweep = store.sweep(a.sweep_id), saved = store.readLedger(sweep.chain, sweep.wallet);
      if (saved) ledger.restore(saved);
      ledger.reconcile({ attemptId, txHash: receipt.txHash, paid: gas, failed: !receipt.success });
      store.putAttempt({ ...a, state: receipt.success ? 'confirmed' : 'failed', gas_paid_raw: String(gas) });
      const s = store.sweep(a.sweep_id);
      if (a.kind === 'burn') {
        if (receipt.success) ledger.sweep(BigInt(s.amount_6));
        store.setState(s.id, s.state, receipt.success ? 'burn_confirmed' : 'approved', {kind:'receipt',reference:receipt.txHash});
        if (receipt.success) store.shared.addTransfer({sweep_id:s.id,source_domain:route(s.chain as 'base' | 'arc').domain,burn_tx_hash:receipt.txHash});
      } else if (a.kind === 'approve') store.setState(s.id, 'approval_pending', receipt.success ? 'approved' : 'planned', {kind:'receipt',reference:receipt.txHash});
      store.saveLedger(s.chain, s.wallet, ledger.snapshot());
    });
  } catch (e) { logDebug('source_executor_error', { stage: 'reconcileSource', ...errorFields(e) });  ledger.restore(before); logError('bridge_source_transition',{chain:ledger.chain,attempt_id:attemptId.slice(0,12),stage:'ledger_restore',...errorFields(e)}); throw e; }
}

function loggedRefusal(reason:string) { logError('bridge_source_transition',{stage:'validation',reason:reasonCode(reason)}); return new Error(reason); }
