import { reasonCode, personPrefix } from '../shims/log-fields.js';
import { logInfo, logDebug } from '../shims/log.js';
import { randomUUID } from 'node:crypto';
import type { SourceStore } from './transfer-record.js';
import type { SourceChain } from './source-registry.js';
export const CHECKING_WINDOW_MS = 86_400_000;
export const sourceInterval = (chain: string) => chain === 'base' ? 15_000 : 5_000;
/** A waiting intent whose deposits are all below the minimum is read on this slower cadence until a
 * qualifying deposit arrives or its checking window ends. */
export const BELOW_MINIMUM_INTERVAL_MS = 60_000;
/** The watch schedule after a signal (or Check again), by time since [DepositIntent.watch_started_at]:
 * the chain's own rate for 15 minutes, every 2 minutes until the first hour, then every 10 minutes
 * until checking ends at 24 hours. A signal or Check again restarts phase 1 from that moment. */
export const WATCH_PHASES: readonly {until_ms: number; interval_ms: number|null}[] = [
  {until_ms: 15 * 60_000, interval_ms: null}, // null: sourceInterval(chain), Base 15 s, Arc 5 s
  {until_ms: 60 * 60_000, interval_ms: 2 * 60_000},
  {until_ms: Infinity, interval_ms: 10 * 60_000},
];
/** The read interval for a watch started at [watchStartedAt] (null: not started, the chain's rate). */
export function watchInterval(watchStartedAt: number|null, now: number, chain: string) {
  const elapsed = watchStartedAt === null ? 0 : Math.max(0, now - watchStartedAt);
  return WATCH_PHASES.find(p => elapsed < p.until_ms)!.interval_ms ?? sourceInterval(chain);
}
/** When an intent read at [now] is read next. Pure: no clock, no storage. */
export const nextCheckAt = (watchStartedAt: number|null, now: number, chain: string) => now + watchInterval(watchStartedAt, now, chain);
const OPEN_STATES = ['preparing','waiting','funded'];
/** What a person did with the deposit address that starts its watch. */
export const WATCH_SIGNALS = ['reveal','copy','open_wallet'] as const;
export type WatchSignal = typeof WATCH_SIGNALS[number];
export type WatchOutcome = 'started'|'renewed'|'restarted'|'none';
/** Holds a new verified consent clears: configuration or attachment (SOURCE_SIGNER_*) and every
 * permission hold of the signing path (permissions/types.ts PERMISSION_HOLD_CODES). */
export const PERMISSION_RELEASE_HOLDS = ['PERMISSION_REQUIRED','POLICY_DRIFT','POLICY_OWNER_MISMATCH','POLICY_READ_UNAVAILABLE'] as const;
const SIGNER_HOLD_SQL = (column: string) => `(substr(${column},1,14)='SOURCE_SIGNER_' OR ${column} IN (${PERMISSION_RELEASE_HOLDS.map(code=>`'${code}'`).join(',')}))`;
export interface DepositIntent {
  id: string; person: string; chain: SourceChain; wallet: string; owner: string;
  state: 'preparing'|'waiting'|'funded'|'held'|'ended'|'complete';
  created_at: number; expires_at: number; next_check_at: number; failures: number;
  last_verified_at: number|null; boundary: string|null; readiness: string|null; hold_reason: string|null; recovery_tx: string|null;
  /** When the scheduled balance reads began. Null while the address was handed out without a signal:
   * readiness still runs once, but a waiting intent is not read until it is armed. */
  watch_started_at: number|null;
}
/** All public reads are local. Creating an intent never performs an RPC. */
export class DepositIntents {
  constructor(readonly store: SourceStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS bridge_deposit_intent (
      id TEXT PRIMARY KEY,person TEXT NOT NULL,chain TEXT NOT NULL,wallet TEXT NOT NULL,owner TEXT NOT NULL,
      state TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,next_check_at INTEGER NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0,boundary TEXT,readiness TEXT,hold_reason TEXT,recovery_tx TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS bridge_one_active_intent ON bridge_deposit_intent(person,chain)
        WHERE state IN ('preparing','waiting','funded');
      CREATE TABLE IF NOT EXISTS bridge_intent_event(event_id TEXT PRIMARY KEY,intent_id TEXT NOT NULL REFERENCES bridge_deposit_intent(id));
      CREATE TABLE IF NOT EXISTS bridge_intent_sweep(sweep_id TEXT PRIMARY KEY,intent_id TEXT NOT NULL REFERENCES bridge_deposit_intent(id));
      CREATE TABLE IF NOT EXISTS bridge_setup_attempt(id TEXT PRIMARY KEY,intent_id TEXT NOT NULL REFERENCES bridge_deposit_intent(id),
        signature TEXT NOT NULL UNIQUE,state TEXT NOT NULL,evidence_json TEXT NOT NULL,cost_raw TEXT NOT NULL DEFAULT '0');
      CREATE TABLE IF NOT EXISTS bridge_repair_audit(id TEXT PRIMARY KEY,record_id TEXT NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bridge_work_clock(id TEXT PRIMARY KEY,next_check_at INTEGER NOT NULL,failures INTEGER NOT NULL DEFAULT 0);`);
    if (!(store.db.prepare('PRAGMA table_info(bridge_deposit_intent)').all() as {name:string}[]).some(c=>c.name==='last_verified_at'))
      store.db.exec('ALTER TABLE bridge_deposit_intent ADD COLUMN last_verified_at INTEGER');
    if (!(store.db.prepare('PRAGMA table_info(bridge_deposit_intent)').all() as {name:string}[]).some(c=>c.name==='watch_started_at'))
      // Every intent created before this column was watched from creation; the backfill keeps those
      // watches running (and lets a held one resume watched). Same step, so no row is ever left unarmed.
      store.transaction(()=>{
        store.db.exec('ALTER TABLE bridge_deposit_intent ADD COLUMN watch_started_at INTEGER');
        store.db.exec('UPDATE bridge_deposit_intent SET watch_started_at=created_at');
      });
  }
  /** Local, idempotent import of receipts created before deposit intents existed. */
  restoreReceipts() {
    this.store.transaction(()=>{
      const rows=this.store.db.prepare(`SELECT s.*,c.acknowledged_at FROM bridge_sweep s
        JOIN bridge_credit_completion c ON c.sweep_id=s.id
        LEFT JOIN bridge_intent_sweep x ON x.sweep_id=s.id
        WHERE s.chain IN ('base','arc') AND s.state='settled' AND c.acknowledged_at IS NOT NULL AND x.sweep_id IS NULL`).all();
      for(const row of rows) {
        const id=`legacy:${row.id}`,at=Date.parse(String(row.created_at));
        this.store.db.prepare(`INSERT OR IGNORE INTO bridge_deposit_intent
          (id,person,chain,wallet,owner,state,created_at,expires_at,next_check_at)
          VALUES (?,?,?,?,?,'complete',?,?,0)`).run(id,String(row.person),String(row.chain),String(row.wallet),String(row.destination_owner),
            Number.isFinite(at)?at:Number(row.acknowledged_at),Number(row.acknowledged_at));
        this.store.db.prepare('INSERT OR IGNORE INTO bridge_intent_sweep VALUES (?,?)').run(String(row.id),id);
        this.store.db.prepare(`INSERT OR IGNORE INTO bridge_intent_event SELECT id,? FROM bridge_deposit_event
          WHERE covered_by=? OR id=?`).run(id,String(row.id),String(row.trigger_event_id));
      }
    });
  }
  get(id: string) { return this.store.db.prepare('SELECT * FROM bridge_deposit_intent WHERE id=?').get(id) as unknown as DepositIntent|undefined; }
  owned(id: string, person: string) { const row=this.get(id); if(!row || row.person!==person) throw new Error('INTENT_FORBIDDEN'); return row; }
  list(person: string) { return this.store.db.prepare('SELECT * FROM bridge_deposit_intent WHERE person=? ORDER BY created_at,id').all(person) as unknown as DepositIntent[]; }
  /** At most one intent per person and chain: an open one is returned, and so is the newest held one
   * for the same wallet (a legacy BELOW_MINIMUM hold resumes; any other hold stays as it is). Only
   * [reuseHeld] false (the legacy sweep import) creates beside a held intent.
   * [watch] false hands out the address without starting the watch (see [arm]); true (the default,
   * and every older client) watches from creation. An open intent is returned as it is, except that
   * [watch] true arms one that was never started. */
  create(input: Pick<DepositIntent,'person'|'chain'|'wallet'|'owner'>, now: number, {reuseHeld = true, watch = true}: {reuseHeld?: boolean; watch?: boolean} = {}) {
    return this.store.transaction(()=>{
      this.expire(now);
      const old=this.list(input.person).find(i=>i.chain===input.chain && OPEN_STATES.includes(i.state));
      if(old) {
        if(old.wallet!==input.wallet.toLowerCase() || old.owner!==input.owner) throw new Error('INTENT_BINDING_CHANGED');
        this.store.shared.afterCommit(()=>logDebug('bridge_intent_transition',{intent_id:old.id.slice(0,12),chain:old.chain,reason:'reuse',next_state:old.state,expires_at:old.expires_at}));
        if(watch && old.watch_started_at===null)return this.start(old,now,'prepare');
        return old;
      }
      const held=reuseHeld?this.list(input.person).filter(i=>i.chain===input.chain && i.state==='held' && i.wallet===input.wallet.toLowerCase() && i.owner===input.owner).at(-1):undefined;
      if(held) {
        if(held.hold_reason==='BELOW_MINIMUM') {
          // Held under the earlier rule: checking resumes on this intent, never on another one.
          const hasSweep=this.store.db.prepare('SELECT 1 FROM bridge_intent_sweep WHERE intent_id=?').get(held.id);
          this.update(held.id,{state:hasSweep?'funded':'preparing',hold_reason:null,failures:0,next_check_at:now,expires_at:now+CHECKING_WINDOW_MS});
        }
        const row=this.get(held.id)!;
        this.store.shared.afterCommit(()=>logDebug('bridge_intent_transition',{intent_id:row.id.slice(0,12),chain:row.chain,reason:'reuse_held',prior_state:held.state,next_state:row.state,expires_at:row.expires_at}));
        return row;
      }
      const id=randomUUID();
      this.store.db.prepare(`INSERT INTO bridge_deposit_intent(id,person,chain,wallet,owner,state,created_at,expires_at,next_check_at,watch_started_at)
        VALUES (?,?,?,?,?,'preparing',?,?,?,?)`).run(id,input.person,input.chain,input.wallet.toLowerCase(),input.owner,now,now+CHECKING_WINDOW_MS,now,watch?now:null);
      this.store.shared.afterCommit(() => logInfo('bridge_intent_created', { chain: input.chain, person: personPrefix(input.person), intent: id.slice(0,12), addr6: input.wallet.slice(0,6), watch }));
      return this.get(id)!;
    });
  }
  update(id: string, values: Partial<Pick<DepositIntent,'watch_started_at'|'last_verified_at'|'state'|'expires_at'|'next_check_at'|'failures'|'boundary'|'readiness'|'hold_reason'|'recovery_tx'>>) {
    const prior = this.get(id);
    const entries=Object.entries(values); if(!entries.length)return;
    this.store.db.prepare(`UPDATE bridge_deposit_intent SET ${entries.map(([k])=>`${k}=?`).join(',')} WHERE id=?`).run(...entries.map(([,v])=>v as string|number|null),id);
    if(prior)this.store.shared.afterCommit(()=>logDebug('bridge_intent_transition',{intent_id:id.slice(0,12),chain:prior.chain,prior_state:prior.state,next_state:values.state??prior.state,expires_at:values.expires_at??prior.expires_at,next_check_at:values.next_check_at??prior.next_check_at,failures:values.failures??prior.failures}));
    if (prior && (values.state !== undefined && values.state !== prior.state || values.hold_reason !== undefined && values.hold_reason !== prior.hold_reason || values.failures !== undefined && values.failures !== prior.failures)) this.store.shared.afterCommit(() => logInfo('bridge_intent_state', { intent: id.slice(0,12), chain: prior.chain, from: prior.state, to: values.state ?? prior.state, hold_reason: values.hold_reason ? reasonCode(values.hold_reason) : null, failures: values.failures ?? prior.failures }));
  }
  expire(now: number) {
    this.store.transaction(() => {
      const rows = this.store.db.prepare(`SELECT id FROM bridge_deposit_intent
        WHERE state IN ('preparing','waiting') AND expires_at<=? AND NOT EXISTS
        (SELECT 1 FROM bridge_setup_attempt a WHERE a.intent_id=bridge_deposit_intent.id AND a.state IN ('submitted','uncertain'))`).all(now);
      for (const row of rows) this.update(String(row.id), { state: 'ended', hold_reason: 'CHECKING_ENDED' });
    });
  }
  /** Local repair, run at boot: of the held intents with no sweep for one person, chain and wallet,
   * every one older than another unfinished intent there ends as SUPERSEDED. Then a remaining
   * BELOW_MINIMUM hold (the earlier rule) returns to waiting, read again on the slower cadence,
   * unless the chain already has an open intent. Returns the superseded and resumed ids. */
  repairDuplicates(now: number) {
    return this.store.transaction(()=>{
      const superseded=(this.store.db.prepare(`SELECT o.id FROM bridge_deposit_intent o WHERE o.state='held'
        AND NOT EXISTS (SELECT 1 FROM bridge_intent_sweep x WHERE x.intent_id=o.id)
        AND EXISTS (SELECT 1 FROM bridge_deposit_intent n WHERE n.person=o.person AND n.chain=o.chain AND n.wallet=o.wallet
          AND n.state IN ('preparing','waiting','funded','held') AND (n.created_at>o.created_at OR n.created_at=o.created_at AND n.id>o.id))
        ORDER BY o.created_at,o.id`).all() as {id:string}[]).map(r=>String(r.id));
      for(const id of superseded)this.update(id,{state:'ended',hold_reason:'SUPERSEDED'});
      const held=this.store.db.prepare(`SELECT * FROM bridge_deposit_intent WHERE state='held' AND hold_reason='BELOW_MINIMUM'
        AND readiness IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bridge_intent_sweep x WHERE x.intent_id=bridge_deposit_intent.id)
        ORDER BY created_at,id`).all() as unknown as DepositIntent[];
      const resumed: string[]=[];
      for(const row of held) {
        if(this.list(row.person).some(i=>i.chain===row.chain && OPEN_STATES.includes(i.state)))continue;
        this.update(row.id,{state:'waiting',next_check_at:now});
        resumed.push(row.id);
      }
      if(superseded.length || resumed.length)this.store.shared.afterCommit(()=>logInfo('bridge_intent_duplicates_repaired',{superseded:superseded.length,resumed:resumed.length,intents:[...superseded,...resumed].map(id=>id.slice(0,12))}));
      return {superseded,resumed};
    });
  }
  /** A preparing intent always gets its one-time readiness (so the address can be shown); a waiting
   * one is read only once its watch has started. */
  due(now: number) { this.expire(now); return this.store.db.prepare(`SELECT * FROM bridge_deposit_intent
    WHERE state IN ('preparing','waiting','funded') AND next_check_at<=? AND NOT (state='waiting' AND watch_started_at IS NULL)
    ORDER BY next_check_at,id`).all(now) as unknown as DepositIntent[]; }
  /** Starts the watch: reads from now, for the next 24 hours. A failure backoff in progress is kept. */
  private start(row: DepositIntent, now: number, signal: string) {
    this.update(row.id,{watch_started_at:now,expires_at:now+CHECKING_WINDOW_MS,next_check_at:row.failures>0?Math.max(now,row.next_check_at):now});
    this.store.shared.afterCommit(()=>logInfo('bridge_intent_watch',{chain:row.chain,intent:row.id.slice(0,12),signal,outcome:'started'}));
    return this.get(row.id)!;
  }
  /** Restarts phase 1 of a running watch from [now] (and its 24 hours). The next read is never later
   * than phase 1 allows; it is now for Check again, and at most one phase-1 interval away for a signal,
   * so repeated signals never read faster than phase 1. A read that fails again backs off as before. */
  private renew(row: DepositIntent, now: number, readNow: boolean) {
    const soonest=readNow?now:now+sourceInterval(row.chain);
    this.update(row.id,{watch_started_at:now,expires_at:now+CHECKING_WINDOW_MS,next_check_at:Math.min(row.next_check_at,soonest)});
    return this.get(row.id)!;
  }
  /** A person revealed, copied or opened a wallet with the address. Not started: the watch starts.
   * Already watching: phase 1 restarts from now. Checking ended: checking restarts, as Check again does.
   * Funded, held, complete (or ended for another reason): nothing is read now; a held intent whose
   * watch never started records the start, so it is read once the hold is released. */
  arm(id: string, person: string, now: number, signal: WatchSignal, signerReady = false) {
    return this.store.transaction(()=>{
      this.expire(now);
      const row=this.owned(id,person);
      const outcome=(o:WatchOutcome)=>this.store.shared.afterCommit(()=>logInfo('bridge_intent_watch',{chain:row.chain,intent:id.slice(0,12),signal,outcome:o}));
      if(['preparing','waiting'].includes(row.state)) {
        if(row.watch_started_at===null)return this.start(row,now,signal);
        outcome('renewed');return this.renew(row,now,false);
      }
      if(row.state==='ended' && row.hold_reason==='CHECKING_ENDED') {
        const restarted=this.rearm(id,person,now,`Deposit watch: ${signal}`,undefined,signerReady);
        outcome('restarted');return restarted;
      }
      if(row.state==='held' && row.watch_started_at===null) {
        this.update(id,{watch_started_at:now});
        outcome('started');return this.get(id)!;
      }
      outcome('none');return row;
    });
  }
  rearm(id: string, person: string, now: number, reason: string, reference?: string, signerReady = false) {
    if(!reason.trim())throw new Error('REPAIR_REASON_REQUIRED');
    return this.store.transaction(()=>{
      const row=this.owned(id,person);
      // Check again on an address whose watch never started starts it (no other signal needed).
      if(['preparing','waiting'].includes(row.state) && row.watch_started_at===null && !reference)return this.start(row,now,'check');
      // Check again on a running watch restarts phase 1 and reads at the next pass.
      if(['preparing','waiting'].includes(row.state) && !reference && row.expires_at>now) {
        this.store.shared.afterCommit(()=>logInfo('bridge_intent_watch',{chain:row.chain,intent:id.slice(0,12),signal:'check',outcome:'renewed'}));
        return this.renew(row,now,true);
      }
      if(row.state==='complete' || row.state==='funded' || ['preparing','waiting'].includes(row.state) && !reference)return row;
      if(row.hold_reason==='FULL_SWEEP_EXCEEDS_CAP')throw new Error('SUPPORT_REQUIRED');
      if(reference && !/^0x[\da-f]{64}$/i.test(reference))throw new Error('RECOVERY_REFERENCE_INVALID');
      this.store.db.prepare('INSERT INTO bridge_repair_audit VALUES (?,?,?,?)').run(randomUUID(),id,reason,now);
      // A public retry only clears a signer hold after readiness is repaired. It does not
      // reset attempt allowances or clear any other operator-controlled hold.
      if(signerReady)this.releaseSignerSweeps(id,person);
      this.store.shared.afterCommit(() => logInfo('bridge_intent_rearmed', { intent: id.slice(0,12), reason: 'user_requested', has_reference: !!reference }));
      const hasSweep=this.store.db.prepare('SELECT 1 FROM bridge_intent_sweep WHERE intent_id=?').get(id);
      this.update(id,{state:hasSweep?'funded':'preparing',expires_at:now+CHECKING_WINDOW_MS,next_check_at:Math.max(now,row.next_check_at),hold_reason:null,failures:0,watch_started_at:now,...(reference?{recovery_tx:reference.toLowerCase()}: {})});
      return this.get(id)!;
    });
  }
  /** Sweeps of this intent blocked for a signer or permission reason return to their prior state. Other holds stay. */
  private releaseSignerSweeps(id: string, person: string) {
    const held=this.store.db.prepare(`SELECT s.id,h.prior_state FROM bridge_intent_sweep x
      JOIN bridge_sweep s ON s.id=x.sweep_id JOIN bridge_transfer_hold h ON h.sweep_id=s.id
      WHERE x.intent_id=? AND s.person=? AND s.state='blocked'
        AND ${SIGNER_HOLD_SQL('s.blocked_reason')} AND h.reason=s.blocked_reason`).all(id,person);
    for(const s of held) {
      this.store.db.prepare('UPDATE bridge_sweep SET state=?,blocked_reason=NULL WHERE id=?').run(s.prior_state!,s.id!);
      this.store.db.prepare('DELETE FROM bridge_transfer_hold WHERE sweep_id=?').run(s.id!);
    }
  }
  /** After a verified consent for [chain] (S1's onVerified(person, chain); all chains when omitted):
   * intents held for a SOURCE_SIGNER_* reason or a permission hold (PERMISSION_REQUIRED, POLICY_DRIFT,
   * POLICY_OWNER_MISMATCH, POLICY_READ_UNAVAILABLE) resume
   * (preparing, or funded when a sweep exists) without waiting for Check again. Other holds, other
   * chains, attempts and the checking window are unchanged; a chain that already has an active
   * intent keeps it. */
  releaseSignerHolds(person: string, chain?: SourceChain, now = Date.now()) {
    return this.store.transaction(()=>{
      const held=(chain ? this.store.db.prepare(`SELECT * FROM bridge_deposit_intent
        WHERE person=? AND chain=? AND state='held' AND ${SIGNER_HOLD_SQL('hold_reason')} ORDER BY created_at,id`).all(person,chain)
        : this.store.db.prepare(`SELECT * FROM bridge_deposit_intent
        WHERE person=? AND state='held' AND ${SIGNER_HOLD_SQL('hold_reason')} ORDER BY created_at,id`).all(person)) as unknown as DepositIntent[];
      const released: string[]=[];
      for(const row of held) {
        if(this.list(person).some(i=>i.chain===row.chain && ['preparing','waiting','funded'].includes(i.state)))continue;
        this.releaseSignerSweeps(row.id,person);
        const hasSweep=this.store.db.prepare('SELECT 1 FROM bridge_intent_sweep WHERE intent_id=?').get(row.id);
        this.update(row.id,{state:hasSweep?'funded':'preparing',hold_reason:null,failures:0,next_check_at:now});
        released.push(row.id);
      }
      if(released.length)this.store.shared.afterCommit(()=>logInfo('bridge_intent_signer_released',{person:personPrefix(person),...(chain?{chain}:{}),count:released.length,intents:released.map(id=>id.slice(0,12))}));
      return released;
    });
  }
  /** Intents held for our own spend caps (SOURCE_FEE_CAP_EXCEEDED, FOLIO_TOPUP_CAP_EXCEEDED) under
   * the earlier rule resume: funded with their cap-blocked sweeps back in their prior state, or
   * preparing. Those caps no longer hold an intent, so this finds rows only once. A chain that
   * already has an active intent keeps it. */
  releaseSpendCapHolds(now: number) {
    return this.store.transaction(()=>{
      const caps="('SOURCE_FEE_CAP_EXCEEDED','FOLIO_TOPUP_CAP_EXCEEDED')";
      const held=this.store.db.prepare(`SELECT * FROM bridge_deposit_intent WHERE state='held' AND hold_reason IN ${caps} ORDER BY created_at,id`).all() as unknown as DepositIntent[];
      const released: string[]=[];
      for(const row of held) {
        if(this.list(row.person).some(i=>i.chain===row.chain && ['preparing','waiting','funded'].includes(i.state)))continue;
        const sweeps=this.store.db.prepare(`SELECT s.id,h.prior_state FROM bridge_intent_sweep x
          JOIN bridge_sweep s ON s.id=x.sweep_id JOIN bridge_transfer_hold h ON h.sweep_id=s.id
          WHERE x.intent_id=? AND s.state='blocked' AND s.blocked_reason IN ${caps} AND h.reason=s.blocked_reason`).all(row.id);
        for(const s of sweeps) {
          this.store.db.prepare('UPDATE bridge_sweep SET state=?,blocked_reason=NULL WHERE id=?').run(s.prior_state!,s.id!);
          this.store.db.prepare('DELETE FROM bridge_transfer_hold WHERE sweep_id=?').run(s.id!);
        }
        const hasSweep=this.store.db.prepare('SELECT 1 FROM bridge_intent_sweep WHERE intent_id=?').get(row.id);
        this.update(row.id,{state:hasSweep?'funded':'preparing',hold_reason:null,failures:0,next_check_at:now});
        released.push(row.id);
      }
      if(released.length)this.store.shared.afterCommit(()=>logInfo('bridge_intent_spend_cap_released',{count:released.length,intents:released.map(id=>id.slice(0,12))}));
      return released;
    });
  }
  /** Operator-only local repair: never callable from the public Check again route. */
  resume(id:string,person:string,reason:string,now:number) {
    if(!reason.trim())throw new Error('REPAIR_REASON_REQUIRED');
    return this.store.transaction(()=>{
      const i=this.owned(id,person);if(i.state!=='held')throw new Error('REPAIR_REQUIRES_HOLD');
      this.store.db.prepare('INSERT INTO bridge_repair_audit VALUES (?,?,?,?)').run(randomUUID(),id,reason,now);
      const sweeps=this.store.db.prepare('SELECT sweep_id FROM bridge_intent_sweep WHERE intent_id=?').all(id);
      for(const s of sweeps)if(this.store.sweep(String(s.sweep_id)).state==='blocked')this.store.shared.resume(String(s.sweep_id),person,reason,now);
      const count=Number(this.store.db.prepare("SELECT count(*) AS n FROM bridge_setup_attempt WHERE intent_id=? AND state='failed'").get(id)?.n??0);
      this.store.db.prepare('INSERT OR REPLACE INTO bridge_retry_allowance VALUES (?,?,?)').run(id,'ata_create',count);
      this.update(id,{state:sweeps.length?'funded':'preparing',hold_reason:null,next_check_at:now,failures:0,expires_at:now+CHECKING_WINDOW_MS});
      return this.get(id)!;
    });
  }
  attach(id: string) {
    const i=this.get(id)!;
    this.store.db.prepare(`INSERT OR IGNORE INTO bridge_intent_event SELECT e.id,? FROM bridge_deposit_event e
      WHERE e.chain=? AND e.wallet=?`).run(id,i.chain,i.wallet);
    this.store.db.prepare(`INSERT OR IGNORE INTO bridge_intent_sweep SELECT s.id,? FROM bridge_sweep s
      JOIN bridge_intent_event e ON e.event_id=s.trigger_event_id WHERE e.intent_id=?`).run(id,id);
    this.store.shared.afterCommit(()=>logDebug('bridge_intent_transition',{intent_id:id.slice(0,12),chain:i.chain,reason:'attach',linked_sweep_count:Number(this.store.db.prepare('SELECT count(*) AS n FROM bridge_intent_sweep WHERE intent_id=?').get(id)?.n??0)}));
  }
  claimClock(id: string, now: number, interval: number) {
    return !!this.store.db.prepare(`INSERT INTO bridge_work_clock(id,next_check_at) VALUES (?,?)
      ON CONFLICT(id) DO UPDATE SET next_check_at=excluded.next_check_at WHERE bridge_work_clock.next_check_at<=?`).run(id,now+interval,now).changes;
  }
  backoffClock(id: string, now: number) {
    const failures=Number(this.store.db.prepare('SELECT failures FROM bridge_work_clock WHERE id=?').get(id)?.failures??0)+1;
    this.store.db.prepare(`INSERT INTO bridge_work_clock VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET next_check_at=excluded.next_check_at,failures=excluded.failures`)
      .run(id,now+Math.min(600_000,30_000*2**Math.min(5,failures-1)),failures);
  }
}
