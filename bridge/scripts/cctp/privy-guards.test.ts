import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { guardedArgs } from './privy-common.js';
import { evmKey } from './privy-evm-key.js';
import { prove, permissionRequests } from './privy-evm-prove.js';
import { evmSignBody, EVM_USDC, EVM_MESSENGER, PROOF_ALLOWED_KINDS, PROOF_DENIED_KINDS } from 'wallet-privy/server';
import { parseSourceArgs } from './run-source.js';
const ata='3wvJdyFnGvaMWpbq93NU91SggiVRveULUXL6iX5VZDGP',other='AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
test('all new Privy scripts default dry, require both Director flags, reject mixed flags and unknown options before IO',async()=>{
  assert.equal(guardedArgs([],[]).live,false);
  for(const args of [['--execute'],['--execute','--dry-run','--i-am-the-director'],['--unknown']])assert.throws(()=>guardedArgs(args,[]));
  for(const fn of [evmKey,prove])await assert.rejects(fn(['--execute']));
  assert.equal(parseSourceArgs(['--db','/tmp/test-db','--chain','arc','--sweep','sweep','--run-dir','/tmp/run','--privy']).privy,true);
});
test('policy/proof dry-run print exact bodies with no transport or environment-dependent configuration',async()=>{
  const log=console.log,fetcher=globalThis.fetch,printed:any[]=[];console.log=(s:string)=>printed.push(JSON.parse(s));globalThis.fetch=async()=>{throw Error('dry-run fetch forbidden');};
  try {
    for(const [chain,id] of [['base',8453],['arc',5042]] as const) {
      await prove(['--chain',chain,'--person','live:alice','--ata',ata,'--other-ata',other]);const proof=printed.at(-1);
      assert.equal(proof.broadcast,false);assert.equal(proof.template,`deposit.${chain}`);assert.equal(proof.requests.length,15);assert.deepEqual(proof.chains,[id]);
      assert.equal(proof.requests.every((r:any)=>r.body.method==='eth_signTransaction'),true);
    }
    await assert.rejects(prove(['--person','live:alice','--ata',ata,'--other-ata',other]),/PROOF_CHAIN_REQUIRED/);
    assert.equal(JSON.stringify(printed).includes('authorization_key'),false);
  }finally{console.log=log;globalThis.fetch=fetcher;}
});
test('authorization key generation writes a new mode-600 file, never private stdout, and refuses overwrite/sensitive paths',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'evm-fixture-key-')),out=join(dir,'fixture.pem'),log=console.log,printed:any[]=[];console.log=(s:string)=>printed.push(JSON.parse(s));
  try {
    await evmKey(['--private-key-out',out,'--dry-run']);assert.equal(statSync(out).mode&0o777,0o600);assert.equal(printed[0].request.path,'/v1/key_quorums');assert.equal(printed[0].request.body.authorization_threshold,1);assert.equal(JSON.stringify(printed).includes('PRIVATE KEY'),false);
    await assert.rejects(evmKey(['--private-key-out',out]));
    await assert.rejects(evmKey(['--private-key-out',join(dir,'.env')]));
  }finally{console.log=log;rmSync(dir,{recursive:true});}
});
test('proof vectors per template: chain-prefixed names, its own chain and token, the other chain\'s burn as a denied case, and every mutation distinct',()=>{
  const key=(t:object)=>JSON.stringify(evmSignBody(t as never));
  for(const [template,chain,otherChain] of [['base',8453,5042],['arc',5042,8453]] as const) {
    const requests=permissionRequests(template,ata,other),mine=requests.filter(r=>r.chain===chain);
    assert.equal(mine.length,requests.length,'every vector is named for this template\'s chain');
    assert.deepEqual(mine.map(r=>r.name).sort(),[...PROOF_ALLOWED_KINDS,...PROOF_DENIED_KINDS].map(k=>`${chain}-${k}`).sort());
    const approve=mine.find(r=>r.kind==='allowed-approve')!,burn=mine.find(r=>r.kind==='allowed-burn')!;
    assert.equal(approve.transaction.chainId,chain);assert.equal(approve.transaction.to.toLowerCase(),EVM_USDC[chain].toLowerCase());
    assert.equal(burn.transaction.chainId,chain);assert.equal(burn.transaction.to.toLowerCase(),EVM_MESSENGER.toLowerCase());
    assert.ok(burn.transaction.data.toLowerCase().includes(EVM_USDC[chain].slice(2).toLowerCase()),'burn token is this chain USDC');
    for(const r of mine.filter(r=>r.allowed))assert.equal(key(r.transaction),key(r.pinned));
    for(const r of mine.filter(r=>!r.allowed)) {
      assert.ok(r.pinned===approve.transaction || r.pinned===burn.transaction,`${r.name} pinned to an allowed base`);
      assert.notEqual(key(r.transaction),key(r.pinned),`${r.name} differs from its base`);
      for(const allowed of requests.filter(x=>x.allowed))assert.notEqual(key(r.transaction),key(allowed.transaction),`${r.name} equals ${allowed.name}`);
    }
    // The other-chain case is exactly the other template's allowed burn.
    const otherBurn=permissionRequests(template==='base'?'arc':'base',ata,other).find(r=>r.kind==='allowed-burn')!;
    assert.equal(key(mine.find(r=>r.kind==='other-chain')!.transaction),key(otherBurn.transaction));assert.equal(otherBurn.transaction.chainId,otherChain);
    assert.equal(new Set(requests.map(r=>key(r.transaction))).size,requests.length,'all 15 bodies distinct');
  }
  assert.throws(()=>permissionRequests('base',ata,ata),/DISTINCT_TEST_ATA_REQUIRED/);
  assert.throws(()=>permissionRequests('solana' as 'base',ata,other),/UNSUPPORTED_PROOF_CHAIN/);
});
