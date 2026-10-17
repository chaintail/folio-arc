import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseSourceArgs,runSource} from './run-source.js';
import {parseSignerArgs} from './sign-with-key.js';
import {privateFile} from './private-file.js';
import {parseDeliveryArgs} from '../../src/bridge/director-delivery.js';
import {owner} from '../../test/bridge/support.js';
const args=['--db','/tmp/fixture.sqlite','--chain','arc','--sweep','fixture','--run-dir','/tmp/evidence','--owner',owner];
test('source CLI dry-run default and independent Director gate, named route, bounded caps',()=>{
 assert.equal(parseSourceArgs(args).execute,false);
 for(const flags of [['--execute'],['--execute','--i-am-the-director'],['--execute','--i-am-the-director','--authorization-ref','fixture'],['--rpc','https://bad.invalid'],['--timeout-ms','999999999'],['--dry-run','--execute','--i-am-the-director']])assert.throws(()=>parseSourceArgs([...args,...flags]));
 const v=parseSourceArgs([...args,'--execute','--i-am-the-director','--authorization-ref','fixture','--max-topup-raw','1','--max-source-fee-raw','1','--implementation-hash',`0x${'11'.repeat(32)}`]);assert.equal(v.execute,true);
 assert.throws(()=>parseSourceArgs(args.map(a=>a==='arc'?'ethereum':a)));assert.throws(()=>parseSourceArgs(args.map(a=>a==='/tmp/fixture.sqlite'?'/tmp/.secrets/test':a)));
});
test('source CLI execute refuses simulation and incomplete process gates before opening files',async()=>{
 const execute=[...args,'--execute','--i-am-the-director','--authorization-ref','fixture','--max-topup-raw','1','--max-source-fee-raw','1','--implementation-hash',`0x${'11'.repeat(32)}`];
 for(const env of [{},{FOLIO_NAMESPACE_MODE:'simulation',FOLIO_BRIDGE_SOURCE:'1',FOLIO_BRIDGE_EXECUTE:'1'},{FOLIO_NAMESPACE_MODE:'live',FOLIO_BRIDGE_SOURCE:'1'}])await assert.rejects(runSource(execute,env),/SOURCE_EXECUTION_DISABLED/);
});
test('separate signer requires Director identity and private mode-600 file; no signer executed',()=>{
 const v=['--transaction','/tmp/unsigned.json','--key-file','/tmp/private-key','--out','/tmp/wire'];assert.throws(()=>parseSignerArgs(v));assert.equal(parseSignerArgs([...v,'--i-am-the-director']).out,'/tmp/wire');
 const dir=mkdtempSync(join(tmpdir(),'cctp-private-')),file=join(dir,'wire');writeFileSync(file,'synthetic wire',{mode:0o644});assert.throws(()=>privateFile(file),/MODE/);
 const privatePath=join(dir,'private');writeFileSync(privatePath,'synthetic wire',{mode:0o600});assert.equal(privateFile(privatePath),'synthetic wire');symlinkSync(privatePath,join(dir,'link'));assert.throws(()=>privateFile(join(dir,'link')));
 rmSync(dir,{recursive:true});
});

test('explicit destination owner is required and validated before source IO',()=>{
 assert.throws(()=>parseSourceArgs(args.slice(0,-2)),/DESTINATION_OWNER_REQUIRED/);
 assert.throws(()=>parseSourceArgs([...args.slice(0,-2),'--owner','invalid-address']));
 assert.equal(parseSourceArgs(args).owner,owner);
 assert.equal(parseSourceArgs([...args.slice(0,-2),'--privy']).privy,true);
});

test('delivery owner is explicit and valid while amount and execution guards remain',()=>{
 const delivery=['--db','/tmp/fixture.sqlite','--sweep','fixture','--burn-hash',`0x${'11'.repeat(32)}`,'--owner',owner,
  '--fee-payer','11111111111111111111111111111111','--max-amount-6','1000000','--max-cost-lamports','10000'];
 assert.equal(parseDeliveryArgs(delivery).owner,owner);
 assert.equal(parseDeliveryArgs(delivery).live,false);
 assert.throws(()=>parseDeliveryArgs(delivery.map(v=>v===owner?'invalid-address':v)));
 assert.throws(()=>parseDeliveryArgs(delivery.map(v=>v==='11111111111111111111111111111111'?owner:v)),/person cannot pay/);
 assert.throws(()=>parseDeliveryArgs([...delivery,'--execute']),/live requires/);
 assert.throws(()=>parseDeliveryArgs(delivery.map(v=>v==='1000000'?'0':v)),/invalid --max-amount-6/);
});
