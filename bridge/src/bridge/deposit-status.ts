import { logDebug } from '../shims/log.js';
import { reasonCode } from '../shims/log-fields.js';
import type { DepositIntent, DepositIntents } from './deposit-intent.js';
import type { Sweep, DepositEvent } from './transfer-record.js';
const usd=(raw:string|bigint)=>{const n=BigInt(raw);return `${n/1000000n}.${String(n%1000000n).padStart(6,'0')}`;};
export type DepositPhase='preparing'|'waiting'|'detected'|'processing'|'delayed'|'action_needed'|'available';
/** Local evidence projection. No provider, observer or chain adapter is reachable from GETs. */
export function depositStatus(intents:DepositIntents,i:DepositIntent,input:{now:number;minimum:bigint;maximum:bigint;address?:string;credited:(signature:string)=>boolean}) {
 const {store}=intents,db=store.db;
 const events=db.prepare(`SELECT e.* FROM bridge_deposit_event e JOIN bridge_intent_event x ON x.event_id=e.id
   WHERE x.intent_id=? AND e.classification='customer' ORDER BY e.block,e.event_index,e.id`).all(i.id) as unknown as DepositEvent[];
 // A later full sweep may cover this intent's earlier dust; event ownership never moves.
 const sweeps=db.prepare(`SELECT DISTINCT s.* FROM bridge_sweep s LEFT JOIN bridge_intent_sweep x ON x.sweep_id=s.id
   WHERE s.person=? AND (x.intent_id=? OR s.id IN (SELECT e.covered_by FROM bridge_deposit_event e
     JOIN bridge_intent_event x ON x.event_id=e.id WHERE x.intent_id=?)) ORDER BY s.created_at,s.id`).all(i.person,i.id,i.id) as unknown as Sweep[];
 const receipts=sweeps.flatMap(s=>{
   const t=store.shared.getTransfer(s.id),proof=store.shared.receipt(s.id);
   const ack=db.prepare('SELECT acknowledged_at FROM bridge_credit_completion WHERE sweep_id=?').get(s.id);
   if(s.state!=='settled' || !t?.settled_signature || proof?.signature!==t.settled_signature || !Array.isArray(proof.reads)
     || ack?.acknowledged_at==null || !input.credited(t.settled_signature))return [];
   const covered=store.events(s.chain as 'base'|'arc',s.wallet).filter(e=>e.classification==='customer' && e.covered_by===s.id);
   const earlier=covered.filter(e=>e.id!==s.trigger_event_id).reduce((n,e)=>n+BigInt(e.amount_6),0n);
   return [{id:`deposit:${t.settled_signature}`,intent_id:i.id,sweep_id:s.id,currency:'USD',credited_usd:usd(s.amount_6),
     detected_at:s.created_at,credited_at:Number(ack.acknowledged_at),finalized_at:proof.verified_at??null,
     source_deposits:covered.map(e=>({event_id:e.id,reference:e.tx_hash,amount:usd(e.amount_6)})),
     burn_reference:t.burn_tx_hash,destination_receipt:t.settled_signature,earlier_deposits_usd:usd(earlier),
     explanation:earlier>0n?'Includes earlier deposits received at this address.':null}];
 });
 const transfers=sweeps.map(s=>store.shared.getTransfer(s.id));
 const complete=sweeps.length>0 && !events.some(e=>!e.covered_by) && receipts.length===sweeps.length;
 const ended=i.state==='ended' || ['preparing','waiting'].includes(i.state) && i.expires_at<=input.now;
 const hold=sweeps.find(s=>s.blocked_reason)?.blocked_reason??(ended?(i.hold_reason==='SUPERSEDED'?'SUPERSEDED':'CHECKING_ENDED'):i.hold_reason);
 // Below the minimum, the intent still waits (and is read again) for a qualifying deposit.
 const belowMinimum=!ended && i.state==='waiting' && i.hold_reason==='BELOW_MINIMUM' && !sweeps.length;
 const phase:DepositPhase=complete?'available':sweeps.some(s=>s.state==='blocked') || i.state==='held' || ended || belowMinimum?'action_needed':
   i.failures>0 || transfers.some(t=>t && t.failures>0)?'delayed':sweeps.some(s=>s.state!=='planned')?'processing':
   events.length || sweeps.length?'detected':i.state==='waiting'?'waiting':'preparing';
 const terminal=complete || phase==='action_needed' && !belowMinimum,readiness=i.readiness?JSON.parse(i.readiness):null;
 logDebug('bridge_address_readiness',{chain:i.chain,intent_id:i.id.slice(0,12),availability:input.address?'available':'not_ready',gate:phase,reason:hold?reasonCode(hold):undefined,expires_at:i.expires_at});
 return {id:i.id,chain:i.chain,state:i.state,phase,terminal,observed_amount:usd(events.reduce((n,e)=>n+BigInt(e.amount_6),0n)),
   events:events.map(e=>({id:e.id,amount:usd(e.amount_6),reference:e.tx_hash,remainder_raw:e.remainder,sweep_id:e.covered_by})),
   sweep_ids:sweeps.map(s=>s.id),hold_reason:hold??null,next_check_at:terminal?null:Math.max(i.next_check_at,...transfers.map(t=>t?.next_check_at??0)),
   last_verified_at:Math.max(i.last_verified_at??0,readiness?.verified_at??0,...receipts.map(r=>r.finalized_at??0))||null,created_at:i.created_at,expires_at:i.expires_at,
   readiness:{ready:!!input.address,address:input.address??null},
   // True while the server reads this address on schedule: its watch started and checking has not ended.
   watching:i.watch_started_at!=null && ['preparing','waiting','funded'].includes(i.state) && !ended,
   // 'busy' when the address is shown while the rehearsed cost exceeds our own spend caps.
   notice:input.address && readiness?.congested===true?'busy' as const:null,limits:{minimum:usd(input.minimum),maximum:usd(input.maximum)},receipts};
}
