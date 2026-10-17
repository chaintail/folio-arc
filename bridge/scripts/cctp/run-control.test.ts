import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runControl} from './run-control.js';
import {SourceStore} from '../../src/bridge/transfer-record.js';
import {route} from '../../src/bridge/source-registry.js';
import {reverifyAta} from '../../src/bridge/solana.js';
import {owner,wallet,destination,event,ataData} from '../../test/bridge/support.js';
import {CCTP} from '../../src/bridge/registry.js';

test('ata-check reports missing and existing ATA details from a throwaway SQLite run',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cctp-ata-check-'));
 try {
  const db=join(dir,'run.sqlite'),store=new SourceStore(db),d=await destination();
  store.ingest('base',wallet,1n,[event('base',1_000000n,1)]);
  const s=store.plan(route('base',1_000000n),wallet,'fixture-person',d,'2026-10-02T12:00:00Z')!;
  store.close();
  const input=join(dir,'input.json');writeFileSync(input,JSON.stringify({db,chain:'base',minimum_6:'1000000',sweep:s.id,person:s.person,wallet:s.wallet,owner}));
  const rpcGuard={call:async<T>():Promise<T>=>{throw Error('owner must be checked before RPC');}};
  for(const suppliedOwner of [undefined,'11111111111111111111111111111111']) {
   writeFileSync(input,JSON.stringify({db,chain:'base',minimum_6:'1000000',sweep:s.id,person:s.person,wallet:s.wallet,owner:suppliedOwner}));
   await assert.rejects(runControl(['--action','ata-check','--input',input],{solanaRpc:rpcGuard}),/pinned identity required/);
  }
  writeFileSync(input,JSON.stringify({db,chain:'base',minimum_6:'1000000',sweep:s.id,person:s.person,wallet:s.wallet,owner}));
  await assert.rejects(reverifyAta({call:async<T>()=>({value:null}) as T},owner,d.ata),/USDC ATA missing/);
  for(const account of [null,{owner:CCTP.tokenProgram,executable:false,data:[Buffer.from(ataData()).toString('base64'),'base64'],lamports:1}]) {
   const out=join(dir,'ata-output.json');
   await runControl(['--action','ata-check','--input',input,'--out',out,'--dry-run'],{solanaRpc:{call:async<T>()=>({value:account}) as T}});
   const output=JSON.parse(readFileSync(out,'utf8')).result;
   assert.equal(output.ata,d.ata);assert.equal(output.expectedAta,d.ata);assert.equal(output.exists,!!account);
   assert.equal(output.owner,account?owner:null);assert.equal(output.mint,account?CCTP.usdc:null);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('resume requires explicit operator authority, exact ownership and audit reason and retains the original record without RPC',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cctp-resume-'));
 try {
  const db=join(dir,'run.sqlite'),store=new SourceStore(db),d=await destination();
  store.ingest('base',wallet,1n,[event('base',20_000000n,1)]);
  const s=store.plan(route('base'),wallet,'fixture-person',d,'2026-10-06T12:00:00Z')!;
  store.shared.hold(s.id,'PAYER_REPAIR_REQUIRED',1);store.close();
  const input=join(dir,'input.json'),out=join(dir,'out.json');
  const body={db,chain:'base',sweep:s.id,person:s.person,wallet:s.wallet,owner:s.destination_owner,reason:'Payer funding and authorization repaired'};
  writeFileSync(input,JSON.stringify(body));
  const rpc={call:async<T>():Promise<T>=>{throw Error('resume must be local');}};
  await assert.rejects(runControl(['--action','resume','--input',input,'--out',out],{solanaRpc:rpc}),/AUDITED_DIRECTOR/);
  writeFileSync(input,JSON.stringify({...body,owner:wallet}));
  await assert.rejects(runControl(['--action','resume','--input',input,'--out',out,'--i-am-the-director'],{solanaRpc:rpc}),/IDENTITY_MISMATCH/);
  writeFileSync(input,JSON.stringify(body));
  await runControl(['--action','resume','--input',input,'--out',out,'--i-am-the-director'],{solanaRpc:rpc});
  const reopened=new SourceStore(db);assert.equal(reopened.sweep(s.id).state,'planned');assert.equal(reopened.sweep(s.id).amount_6,'20000000');
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM bridge_transfer_resume').get()?.n,1);assert.equal(JSON.parse(readFileSync(out,'utf8')).broadcast,false);reopened.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
