import test from 'node:test';
import assert from 'node:assert/strict';
import {SourceStore} from '../../src/bridge/transfer-record.js';
import {DepositIntents,nextCheckAt,watchInterval,WATCH_PHASES} from '../../src/bridge/deposit-intent.js';
import {owner,wallet} from './support.js';
test('releaseSignerHolds moves signer-held intents to preparing and leaves others',()=>{
  const store=new SourceStore(),intents=new DepositIntents(store);
  try {
    const held=(person:string,chain:'base'|'arc',hold_reason:string)=>{const i=intents.create({person,chain,wallet,owner},1000);intents.update(i.id,{state:'held',hold_reason,failures:2,next_check_at:5000});return i.id;};
    const notAttached=held('alice','base','SOURCE_SIGNER_NOT_ATTACHED');
    const otherHold=held('alice','arc','FULL_SWEEP_EXCEEDS_CAP');
    const otherPerson=held('bob','base','SOURCE_SIGNER_NOT_ATTACHED');
    const unconfigured=held('carol','arc','SOURCE_SIGNER_UNCONFIGURED');
    assert.deepEqual(intents.releaseSignerHolds('alice',undefined,2000),[notAttached]);
    assert.deepEqual(intents.releaseSignerHolds('carol',undefined,2000),[unconfigured]);
    for(const id of [notAttached,unconfigured]){const i=intents.get(id)!;assert.equal(i.state,'preparing');assert.equal(i.hold_reason,null);assert.equal(i.failures,0);assert.equal(i.next_check_at,2000);assert.equal(i.expires_at,1000+86_400_000);}
    assert.equal(intents.get(otherHold)!.state,'held');assert.equal(intents.get(otherHold)!.hold_reason,'FULL_SWEEP_EXCEEDS_CAP');
    assert.equal(intents.get(otherPerson)!.state,'held');assert.equal(intents.get(otherPerson)!.hold_reason,'SOURCE_SIGNER_NOT_ATTACHED');
    // Idempotent, and a chain that already has an active intent keeps it.
    assert.deepEqual(intents.releaseSignerHolds('alice',undefined,3000),[]);
  } finally {store.close();}
});
test('releaseSignerHolds per chain (DA 1): a consent releases the permission holds of its own chain only',()=>{
  const store=new SourceStore(),intents=new DepositIntents(store);
  try {
    const held=(person:string,chain:'base'|'arc',hold_reason:string)=>{const i=intents.create({person,chain,wallet,owner},1000);intents.update(i.id,{state:'held',hold_reason,failures:1,next_check_at:5000});return i.id;};
    const required=held('alice','base','PERMISSION_REQUIRED'), arcDrift=held('alice','arc','POLICY_DRIFT');
    const owner_=held('dana','base','POLICY_OWNER_MISMATCH'), unrelated=held('erin','base','DESTINATION_BINDING_MISMATCH');
    const readFailed=held('fay','arc','POLICY_READ_UNAVAILABLE');
    // Base consent: Base released, Arc's drift hold waits for Arc's own consent.
    assert.deepEqual(intents.releaseSignerHolds('alice','base',2000),[required]);
    assert.equal(intents.get(required)!.state,'preparing');assert.equal(intents.get(arcDrift)!.state,'held');assert.equal(intents.get(arcDrift)!.hold_reason,'POLICY_DRIFT');
    assert.deepEqual(intents.releaseSignerHolds('alice','arc',2000),[arcDrift]);
    assert.deepEqual(intents.releaseSignerHolds('dana','base',2000),[owner_]);
    assert.deepEqual(intents.releaseSignerHolds('fay','arc',2000),[readFailed]);
    // Holds that are not about the signer or the permission stay.
    assert.deepEqual(intents.releaseSignerHolds('erin','base',2000),[]);assert.equal(intents.get(unrelated)!.hold_reason,'DESTINATION_BINDING_MISMATCH');
  } finally {store.close();}
});
test('create while held returns the held intent: a BELOW_MINIMUM hold resumes, another hold stays',()=>{
  const store=new SourceStore(),intents=new DepositIntents(store);
  try {
    const first=intents.create({person:'alice',chain:'base',wallet,owner},1000);
    intents.update(first.id,{state:'held',hold_reason:'BELOW_MINIMUM',failures:1,next_check_at:9000});
    const again=intents.create({person:'alice',chain:'base',wallet,owner},2000);
    assert.equal(again.id,first.id);
    assert.equal(again.state,'preparing');assert.equal(again.hold_reason,null);assert.equal(again.failures,0);
    assert.equal(again.next_check_at,2000);assert.equal(again.expires_at,2000+86_400_000);
    assert.equal(intents.create({person:'alice',chain:'base',wallet,owner},3000).id,first.id);
    // Waiting below the minimum is open: still the same intent.
    intents.update(first.id,{state:'waiting',hold_reason:'BELOW_MINIMUM'});
    assert.equal(intents.create({person:'alice',chain:'base',wallet,owner},4000).id,first.id);
    const arc=intents.create({person:'alice',chain:'arc',wallet,owner},1000);
    intents.update(arc.id,{state:'held',hold_reason:'SOURCE_ROUTE_MISMATCH'});
    const arcAgain=intents.create({person:'alice',chain:'arc',wallet,owner},2000);
    assert.equal(arcAgain.id,arc.id);assert.equal(arcAgain.state,'held');assert.equal(arcAgain.hold_reason,'SOURCE_ROUTE_MISMATCH');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM bridge_deposit_intent WHERE person='alice'").get()?.n,2);
    // Only the legacy sweep import creates beside a held intent.
    assert.notEqual(intents.create({person:'alice',chain:'arc',wallet,owner},3000,{reuseHeld:false}).id,arc.id);
  } finally {store.close();}
});
test('repairDuplicates ends older duplicate held intents as SUPERSEDED and resumes the newest BELOW_MINIMUM one',()=>{
  const store=new SourceStore(),intents=new DepositIntents(store);
  try {
    const held=(person:string,at:number)=>{const i=intents.create({person,chain:'base',wallet,owner},at,{reuseHeld:false});
      intents.update(i.id,{state:'held',hold_reason:'BELOW_MINIMUM',readiness:'{}',next_check_at:at});return i.id;};
    const ids=[1000,2000,3000,4000,5000,6000].map(at=>held('alice',at)),bob=held('bob',1000);
    const repaired=intents.repairDuplicates(7000);
    assert.deepEqual(repaired.superseded,ids.slice(0,5));assert.deepEqual(repaired.resumed,[bob,ids[5]]);
    for(const id of ids.slice(0,5)){const i=intents.get(id)!;assert.equal(i.state,'ended');assert.equal(i.hold_reason,'SUPERSEDED');}
    const newest=intents.get(ids[5])!;assert.equal(newest.state,'waiting');assert.equal(newest.hold_reason,'BELOW_MINIMUM');assert.equal(newest.next_check_at,7000);
    assert.equal(intents.get(bob)!.state,'waiting');
    assert.equal(intents.create({person:'alice',chain:'base',wallet,owner},8000).id,ids[5]);
    assert.deepEqual(intents.repairDuplicates(9000),{superseded:[],resumed:[]});
  } finally {store.close();}
});
const DAY=86_400_000;
const audits=(store:SourceStore,id:string)=>Number(store.db.prepare('SELECT count(*) AS n FROM bridge_repair_audit WHERE record_id=?').get(id)?.n??0);
test('watch:false hands out the address unarmed: preparing runs once, waiting is not due until armed',()=>{
  const store=new SourceStore(),intents=new DepositIntents(store);
  try {
    const i=intents.create({person:'alice',chain:'base',wallet,owner},1000,{watch:false});
    assert.equal(i.watch_started_at,null);assert.equal(i.expires_at,1000+DAY);
    // Readiness still runs so the address can be shown.
    assert.deepEqual(intents.due(1000).map(r=>r.id),[i.id]);
    intents.update(i.id,{state:'waiting',readiness:'{}',next_check_at:16_000});
    for(const at of [16_000,60_000,3_600_000])assert.deepEqual(intents.due(at),[]);
    // Reusing the open intent with watch:false leaves it unarmed.
    assert.equal(intents.create({person:'alice',chain:'base',wallet,owner},2000,{watch:false}).watch_started_at,null);
  } finally {store.close();}
});
test('the default create (every older client) watches from creation; watch:true arms an unarmed open intent',()=>{
  const store=new SourceStore(),intents=new DepositIntents(store);
  try {
    const i=intents.create({person:'alice',chain:'base',wallet,owner},1000);
    assert.equal(i.watch_started_at,1000);intents.update(i.id,{state:'waiting',next_check_at:16_000});
    assert.deepEqual(intents.due(16_000).map(r=>r.id),[i.id]);
    const arc=intents.create({person:'alice',chain:'arc',wallet,owner},1000,{watch:false});intents.update(arc.id,{state:'waiting',next_check_at:6000});
    const armed=intents.create({person:'alice',chain:'arc',wallet,owner},50_000);
    assert.equal(armed.id,arc.id);assert.equal(armed.watch_started_at,50_000);assert.equal(armed.expires_at,50_000+DAY);assert.equal(armed.next_check_at,50_000);
  } finally {store.close();}
});
test('arm: started, then renewed (phase 1 restarts, no audit, never an earlier read), restarted after CHECKING_ENDED; no-op when funded or complete',()=>{
  const store=new SourceStore(),intents=new DepositIntents(store);
  try {
    const i=intents.create({person:'alice',chain:'base',wallet,owner},1000,{watch:false});
    intents.update(i.id,{state:'waiting',readiness:'{}',next_check_at:16_000});
    const started=intents.arm(i.id,'alice',90_000,'reveal');
    assert.equal(started.watch_started_at,90_000);assert.equal(started.expires_at,90_000+DAY);assert.equal(started.next_check_at,90_000);assert.equal(started.state,'waiting');
    assert.deepEqual(intents.due(90_000).map(r=>r.id),[i.id]);
    intents.update(i.id,{next_check_at:105_000});
    // A second signal restarts phase 1 (and the 24 h) from now; the next read is not moved earlier.
    const renewed=intents.arm(i.id,'alice',95_000,'copy');
    assert.equal(renewed.watch_started_at,95_000);assert.equal(renewed.expires_at,95_000+DAY);assert.equal(renewed.next_check_at,105_000);assert.equal(audits(store,i.id),0);
    // Deep in phase 3 (next read 10 min away), a signal brings the next read within one phase-1 interval.
    intents.update(i.id,{watch_started_at:0,next_check_at:7_800_000});
    assert.equal(intents.arm(i.id,'alice',7_300_000,'reveal').next_check_at,7_315_000);
    assert.throws(()=>intents.arm(i.id,'bob',95_000,'reveal'),/INTENT_FORBIDDEN/);
    // The checking window ends 24 h after the last signal; a later signal restarts checking.
    assert.deepEqual(intents.due(7_300_000+DAY),[]);assert.equal(intents.get(i.id)!.hold_reason,'CHECKING_ENDED');
    const at=7_400_000+DAY,restarted=intents.arm(i.id,'alice',at,'open_wallet');
    assert.equal(restarted.state,'preparing');assert.equal(restarted.hold_reason,null);assert.equal(restarted.watch_started_at,at);
    assert.equal(restarted.expires_at,at+DAY);assert.equal(audits(store,i.id),1);
    intents.update(i.id,{state:'funded'});const funded=intents.get(i.id)!;
    assert.deepEqual(intents.arm(i.id,'alice',at+1000,'reveal'),funded);
    intents.update(i.id,{state:'complete'});const complete=intents.get(i.id)!;
    assert.deepEqual(intents.arm(i.id,'alice',at+1000,'reveal'),complete);
  } finally {store.close();}
});
test('arm on a held intent never resumes it, but records the start so a released hold is read',()=>{
  const store=new SourceStore(),intents=new DepositIntents(store);
  try {
    const i=intents.create({person:'alice',chain:'base',wallet,owner},1000,{watch:false});
    intents.update(i.id,{state:'held',hold_reason:'SOURCE_SIGNER_NOT_ATTACHED'});
    const held=intents.arm(i.id,'alice',5000,'reveal');
    assert.equal(held.state,'held');assert.equal(held.hold_reason,'SOURCE_SIGNER_NOT_ATTACHED');assert.equal(held.watch_started_at,5000);
    assert.deepEqual(intents.releaseSignerHolds('alice',undefined,6000),[i.id]);intents.update(i.id,{state:'waiting'});
    assert.deepEqual(intents.due(6000).map(r=>r.id),[i.id]);
  } finally {store.close();}
});
test('Check again on an unarmed intent starts the watch with no other signal',()=>{
  const store=new SourceStore(),intents=new DepositIntents(store);
  try {
    const i=intents.create({person:'alice',chain:'base',wallet,owner},1000,{watch:false});
    intents.update(i.id,{state:'waiting',readiness:'{}',next_check_at:16_000});
    const checked=intents.rearm(i.id,'alice',40_000,'User requested checking');
    assert.equal(checked.state,'waiting');assert.equal(checked.watch_started_at,40_000);assert.equal(checked.expires_at,40_000+DAY);assert.equal(checked.next_check_at,40_000);
    assert.deepEqual(intents.due(40_000).map(r=>r.id),[i.id]);assert.equal(audits(store,i.id),0);
    // Once armed, Check again restarts phase 1 from that moment and reads at the next pass.
    intents.update(i.id,{watch_started_at:0,next_check_at:7_800_000});
    const again=intents.rearm(i.id,'alice',7_300_000,'User requested checking');
    assert.equal(again.watch_started_at,7_300_000);assert.equal(again.next_check_at,7_300_000);assert.equal(again.expires_at,7_300_000+DAY);
    assert.equal(again.state,'waiting');assert.equal(audits(store,i.id),0);
    // A next read already sooner is never moved later.
    intents.update(i.id,{next_check_at:7_305_000});
    assert.equal(intents.rearm(i.id,'alice',7_310_000,'User requested checking').next_check_at,7_305_000);
  } finally {store.close();}
});
test('migration: intents stored before watch_started_at existed are backfilled from created_at and keep being read',()=>{
  const store=new SourceStore();
  try {
    store.db.exec(`CREATE TABLE bridge_deposit_intent (
      id TEXT PRIMARY KEY,person TEXT NOT NULL,chain TEXT NOT NULL,wallet TEXT NOT NULL,owner TEXT NOT NULL,
      state TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,next_check_at INTEGER NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0,boundary TEXT,readiness TEXT,hold_reason TEXT,recovery_tx TEXT)`);
    const insert=store.db.prepare(`INSERT INTO bridge_deposit_intent(id,person,chain,wallet,owner,state,created_at,expires_at,next_check_at,hold_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    insert.run('open-waiting','alice','base',wallet,owner,'waiting',1000,1000+DAY,16_000,null);
    insert.run('open-preparing','bob','arc',wallet,owner,'preparing',2000,2000+DAY,2000,null);
    insert.run('held','carol','base',wallet,owner,'held',3000,3000+DAY,3000,'SOURCE_SIGNER_NOT_ATTACHED');
    const intents=new DepositIntents(store);
    assert.deepEqual(['open-waiting','open-preparing','held'].map(id=>intents.get(id)!.watch_started_at),[1000,2000,3000]);
    assert.deepEqual(intents.due(16_000).map(r=>r.id).sort(),['open-preparing','open-waiting']);
    // The step runs once: a later boot never re-arms an intent created unarmed.
    const fresh=intents.create({person:'dave',chain:'base',wallet,owner},4000,{watch:false});
    new DepositIntents(store);assert.equal(intents.get(fresh.id)!.watch_started_at,null);
  } finally {store.close();}
});
test('watch schedule: chain rate for 15 min, every 2 min to 1 h, every 10 min to the end; a restart is phase 1 again',()=>{
  const MIN=60_000,start=1_000_000;
  assert.equal(WATCH_PHASES.length,3);
  for(const [elapsed,base,arc] of [[0,15_000,5_000],[15*MIN-1,15_000,5_000],[15*MIN,2*MIN,2*MIN],[60*MIN-1,2*MIN,2*MIN],[60*MIN,10*MIN,10*MIN],[DAY-1,10*MIN,10*MIN]] as const) {
    assert.equal(watchInterval(start,start+elapsed,'base'),base,`base at ${elapsed}`);assert.equal(watchInterval(start,start+elapsed,'arc'),arc,`arc at ${elapsed}`);
    assert.equal(nextCheckAt(start,start+elapsed,'base'),start+elapsed+base);
  }
  // Not started (readiness only): the chain's rate.
  assert.equal(nextCheckAt(null,5000,'base'),20_000);assert.equal(nextCheckAt(null,5000,'arc'),10_000);
  // Restart: Check again or a new signal at 3 h moves the start, so the next read is phase 1 again.
  const restart=start+3*60*MIN;
  assert.equal(nextCheckAt(start,restart,'base'),restart+10*MIN);assert.equal(nextCheckAt(restart,restart,'base'),restart+15_000);
  assert.equal(nextCheckAt(restart,restart+16*MIN,'base'),restart+18*MIN);
});
