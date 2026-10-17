import { errorFields, reasonCode } from '../shims/log-fields.js';
import { logDebug, logInfo, logError } from '../shims/log.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Hex } from 'viem';
import { GasLedger } from './source-gas.js';
import { normalise, qualifies, type SourceRoute, type SourceChain } from './source-registry.js';
import type { Destination } from './source-calls.js';
import type { TopupMatch } from './source-observer.js';

/** Shared source and delivery contract. Integer amounts are decimal strings, never REAL. */
export const sweepStates = ['planned', 'approval_pending', 'approved', 'burn_pending', 'burn_uncertain', 'burn_confirmed', 'attested', 'delivery_submitted', 'delivery_uncertain', 'settled', 'blocked'] as const;
export type SweepState = typeof sweepStates[number];
export type BridgeChain = 'base' | 'arc' | 'solana';
export type AttemptState = 'prepared' | 'prepared_dry_run' | 'signed' | 'submitted' | 'uncertain' | 'confirmed' | 'failed';
export interface DepositEvent {
  id: string; chain: BridgeChain; wallet: string; tx_hash: string; event_index: number;
  raw_amount: string; amount_6: string; remainder: string; block: string; sender: string;
  classification: 'customer' | 'folio_gas' | 'self' | 'other'; covered_by: string | null;
  block_hash?: string;
}
export interface Sweep {
  id: string; chain: BridgeChain; wallet: string; person: string; trigger_event_id: string;
  amount_6: string; mint_recipient_bytes32: string; mint_recipient: string; destination_owner: string;
  created_at: string; state: SweepState; blocked_reason: string | null;
}
export interface Attempt {
  id: string; sweep_id: string; kind: 'gas_topup' | 'approve' | 'burn' | 'ata_create' | 'receive';
  chain: BridgeChain; request_id: string; tx_hash: string | null; nonce: string | null;
  state: AttemptState; gas_paid_raw: string; evidence_json: string;
  signed_raw?: string | null; sender?: string | null;
}
export interface Transfer {
  sweep_id: string; source_domain: number; burn_tx_hash: string; message_nonce: string | null;
  message_hash: string | null; attestation_state: 'pending' | 'complete'; destination_signature: string | null;
  settled_signature: string | null; state: SweepState; message: string | null; attestation: string | null;
  next_check_at: number; failures: number;
}
export interface ChainEvidence { kind: 'receipt' | 'nonce_consumed'; reference: string }
const edges: Record<SweepState, readonly SweepState[]> = {
  planned: ['approval_pending'], approval_pending: ['approved'], approved: ['burn_pending'],
  burn_pending: ['burn_uncertain', 'burn_confirmed', 'approved'],
  burn_uncertain: ['burn_confirmed', 'approved'], burn_confirmed: ['attested'],
  attested: ['delivery_submitted'], delivery_submitted: ['delivery_uncertain', 'settled'],
  delivery_uncertain: ['settled', 'attested'], settled: [], blocked: [],
};
export function legalTransition(from: SweepState, to: SweepState): boolean {
  return (to === 'blocked' && from !== 'settled' && from !== 'blocked') || edges[from].includes(to);
}
const integer = (value: string) => { if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('invalid raw integer'); return BigInt(value); };
const evidenceRequired = (e?: ChainEvidence) => { if (!e || !e.reference.trim()) throw new Error('chain evidence required'); };

/** Accept an existing SQLite handle to share transactions with person accounting, or a file. */
export function openTransferStore(file: string | DatabaseSync) {
  const db = typeof file === 'string' ? new DatabaseSync(file) : file;
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS bridge_deposit_event (
      id TEXT PRIMARY KEY, chain TEXT NOT NULL, wallet TEXT NOT NULL, tx_hash TEXT NOT NULL,
      event_index INTEGER NOT NULL, raw_amount TEXT NOT NULL, amount_6 TEXT NOT NULL, remainder TEXT NOT NULL,
      block TEXT NOT NULL, sender TEXT NOT NULL, classification TEXT NOT NULL, covered_by TEXT,
      UNIQUE(chain,tx_hash,event_index));
    CREATE TABLE IF NOT EXISTS bridge_sweep (
      id TEXT PRIMARY KEY, chain TEXT NOT NULL, wallet TEXT NOT NULL, person TEXT NOT NULL,
      trigger_event_id TEXT NOT NULL REFERENCES bridge_deposit_event(id), amount_6 TEXT NOT NULL,
      mint_recipient_bytes32 TEXT NOT NULL, mint_recipient TEXT NOT NULL, destination_owner TEXT NOT NULL,
      created_at TEXT NOT NULL, state TEXT NOT NULL, blocked_reason TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS bridge_one_uncertain_burn ON bridge_sweep(wallet,chain)
      WHERE state IN ('burn_pending','burn_uncertain');
    CREATE TABLE IF NOT EXISTS bridge_attempt (
      id TEXT PRIMARY KEY, sweep_id TEXT NOT NULL REFERENCES bridge_sweep(id), kind TEXT NOT NULL,
      chain TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, tx_hash TEXT, nonce TEXT, state TEXT NOT NULL,
      gas_paid_raw TEXT NOT NULL, evidence_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bridge_transfer (
      sweep_id TEXT PRIMARY KEY REFERENCES bridge_sweep(id), source_domain INTEGER NOT NULL,
      burn_tx_hash TEXT NOT NULL, message_nonce TEXT, message_hash TEXT, attestation_state TEXT NOT NULL,
      destination_signature TEXT, settled_signature TEXT, state TEXT NOT NULL, message TEXT, attestation TEXT,
      next_check_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
      UNIQUE(source_domain,message_nonce));
    CREATE TRIGGER IF NOT EXISTS bridge_pinned_fields BEFORE UPDATE ON bridge_sweep
      WHEN NEW.chain != OLD.chain OR NEW.wallet != OLD.wallet OR NEW.person != OLD.person
        OR NEW.trigger_event_id != OLD.trigger_event_id OR NEW.amount_6 != OLD.amount_6
        OR NEW.mint_recipient_bytes32 != OLD.mint_recipient_bytes32 OR NEW.mint_recipient != OLD.mint_recipient
        OR NEW.destination_owner != OLD.destination_owner OR NEW.created_at != OLD.created_at
      BEGIN SELECT RAISE(ABORT,'pinned fields immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bridge_pinned_burn BEFORE UPDATE ON bridge_transfer
      WHEN NEW.source_domain != OLD.source_domain OR NEW.burn_tx_hash != OLD.burn_tx_hash
        OR (OLD.message_nonce IS NOT NULL AND NEW.message_nonce IS NOT OLD.message_nonce)
        OR (OLD.message_hash IS NOT NULL AND NEW.message_hash IS NOT OLD.message_hash)
        OR (OLD.settled_signature IS NOT NULL AND NEW.settled_signature IS NOT OLD.settled_signature)
      BEGIN SELECT RAISE(ABORT,'burn identity immutable'); END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS bridge_observation_cursor(chain TEXT NOT NULL,wallet TEXT NOT NULL,block TEXT NOT NULL,PRIMARY KEY(chain,wallet));
    CREATE TABLE IF NOT EXISTS bridge_event_block(id TEXT PRIMARY KEY REFERENCES bridge_deposit_event(id),block_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bridge_gas_reservation(chain TEXT NOT NULL,wallet TEXT NOT NULL,snapshot TEXT NOT NULL,PRIMARY KEY(chain,wallet));
    CREATE TABLE IF NOT EXISTS bridge_chain_pause(chain TEXT PRIMARY KEY,paused INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bridge_wallet_assignment(chain TEXT NOT NULL,wallet TEXT NOT NULL,person TEXT NOT NULL,block TEXT NOT NULL,PRIMARY KEY(chain,wallet));
    CREATE TABLE IF NOT EXISTS bridge_source_lease(name TEXT PRIMARY KEY,holder TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS bridge_credit_completion(sweep_id TEXT PRIMARY KEY REFERENCES bridge_sweep(id), evidence_json TEXT NOT NULL, acknowledged_at INTEGER);
    CREATE TABLE IF NOT EXISTS bridge_destination_lease(name TEXT PRIMARY KEY,holder TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bridge_transfer_hold(sweep_id TEXT PRIMARY KEY,prior_state TEXT NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bridge_retry_allowance(record_id TEXT NOT NULL,phase TEXT NOT NULL,failed_baseline INTEGER NOT NULL,PRIMARY KEY(record_id,phase));
    CREATE TABLE IF NOT EXISTS bridge_transfer_resume(id TEXT PRIMARY KEY,sweep_id TEXT NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL);`);
  // Existing attempts deliberately remain NULL: they require operator recovery without signed bytes.
  for (const column of ['signed_raw', 'sender']) {
    if (!(db.prepare('PRAGMA table_info(bridge_attempt)').all() as {name:string}[]).some(c=>c.name===column))
      db.exec(`ALTER TABLE bridge_attempt ADD COLUMN ${column} TEXT`);
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS bridge_signed_identity BEFORE UPDATE ON bridge_attempt
    WHEN (OLD.signed_raw IS NOT NULL AND NEW.signed_raw IS NOT OLD.signed_raw)
      OR (OLD.sender IS NOT NULL AND NEW.sender IS NOT OLD.sender)
      OR (OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS NOT OLD.tx_hash)
      OR NEW.nonce IS NOT OLD.nonce
    BEGIN SELECT RAISE(ABORT,'signed transaction immutable'); END;`);
  let depth = 0;
  const committedEvents: (() => void)[][] = [];
  const afterCommit = (emit: () => void) => { const pending = committedEvents.at(-1); if (pending) pending.push(emit); else emit(); };
  function atomic<T>(fn: () => T): T {
    const nested = depth > 0, name = `bridge_atomic_${depth}`;
    db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
    depth++;
    committedEvents.push([]);
    let committed = false;
    try { const result = fn(); db.exec(nested ? `RELEASE ${name}` : 'COMMIT'); committed = true; return result; }
    catch (error) { logError('bridge_store_transition', { operation: 'rollback', ...errorFields(error) });  db.exec(nested ? `ROLLBACK TO ${name}` : 'ROLLBACK'); if (nested) db.exec(`RELEASE ${name}`); throw error; }
    finally { depth--; const events = committedEvents.pop()!; if (committed) for (const emit of events) afterCommit(emit); }
  }
  const getSweep = (id: string) => db.prepare('SELECT * FROM bridge_sweep WHERE id=?').get(id) as unknown as Sweep | undefined;
  const getTransfer = (id: string) => db.prepare('SELECT * FROM bridge_transfer WHERE sweep_id=?').get(id) as unknown as Transfer | undefined;
  function transition(id: string, to: SweepState, proof?: ChainEvidence, reason?: string) {
    return atomic(() => {
      const row = getSweep(id); if (!row) throw new Error('sweep missing');
      if (to === 'burn_pending' && db.prepare("SELECT 1 FROM bridge_sweep WHERE wallet=? AND chain=? AND id<>? AND state IN ('burn_pending','burn_uncertain','blocked')").get(row.wallet,row.chain,id)) throw new Error('unresolved burn or hold blocks signing');
      if (!legalTransition(row.state, to)) { logError('bridge_store_transition',{sweep_id:id.slice(0,12),operation:'illegal_transition',state_from:row.state,state_to:to,reason:'ILLEGAL_TRANSITION'}); throw new Error(`illegal transition ${row.state} -> ${to}`); }
      if (row.state === 'burn_uncertain' || to === 'burn_confirmed' || to === 'settled' || (row.state === 'delivery_uncertain' && to === 'attested')) evidenceRequired(proof);
      if (to === 'approved' && ['burn_pending', 'burn_uncertain'].includes(row.state)) {
        evidenceRequired(proof);
        if (!db.prepare("SELECT 1 FROM bridge_attempt WHERE sweep_id=? AND kind='burn' AND state='failed'").get(id)) throw new Error('failed burn attempt required');
      }
      if (to === 'attested') { const t = getTransfer(id); if (!t || t.attestation_state !== 'complete' || !t.message || !t.attestation || !t.message_nonce || !t.message_hash) throw new Error('validated attestation required'); }
      if (to === 'delivery_submitted' && !getTransfer(id)?.destination_signature) throw new Error('durable destination signature required');
      if (to === 'settled' && !getTransfer(id)?.settled_signature) throw new Error('finalized destination signature required');
      if (to === 'blocked' && !reason?.trim()) throw new Error('hold reason required');
      db.prepare('UPDATE bridge_sweep SET state=?,blocked_reason=? WHERE id=?').run(to, reason ?? null, id);
      db.prepare('UPDATE bridge_transfer SET state=? WHERE sweep_id=?').run(to, id);
      afterCommit(() => logInfo('bridge_transition', { sweep: id.slice(0, 8), from: row.state, to, proof_kind: proof?.kind, proof_ref12: proof?.reference.slice(0, 12), reason: reason ? reasonCode(reason) : undefined }));
      return getSweep(id)!;
    });
  }
  return {
    db, atomic, afterCommit, getSweep, getTransfer, transition,
    failedAttempts(id:string,phase:string) {
      const count=Number(db.prepare("SELECT count(*) AS n FROM bridge_attempt WHERE sweep_id=? AND kind=? AND state='failed'").get(id,phase)?.n??0);
      const baseline=Number(db.prepare('SELECT failed_baseline FROM bridge_retry_allowance WHERE record_id=? AND phase=?').get(id,phase)?.failed_baseline??0);
      return count-baseline;
    },
    saveReceipt(id: string, evidence: unknown) {
      const json=JSON.stringify(evidence),prior=db.prepare('SELECT evidence_json FROM bridge_credit_completion WHERE sweep_id=?').get(id);
      if(prior && prior.evidence_json!==json)throw new Error('VERIFIED_RECEIPT_CHANGED');
      const changed=db.prepare('INSERT OR IGNORE INTO bridge_credit_completion(sweep_id,evidence_json) VALUES (?,?)').run(id,json).changes;
      afterCommit(()=>logInfo('bridge_store_transition',{sweep_id:id.slice(0,12),operation:'receipt',deduped:!changed,rows_changed:Number(changed)}));
    },
    receipt(id: string) { const row=db.prepare('SELECT evidence_json FROM bridge_credit_completion WHERE sweep_id=?').get(id);return row?JSON.parse(String(row.evidence_json)):undefined; },
    acknowledged(id:string) { return !!db.prepare('SELECT 1 FROM bridge_credit_completion WHERE sweep_id=? AND acknowledged_at IS NOT NULL').get(id); },
    acknowledge(id: string, at: number) {
      if(getTransfer(id)?.state!=='settled')throw new Error('SETTLED_CREDIT_REQUIRED');
      if(!db.prepare('UPDATE bridge_credit_completion SET acknowledged_at=? WHERE sweep_id=?').run(at,id).changes)throw new Error('VERIFIED_RECEIPT_REQUIRED');
      afterCommit(()=>logInfo('bridge_store_transition',{sweep_id:id.slice(0,12),operation:'credit_ack',credit_acknowledged:true}));
    },
    hold(id: string, reason: string, at: number) {
      atomic(()=>{const row=getSweep(id);if(!row || row.state==='blocked')return;
        db.prepare('INSERT OR REPLACE INTO bridge_transfer_hold VALUES (?,?,?,?)').run(id,row.state,reason,at);
        afterCommit(() => logError('bridge_hold', { sweep: id.slice(0, 8), reason: reasonCode(reason), prior_state: row.state }));
        if(row.state==='settled') { db.prepare('UPDATE bridge_transfer SET next_check_at=? WHERE sweep_id=?').run(Number.MAX_SAFE_INTEGER,id);return; }
        transition(id,'blocked',undefined,reason);
      });
    },
    resume(id: string, person: string, reason: string, at: number) {
      if(!reason.trim())throw new Error('REPAIR_REASON_REQUIRED');
      atomic(()=>{const row=getSweep(id),held=db.prepare('SELECT * FROM bridge_transfer_hold WHERE sweep_id=?').get(id);
        if(!row || row.person!==person || !held)throw new Error('REPAIR_FORBIDDEN');
        db.prepare('INSERT INTO bridge_transfer_resume VALUES (?,?,?,?)').run(randomUUID(),id,reason,at);
        db.prepare('UPDATE bridge_sweep SET state=?,blocked_reason=NULL WHERE id=?').run(held.prior_state!,id);
        db.prepare('UPDATE bridge_transfer SET state=?,next_check_at=?,failures=0 WHERE sweep_id=?').run(held.prior_state!,at,id);
        for(const phase of ['approve','burn','gas_topup','receive']){const count=db.prepare("SELECT count(*) AS n FROM bridge_attempt WHERE sweep_id=? AND kind=? AND state='failed'").get(id,phase)!.n;db.prepare('INSERT OR REPLACE INTO bridge_retry_allowance VALUES (?,?,?)').run(id,phase,count!);}
        db.prepare('DELETE FROM bridge_transfer_hold WHERE sweep_id=?').run(id);
        afterCommit(()=>logInfo('bridge_store_transition',{sweep_id:id.slice(0,12),operation:'repair',state_from:row.state,state_to:held.prior_state,reason:'operator_repair'}));
      });
    },
    close: () => { if (typeof file === 'string') db.close(); },
    addEvent(event: DepositEvent) {
      integer(event.raw_amount); integer(event.amount_6); integer(event.remainder);
      if (!Number.isSafeInteger(event.event_index) || event.event_index < 0) throw new Error('invalid event index');
      const prior = db.prepare('SELECT * FROM bridge_deposit_event WHERE chain=? AND tx_hash=? AND event_index=?').get(event.chain,event.tx_hash,event.event_index) as unknown as DepositEvent | undefined;
      if (prior && (['wallet','raw_amount','amount_6','remainder','sender','classification','block'] as const).some(key => prior[key] !== event[key])) throw new Error('conflicting canonical deposit event');
      db.prepare('INSERT INTO bridge_deposit_event VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chain,tx_hash,event_index) DO NOTHING')
        .run(event.id,event.chain,event.wallet,event.tx_hash,event.event_index,event.raw_amount,event.amount_6,event.remainder,event.block,event.sender,event.classification,event.covered_by);
      if (event.block_hash) {
        const old = db.prepare('SELECT block_hash FROM bridge_event_block WHERE id=?').get(event.id);
        if (old && old.block_hash !== event.block_hash) throw new Error('CANONICAL_EVENT_CHANGED');
        db.prepare('INSERT OR IGNORE INTO bridge_event_block VALUES (?,?)').run(event.id,event.block_hash);
      }
      afterCommit(()=>logDebug('bridge_store_transition',{chain:event.chain,operation:'deposit_event',deduped:!!prior,rows_changed:prior?0:1}));
    },
    plan(sweep: Omit<Sweep, 'state' | 'blocked_reason'>) {
      return atomic(() => {
      integer(sweep.amount_6); if (BigInt(sweep.amount_6) === 0n) throw new Error('empty sweep');
      if (!/^0x[\da-f]{64}$/i.test(sweep.mint_recipient_bytes32)) throw new Error('invalid recipient bytes32');
      const trigger = db.prepare('SELECT * FROM bridge_deposit_event WHERE id=?').get(sweep.trigger_event_id) as unknown as DepositEvent | undefined;
      if (!trigger || trigger.chain !== sweep.chain || trigger.wallet !== sweep.wallet || trigger.classification !== 'customer' || trigger.covered_by) throw new Error('invalid sweep trigger');
      if (db.prepare("SELECT 1 FROM bridge_sweep WHERE wallet=? AND chain=? AND state IN ('burn_pending','burn_uncertain','blocked')").get(sweep.wallet,sweep.chain)) throw new Error('unresolved burn blocks new sweep');
      db.prepare('INSERT INTO bridge_sweep VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)').run(sweep.id,sweep.chain,sweep.wallet,sweep.person,sweep.trigger_event_id,sweep.amount_6,sweep.mint_recipient_bytes32,sweep.mint_recipient,sweep.destination_owner,sweep.created_at,'planned');
      afterCommit(()=>logInfo('bridge_store_transition',{chain:sweep.chain,sweep_id:sweep.id.slice(0,12),operation:'plan',state_to:'planned'}));
      return getSweep(sweep.id)!;
      });
    },
    cover(eventId: string, sweepId: string) {
      const row = db.prepare('SELECT * FROM bridge_deposit_event WHERE id=?').get(eventId) as unknown as DepositEvent | undefined;
      const sweep = getSweep(sweepId);
      if (!row || !sweep || row.chain !== sweep.chain || row.wallet !== sweep.wallet || row.classification !== 'customer' || (row.covered_by && row.covered_by !== sweepId)) throw new Error('invalid coverage');
      db.prepare('UPDATE bridge_deposit_event SET covered_by=? WHERE id=?').run(sweepId,eventId);
      afterCommit(()=>logInfo('bridge_store_transition',{sweep_id:sweepId.slice(0,12),operation:'cover',deduped:row.covered_by===sweepId}));
    },
    addAttempt(attempt: Attempt) {
      integer(attempt.gas_paid_raw); JSON.parse(attempt.evidence_json);
      if (!getSweep(attempt.sweep_id)) throw new Error('sweep missing');
      db.prepare('INSERT INTO bridge_attempt (id,sweep_id,kind,chain,request_id,tx_hash,nonce,state,gas_paid_raw,evidence_json,signed_raw,sender) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(attempt.id,attempt.sweep_id,attempt.kind,attempt.chain,attempt.request_id,attempt.tx_hash,attempt.nonce,attempt.state,attempt.gas_paid_raw,attempt.evidence_json,attempt.signed_raw??null,attempt.sender??null);
      afterCommit(() => logInfo('bridge_attempt', { sweep: attempt.sweep_id.slice(0,8), attempt: attempt.id.slice(0,12), kind: attempt.kind, from: null, to: attempt.state, gas_paid_raw: attempt.gas_paid_raw, tx12: attempt.tx_hash?.slice(0,12), signer: ['receive','gas_topup'].includes(attempt.kind) ? 'folio' : 'person' }));
    },
    updateAttempt(id: string, state: AttemptState, gasPaidRaw: string, evidence: unknown, txHash?: string) {
      integer(gasPaidRaw);
      const row = db.prepare('SELECT * FROM bridge_attempt WHERE id=?').get(id) as unknown as Attempt | undefined;
      const allowed: Record<AttemptState, AttemptState[]> = { prepared:['prepared_dry_run','signed','submitted','failed'], prepared_dry_run:[], signed:['submitted','uncertain','failed'], submitted:['confirmed','uncertain','failed'], uncertain:['confirmed','failed'], confirmed:[], failed:[] };
      if (!row || !allowed[row.state].includes(state)) throw new Error('illegal attempt transition');
      if (row.tx_hash && txHash && row.tx_hash !== txHash) throw new Error('transaction identity immutable');
      db.prepare('UPDATE bridge_attempt SET state=?,gas_paid_raw=?,evidence_json=?,tx_hash=COALESCE(tx_hash,?) WHERE id=?').run(state,gasPaidRaw,JSON.stringify(evidence),txHash ?? null,id);
      afterCommit(() => logInfo('bridge_attempt', { sweep: row.sweep_id.slice(0,8), attempt: id.slice(0,12), kind: row.kind, from: row.state, to: state, gas_paid_raw: gasPaidRaw, tx12: (txHash ?? row.tx_hash)?.slice(0,12), signer: ['receive','gas_topup'].includes(row.kind) ? 'folio' : 'person' }));
    },
    addTransfer(input: Pick<Transfer, 'sweep_id' | 'source_domain' | 'burn_tx_hash'>) {
      const sweep = getSweep(input.sweep_id); if (!sweep || sweep.state !== 'burn_confirmed') throw new Error('confirmed burn required');
      db.prepare("INSERT INTO bridge_transfer(sweep_id,source_domain,burn_tx_hash,attestation_state,state) VALUES (?,?,?,'pending',?)").run(input.sweep_id,input.source_domain,input.burn_tx_hash,sweep.state);
      afterCommit(()=>logInfo('bridge_store_transition',{sweep_id:input.sweep_id.slice(0,12),operation:'transfer',state_to:sweep.state}));
    },
    saveAttestation(id: string, data: { message_nonce: string; message_hash: string; message: string; attestation: string }) {
      db.prepare("UPDATE bridge_transfer SET message_nonce=?,message_hash=?,message=?,attestation=?,attestation_state='complete' WHERE sweep_id=? AND state='burn_confirmed'").run(data.message_nonce,data.message_hash,data.message,data.attestation,id);
      afterCommit(()=>logInfo('bridge_store_transition',{sweep_id:id.slice(0,12),operation:'attestation',evidence_ref:data.message_hash.slice(0,12)}));
    },
    schedule(id: string, nextCheckAt: number, failures: number) {
      db.prepare('UPDATE bridge_transfer SET next_check_at=?,failures=? WHERE sweep_id=?').run(nextCheckAt,failures,id);
      afterCommit(()=>logDebug('bridge_store_transition',{sweep_id:id.slice(0,12),operation:'schedule',next_retry_at:nextCheckAt,failures}));
    },
    destination(id: string, signature: string, finalized = false) {
      if (!signature.trim()) throw new Error('signature required');
      db.prepare(`UPDATE bridge_transfer SET destination_signature=?,settled_signature=CASE WHEN ? THEN ? ELSE settled_signature END WHERE sweep_id=? AND state != 'settled'`).run(signature,finalized ? 1 : 0,signature,id);
      afterCommit(()=>logInfo('bridge_store_transition',{sweep_id:id.slice(0,12),operation:'destination',evidence_ref:signature.slice(0,12),finalized}));
    },
    attempts(sweepId: string): Attempt[] { return db.prepare('SELECT * FROM bridge_attempt WHERE sweep_id=? ORDER BY rowid').all(sweepId) as unknown as Attempt[]; },
    due(at: number): Transfer[] {
      return db.prepare("SELECT * FROM bridge_transfer WHERE next_check_at<=? AND state!='blocked' AND NOT EXISTS (SELECT 1 FROM bridge_credit_completion c WHERE c.sweep_id=bridge_transfer.sweep_id AND c.acknowledged_at IS NOT NULL) ORDER BY next_check_at,sweep_id").all(at) as unknown as Transfer[];
    },
    gasLedger(wallet: string, chain: BridgeChain) {
      const sum = (rows: { value: string }[]) => rows.reduce((n,r) => n + integer(r.value),0n);
      const incoming = sum(db.prepare("SELECT raw_amount AS value FROM bridge_deposit_event WHERE wallet=? AND chain=? AND classification='customer'").all(wallet,chain) as {value:string}[]);
      const scale = chain === 'arc' ? 10n ** 12n : 1n;
      const swept = sum(db.prepare("SELECT amount_6 AS value FROM bridge_sweep WHERE wallet=? AND chain=? AND (state IN ('burn_confirmed','attested','delivery_submitted','delivery_uncertain','settled') OR EXISTS (SELECT 1 FROM bridge_transfer t WHERE t.sweep_id=bridge_sweep.id) OR EXISTS (SELECT 1 FROM bridge_attempt a WHERE a.sweep_id=bridge_sweep.id AND a.kind='burn' AND a.state='confirmed'))").all(wallet,chain) as {value:string}[]) * scale;
      const attempts = db.prepare('SELECT a.* FROM bridge_attempt a JOIN bridge_sweep s ON s.id=a.sweep_id WHERE s.wallet=? AND a.chain=?').all(wallet,chain) as unknown as Attempt[];
      const charged = attempts.reduce((n,a) => n + integer(a.gas_paid_raw),0n);
      const contribution = attempts.filter(a => a.kind === 'gas_topup' && a.state === 'confirmed').reduce((n,a) => {
        const evidence = JSON.parse(a.evidence_json) as { contribution_raw?: string }; return n + integer(evidence.contribution_raw ?? '0');
      },0n);
      return { customer_principal: incoming-swept, folio_contribution: contribution, gas_charged: charged, folio_residual: contribution-charged };
    },
    requireGas(wallet: string, chain: BridgeChain, maxGasRaw: string) {
      if (this.gasLedger(wallet,chain).folio_residual < integer(maxGasRaw)) throw new Error('Folio top-up required before signing');
    },
  };
}
export type TransferStore = ReturnType<typeof openTransferStore>;

/** Source coordinator over the same entities/API as destination reconciliation. */
export class SourceStore {
  readonly shared: TransferStore;
  get db() { return this.shared.db; }
  constructor(path: string | DatabaseSync = ':memory:') { this.shared = openTransferStore(path); }
  assignment(chain: SourceChain, wallet: string, person: string, block: bigint): bigint {
    const old = this.db.prepare('SELECT * FROM bridge_wallet_assignment WHERE chain=? AND wallet=?').get(chain,wallet.toLowerCase());
    if (old && old.person !== person) throw new Error('SOURCE_WALLET_OWNER_CHANGED');
    if (!old) this.db.prepare('INSERT INTO bridge_wallet_assignment VALUES (?,?,?,?)').run(chain,wallet.toLowerCase(),person,String(block));
    return BigInt(old?.block as string ?? String(block));
  }
  close() { this.shared.close(); }
  transaction<T>(fn: () => T): T { return this.shared.atomic(fn); }
  saveLedger(chain: BridgeChain, wallet: string, snapshot: string) {
    const prior=this.readLedger(chain,wallet);
    this.db.prepare('INSERT OR REPLACE INTO bridge_gas_reservation VALUES (?,?,?)').run(chain,wallet.toLowerCase(),snapshot);
    // Diagnose committed snapshots without making logging another validation gate.
    try {
      if(chain!=='base' && chain!=='arc')return;
      const ledger=new GasLedger(chain),before=new GasLedger(chain);ledger.restore(snapshot);if(prior)before.restore(prior);
      const fields={chain,operation:'gas_ledger',principal_delta_raw:String(ledger.customerPrincipal-before.customerPrincipal),gas_paid_raw:String(ledger.gasCharged),gas_reserved_raw:String([...ledger.reservations.values()].reduce((a,b)=>a+b,0n))};
      this.shared.afterCommit(()=>logDebug('bridge_source_transition',fields));
    } catch { this.shared.afterCommit(()=>logDebug('bridge_source_transition',{chain,operation:'gas_ledger',reason:'diagnostic_unavailable'})); }
  }
  readLedger(chain: BridgeChain, wallet: string): string | undefined {
    return this.db.prepare('SELECT snapshot FROM bridge_gas_reservation WHERE chain=? AND wallet=?').get(chain,wallet.toLowerCase())?.snapshot as string | undefined;
  }
  pause(chain: SourceChain, paused: boolean) { this.db.prepare('INSERT OR REPLACE INTO bridge_chain_pause VALUES (?,?)').run(chain,paused ? 1 : 0); }
  paused(chain: BridgeChain) { return !!this.db.prepare('SELECT paused FROM bridge_chain_pause WHERE chain=?').get(chain)?.paused; }
  cursor(chain: SourceChain, wallet: string): bigint | undefined {
    const block = this.db.prepare('SELECT block FROM bridge_observation_cursor WHERE chain=? AND wallet=?').get(chain,wallet.toLowerCase())?.block;
    return block === undefined ? undefined : BigInt(block as string);
  }
  events(chain: SourceChain, wallet: string): DepositEvent[] {
    return (this.db.prepare('SELECT e.*,b.block_hash FROM bridge_deposit_event e LEFT JOIN bridge_event_block b ON b.id=e.id WHERE e.chain=? AND e.wallet=?').all(chain,wallet.toLowerCase()) as unknown as DepositEvent[])
      .sort((a,b) => BigInt(a.block)<BigInt(b.block) ? -1 : BigInt(a.block)>BigInt(b.block) ? 1 : a.event_index-b.event_index);
  }
  sweeps(chain: SourceChain, wallet: string): Sweep[] { return this.db.prepare('SELECT * FROM bridge_sweep WHERE chain=? AND wallet=?').all(chain,wallet.toLowerCase()) as unknown as Sweep[]; }
  sweep(id: string): Sweep { const s = this.shared.getSweep(id); if (!s) throw new Error('SWEEP_NOT_FOUND'); return s; }
  attempt(id: string): Attempt | undefined { return this.db.prepare('SELECT * FROM bridge_attempt WHERE id=?').get(id) as unknown as Attempt | undefined; }
  attempts(id: string) { return this.shared.attempts(id); }
  putAttempt(a: Attempt) {
    const old = this.attempt(a.id);
    if (!old) { this.shared.addAttempt(a); return; }
    if (old.sweep_id!==a.sweep_id || old.chain!==a.chain || old.kind!==a.kind || old.request_id!==a.request_id || old.nonce!==a.nonce || (old.tx_hash && old.tx_hash!==a.tx_hash)) throw new Error('ATTEMPT_BINDING_CHANGED');
    this.shared.updateAttempt(a.id,a.state,a.gas_paid_raw,JSON.parse(a.evidence_json),a.tx_hash ?? undefined);
  }
  persistSigned(id: string, bytes: Hex, hash: Hex, sender: string) {
    if (!this.db.prepare("UPDATE bridge_attempt SET signed_raw=?,tx_hash=?,sender=? WHERE id=? AND state='prepared' AND nonce IS NOT NULL")
      .run(bytes,hash,sender.toLowerCase(),id).changes) throw new Error('SOURCE_ATTEMPT_BLOCKED');
  }
  setState(id: string, expected: SweepState, next: SweepState, proof?: ChainEvidence) {
    if (this.sweep(id).state!==expected) throw new Error('SWEEP_STATE_CONFLICT');
    if (expected==='approval_pending' && next==='planned') {
      if (!proof?.reference.trim() || !this.attempts(id).some(a=>a.kind==='approve' && a.state==='failed' && a.tx_hash===proof.reference)) throw new Error('failed approval receipt required');
      this.db.prepare("UPDATE bridge_sweep SET state='planned' WHERE id=? AND state='approval_pending'").run(id);
      this.shared.afterCommit(() => logInfo('bridge_transition', { sweep: id.slice(0,8), from: expected, to: next, proof_kind: proof.kind, proof_ref12: proof.reference.slice(0,12) })); return;
    }
    this.shared.transition(id,next,proof);
  }
  topupMatches(chain: SourceChain, wallet: string): TopupMatch[] {
    return (this.db.prepare("SELECT a.* FROM bridge_attempt a JOIN bridge_sweep s ON s.id=a.sweep_id WHERE s.wallet=? AND a.chain=? AND a.kind='gas_topup' AND a.state IN ('submitted','uncertain','confirmed')").all(wallet.toLowerCase(),chain) as unknown as Attempt[]).flatMap(a=>{
      const e=JSON.parse(a.evidence_json);
      if (!a.tx_hash || e.wallet?.toLowerCase()!==wallet.toLowerCase() || !e.from || !e.rawAmount) return [];
      // Receipt validation in observe confirms this exact transaction before classification.
      return [{attemptId:a.id,txHash:a.tx_hash as Hex,chain,wallet,from:e.from,rawAmount:BigInt(e.rawAmount),confirmed:true}];
    });
  }
  ingest(chain: SourceChain, wallet: string, block: bigint, events: readonly DepositEvent[], confirmTopups = true) {
    this.transaction(()=>{
      const ledger=new GasLedger(chain),saved=this.readLedger(chain,wallet); if (saved) ledger.restore(saved);
      for (const e of events) {
        const normal=normalise(BigInt(e.raw_amount),chain==='arc'?18:6);
        if (normal.amount!==BigInt(e.amount_6) || normal.remainder!==BigInt(e.remainder) || BigInt(e.raw_amount)<=0n) throw new Error('EVENT_AMOUNT_INVALID');
        if (e.chain!==chain || e.wallet.toLowerCase()!==wallet.toLowerCase() || BigInt(e.block)>block) throw new Error('EVENT_SCOPE_MISMATCH');
        const existed=this.db.prepare('SELECT id FROM bridge_deposit_event WHERE chain=? AND tx_hash=? AND event_index=?').get(chain,e.tx_hash,e.event_index);
        this.shared.addEvent(e);
        if (!existed && e.classification==='customer') ledger.observeCustomer(e.id,BigInt(e.raw_amount));
        if (confirmTopups && !existed && e.classification==='folio_gas' && chain==='arc') {
          const match=this.topupMatches(chain,wallet).find(t=>t.txHash===e.tx_hash && t.rawAmount===BigInt(e.raw_amount) && t.from.toLowerCase()===e.sender.toLowerCase());
          if (match) {
            ledger.confirmTopup({attemptId:match.attemptId,txHash:e.tx_hash as Hex,contribution:BigInt(e.raw_amount)});
            const a=this.attempt(match.attemptId)!;
            if (a.state!=='confirmed') this.putAttempt({...a,state:'confirmed',evidence_json:JSON.stringify({...JSON.parse(a.evidence_json),contribution_raw:e.raw_amount})});
          }
        }
      }
      this.saveLedger(chain,wallet,ledger.snapshot());
      if (block>=(this.cursor(chain,wallet)??-1n)) this.db.prepare('INSERT OR REPLACE INTO bridge_observation_cursor VALUES (?,?,?)').run(chain,wallet.toLowerCase(),String(block));
    });
  }
  plan(r: SourceRoute, wallet: string, person: string, d: Destination, createdAt: string, cap=100_000000n): Sweep | undefined {
    return this.transaction(()=>{
      if (this.paused(r.chain) || this.sweeps(r.chain,wallet).some(s=>s.state!=='settled')) return;
      const events=this.events(r.chain,wallet).filter(e=>e.classification==='customer'),uncovered=events.filter(e=>!e.covered_by);
      const trigger=uncovered.find(e=>qualifies(BigInt(e.raw_amount),r)); if (!trigger) return;
      const scale=r.eventDecimals===18 ? 10n**12n : 1n;
      const raw=events.reduce((n,e)=>n+BigInt(e.raw_amount),0n)-this.sweeps(r.chain,wallet).reduce((n,s)=>n+BigInt(s.amount_6)*scale,0n);
      const amount=normalise(raw,r.eventDecimals).amount;
      if(amount>cap)throw new Error('FULL_SWEEP_EXCEEDS_CAP');
      if (amount<=0n) throw new Error('CUSTOMER_PRINCIPAL_SHORT');
      const s=this.shared.plan({id:randomUUID(),chain:r.chain,wallet:wallet.toLowerCase(),person,trigger_event_id:trigger.id,amount_6:String(amount),mint_recipient_bytes32:d.bytes32,mint_recipient:d.ata,destination_owner:d.owner,created_at:createdAt});
      for (const e of uncovered) this.shared.cover(e.id,s.id);
      return s;
    });
  }
}
