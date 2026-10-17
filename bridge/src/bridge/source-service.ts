import { errorFields, eventSink, reasonCode, ref8 } from '../shims/log-fields.js';
import { logEvent, logDebug, logInfo, logError } from '../shims/log.js';
import { sourceSignerDiagnostic } from '../shims/capabilities.js';
import { permissionProofStatus } from '../shims/permission-proof.js';
import { depositStatus } from './deposit-status.js';
import { BELOW_MINIMUM_INTERVAL_MS, DepositIntents, nextCheckAt, sourceInterval, type DepositIntent, type WatchSignal } from './deposit-intent.js';
import { assertReadinessLocal, ensureIntentAta, checkSponsorship, verifyDeployment, quorumDrift, ReadinessHold, spendCapHold, type SetupPorts } from './deposit-readiness.js';
import { noPermissionReceipts, PolicyReadUnavailable, receiptUsable, type PolicyLiveCheck, type SigningPermissions } from './deposit-permission.js';
import type { PermissionReceipt, PermissionReceiptHold } from '../shims/permission-types.js';
import { bridgeReadBudget, BridgeBudgetExceeded } from './read-budget.js';
import { canonicalEvent } from './source-observer.js';
import { PrivyError, type EvmSigner } from 'wallet-privy/server';
import { randomUUID } from 'node:crypto';
import { namespaceKey } from '../shims/namespace.js';
import type { Address, Hex } from 'viem';
import type { PersonScope } from '../shims/person-scope.js';
import { BridgeConfigError, readBridgeConfig, sourceChains, type BridgeConfig } from './config.js';
import { SourceStore, type Attempt } from './transfer-record.js';
import { GasLedger, prepareTopup } from './source-gas.js';
import { observe } from './source-observer.js';
import { verifyDestination, sourceCalls, type AtaRead } from './source-calls.js';
import { prepareSource, submitSource, reconcileSource, type PreparedTransaction } from './source-executor.js';
import { createSourceRpc, providerDetail, signGasTopup, type SourceRpc } from './source-rpc.js';
import type { SourceChain } from './source-registry.js';
import { publicSolanaRpc, readAccount, deriveUsdcAta } from './solana.js';
/** One deposit chain's server signer and the key quorum it signs as. */
export interface DepositSigner { readonly signer: EvmSigner; readonly keyQuorumId: string }
export const dollars = (raw: string | bigint) => { const n = BigInt(raw); return `${n / 1000000n}.${String(n % 1000000n).padStart(6,'0')}`; };
export const estimates = {solana: '< 1 min', base: '< 30 min', arc: '< 1 min'} as const;
export class SourceRefusal extends Error {
  /** [retryable]: a provider/configuration fault the pass retries on backoff; never a hold. */
  constructor(readonly code: string, readonly status = 409, readonly failing_stage: string = 'source_request', readonly retryable = false) { super('This deposit cannot be continued yet.'); logInfo('bridge_source_refused', { code: reasonCode(code), stage: failing_stage, reason: reasonCode(code) }); }
}
function sourceReadDetail(error: unknown) {
  const sanitize = (value: string) => value.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]').replace(/[\r\n\t]+/g, ' ').slice(0, 400);
  let current: unknown = error, code: string | number = 'UNKNOWN', message = 'Source RPC read failed';
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const item = current as {code?: unknown; shortMessage?: unknown; message?: unknown; cause?: unknown};
    if (typeof item.code === 'string' || typeof item.code === 'number') code = item.code;
    const nextMessage = typeof item.shortMessage === 'string' ? item.shortMessage : item.message;
    if (typeof nextMessage === 'string' && nextMessage) message = nextMessage;
    current = item.cause;
  }
  return {code: typeof code === 'string' ? sanitize(code) : code, message: sanitize(message)};
}
/** The provider's message (bounded, URL-free) for bridge_intent_error, so an RPC refusal says what is wrong. */
const intentDetail = (error: unknown) => { const detail = error instanceof PrivyError ? undefined : providerDetail(error); return detail ? {detail} : {}; };
/** An EVM provider's rate limit anywhere in the error chain: JSON-RPC -32016, HTTP 429, or a
 * message naming a rate limit ("over rate limit", "rate limited", "Too Many Requests"). */
export function rateLimited(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === 'object' && !seen.has(current);) {
    seen.add(current);
    const item = current as {code?: unknown; status?: unknown; shortMessage?: unknown; message?: unknown; details?: unknown; cause?: unknown};
    if (item.code === -32016 || item.code === 429 || item.status === 429) return true;
    if ([item.shortMessage, item.message, item.details].some(text => typeof text === 'string' && /rate[ -]?limit|too many requests/i.test(text))) return true;
    current = item.cause;
  }
  return false;
}
/** Observation backoff after a provider rate limit: 30 s, doubling to 10 minutes. */
export const SOURCE_BACKOFF_START_S = 30, SOURCE_BACKOFF_CAP_S = 600;
/** A hold that persists is logged again at most this often (it is logged at once when its code changes). */
export const SOURCE_HOLD_REPEAT_MS = 600_000;
/** The cross-process source lease (bridge_source_lease): its holder refreshes it every 20 s and a
 * row not refreshed for 60 s is a dead process's, claimed by the next. Only execution (approve,
 * burn, gas top-up, their receipts) runs under it; observation never waits for it. */
export const SOURCE_LEASE_MS = 60_000, SOURCE_LEASE_HEARTBEAT_MS = 20_000;
export const androidTransaction = (t: PreparedTransaction) => ({type: '0x2', chainId: `0x${t.chainId.toString(16)}`, to: t.to,
  value: `0x${t.value.toString(16)}`, data: t.data, nonce: `0x${t.nonce.toString(16)}`, gas: `0x${t.gas.toString(16)}`,
  maxFeePerGas: `0x${t.maxFeePerGas.toString(16)}`, maxPriorityFeePerGas: `0x${t.maxPriorityFeePerGas.toString(16)}`});
export function createSourceService(options: {
  store: SourceStore; config: BridgeConfig; rpc: Partial<Record<SourceChain, SourceRpc>>;
  people(): readonly PersonScope[]; readAta(ata: string): Promise<AtaRead>;
  credited(scope: PersonScope, settledSignature: string): boolean;
  /** One signer per deposit chain, each built only when that chain's proof verified (release-main). */
  signers?: Partial<Record<SourceChain, DepositSigner>>;
  /** The person's verified receipt per chain (S1's store). Default: none, so nothing is signed. */
  permissions?: SigningPermissions;
  /** The live Privy read of the receipt's policy, owner quorum and wallet before every signing step.
   * Absent: signing is refused as configuration (never signs blind). */
  policyCheck?: PolicyLiveCheck;
  /** The live check (or a signing-time refusal) found the policy, owner or wallet entry changed: the
   * receipt is held. One alert per hold. */
  onPolicyDrift?(scope: PersonScope, chain: SourceChain, code: PermissionReceiptHold, cause: string): void;
  /** A signing-time Privy refusal right after a passing live check: the grant changed under us. */
  onSignerRevoked?(scope: PersonScope, code: string, detail?: string): void;
  /** A generic Privy HTTP 401/403 at signing: the server's credential or the provider, not the
   * person. Raised once per fault episode (until a signature succeeds), never per person. */
  onSignerProviderFault?(code: string): void;
  env?: NodeJS.ProcessEnv; log?: (event: object) => void; signTopup?: typeof signGasTopup;
  /** Milliseconds (default Date.now): the backoff and hold repeat clock. */
  now?: () => number; setup?: SetupPorts;
}) {
  const {store, config} = options, log = eventSink(options.log), now = options.now ?? Date.now;
  const intents=new DepositIntents(store), identities=new Map<SourceChain,Promise<number>>();
  // Boot: duplicate held intents from before one-intent-per-chain end, and BELOW_MINIMUM holds wait again.
  intents.repairDuplicates(now());
  const holds = new Map<string, {code: string; at: number}>();
  const hold = (chain: SourceChain, person: string, code: string, extra: object = {}) => {
    const key = `${person}:${chain}`, last = holds.get(key), at = now();
    if (last && last.code === code && at - last.at < SOURCE_HOLD_REPEAT_MS) return;
    holds.set(key, {code, at});
    log({event: 'bridge_source_hold', chain, person, code, ...(code.startsWith('SOURCE_SIGNER_') ? sourceSignerDiagnostic(options.env ?? {}, chain) : {}), ...extra});
  };
  /** In this process: one source task at a time (tick, prepare, submit, execute, reconcile). */
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const queued=now(); logDebug('bridge_source_lease', {action:'queue'}); const p = tail.then(()=>{logDebug('bridge_source_lease', {action:'dequeue',wait_ms:now()-queued});return fn();}); tail = p.catch(e => { logDebug('bridge_source_serial_failed', errorFields(e)); }); return p; };
  /** Set by stop: no lease is claimed again and the tick does nothing. */
  let stopping = false;
  /** The running lease holder; `released` settles once its row is deleted. */
  let active: {holder:string; released: Promise<void>} | undefined;
  /** Across processes: `fn` runs only while this process holds the lease row. Callers are already
   * serial in this process. A refusal here is SOURCE_BUSY (another live holder) or SOURCE_STOPPING. */
  const leased = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (stopping) throw new SourceRefusal('SOURCE_STOPPING',503);
    const holder=randomUUID(),at=now();
    const claimed=store.db.prepare(`INSERT INTO bridge_source_lease VALUES ('source',?,?)
      ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at WHERE bridge_source_lease.expires_at<?`).run(holder,at+SOURCE_LEASE_MS,at);
    logDebug('bridge_source_lease', { action:'claim', lease_ref:ref8(holder), expires_at:at+SOURCE_LEASE_MS, acquired: !!claimed.changes, busy: !claimed.changes });
    if(!claimed.changes)throw new SourceRefusal('SOURCE_BUSY');
    let release!: () => void; active = {holder,released: new Promise<void>(resolve => { release = resolve; })};
    const heartbeat=setInterval(()=>{try{const result=store.db.prepare("UPDATE bridge_source_lease SET expires_at=? WHERE name='source' AND holder=?").run(now()+SOURCE_LEASE_MS,holder); logEvent(result.changes?'debug':'error','bridge_source_lease',{action:'heartbeat',lease_ref:ref8(holder),outcome:result.changes?'renewed':'ownership_lost',expires_at:now()+SOURCE_LEASE_MS});}catch(e){logError('bridge_source_lease_failed', { stage: 'heartbeat', ...errorFields(e) });/* Next ownership check fails closed. */}},SOURCE_LEASE_HEARTBEAT_MS);
    try{return await fn();}
    finally{
      clearInterval(heartbeat);
      // A closed store keeps the row; it lapses SOURCE_LEASE_MS after the last heartbeat.
      try{store.db.prepare("DELETE FROM bridge_source_lease WHERE name='source' AND holder=?").run(holder);logDebug('bridge_source_lease',{action:'release',lease_ref:ref8(holder),outcome:'released'});}catch(e){logError('bridge_source_lease_failed', { stage: 'release', ...errorFields(e) });/* lapses */}
      active=undefined; release();
    }
  };
  const assertLease=()=>{if(!active || !store.db.prepare("SELECT 1 FROM bridge_source_lease WHERE name='source' AND holder=? AND expires_at>?").get(active.holder,now()))throw new SourceRefusal('SOURCE_BUSY');};
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => serial(() => leased(fn));
  const busy = (e: unknown) => e instanceof SourceRefusal && (e.code==='SOURCE_BUSY' || e.code==='SOURCE_STOPPING');
  const ledgerFor = (chain: SourceChain, wallet: string) => {const l = new GasLedger(chain), saved = store.readLedger(chain,wallet); if (saved) l.restore(saved); return l;};
  function chainFor(sweep: string, scope: PersonScope) {
    const s = store.sweep(sweep), chain = s.chain as SourceChain, c = config.chains[chain], rpc = options.rpc[chain];
    if (s.person !== namespaceKey(scope.namespace) || s.wallet !== scope.evm_wallet?.address.toLowerCase()) throw new SourceRefusal('SOURCE_IDENTITY_MISMATCH',403);
    if (!c || !rpc) throw new SourceRefusal('SOURCE_CHAIN_UNAVAILABLE',503);
    const bound=currentScope(scope);
    if(!c.enabled)throw new SourceRefusal('SOURCE_PAUSED');
    // Configuration, not the person: logged, never written to the person record.
    if(!permissionProofStatus(options.env ?? {},chain).ok) { hold(chain, s.person, 'SOURCE_SIGNER_UNCONFIGURED'); throw new SourceRefusal('SOURCE_SIGNER_UNCONFIGURED',503); }
    // The destination the person consented to is the receipt's; with no receipt the signer gate refuses PERMISSION_REQUIRED.
    const receipt=receiptFor(scope,chain);
    if(bound.wallet_address!==s.destination_owner || receipt && receipt.ata!==s.mint_recipient)throw new SourceRefusal('DESTINATION_BINDING_MISMATCH');
    return {s,chain,c,rpc};
  }
  async function reconcile(a: Attempt, supplied?: SourceRpc) {
    const s = store.sweep(a.sweep_id), chain = s.chain as SourceChain, rpc = supplied ?? options.rpc[chain];
    if (!rpc || !a.tx_hash) return;
    let receipt = await rpc.charge(a.tx_hash as Hex);
    if (!receipt) {
      if (!a.signed_raw || !a.sender || a.nonce===null) {
        hold(chain,s.person,'SOURCE_RECOVERY_REQUIRES_OPERATOR',{attempt:a.id});
        return;
      }
      const nonce=await rpc.nonce(a.sender as Address,'latest');
      if (BigInt(nonce)>BigInt(a.nonce)) {
        // Check again after reading the nonce: our transaction may have landed between reads.
        receipt=await rpc.charge(a.tx_hash as Hex);
        if (!receipt) {
          assertLease();
          store.transaction(()=>{
            const ledger=ledgerFor(chain,s.wallet);
            ledger.reservations.delete(a.id);
            store.putAttempt({...a,state:'failed',evidence_json:JSON.stringify({...JSON.parse(a.evidence_json),nonce_consumed:String(nonce)})});
            if(a.kind!=='gas_topup')store.setState(s.id,s.state,a.kind==='approve'?'planned':'approved',{kind:'nonce_consumed',reference:a.tx_hash!});
            store.saveLedger(chain,s.wallet,ledger.snapshot());
          });
          log({event:'bridge_source_nonce_consumed',chain,attempt:a.id,tx_hash:a.tx_hash});
          return;
        }
      } else {
        if(!config.source || !config.execute || config.chains[chain].paused || store.paused(chain))return;
        // This clock survives restarts and also bounds explicit reconciliation requests.
        const key=`rebroadcast:${a.id}`;
        if(!intents.claimClock(key,now(),30_000))return;
        assertLease();
        if(a.state==='prepared')store.putAttempt({...a,state:'submitted'});
        // Record the next delay before crossing the network boundary, even if this process dies.
        intents.backoffClock(key,now());
        try {
          if(await rpc.broadcast(a.signed_raw as Hex)!==a.tx_hash)throw new Error('SUBMISSION_HASH_MISMATCH');
        } catch (e) {
          logError('bridge_source_broadcast_uncertain', { attempt: a.id.slice(0,12), tx12: a.tx_hash.slice(0,12), ...errorFields(e) });
          const current=store.attempt(a.id)!;
          if(current.state==='submitted')store.putAttempt({...current,state:'uncertain'});
          if(a.kind==='burn' && store.sweep(s.id).state==='burn_pending')store.setState(s.id,'burn_pending','burn_uncertain');
        }
        return;
      }
    }
    if (!receipt.finalized) return;
    assertLease();
    if(a.state==='prepared') {store.putAttempt({...a,state:'submitted'});a=store.attempt(a.id)!;}
    const ledger = ledgerFor(chain,s.wallet);
    const reconciled = () => logInfo('bridge_source_reconciled', { attempt: a.id.slice(0,12), kind: a.kind, success: receipt!.success, payer_cost_raw: String(receipt!.gasUsed*receipt!.effectiveGasPrice+receipt!.additionalFee) });
    if (a.kind !== 'gas_topup') {reconcileSource(store,ledger,a.id,receipt); reconciled(); return;}
    const e = JSON.parse(a.evidence_json), tx = await rpc.transaction(a.tx_hash as Hex);
    if (tx.from.toLowerCase() !== e.from.toLowerCase() || tx.to?.toLowerCase() !== s.wallet || String(tx.value) !== e.rawAmount
      || tx.input !== '0x' || String(tx.nonce) !== a.nonce) { logError('bridge_source_reconcile_refused', { attempt: a.id.slice(0,12), code: 'TOPUP_RECEIPT_MISMATCH' }); throw new SourceRefusal('TOPUP_RECEIPT_MISMATCH'); }
    store.transaction(() => {
      if (receipt.success) ledger.confirmTopup({attemptId:a.id,txHash:a.tx_hash as Hex,contribution:tx.value});
      store.putAttempt({...a,state:receipt.success?'confirmed':'failed',evidence_json:JSON.stringify({...e,
        contribution_raw:receipt.success?String(tx.value):'0',payer_cost_raw:String(receipt.gasUsed*receipt.effectiveGasPrice+receipt.additionalFee)})});
      store.saveLedger(chain,s.wallet,ledger.snapshot());
    });
    reconciled();
  }
  async function ensureGas(sweep: string, needed: bigint) {
    const s = store.sweep(sweep), chain = s.chain as SourceChain, c = config.chains[chain], rpc = options.rpc[chain]!;
    const ledger = ledgerFor(chain,s.wallet), shortfall = ledger.topupRequired(needed);
    const decision = (outcome: string, extra: Record<string, unknown> = {}) => logInfo('bridge_topup_decision', { chain, sweep: sweep.slice(0,8), needed: String(needed), shortfall: String(shortfall), outcome, ...extra });
    if (!shortfall) { decision('not_needed'); return; }
    if(store.shared.failedAttempts(sweep,'gas_topup')>=3)throw new ReadinessHold('TOPUP_ATTEMPTS_EXHAUSTED');
    if (store.attempts(sweep).some(a=>a.kind==='gas_topup' && !['confirmed','failed'].includes(a.state))) { decision('pending'); throw new SourceRefusal('FOLIO_TOPUP_PENDING'); }
    if (store.paused(chain) || c.paused) { decision('paused'); throw new SourceRefusal('SOURCE_PAUSED'); }
    // KEEP: segregated gas authority.
    const env = options.env ?? {}, from = env[c.gasWalletEnv] as Address | undefined;
    const initialCall = prepareTopup(s.wallet as Address,from,shortfall);
    const budget = await rpc.budget(initialCall.from,{to:initialCall.to,data:initialCall.data,value:initialCall.value});
    const transferFee = budget.gas*budget.maxFeePerGas+budget.maxAdditionalFee;
    const margin = (needed+3n)/4n > 2n*budget.gas*budget.maxFeePerGas
      ? (needed+3n)/4n : 2n*budget.gas*budget.maxFeePerGas;
    // KEEP: gas top-up spend limit.
    const cap = env[`FOLIO_BRIDGE_TOPUP_CAP_${chain.toUpperCase()}_RAW`];
    const contributed = store.shared.gasLedger(s.wallet,chain).folio_contribution;
    const payerCosts = store.sweeps(chain,s.wallet).flatMap(row=>store.attempts(row.id)).filter(a=>a.kind==='gas_topup')
      .reduce((sum,a)=>sum+BigInt(JSON.parse(a.evidence_json).payer_cost_raw??'0'),0n);
    if (!config.execute) { decision('paused'); throw new SourceRefusal('FOLIO_TOPUP_REQUIRED'); }
    if (!cap || !/^[1-9]\d*$/.test(cap)) { decision('cap_exceeded'); throw new SourceRefusal('FOLIO_TOPUP_CAP_EXCEEDED'); }
    const remaining = BigInt(cap)-contributed-payerCosts-transferFee;
    if (remaining < shortfall) { decision('cap_exceeded'); throw new SourceRefusal('FOLIO_TOPUP_CAP_EXCEEDED'); }
    const desired = shortfall+margin, amount = desired < remaining ? desired : remaining;
    const topupMarginCapped = amount < desired;
    const call = prepareTopup(s.wallet as Address,from,amount), balance = await rpc.balance(call.from);
    if (balance < amount+transferFee) {
      decision('wallet_low', { amount: String(amount), cap_remaining: String(remaining) });
      log({event:'bridge_gas_wallet_low',chain,person:s.person,sweep_id:sweep.slice(0,12),stage:'balance',balance:String(balance)}); throw new SourceRefusal('FOLIO_TOPUP_UNAVAILABLE',503);
    }
    if (store.db.prepare("SELECT 1 FROM bridge_attempt WHERE chain=? AND kind='gas_topup' AND state IN ('prepared','submitted','uncertain')").get(chain)) { decision('pending'); throw new SourceRefusal('FOLIO_TOPUP_PENDING'); }
    const tx: PreparedTransaction = {type:'eip1559',chainId:c.route.chainId,to:call.to,value:call.value,data:call.data,
      nonce:await rpc.nonce(call.from),...budget};
    // KEEP: segregated gas signing authority.
    const key = env[c.gasKeyEnv]; if (!key || !/^0x[\da-f]{64}$/i.test(key)) throw new SourceRefusal('GAS_WALLET_NOT_CONFIGURED',503);
    logInfo('bridge_gas_topup',{chain,sweep_id:sweep.slice(0,12),stage:'sign',nonce:tx.nonce,contribution_raw:String(amount)});
    const signed = await (options.signTopup ?? signGasTopup)(key as Hex,call.from,tx), id = randomUUID();
    const a: Attempt = {id,sweep_id:sweep,chain,kind:'gas_topup',request_id:id,nonce:String(tx.nonce),tx_hash:signed.hash,
      state:'prepared',signed_raw:signed.bytes,sender:call.from.toLowerCase(),gas_paid_raw:'0',evidence_json:JSON.stringify({from:call.from,wallet:s.wallet,rawAmount:String(amount),
        ...(topupMarginCapped?{topup_margin_capped:true}:{}),transaction:androidTransaction(tx)})};
    assertLease();store.putAttempt(a); logInfo('bridge_gas_topup',{chain,sweep_id:sweep.slice(0,12),attempt_id:id.slice(0,12),stage:'reserved',nonce:tx.nonce,tx_ref:signed.hash.slice(0,12)});
    assertLease();store.putAttempt({...a,state:'submitted'});
    decision('broadcast', { amount: String(amount), cap_remaining: String(remaining) });
    try {if (await rpc.broadcast(signed.bytes) !== signed.hash) throw new Error('HASH_MISMATCH');}
    catch (e) {logError('bridge_topup_uncertain', { chain, sweep_id:sweep.slice(0,12), attempt_id:id.slice(0,12), tx12: signed.hash.slice(0,12), ...errorFields(e) });store.putAttempt({...a,state:'uncertain'});}
    { decision('pending'); throw new SourceRefusal('FOLIO_TOPUP_PENDING'); }
  }
  const currentScope=(scope:PersonScope)=>options.people().find(p=>p.user===scope.user)??scope;
  const permissions=options.permissions ?? noPermissionReceipts;
  const signerFor=(chain:SourceChain)=>options.signers?.[chain];
  /** The person's verified receipt for [chain], as stored (not yet checked against this code or the wallet). */
  const receiptFor=(scope:PersonScope,chain:SourceChain)=>permissions.verified(namespaceKey(scope.namespace),chain);
  /** The receipt that may gate a sweep on [chain] now, or null: verified, this chain's template, the
   * person's current wallet and this chain's configured quorum. */
  const usableReceipt=(scope:PersonScope,chain:SourceChain):PermissionReceipt|null=>{
    const r=receiptFor(scope,chain);return receiptUsable(r,{chain,wallet:currentScope(scope).evm_wallet,quorumId:signerFor(chain)?.keyQuorumId})?r:null;};
  const ready=(scope:PersonScope,chain:SourceChain)=>!!usableReceipt(scope,chain);
  /** Server configuration cannot sign on [chain] (no signer, no verified proof for its template, or
   * a receipt recorded under another configured quorum). A logged refusal; nothing about the person is written. */
  const unconfigured=(scope:PersonScope,chain:SourceChain)=>!signerFor(chain)?'signer_absent':!permissionProofStatus(options.env ?? {},chain).ok?'permission_proof_unverified'
    :quorumDrift(receiptFor(scope,chain),signerFor(chain)?.keyQuorumId)?'quorum_mismatch':undefined;
  function refuseUnconfigured(scope:PersonScope, sweep: string, cause: string):never {
    log({event:'bridge_signer_unconfigured',person:namespaceKey(scope.namespace),code:'SOURCE_SIGNER_UNCONFIGURED',cause,
      ...sourceSignerDiagnostic(options.env ?? {}, store.sweep(sweep).chain as SourceChain)});
    throw new SourceRefusal('SOURCE_SIGNER_UNCONFIGURED',503);
  }
  /** The person has no verified receipt for this chain (never set up, revoked, held or stale). Nothing
   * is written; the intent holds PERMISSION_REQUIRED until the person consents. */
  function notAttached(scope:PersonScope, sweep: string):never {
    log({event:'bridge_signer_missing',person:namespaceKey(scope.namespace),code:'PERMISSION_REQUIRED',
      ...sourceSignerDiagnostic(options.env ?? {}, store.sweep(sweep).chain as SourceChain)});
    throw new SourceRefusal('PERMISSION_REQUIRED');
  }
  /** Holds the receipt (signing for that chain stops until the person sets it up again), logs and alerts. */
  function holdReceipt(scope:PersonScope, chain:SourceChain, receipt:PermissionReceipt, code:PermissionReceiptHold, cause:string):never {
    try { permissions.hold?.(receipt.id, code); } catch (e) { logError('permission_drift_hold_failed', { chain, receipt_ref: ref8(receipt.id), ...errorFields(e) }); }
    log({event:'permission_drift',chain,person:namespaceKey(scope.namespace),code,cause,receipt_ref:ref8(receipt.id),policy_ref:ref8(receipt.policy_id)});
    try { options.onPolicyDrift?.(scope, chain, code, cause); } catch { /* alerting never changes the refusal */ }
    throw new SourceRefusal(code,409,'policy_check');
  }
  /** DA 11: the live read before a signing step. A mismatch holds the receipt; a failed read is
   * retryable (POLICY_READ_UNAVAILABLE, the backoff branch); no check configured is configuration. */
  async function livePolicyCheck(scope:PersonScope, sweep:string, chain:SourceChain, receipt:PermissionReceipt) {
    if(!options.policyCheck)return refuseUnconfigured(scope, sweep, 'policy_check_absent');
    const started=now();
    let result;
    try { result=await options.policyCheck(receipt, currentScope(scope).user); }
    catch (e) {
      logInfo('permission_live_check', { chain, receipt_ref: ref8(receipt.id), outcome: 'unavailable', ms: now()-started,
        code: e instanceof PolicyReadUnavailable ? reasonCode(e.code) : 'POLICY_READ_FAILED', ...(e instanceof PolicyReadUnavailable ? { kind: e.kind } : errorFields(e)) });
      throw new SourceRefusal('POLICY_READ_UNAVAILABLE',503,'policy_check',true);
    }
    logInfo('permission_live_check', { chain, receipt_ref: ref8(receipt.id), outcome: result.ok ? 'ok' : 'mismatch', ms: now()-started, ...(result.ok ? {} : { code: result.code, cause: result.cause }) });
    if(!result.ok)holdReceipt(scope, chain, receipt, result.code, result.cause);
  }
  /** Narrow Privy refusals that prove the person's grant is gone (transport.ts). */
  const SIGNER_REVOKED_CODES = ['PRIVY_POLICY_DENIED','PRIVY_AUTHORIZATION_DENIED'];
  /** Generic HTTP refusals: app credential, provider or configuration faults. Never evidence about the person. */
  const SIGNER_PROVIDER_FAULT_CODES = ['PRIVY_HTTP_401','PRIVY_HTTP_403'];
  /** The open provider-fault episode, if any: one founder alert until a signature succeeds. */
  let providerFault: string | undefined;
  /** The configuration clause first, then the person clause. */
  function signerGate(scope:PersonScope, sweep: string) {
    const chain=store.sweep(sweep).chain as SourceChain;
    const cause=unconfigured(scope,chain); if(cause)return refuseUnconfigured(scope, sweep, cause);
    if(!ready(scope,chain))return notAttached(scope, sweep);
  }
  async function prepare(scope: PersonScope, sweep: string, kind: 'approve'|'burn', principalCap?: bigint, feeCap?: bigint) {
      const {s,chain,c,rpc} = chainFor(sweep,scope);
      if (!config.source || c.paused || store.paused(chain)) throw new SourceRefusal('SOURCE_PAUSED');
      if (store.shared.failedAttempts(sweep,kind)>=3) throw new ReadinessHold('SOURCE_ATTEMPTS_EXHAUSTED');
      signerGate(scope, sweep);
      logDebug('bridge_source_execution',{chain,sweep_id:sweep.slice(0,12),action:kind,stage:'chain_identity',cache_decision:identities.has(chain)?'hit':'miss'});
      if(!identities.has(chain))identities.set(chain,rpc.chainId().catch(e=>{ logDebug('source_service_error', { stage: 'operation', ...errorFields(e) }); identities.delete(chain);throw e;}));
      if(await identities.get(chain)!==c.route.chainId)throw new ReadinessHold('SOURCE_ROUTE_MISMATCH');
      await verifyDeployment(rpc,c.feeProof,now());
      if (s.state !== (kind==='approve'?'planned':'approved')) throw new SourceRefusal('SOURCE_ATTEMPT_BLOCKED');
      if (BigInt(s.amount_6)>(principalCap??config.principalCap)) throw new SourceRefusal('FULL_SWEEP_EXCEEDS_TEST_CAP');
      if (!c.feeProof) throw new SourceRefusal('STANDARD_FEE_UNVERIFIED_OR_NONZERO');
      if (chain==='arc' && await rpc.minimumFee(BigInt(s.amount_6))!==0n) throw new SourceRefusal('STANDARD_FEE_UNVERIFIED_OR_NONZERO');
      const destination = await verifyDestination(s.destination_owner,options.readAta);
      const call = sourceCalls(c.route,BigInt(s.amount_6),destination,0n).find(x=>x.kind===kind)!;
      const budget = await rpc.budget(s.wallet as Address,call);
      if (feeCap !== undefined && budget.gas*budget.maxFeePerGas+budget.maxAdditionalFee>feeCap) throw new SourceRefusal('SOURCE_FEE_CAP_EXCEEDED');
      await ensureGas(sweep,budget.gas*budget.maxFeePerGas+budget.maxAdditionalFee);
      const p = await prepareSource(store,ledgerFor(chain,s.wallet),sweep,kind,{person:s.person,wallet:s.wallet as Address,attemptId:randomUUID(),
        nonce:await rpc.nonce(s.wallet as Address),...budget,minFee:0n,readAta:options.readAta,principalCap});
      logInfo('bridge_source_prepared', { sweep: sweep.slice(0,8), kind, attempt: p.attemptId.slice(0,12), nonce: p.unsignedTransactions[0].nonce, gas_limit: String(p.unsignedTransactions[0].gas), fee_cap_ok: true });
      return {sweep:p.sweepId,attempt:p.attemptId,transaction:{from:s.wallet,...androidTransaction(p.unsignedTransactions[0])}};
  }
  async function submit(scope: PersonScope, sweep: string, attempt: string, signed: Hex) {
      const {s,chain,c,rpc} = chainFor(sweep,scope), a = store.attempt(attempt);
      if (!a || a.sweep_id!==sweep) throw new SourceRefusal('SOURCE_ATTEMPT_BLOCKED');
      if (!config.source || c.paused || store.paused(chain)) throw new SourceRefusal('SOURCE_PAUSED');
      if (!c.feeProof || chain==='arc' && await rpc.minimumFee(BigInt(s.amount_6))!==0n) throw new SourceRefusal('STANDARD_FEE_UNVERIFIED_OR_NONZERO');
      signerGate(scope, sweep);
      await verifyDeployment(rpc,c.feeProof,now());
      if (a.nonce !== String(await rpc.nonce(s.wallet as Address))) throw new SourceRefusal('SOURCE_NONCE_CHANGED');
      const ledger = ledgerFor(chain,s.wallet);
      if (!ledger.reservations.has(attempt) || ledger.folioResidual < [...ledger.reservations.values()].reduce((n,x)=>n+x,0n)) throw new SourceRefusal('FOLIO_TOPUP_REQUIRED');
      const result = await submitSource(store,attempt,s.person,signed,{dryRun:!config.execute,recordDryRun:true,readAta:options.readAta,
        ...(config.execute?{beforeBroadcast:assertLease,broadcast:(bytes: Hex)=>rpc.broadcast(bytes)}:{})});
      logInfo('bridge_source_broadcast', { attempt: attempt.slice(0,12), tx12: store.attempt(attempt)?.tx_hash?.slice(0,12), dry_run: !config.execute });
      return {sweep,attempt,...result,state:store.attempt(attempt)!.state};
  }
  async function execute(scope:PersonScope,sweep:string,principalCap?:bigint,feeCap?:bigint) {
    const sweepChain=store.sweep(sweep).chain as SourceChain;
    // Only a quorum drift is configuration here: an absent signer is SOURCE_EXECUTION_DISABLED and
    // an absent proof is refused by chainFor, neither touching the person.
    if(quorumDrift(receiptFor(scope,sweepChain),signerFor(sweepChain)?.keyQuorumId))return refuseUnconfigured(scope, sweep, 'quorum_mismatch');
    if(!ready(scope,sweepChain))return notAttached(scope, sweep);
    // A dry run cannot call Privy, even when credentials are configured.
    const signer=signerFor(sweepChain)?.signer;
    if(!config.source || !config.execute || !signer)throw new SourceRefusal('SOURCE_EXECUTION_DISABLED');
    const {s,chain,c,rpc}=chainFor(sweep,scope);
    if(usableReceipt(scope,chain)?.ata!==s.mint_recipient)throw new SourceRefusal('DESTINATION_BINDING_MISMATCH');
    if(c.paused || store.paused(s.chain))throw new SourceRefusal('SOURCE_PAUSED');
    const prior=store.attempts(sweep).find(a=>a.kind!=='gas_topup' && ['prepared','submitted','uncertain'].includes(a.state));
    if(prior && prior.state!=='prepared')return {state:prior.state,attempt:prior.id};
    const kind=s.state==='planned'?'approve':s.state==='approved'?'burn':prior?.kind;
    if(kind!=='approve' && kind!=='burn')throw new SourceRefusal('SOURCE_ATTEMPT_BLOCKED');
    if(!prior)await prepare(scope,sweep,kind,principalCap,feeCap);
    const attempt=prior??store.attempts(sweep).find(a=>a.kind===kind && a.state==='prepared')!;
    const raw=JSON.parse(attempt.evidence_json),transaction:PreparedTransaction={...raw,value:BigInt(raw.value),gas:BigInt(raw.gas),maxFeePerGas:BigInt(raw.maxFeePerGas),maxPriorityFeePerGas:BigInt(raw.maxPriorityFeePerGas)};
    if(BigInt(s.amount_6)>(principalCap??config.principalCap))throw new SourceRefusal('FULL_SWEEP_EXCEEDS_TEST_CAP');
    const ledger=ledgerFor(s.chain as SourceChain,s.wallet),reserved=ledger.reservations.get(attempt.id);
    if(feeCap!==undefined && (!reserved || reserved>feeCap))throw new SourceRefusal('SOURCE_FEE_CAP_EXCEEDED');
    if(!c.feeProof || s.chain==='arc' && await rpc.minimumFee(BigInt(s.amount_6))!==0n)throw new SourceRefusal('STANDARD_FEE_UNVERIFIED_OR_NONZERO');
    await verifyDeployment(rpc,c.feeProof,now());
    await verifyDestination(s.destination_owner,options.readAta);
    if(attempt.nonce!==String(await rpc.nonce(s.wallet as Address)))throw new SourceRefusal('SOURCE_NONCE_CHANGED');
    if(!reserved || ledger.folioResidual<[...ledger.reservations.values()].reduce((n,x)=>n+x,0n))throw new SourceRefusal('FOLIO_TOPUP_REQUIRED');
    // Recheck ownership/readiness immediately before requesting the offline signature.
    signerGate(scope, sweep);
    // Already signed (a burn on its way): submitting it signs nothing new, so no live read.
    if(attempt.signed_raw) {assertLease();return submit(scope,sweep,attempt.id,attempt.signed_raw as Hex);}
    // DA 11: read the receipt's policy, owner and the wallet entry live; never sign on a stale view.
    const receipt=usableReceipt(scope,chain)!;
    await livePolicyCheck(scope, sweep, chain, receipt);
    let signed:Hex;
    const signStarted = now();
    logDebug('bridge_sign', { attempt: attempt.id.slice(0,12), phase: 'start' });
    try {assertLease();signed=await signer.sign(receipt.wallet_id,attempt.id,transaction);}
    catch(e) {
      const revoked=e instanceof PrivyError && SIGNER_REVOKED_CODES.includes(e.code);
      const providerFaulted=e instanceof PrivyError && SIGNER_PROVIDER_FAULT_CODES.includes(e.code);
      logError('bridge_sign', { attempt: attempt.id.slice(0,12), ms: now()-signStarted, outcome: revoked ? 'privy_denied' : providerFaulted ? 'provider_fault' : 'pending', privy_code: e instanceof PrivyError ? reasonCode(e.code) : undefined, ...errorFields(e) });
      if(providerFaulted) {
        // Not a revocation: the person's record is untouched and the same prepared attempt and
        // idempotency key are retried on the pass's backoff once the provider recovers.
        const code=(e as PrivyError).code;
        log({event:'bridge_signer_unconfigured',person:namespaceKey(scope.namespace),code:'SOURCE_SIGNER_UNCONFIGURED',cause:code.toLowerCase(),
          ...sourceSignerDiagnostic(options.env ?? {}, store.sweep(sweep).chain as SourceChain)});
        if(!providerFault) {
          providerFault=code;
          try { options.onSignerProviderFault?.(code); } catch { /* alerting never changes the refusal */ }
        }
        throw new SourceRefusal('SOURCE_SIGNER_UNCONFIGURED',503,'signing',true);
      }
      if(revoked) {
        // Privy refused right after a passing live check: the grant or policy changed under us. Hold
        // the receipt like any drift; the person sets the chain up again.
        log({event:'signer_revoked',person:namespaceKey(scope.namespace),stage:'signing',code:reasonCode(e.code),...(e.detail?{detail:e.detail}:{})});
        try { options.onSignerRevoked?.(scope, e.code, e.detail); } catch { /* alerting never changes the refusal */ }
        return holdReceipt(scope, chain, receipt, 'POLICY_DRIFT', `signing_${e.code.toLowerCase()}`);
      }
      // Signing alone cannot submit funds. Keep the same prepared attempt/idempotency key.
      throw new SourceRefusal('SOURCE_SIGNATURE_PENDING');
    }
    logInfo('bridge_sign', { attempt: attempt.id.slice(0,12), ms: now()-signStarted, outcome: 'ok' });
    if(providerFault){logInfo('bridge_signer_provider_recovered',{code:reasonCode(providerFault)});providerFault=undefined;}
    signerGate(scope, sweep);
    assertLease();return submit(scope,sweep,attempt.id,signed);
  }
  function owned(scope:PersonScope,id:string) {
    let i:DepositIntent;
    try {i=intents.owned(id,namespaceKey(scope.namespace));}catch(e){logDebug('bridge_intent_lookup_failed', errorFields(e));throw new SourceRefusal('INTENT_FORBIDDEN',403);}
    if(i.wallet!==currentScope(scope).evm_wallet?.address.toLowerCase() || i.owner!==scope.wallet_address)throw new SourceRefusal('INTENT_FORBIDDEN',403);
    return i;
  }
  return {
    intents,
    /** [watch] false prepares the address without starting its watch; [watch] starts it later. */
    prepareDeposit(scope:PersonScope,chain:SourceChain,watch=true) {
      if(!sourceChains.includes(chain) || !config.source || !config.chains[chain].enabled || config.chains[chain].paused || store.paused(chain))throw new SourceRefusal('SOURCE_PAUSED');
      const bound=currentScope(scope);
      if(!bound.wallet_address)throw new SourceRefusal('SOURCE_IDENTITY_MISMATCH',403);
      const person=namespaceKey(scope.namespace);
      // No Ethereum deposit wallet or no verified receipt for this chain: the app shows the consent sheet.
      if(!bound.evm_wallet || !ready(scope,chain))throw new SourceRefusal('PERMISSION_REQUIRED',409);
      if(intents.list(person).some(i=>i.chain===chain && i.hold_reason==='FULL_SWEEP_EXCEEDS_CAP'))throw new SourceRefusal('SUPPORT_REQUIRED');
      const held=intents.list(person).find(i=>i.chain===chain && i.state==='held' && i.hold_reason!=='BELOW_MINIMUM');
      if(held){logDebug('bridge_address_readiness',{chain,intent_id:held.id.slice(0,12),gate:'held_intent',reason:held.hold_reason?reasonCode(held.hold_reason):undefined});return held;} // A new tap cannot reset a phase's attempts or sponsorship ceiling.
      return intents.create({person,chain,wallet:bound.evm_wallet!.address,owner:bound.wallet_address},now(),{watch});
    },
    /** The person revealed, copied or opened a wallet with the address: the watch starts (once). */
    watch(scope:PersonScope,id:string,signal:WatchSignal) {
      const i=owned(scope,id);
      if(!config.source)throw new SourceRefusal('SOURCE_PAUSED');
      try{return intents.arm(id,namespaceKey(scope.namespace),now(),signal,ready(scope,i.chain));}catch(e){ logDebug('source_service_error', { stage: 'watch', ...errorFields(e) }); throw new SourceRefusal(e instanceof Error?e.message:'INTENT_REARM_REFUSED');}
    },
    checkAgain(scope:PersonScope,id:string,reference?:string) {
      const i=owned(scope,id);
      if(!config.source)throw new SourceRefusal('SOURCE_PAUSED');
      try{return intents.rearm(id,namespaceKey(scope.namespace),now(),'User requested checking',reference,ready(scope,i.chain));}catch(e){ logDebug('source_service_error', { stage: 'checkAgain', ...errorFields(e) }); throw new SourceRefusal(e instanceof Error?e.message:'INTENT_REARM_REFUSED');}
    },
    intent(scope:PersonScope,id:string) {
      const i=owned(scope,id), address=this.addresses(scope).addresses.find(a=>a.chain===i.chain && 'intent' in a && a.intent===i.id)?.address;
      return depositStatus(intents,i,{now:now(),minimum:config.chains[i.chain].route.minimum,maximum:config.principalCap,address,
        credited:signature=>options.credited(scope,signature)});
    },
    /** Every intent with a receipt, and of the rest only the newest per chain and wallet: one pending row per chain. */
    history(scope:PersonScope) {
      intents.restoreReceipts();
      const rows=intents.list(namespaceKey(scope.namespace)).map(i=>({i,status:this.intent(scope,i.id)}));
      const newest=new Map<string,string>();
      for(const {i,status} of rows)if(i.state!=='complete' && !status.receipts.length)newest.set(`${i.chain}:${i.wallet}`,i.id);
      return {intents:rows.filter(({i,status})=>i.state==='complete' || status.receipts.length>0 || newest.get(`${i.chain}:${i.wallet}`)===i.id).map(r=>r.status)};
    },
    addresses(scope: PersonScope) {
      const rows=intents.list(namespaceKey(scope.namespace));
      return {addresses:[...(scope.wallet_address?[{chain:'solana',address:scope.wallet_address,state:'available',estimate:estimates.solana,minimum:'0.000000'}]:[]),
        ...sourceChains.map(chain=>{
          const i=rows.filter(i=>i.chain===chain).at(-1),paused=!config.source || config.chains[chain].paused || store.paused(chain);
          let available=false, notice:'busy'|null=null, gate=paused?'paused':!i?'intent_missing':i.state!=='waiting'?'intent_state':i.expires_at<=now()?'expired':!i.readiness?'readiness_missing':!ready(scope,chain)?'signer_not_ready':'local_readiness';
          if(i?.state==='waiting' && i.expires_at>now() && i.readiness && ready(scope,chain)) {
            try {
              assertReadinessLocal(currentScope(scope),i,config,!!signerFor(chain),options.env??{},signerFor(chain)?.keyQuorumId,receiptFor(scope,chain));
              const proof=JSON.parse(config.chains[chain].feeProof??'null');
              const saved=JSON.parse(i.readiness),receipt=usableReceipt(scope,chain)!;
              available=proof?.zeroFee===true && Number.isFinite(proof.expiresAt) && proof.expiresAt>now()
                && saved.fee_proof===config.chains[chain].feeProof && saved.policy_id===receipt.policy_id && saved.ata===receipt.ata;
              gate=available?'ready':'stale_readiness';
              // Our own spend caps never hide the address: a congested readiness only says so.
              notice=available && saved.congested===true?'busy':null;
            } catch (e) { gate=e instanceof Error?reasonCode(e.message):'LOCAL_READINESS_FAILED'; logError('bridge_readiness_unavailable', {chain,intent_id:i.id.slice(0,12),gate,...errorFields(e)}); /* Stored readiness remains readable when current local gates are closed. */ }
          }
          logDebug('bridge_address_readiness',{chain,intent_id:i?.id.slice(0,12),availability:paused?'paused':available?'available':'not_ready',gate,expires_at:i?.expires_at,stale_readiness:!!i?.readiness&&!available,notice});
          return {chain,...(available && !paused?{address:i!.wallet}:{}),state:paused?'paused':available?'available':'not_ready',notice:paused?null:notice,
            estimate:estimates[chain],intent:i?.id,readiness:i?.readiness?JSON.parse(i.readiness):null,minimum:dollars(config.chains[chain].route.minimum),maximum:dollars(config.principalCap),
            // A held receipt shows on GET /api/permissions; the address row carries the intent's hold.
            reason:i?.hold_reason ?? undefined,checking_notice:'Checking lasts 24 hours. After it ends, choose Check again to find a later deposit.'};
        })]};
    },
    incoming(scope: PersonScope) {
      const rows = store.db.prepare('SELECT * FROM bridge_sweep WHERE person=? ORDER BY created_at,id').all(namespaceKey(scope.namespace)) as unknown as ReturnType<SourceStore['sweep']>[];
      return {incoming:[...rows.map(s=>{
        const signature=s.state==='settled'?store.shared.getTransfer(s.id)?.settled_signature:undefined;
        return {sweep:s.id,chain:s.chain,amount:dollars(s.amount_6),detected_at:s.created_at,
          reason:s.blocked_reason, state:s.state==='blocked'?'action_needed':s.state==='settled' && signature && store.shared.acknowledged(s.id) && options.credited(scope,signature)?'available':s.state==='planned'?'detected':'processing'};
      }),...intents.list(namespaceKey(scope.namespace)).flatMap(i=>store.events(i.chain,i.wallet).filter(e=>e.classification==='customer' && !e.covered_by && store.db.prepare('SELECT 1 FROM bridge_intent_event WHERE event_id=? AND intent_id=?').get(e.id,i.id)).map(e=>({event:e.id,intent:i.id,chain:i.chain,amount:dollars(e.amount_6),state:'action_needed',reason:i.hold_reason??'BELOW_MINIMUM',reference:e.tx_hash})))]};
    },
    prepare: (scope:PersonScope,sweep:string,kind:'approve'|'burn',principalCap?:bigint,feeCap?:bigint) => exclusive(()=>prepare(scope,sweep,kind,principalCap,feeCap)),
    submit: (scope:PersonScope,sweep:string,attempt:string,signed:Hex) => exclusive(()=>submit(scope,sweep,attempt,signed)),
    execute: (scope:PersonScope,sweep:string,principalCap?:bigint,feeCap?:bigint) => exclusive(()=>execute(scope,sweep,principalCap,feeCap)),
    /**
     * At revoke (S1): every approve or burn attempt of [person] (namespace key) on [chain] that is
     * prepared but not signed becomes `failed` with `cancelled: REVOKED` in its evidence, its gas
     * reservation is released and its sweep returns to the state before that prepare (planned or
     * approved). Nothing was signed, so nothing can be on chain; the retry allowance is not consumed
     * and its nonce stays usable. Signed, submitted and uncertain work keeps reconciling. Returns the
     * cancelled attempt ids. Runs under the source lease (SOURCE_BUSY when another process holds it).
     */
    cancelPreparedUnsigned: (person: string, chain: SourceChain) => exclusive(async () => {
      const rows=store.db.prepare(`SELECT a.* FROM bridge_attempt a JOIN bridge_sweep s ON s.id=a.sweep_id
        WHERE s.person=? AND s.chain=? AND a.kind IN ('approve','burn') AND a.state='prepared' AND a.signed_raw IS NULL ORDER BY a.rowid`).all(person,chain) as unknown as Attempt[];
      for(const a of rows) {
        assertLease();
        store.transaction(()=>{
          const s=store.sweep(a.sweep_id),pending=a.kind==='approve'?'approval_pending':'burn_pending',before=a.kind==='approve'?'planned':'approved';
          const ledger=ledgerFor(chain,s.wallet);ledger.reservations.delete(a.id);
          store.putAttempt({...a,state:'failed',evidence_json:JSON.stringify({...JSON.parse(a.evidence_json),cancelled:'REVOKED'})});
          store.db.prepare('INSERT INTO bridge_retry_allowance VALUES (?,?,1) ON CONFLICT(record_id,phase) DO UPDATE SET failed_baseline=failed_baseline+1').run(a.sweep_id,a.kind);
          if(s.state===pending)store.db.prepare('UPDATE bridge_sweep SET state=? WHERE id=? AND state=?').run(before,s.id,pending);
          store.saveLedger(chain,s.wallet,ledger.snapshot());
        });
      }
      log({event:'bridge_prepared_cancelled',chain,person,reason:'REVOKED',count:rows.length,attempts:rows.map(a=>a.id.slice(0,12))});
      return rows.map(a=>a.id);
    }),
    reconcile: (attempt: string) => exclusive(async()=>{const a=store.attempt(attempt);if(a && (['submitted','uncertain'].includes(a.state) || a.state==='prepared' && a.signed_raw)) await reconcile(a);}),
    /** Stops claiming the lease and waits up to `timeoutMs` for a running holder to finish and
     * delete its row; true when no holder remains. A holder still running keeps its row until it
     * lapses, so two live holders never run the source at once. */
    async stop(timeoutMs = 8000): Promise<boolean> {
      stopping = true;
      const running = active?.released; if (!running) return true;
      let timer: NodeJS.Timeout | undefined;
      const done = await Promise.race([running.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
      clearTimeout(timer); return done;
    },
    /** Observation runs without the lease (each step is one SQLite transaction and idempotent);
     * receipts and sweeps claim it per step. A refusal or failure of one person's chain is a hold
     * for that person and chain: the tick continues with the next. */
    tick: () => serial(async()=>{
      if(stopping){logDebug('bridge_source_pass',{stage:'skip',reason:'stopping'});return;}
      const work_id=randomUUID().slice(0,12),passStarted=now();
      // Reconciliation remains enabled when accepting new deposits is paused.
      const heads=new Map<SourceChain,Promise<bigint>>();
      const tickRpc=(chain:SourceChain,rpc:SourceRpc):SourceRpc=>({...rpc,finalizedBlock:()=>{if(!heads.has(chain))heads.set(chain,rpc.finalizedBlock());return heads.get(chain)!;}});
      const attempts=store.db.prepare("SELECT * FROM bridge_attempt WHERE (state IN ('submitted','uncertain') OR state='prepared' AND signed_raw IS NOT NULL) AND kind IN ('approve','burn','gas_topup') ORDER BY rowid").all() as unknown as Attempt[];
      for(const a of attempts) {
        const key=`attempt:${a.id}`;
        if(!intents.claimClock(key,now(),sourceInterval(a.chain))){logDebug('bridge_source_pass',{work_id,chain:a.chain,attempt_id:a.id.slice(0,12),stage:'skip',reason:'read_clock'});continue;}
        try {await leased(()=>reconcile(a,options.rpc[a.chain as SourceChain]?tickRpc(a.chain as SourceChain,options.rpc[a.chain as SourceChain]!):undefined));}
        catch(e) {if(!busy(e))intents.backoffClock(key,now());const saved=store.db.prepare('SELECT next_check_at FROM bridge_work_clock WHERE id=?').get(key);logInfo('bridge_reconcile_failed', { attempt: a.id.slice(0,12), retry_in_ms: Number(saved?.next_check_at ?? now())-now(), ...errorFields(e) });}
      }
      // Retain legacy unresolved sweeps without creating observation work for idle accounts.
      for(const scope of options.people()) for(const chain of sourceChains) {
        if(!scope.evm_wallet || !scope.wallet_address)continue;
        const pending=store.sweeps(chain,scope.evm_wallet.address).filter(s=>!['settled','blocked'].includes(s.state) && !store.db.prepare('SELECT 1 FROM bridge_intent_sweep WHERE sweep_id=?').get(s.id));
        if(pending.length && !intents.list(namespaceKey(scope.namespace)).some(i=>i.chain===chain && i.state==='funded')) {
          const i=intents.create({person:namespaceKey(scope.namespace),chain,wallet:scope.evm_wallet.address,owner:scope.wallet_address},now(),{reuseHeld:false});
          logInfo('bridge_intent_created', { chain, legacy: true, intent: i.id.slice(0,12) });
          intents.update(i.id,{state:'funded'});intents.attach(i.id);
        }
      }
      intents.releaseSpendCapHolds(now());
      const due=intents.due(now()); logDebug('bridge_source_pass',{work_id,stage:'start',due_count:due.length,attempt_count:attempts.length});
      if(!attempts.length && !store.db.prepare("SELECT 1 FROM bridge_deposit_intent WHERE state IN ('preparing','waiting','funded') LIMIT 1").get())identities.clear();
      for(const i of due) {
        logDebug('bridge_source_pass',{work_id,chain:i.chain,intent_id:i.id.slice(0,12),stage:i.state});
        const scope=options.people().find(s=>namespaceKey(s.namespace)===i.person),direct=options.rpc[i.chain],c=config.chains[i.chain];
        if(!scope || !direct) {logInfo('bridge_intent_error', { intent: i.id.slice(0,12), code: 'SOURCE_IDENTITY_UNAVAILABLE', action: 'hold', failures: i.failures });intents.update(i.id,{state:'held',hold_reason:'SOURCE_IDENTITY_UNAVAILABLE'});continue;}
        // Funded work (a received deposit moving on) keeps the chain's rate; observation follows the watch phases.
        const scheduled=(at:number)=>i.state==='funded'?at:Math.max(at,nextCheckAt(i.watch_started_at,now(),i.chain));
        if(!store.db.prepare('UPDATE bridge_deposit_intent SET next_check_at=? WHERE id=? AND next_check_at<=?').run(scheduled(now()+sourceInterval(i.chain)),i.id,now()).changes)continue;
        try {
          if(i.state==='funded') {
            const sweeps=store.sweeps(i.chain,i.wallet).filter(s=>store.db.prepare('SELECT 1 FROM bridge_intent_sweep WHERE sweep_id=? AND intent_id=?').get(s.id,i.id));
            if(sweeps.length && sweeps.every(s=>s.state==='settled')) {intents.update(i.id,{state:'complete'});continue;}
            if(sweeps.some(s=>s.state==='blocked')) {intents.update(i.id,{state:'held',hold_reason:'TRANSFER_HELD'});continue;}
            for(const s of sweeps.filter(s=>['planned','approved','approval_pending','burn_pending'].includes(s.state))) {
              if(store.attempts(s.id).some(a=>['submitted','uncertain'].includes(a.state)))continue;
              if(!config.source || c.paused || store.paused(i.chain))continue;
              await leased(()=>execute(scope,s.id,config.principalCap,BigInt(options.env?.[`FOLIO_BRIDGE_SOURCE_FEE_CAP_${i.chain.toUpperCase()}_RAW`]??'0')));
            }
            if(spendCapHold(i.hold_reason) || i.hold_reason==='SOURCE_SIGNER_UNCONFIGURED' || i.hold_reason==='POLICY_READ_UNAVAILABLE')intents.update(i.id,{hold_reason:null,failures:0});
            continue;
          }
          if(!config.source){if(store.db.prepare("SELECT 1 FROM bridge_setup_attempt WHERE intent_id=? AND state IN ('submitted','uncertain')").get(i.id))await leased(()=>ensureIntentAta(intents,i,options.readAta,options.setup,assertLease));continue;}
          if(i.state==='preparing')assertReadinessLocal(currentScope(scope),i,config,!!signerFor(i.chain),options.env??{},signerFor(i.chain)?.keyQuorumId,receiptFor(scope,i.chain));
          if(i.state==='preparing' && usableReceipt(scope,i.chain)?.ata!==await deriveUsdcAta(i.owner))throw new ReadinessHold('DESTINATION_BINDING_MISMATCH');
          if(!identities.has(i.chain))identities.set(i.chain,direct.chainId().catch(e=>{ logDebug('source_service_error', { stage: 'operation', ...errorFields(e) }); identities.delete(i.chain);throw e;}));
          if(await identities.get(i.chain)!==c.route.chainId)throw new ReadinessHold('SOURCE_ROUTE_MISMATCH');
          const rpc={...direct,chainId:()=>identities.get(i.chain)!,finalizedBlock:()=>{if(!heads.has(i.chain))heads.set(i.chain,direct.finalizedBlock());return heads.get(i.chain)!;}};
          if(i.boundary===null) {
            const head=await rpc.finalizedBlock();
            store.transaction(()=>{
              const boundary=store.assignment(i.chain,i.wallet,i.person,head);
              if(store.cursor(i.chain,i.wallet)===undefined)store.ingest(i.chain,i.wallet,boundary,[]);
              intents.update(i.id,{boundary:String(boundary)});
              store.shared.afterCommit(()=>logInfo('bridge_boundary_set', { chain: i.chain, intent: i.id.slice(0,12), block: String(boundary) }));
            });
          }
          if(i.state==='preparing') {
            const d=await leased(()=>ensureIntentAta(intents,i,options.readAta,options.setup,assertLease));
            if(!d)continue;
            const receipt=usableReceipt(scope,i.chain);
            if(!receipt)throw new ReadinessHold('PERMISSION_REQUIRED');
            if(receipt.ata!==d.ata)throw new ReadinessHold('DESTINATION_BINDING_MISMATCH');
            const {congested}=await checkSponsorship(i,config,rpc,options.env??{},d,options.setup,store,now());
            intents.update(i.id,{state:'waiting',readiness:JSON.stringify({ata:d.ata,owner:d.owner,policy_id:receipt.policy_id,fee_proof:c.feeProof,verified_at:now(),congested}),hold_reason:null,failures:0});
            continue;
          }
          if(i.recovery_tx) {
            const receipt=await rpc.receipt(i.recovery_tx as Hex),head=await rpc.finalizedBlock();
            if(receipt.transactionHash.toLowerCase()!==i.recovery_tx || receipt.status!=='success' || receipt.blockNumber>head || await rpc.blockHash(receipt.blockNumber)!==receipt.blockHash)throw new ReadinessHold('RECOVERY_REFERENCE_INVALID');
            const events=receipt.logs.map(l=>canonicalEvent(c.route,i.wallet as Hex,l,store.topupMatches(i.chain,i.wallet))).filter((e):e is NonNullable<typeof e>=>!!e);
            if(!events.length || events.some(e=>e.tx_hash!==i.recovery_tx || e.block!==String(receipt.blockNumber) || e.block_hash!==receipt.blockHash))throw new ReadinessHold('RECOVERY_REFERENCE_INVALID');
            store.transaction(()=>{const cursor=store.cursor(i.chain,i.wallet);store.ingest(i.chain,i.wallet,receipt.blockNumber,events,false);if(cursor!==undefined)store.db.prepare('UPDATE bridge_observation_cursor SET block=? WHERE chain=? AND wallet=?').run(String(cursor),i.chain,i.wallet);});intents.update(i.id,{recovery_tx:null});
          }
          const cursorFrom=store.cursor(i.chain,i.wallet);
          const before=new Set(store.events(i.chain,i.wallet).map(e=>e.id));
          // Balance first: one read at the finalized head; logs only when it exceeds what the ledger accounts for.
          const probe={read:(block:bigint)=>i.chain==='arc'?rpc.balance(i.wallet as Address,block):rpc.tokenBalance(i.wallet as Address,block),
            accounted:()=>{const l=ledgerFor(i.chain,i.wallet);return l.customerPrincipal+(i.chain==='arc'?l.folioResidual:0n);}};
          const progress=await observe(store,rpc,c.route,i.wallet as Hex,BigInt(intents.get(i.id)!.boundary!),[],c.scanPageBlocks,false,c.scanChunks,undefined,probe);
          logDebug('bridge_source_pass',{work_id,chain:i.chain,intent_id:i.id.slice(0,12),stage:'scan',cursor_from:cursorFrom?.toString(),cursor_to:store.cursor(i.chain,i.wallet)?.toString(),remaining_blocks:String(progress.remainingBlocks),balance:progress.balance});
          intents.update(i.id,{last_verified_at:now()});
          intents.attach(i.id);
          for(const e of store.events(i.chain,i.wallet))if(!before.has(e.id))log({event:'bridge_deposit_observed',chain:i.chain,person:i.person,intent:i.id.slice(0,12),sweep:e.covered_by?.slice(0,8),amount_6:e.amount_6,event_index:e.event_index});
          if(progress.balance==='unexplained')throw new ReadinessHold('SOURCE_OPENING_BALANCE_UNEXPLAINED');
          if(progress.remainingBlocks>0n)continue;
          const ledger=ledgerFor(i.chain,i.wallet);
          const uncovered=store.events(i.chain,i.wallet).filter(e=>e.classification==='customer' && !e.covered_by);
          if(!uncovered.length)continue;
          const scale=i.chain==='arc'?10n**12n:1n;
          if(ledger.customerPrincipal>config.principalCap*scale)throw new ReadinessHold('FULL_SWEEP_EXCEEDS_CAP');
          if(!uncovered.some(e=>BigInt(e.amount_6)>=c.route.minimum)) {
            // Not a hold: the intent keeps waiting for a qualifying deposit, read on a slower cadence
            // until one arrives or the checking window ends. Status still reports the reason.
            intents.update(i.id,{hold_reason:'BELOW_MINIMUM',failures:0,next_check_at:scheduled(now()+BELOW_MINIMUM_INTERVAL_MS)});
            hold(i.chain,i.person,'BELOW_MINIMUM');
            continue;
          }
          const d=await verifyDestination(i.owner,options.readAta);
          store.transaction(()=>{const sweep=store.plan(c.route,i.wallet,i.person,d,new Date(now()).toISOString(),config.principalCap);
            if(sweep){store.db.prepare('INSERT OR REPLACE INTO bridge_intent_sweep VALUES (?,?)').run(sweep.id,i.id);intents.attach(i.id);intents.update(i.id,{state:'funded',hold_reason:null});}});
        } catch(e) {
          const code=e instanceof SourceRefusal?e.code:e instanceof Error?e.message:'SOURCE_READ_UNAVAILABLE';
          if(code==='FOLIO_TOPUP_PENDING' || busy(e)){
            // A pending top-up is past both spend caps.
            if(code==='FOLIO_TOPUP_PENDING' && spendCapHold(i.hold_reason))intents.update(i.id,{hold_reason:null,failures:0});
            logDebug('bridge_source_pass',{work_id,chain:i.chain,intent_id:i.id.slice(0,12),stage:'skip',reason:code});continue;}
          if(i.state==='funded' && spendCapHold(code)) {
            // Our own spend cap at execution: the deposit was received and stays funded. The sweep is
            // never blocked; it re-plans on the backoff schedule against the current price and caps.
            const failures=i.failures+1,retry=Math.min(600_000,30_000*2**Math.min(5,failures-1));
            logInfo('bridge_intent_error', { intent: i.id.slice(0,12), chain: i.chain, action: 'retry_later', code: reasonCode(code), failures, retry_in_ms: retry });
            intents.update(i.id,{failures,next_check_at:now()+retry,hold_reason:code});
          } else if(e instanceof ReadinessHold || /^(DESTINATION_|SOURCE_DEPLOYMENT_|STANDARD_FEE_|FULL_SWEEP_|GAS_PRINCIPAL_|PRINCIPAL_SHORT)/.test(code) || e instanceof SourceRefusal && !e.retryable && !['SOURCE_SIGNATURE_PENDING'].includes(code)) {
            if(i.state==='funded')for(const s of store.sweeps(i.chain,i.wallet).filter(s=>!['settled','blocked'].includes(s.state)))store.shared.hold(s.id,code,now());
            logEvent(/MISMATCH|OPENING_BALANCE_UNEXPLAINED/.test(code) ? 'error' : 'info', 'bridge_intent_error', { intent: i.id.slice(0,12), ...errorFields(e), ...intentDetail(e), code: reasonCode(code), action: 'hold', failures: i.failures });
            intents.update(i.id,{state:'held',hold_reason:code});
          } else {
            const failures=i.failures+1;
            logInfo('bridge_intent_error', { intent: i.id.slice(0,12), action: 'backoff', code: reasonCode(code), failures, retry_in_ms: e instanceof BridgeBudgetExceeded ? e.retryAt-now() : Math.min(600_000,30_000*2**Math.min(5,failures-1)), ...errorFields(e), ...intentDetail(e) });
            intents.update(i.id,{failures,next_check_at:scheduled(e instanceof BridgeBudgetExceeded?e.retryAt:now()+Math.min(600_000,30_000*2**Math.min(5,failures-1))),hold_reason:e instanceof SourceRefusal && e.retryable?code:'SOURCE_READ_UNAVAILABLE'});
          }
          hold(i.chain,i.person,/^[A-Z0-9_]+$/.test(code)?code:'SOURCE_READ_UNAVAILABLE');
        }
      }
      logDebug('bridge_source_pass',{work_id,stage:'complete',due_count:due.length,elapsed_ms:now()-passStarted});
    }),
  };
}
export type SourceService = ReturnType<typeof createSourceService>;
export async function bootSourceService(options: {env: NodeJS.ProcessEnv; mode: string; db: string; people(): readonly PersonScope[];
  credited(scope: PersonScope, settledSignature: string): boolean;
  signers?: Partial<Record<SourceChain, DepositSigner>>; permissions?: SigningPermissions; policyCheck?: PolicyLiveCheck;
  onPolicyDrift?(scope:PersonScope,chain:SourceChain,code:PermissionReceiptHold,cause:string):void;
  /** @deprecated Ignored: the signing path writes nothing on the person (receipts carry holds). S1 removes the caller (release-main). */
  onSignerRevoked?(scope:PersonScope,code:string,detail?:string):void; onSignerProviderFault?(code:string):void; fetch?: typeof fetch; open?: (path:string)=>SourceStore; rpc?: (chain:SourceChain,url:string)=>SourceRpc; log?: (event:object)=>void; setup?: SetupPorts}) {
  let config:BridgeConfig; try {config=readBridgeConfig(options.env,options.mode);}catch(e){logError('bridge_startup',{stage:'config',outcome:'refused',...errorFields(e),...(e instanceof BridgeConfigError?{detail:e.detail}:{})});throw e;} if (options.mode!=='live') {logInfo('bridge_startup',{stage:'mode',enabled:false,outcome:'disabled'});return undefined;}
  const store=(options.open??(path=>new SourceStore(path)))(options.db), rpc: Partial<Record<SourceChain,SourceRpc>>={};
  const log=eventSink(options.log),budget=bridgeReadBudget(store.db);
  for(const chain of sourceChains) {
    const c=config.chains[chain]; store.pause(chain,c.paused);
    try {
      // KEEP: source chain provider endpoint.
      const url=options.env[c.rpcEnv]??(chain==='base'?'https://mainnet.base.org':'https://rpc.mainnet.arc.io');
      const adapter=(options.rpc??((ch,u)=>createSourceRpc(ch,u,budget(ch,options.fetch??fetch),{env:options.env,mode:options.mode})))(chain,url);
      rpc[chain]=adapter; logInfo('bridge_startup',{chain,stage:'adapter',enabled:c.enabled,outcome:'constructed',paused:c.paused,execute:config.execute});
    } catch (e) {log({event:'bridge_source_chain_refused',chain,...errorFields(e),code:'SOURCE_RPC_UNAVAILABLE'});}
  }
  const solana=publicSolanaRpc(budget('solana',options.fetch??fetch)), readAta=async(ata:string)=>{const a=await readAccount(solana,ata);return {exists:!!a,program:a?.owner??'',data:Buffer.from(a?.data[0]??'','base64')};};
  const service=createSourceService({store,config,rpc,people:options.people,readAta,credited:options.credited,env:options.env,log:options.log,signers:options.signers,permissions:options.permissions,policyCheck:options.policyCheck,onPolicyDrift:options.onPolicyDrift,onSignerRevoked:options.onSignerRevoked,onSignerProviderFault:options.onSignerProviderFault,setup:options.setup});
  // stop (the server's SIGTERM/SIGINT handler) lets a running lease holder delete its row;
  // close claims nothing more and closes the store.
  return {service,store,capabilities: { base: !!rpc.base, arc: !!rpc.arc },stop:(timeoutMs?:number)=>service.stop(timeoutMs),close:()=>{void service.stop(0);store.close();}};
}
