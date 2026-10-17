import test from 'node:test';
import assert from 'node:assert/strict';
import {SourceStore} from '../../src/bridge/transfer-record.js';
import {DepositIntents} from '../../src/bridge/deposit-intent.js';
import {ensureIntentAta,type SetupPorts} from '../../src/bridge/deposit-readiness.js';
import {readAta,owner,wallet} from './support.js';

async function setupFixture() {
 const store=new SourceStore(),intents=new DepositIntents(store),i=intents.create({person:'alice',chain:'base',wallet,owner},1000);
 store.db.prepare("INSERT INTO bridge_setup_attempt VALUES ('setup',?,'signature','uncertain',?,'0')").run(i.id,JSON.stringify({last_valid_block_height:300}));
 let height=300,status:unknown=null;const calls:string[]=[];
 const setup:SetupPorts={maxCost:3000000n,delivery:{live:true,payer:owner,prepare:async()=>{throw Error('Unexpected prepare');},submit:async()=>{throw Error('Unexpected submit');}},
  rpc:{async call<T>(method:string):Promise<T>{calls.push(method);
   if(method==='getSignatureStatuses')return {value:[status]} as T;
   if(method==='getBlockHeight')return height as T;
   if(method==='getTransaction')return {meta:{fee:5000,preBalances:[10000000],postBalances:[7955720]}} as T;
   throw Error(method);
  }}};
 return {store,intents,i,setup,calls,height(n:number){height=n;},status(s:unknown){status=s;},row:()=>store.db.prepare('SELECT * FROM bridge_setup_attempt').get()!};
}
test('T12: account exists waits through expiry height, then supersedes the absent signature and proceeds',async()=>{
 const f=await setupFixture();try {
  assert.equal(await ensureIntentAta(f.intents,f.i,readAta,f.setup),undefined);assert.equal(f.row().state,'uncertain');
  f.height(301);assert.ok(await ensureIntentAta(f.intents,f.i,readAta,f.setup));assert.equal(f.row().state,'superseded');
  const calls=f.calls.length;assert.ok(await ensureIntentAta(f.intents,f.i,readAta,f.setup));assert.equal(f.calls.length,calls);
  assert.deepEqual(f.calls,['getSignatureStatuses','getBlockHeight','getSignatureStatuses','getBlockHeight']);
 }finally{f.store.close();}
});
test('T12: a processed setup may still finalize; late finalized receipt is recorded once',async()=>{
 const f=await setupFixture();try {
  f.height(301);f.status({confirmationStatus:'processed',err:null});assert.equal(await ensureIntentAta(f.intents,f.i,readAta,f.setup),undefined);assert.equal(f.row().state,'uncertain');
  f.status({confirmationStatus:'finalized',err:null});assert.ok(await ensureIntentAta(f.intents,f.i,readAta,f.setup));assert.equal(f.row().state,'confirmed');assert.equal(f.row().cost_raw,'2044280');
  assert.ok(await ensureIntentAta(f.intents,f.i,readAta,f.setup));assert.equal(f.calls.filter(c=>c==='getTransaction').length,1);
 }finally{f.store.close();}
});
test('T12: missing setup ports cannot bypass an unresolved setup signature',async()=>{
 const f=await setupFixture();try {assert.equal(await ensureIntentAta(f.intents,f.i,readAta),undefined);assert.equal(f.row().state,'uncertain');}finally{f.store.close();}
});
