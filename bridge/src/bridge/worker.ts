import { errorFields, ref8 } from '../shims/log-fields.js';
import { logEvent, logDebug, logInfo, logError } from '../shims/log.js';
import { sourceInterval } from './deposit-intent.js';
import { ReadinessHold } from './deposit-readiness.js';
import { BridgeBudgetExceeded } from './read-budget.js';
import { randomUUID } from 'node:crypto';
import type { Instruction } from '@solana/kit';
import { createAttestationClient } from './attestation.js';
import { validateMessage, type MessageExpectation } from './message.js';
import { discoverDelivery, verifyDelivery, type VerifiedDelivery } from './delivery.js';
import { decodeFeeRecipient, receivePdas, receiveInstruction, readAccount, reverifyAta, verifyPrograms, type ReadRpc } from './solana.js';
import type { Sweep, Transfer, TransferStore } from './transfer-record.js';
/** No default signer/sender. The operator supplies an explicitly gated adapter. */
export interface GuardedDeliveryPort {
  live: true; payer: string;
  prepare(instruction:Instruction, remainingCost?:bigint):Promise<{signature:string;requestId:string;evidence:unknown}>;
  submit(signature:string):Promise<void>;
}
export interface WorkerOptions {
  store:TransferStore;rpc:ReadRpc;payer:string;expected(sweep:Sweep,transfer:Transfer):MessageExpectation;
  credit(delivery:VerifiedDelivery):Promise<unknown>;
  maxCost?: bigint;
  attestation?:ReturnType<typeof createAttestationClient>;now?:()=>number;delivery?:GuardedDeliveryPort;
}
export function createDestinationWorker(options:WorkerOptions) {
  const {store,rpc}=options,clock=options.now ?? Date.now,iris=options.attestation ?? createAttestationClient();
  store.db.exec('CREATE TABLE IF NOT EXISTS bridge_destination_clock(id INTEGER PRIMARY KEY,next_read INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS bridge_destination_candidates(sweep_id TEXT PRIMARY KEY,signatures_json TEXT NOT NULL)');
  let leaseHolder:string|undefined;
  const assertLease=()=>{if(!leaseHolder || !store.db.prepare("SELECT 1 FROM bridge_destination_lease WHERE name='destination' AND holder=? AND expires_at>?").get(leaseHolder,clock()))throw new Error('DESTINATION_LEASE_LOST');};
  type Read = {method:string;params:unknown[];value:unknown};
  let statuses: Map<string,unknown> = new Map();
  const verify=async(sweep:Sweep,row:Transfer,sig:string) => {
    const reads:Read[]=[];
    const recording:ReadRpc={async call<T>(method:string,params:unknown[]) {
      const signatures=params[0] as string[];
      const value=method==='getSignatureStatuses' && signatures.every(s=>statuses.has(s))
        ? {value:signatures.map(s=>statuses.get(s))} : await rpc.call<T>(method,params);
      reads.push({method,params,value});return value as T;
    }};
    logDebug('bridge_delivery_reconcile',{sweep_id:row.sweep_id.slice(0,12),stage:'verify',receipt_source:'rpc',tx_ref:sig.slice(0,12)});
    const delivery=await verifyDelivery(recording,sweep,row,sig,options.expected(sweep,row));
    store.saveReceipt(row.sweep_id,{reads,signature:sig,verified_at:clock()});return delivery;
  };
  const replay=async(sweep:Sweep,row:Transfer) => {
    const proof=store.receipt(row.sweep_id) as {reads:Read[];signature:string}|undefined;
    logDebug('bridge_delivery_reconcile',{sweep_id:row.sweep_id.slice(0,12),stage:'replay',receipt_source:proof?'retained':'legacy_rpc'});
    if(!proof)return verify(sweep,row,row.settled_signature!); // Bounded legacy repair, then local forever.
    return verifyDelivery({async call<T>(method:string,params:unknown[]) {
      const read=proof.reads.find(r=>r.method===method && JSON.stringify(r.params)===JSON.stringify(params));
      if(!read)throw new Error('VERIFIED_RECEIPT_INCOMPLETE');return read.value as T;
    }},sweep,row,proof.signature,options.expected(sweep,row));
  };
  async function settle(sweep:Sweep,row:Transfer,delivery:VerifiedDelivery) {
    store.atomic(()=>{if(row.state==='attested') {store.destination(row.sweep_id,delivery.signature);store.transition(row.sweep_id,'delivery_submitted');}
    store.destination(row.sweep_id,delivery.signature,true);
    recordGas(row,delivery);
    store.transition(row.sweep_id,'settled',{kind:'receipt',reference:`finalized:${delivery.signature}:${delivery.slot}`});});
    // Settled is a replayable outbox, intentionally written before asynchronous person credit.
    await credit(row,delivery);
    store.acknowledge(row.sweep_id,clock());
    logInfo('bridge_settled', { sweep: row.sweep_id.slice(0,8), sig12: delivery.signature.slice(0,12), slot: delivery.slot, amount6: delivery.amount6, fee_payer_cost_raw: delivery.payerCostRaw });
  }
  async function credit(row:Transfer,delivery:VerifiedDelivery) {
    const fields={sweep_id:row.sweep_id.slice(0,12),stage:'person_credit',tx_ref:delivery.signature.slice(0,12),slot:delivery.slot};
    logInfo('bridge_delivery_reconcile',{...fields,result:'requested'});
    try {await options.credit(delivery);logInfo('bridge_delivery_reconcile',{...fields,result:'succeeded'});}
    catch(e){logError('bridge_delivery_reconcile',{...fields,result:'failed',...errorFields(e)});throw e;}
  }
  function recordGas(row:Transfer,delivery:VerifiedDelivery) {
    for(const attempt of store.attempts(row.sweep_id).filter(a=>a.kind==='receive' && a.tx_hash===delivery.signature && !['confirmed','failed'].includes(a.state))) {
      if(attempt.state==='prepared' || attempt.state==='signed') store.updateAttempt(attempt.id,'submitted','0',{reconciled:true});
      store.updateAttempt(attempt.id,'confirmed',delivery.feePaidRaw,{signature:delivery.signature,slot:delivery.slot,payer:delivery.feePayer,payer_cost_raw:delivery.payerCostRaw});
    }
  }
  async function tick():Promise<{sweepId:string;outcome:'ready_to_submit'|'waiting'|'settled'|'credited'|'retry'}[]> {
    const results:{sweepId:string;outcome:'ready_to_submit'|'waiting'|'settled'|'credited'|'retry'}[]=[];
    const all=store.due(clock()),at=clock();
    const summary = () => { const outcomes: Record<string, number> = {}; for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1; logEvent(results.some(r => r.outcome !== 'waiting') ? 'info' : 'debug', 'bridge_dest_pass', { due: all.length, outcomes, ms: clock() - at }); return results; };
    const backoff = (row: Transfer, error: unknown) => { const retryAt = error instanceof BridgeBudgetExceeded ? error.retryAt : at + Math.min(600_000,30_000*2**Math.min(5,row.failures)); store.schedule(row.sweep_id,retryAt,row.failures+1); logInfo('bridge_dest_backoff', { sweep: row.sweep_id.slice(0,8), failures: row.failures+1, n: row.failures+1, retry_in_ms: retryAt-at, budget: error instanceof BridgeBudgetExceeded, ...errorFields(error) }); };
    const slot=all.some(r=>!store.receipt(r.sweep_id)) && !!store.db.prepare(`INSERT INTO bridge_destination_clock VALUES (1,?)
      ON CONFLICT(id) DO UPDATE SET next_read=excluded.next_read WHERE bridge_destination_clock.next_read<=?`).run(at+5000,at).changes;
    logDebug('bridge_destination_pass',{stage:'read_clock',due_count:all.length,reason:slot?'allowed':'read_clock_skip'});
    let due=all.filter(r=>slot || store.receipt(r.sweep_id));
    const discovered=new Map<string,string[]>(),deferred=new Set<string>();
    for(const row of due.filter(r=>r.state==='attested' && !r.destination_signature && !store.receipt(r.sweep_id))) {
      try {discovered.set(row.sweep_id,await discoverDelivery(rpc,row));}
      catch(error) { logDebug('worker_error', { stage: 'discovery', sweep_id:row.sweep_id.slice(0,12), ...errorFields(error) }); deferred.add(row.sweep_id);backoff(row,error);}
    }
    due=due.filter(row=>!deferred.has(row.sweep_id));
    for(const row of due){const saved=store.db.prepare('SELECT signatures_json FROM bridge_destination_candidates WHERE sweep_id=?').get(row.sweep_id);if(saved)discovered.set(row.sweep_id,JSON.parse(String(saved.signatures_json)));}
    const signatures=due.filter(r=>(r.state==='delivery_submitted' || r.state==='delivery_uncertain') && !store.receipt(r.sweep_id)).flatMap(r=>r.destination_signature?[r.destination_signature]:[]).concat([...discovered.values()].flat());
    statuses=new Map();
    if(signatures.length) {
      try {const response=await rpc.call<{value:unknown[]}>('getSignatureStatuses',[[...new Set(signatures)],{searchTransactionHistory:true}]);
      [...new Set(signatures)].forEach((sig,i)=>statuses.set(sig,response.value[i]));}
      catch (error) { logDebug('worker_error', { stage: 'status_batch', ...errorFields(error) }); for(const row of due)backoff(row,error);return summary();}
    }
    for(const initial of due) {
      store.schedule(initial.sweep_id,clock()+ (initial.state==='burn_confirmed'?sourceInterval(initial.source_domain===6?'base':'arc'):5000),initial.failures);
      try {
        let row=initial;const sweep=store.getSweep(row.sweep_id)!;
        if(row.state==='settled') {
          const delivery=await replay(sweep,row);recordGas(row,delivery);await credit(row,delivery);store.acknowledge(row.sweep_id,clock());
          logDebug('bridge_settled', { sweep: row.sweep_id.slice(0,8), sig12: delivery.signature.slice(0,12), replay: true, slot: delivery.slot, amount6: delivery.amount6, fee_payer_cost_raw: delivery.payerCostRaw });
          results.push({sweepId:row.sweep_id,outcome:'credited'});continue;
        }
        if(store.receipt(row.sweep_id)){await settle(sweep,row,await replay(sweep,row));results.push({sweepId:row.sweep_id,outcome:'settled'});continue;}
        if(row.state==='burn_confirmed') {
          const response=await iris.lookup(row.burn_tx_hash,options.expected(sweep,row),row.failures);
          logInfo('bridge_attestation', { sweep: row.sweep_id.slice(0,8), result: response.kind === 'ready' ? 'attested' : 'retry', ...(response.kind === 'retry' ? { reason: response.reason, delay_ms: response.delayMs, failures: row.failures+1 } : {}) });
          if(response.kind==='retry'){store.schedule(row.sweep_id,clock()+Math.max(sourceInterval(row.source_domain===6?'base':'arc'),response.delayMs),row.failures+1);results.push({sweepId:row.sweep_id,outcome:'retry'});continue;}
          store.saveAttestation(row.sweep_id,{message_nonce:response.nonce,message_hash:response.messageHash,message:response.message,attestation:response.attestation});
          store.transition(row.sweep_id,'attested');continue; // Discovery and its status batch occur on the next destination interval.
        }
        const candidates=[...new Set([...(row.destination_signature?[row.destination_signature]:[]),...discovered.get(row.sweep_id)??[]])];
        let landed:VerifiedDelivery|undefined;
        for(const signature of candidates) {if(statuses.has(signature) && !(statuses.get(signature) as {confirmationStatus?:string;err?:unknown}|null)?.confirmationStatus?.includes('finalized'))continue;try{landed=await verify(sweep,row,signature);break;}catch(e){logDebug('bridge_receipt_rejected', { sweep: row.sweep_id.slice(0,8), ...errorFields(e) });if(e instanceof BridgeBudgetExceeded)throw e;/* Only a matching finalized receipt settles. */}}
        if(landed){await settle(sweep,row,landed);results.push({sweepId:row.sweep_id,outcome:'settled'});continue;}
        if(row.state==='delivery_submitted' || row.state==='delivery_uncertain') {
          if(row.destination_signature) {
            const status=statuses.get(row.destination_signature) as {confirmationStatus:string;err:unknown;slot:number}|null,attempt=store.attempts(row.sweep_id).find(a=>a.kind==='receive' && a.tx_hash===row.destination_signature);
            const retained=attempt?JSON.parse(attempt.evidence_json) as {last_valid_block_height?:string}:{};
            const failed=status?.confirmationStatus==='finalized' && !!status.err;
            const expired=!status && retained.last_valid_block_height && BigInt(await rpc.call<number>('getBlockHeight',[{commitment:'finalized'}]))>BigInt(retained.last_valid_block_height);
            logDebug('bridge_delivery_attempt',{sweep_id:row.sweep_id.slice(0,12),attempt_id:attempt?.id.slice(0,12),prior_state:row.state,reason:failed?'failed':expired?'expired':'waiting',expired:!!expired});
            if(!failed && !expired){results.push({sweepId:row.sweep_id,outcome:'waiting'});continue;}
            const pdas=await receivePdas(row.message!),nonce=await readAccount(rpc,pdas.usedNonce);
            if(nonce) {
              if(!discovered.has(row.sweep_id))store.db.prepare('INSERT OR REPLACE INTO bridge_destination_candidates VALUES (?,?)').run(row.sweep_id,JSON.stringify(await discoverDelivery(rpc,row)));
              results.push({sweepId:row.sweep_id,outcome:'waiting'});continue;
            }
            if(failed || expired) {
              let gas='0'; if(failed) {const tx=await rpc.call<{meta:{fee:number}}|null>('getTransaction',[row.destination_signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}]);if(!tx || !Number.isSafeInteger(tx.meta.fee))throw new Error('failed receipt gas unavailable');gas=String(tx.meta.fee);}
              if(attempt && !['confirmed','failed'].includes(attempt.state)) store.updateAttempt(attempt.id,'failed',gas,{failed:!!failed,expired:!!expired,signature:row.destination_signature});
              if(row.state==='delivery_submitted')store.transition(row.sweep_id,'delivery_uncertain');
              store.transition(row.sweep_id,'attested',{kind:'receipt',reference:`${failed?'failed':'expired'}:${row.destination_signature}`});row=store.getTransfer(row.sweep_id)!;
            }
          }
        }
        if(row.state!=='attested'){results.push({sweepId:row.sweep_id,outcome:'waiting'});continue;}
        if(store.failedAttempts(row.sweep_id,'receive')>=3)throw new ReadinessHold('DELIVERY_ATTEMPTS_EXHAUSTED');
        const used=await readAccount(rpc,(await receivePdas(row.message!)).usedNonce);
        if(used){logDebug('bridge_delivery_attempt',{sweep_id:row.sweep_id.slice(0,12),reason:'nonce_consumed',nonce_used:true});results.push({sweepId:row.sweep_id,outcome:'waiting'});continue;}
        validateMessage(row.message!,options.expected(sweep,row));
        await reverifyAta(rpc,sweep.destination_owner,sweep.mint_recipient);
        if(options.payer===sweep.destination_owner) throw new Error('person cannot pay delivery gas');
        const pdas=await receivePdas(row.message!),config=await readAccount(rpc,pdas.tokenMessenger);
        if(!config) throw new Error('TokenMessenger config missing');
        const instruction=await receiveInstruction(row.message!,row.attestation!,options.payer,decodeFeeRecipient(config));
        if(!options.delivery){logDebug('bridge_delivery_attempt',{sweep_id:row.sweep_id.slice(0,12),reason:'adapter_missing'});results.push({sweepId:row.sweep_id,outcome:'ready_to_submit'});continue;}
        const retained=store.attempts(row.sweep_id).find(a=>a.kind==='receive' && ['prepared','signed','submitted','uncertain'].includes(a.state));
        if(retained?.tx_hash){logInfo('bridge_delivery_attempt',{sweep_id:row.sweep_id.slice(0,12),attempt_id:retained.id.slice(0,12),reason:'retained_attempt',next_state:'delivery_submitted'});store.destination(row.sweep_id,retained.tx_hash);store.transition(row.sweep_id,'delivery_submitted');continue;}
        if(options.delivery.live!==true || options.delivery.payer!==options.payer) throw new Error('delivery guard/payer mismatch');
        await verifyPrograms(rpc);
        const spent=store.attempts(row.sweep_id).filter(a=>a.kind==='receive').reduce((n,a)=>n+BigInt(a.gas_paid_raw),0n);
        if(options.maxCost!==undefined && spent>=options.maxCost)throw new ReadinessHold('DELIVERY_BUDGET_EXHAUSTED');
        assertLease();const prepared=await options.delivery.prepare(instruction,options.maxCost===undefined?undefined:options.maxCost-spent);
        logInfo('bridge_delivery_prepared', { sweep: row.sweep_id.slice(0,8), request_id_ref: ref8(prepared.requestId), sig12: prepared.signature.slice(0,12), payer6: options.payer.slice(0,6), remaining_cost: options.maxCost === undefined ? undefined : String(options.maxCost-spent) });
        const attemptId=randomUUID();
        assertLease();store.atomic(()=>{store.addAttempt({id:attemptId,sweep_id:row.sweep_id,kind:'receive',chain:'solana',request_id:prepared.requestId,tx_hash:prepared.signature,nonce:row.message_nonce,state:'prepared',gas_paid_raw:'0',evidence_json:JSON.stringify(prepared.evidence)});
        store.destination(row.sweep_id,prepared.signature);store.transition(row.sweep_id,'delivery_submitted');});
        try {assertLease();await options.delivery.submit(prepared.signature);store.updateAttempt(attemptId,'submitted','0',{...(prepared.evidence as object),signature:prepared.signature});}
        catch (error) {logError('bridge_delivery_uncertain', { sweep: row.sweep_id.slice(0,8), sig12: prepared.signature.slice(0,12), ...errorFields(error) });store.updateAttempt(attemptId,'submitted','0',{...(prepared.evidence as object),signature:prepared.signature});store.updateAttempt(attemptId,'uncertain','0',{...(prepared.evidence as object),reason:'submission response unavailable'});store.transition(row.sweep_id,'delivery_uncertain');}
        results.push({sweepId:row.sweep_id,outcome:'waiting'});
      } catch(error) {
        if(error instanceof ReadinessHold || error instanceof Error && /COST_CAP|AUTHORIZATION|POLICY_DENIED|HTTP_40[13]|wrong mint|wrong authority|classic Token/.test(error.message))store.hold(initial.sweep_id,error.message,clock());
        else if(initial.state==='settled' && !store.receipt(initial.sweep_id) && initial.failures>=2)store.hold(initial.sweep_id,'LEGACY_EVIDENCE_REPAIR_REQUIRED',clock());
        else store.schedule(initial.sweep_id,error instanceof BridgeBudgetExceeded?error.retryAt:clock()+Math.min(600_000,30_000*2**Math.min(5,initial.failures)),initial.failures+1);
        const held = store.getSweep(initial.sweep_id)?.state === 'blocked' || !!store.db.prepare('SELECT 1 FROM bridge_transfer_hold WHERE sweep_id=?').get(initial.sweep_id);
        const saved = store.getTransfer(initial.sweep_id);
        logEvent(held ? 'error' : 'info', 'bridge_dest_error', { sweep: initial.sweep_id.slice(0,8), action: held ? initial.state === 'settled' ? 'repair_hold' : 'hold' : 'schedule', failures: saved?.failures, retry_in_ms: held ? undefined : (saved?.next_check_at ?? clock()) - clock(), ...errorFields(error) });
        results.push({sweepId:initial.sweep_id,outcome:'retry'});
      }
    }
    return summary();
  }
  let running:ReturnType<typeof tick>|undefined;
  return {tick() {
    if(running){logDebug('bridge_dest_lease', { action:'running_join', acquired: false, busy: true });return running;}
    const holder=randomUUID(),at=clock();
    if(!store.db.prepare(`INSERT INTO bridge_destination_lease VALUES ('destination',?,?) ON CONFLICT(name)
      DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at WHERE bridge_destination_lease.expires_at<?`).run(holder,at+60_000,at).changes){logDebug('bridge_dest_lease', { action:'claim',reason:'contention',lease_ref:ref8(holder),acquired: false });return Promise.resolve([]);}
    logDebug('bridge_dest_lease', { action:'claim',lease_ref:ref8(holder),acquired: true });
    leaseHolder=holder;
    const heartbeat=setInterval(()=>{try {const result=store.db.prepare("UPDATE bridge_destination_lease SET expires_at=? WHERE name='destination' AND holder=?").run(clock()+60_000,holder);logEvent(result.changes?'debug':'error','bridge_destination_pass',{lease_ref:ref8(holder),stage:'heartbeat',reason:result.changes?'renewed':'ownership_lost'});}catch(e){logError('bridge_destination_pass',{lease_ref:ref8(holder),stage:'heartbeat',...errorFields(e)});}},20_000);
    running=tick().catch(e=>{logError('bridge_destination_pass',{lease_ref:ref8(holder),stage:'pass',...errorFields(e)});throw e;}).finally(()=>{clearInterval(heartbeat);try{store.db.prepare("DELETE FROM bridge_destination_lease WHERE name='destination' AND holder=?").run(holder);}catch(e){logError('bridge_destination_pass',{lease_ref:ref8(holder),stage:'release',...errorFields(e)});throw e;}finally{running=undefined;leaseHolder=undefined;}});
    return running;
  }};
}
