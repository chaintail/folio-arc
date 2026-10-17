import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PrivyError, evmSignBody, policyTemplateDigest, verifyPermissionProof, permissionProofRecord, type DepositChain, type HttpRequest, type HttpResponse, type PrivyTransport } from 'wallet-privy/server';
import { verifiedReceipt as receiptFixture } from '../../test/permission-proof-support.js';
import { associatedTokenAddress } from '../../src/shims/associated-token.js';
import { CCTP } from '../../src/bridge/registry.js';
import { prove, permissionRequests, signOnlyTransport, type PermissionRequest } from './privy-evm-prove.js';

const owner='3wvJdyFnGvaMWpbq93NU91SggiVRveULUXL6iX5VZDGP',other='AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9',person='live:disposable',walletId='proof-wallet';
/** 'sign' follows the policy (denied cases are refused); 'accept' signs regardless, a negative-control success. */
type Behaviour='sign'|'accept'|'deny'|'timeout'|'auth'|'http400'|'tamper'|'wrong-key';
/** [receiptPatch]: changes to the person's verified receipt; null writes no receipt table at all. */
async function fixture(receiptPatch:Record<string,unknown>|null={},chain:DepositChain='base') {
  const dir=mkdtempSync(join(tmpdir(),'evm-prove-')),dbPath=join(dir,'people.db'),ata=await associatedTokenAddress(owner,CCTP.usdc,CCTP.tokenProgram);
  const account=privateKeyToAccount(generatePrivateKey()),stranger=privateKeyToAccount(generatePrivateKey()),auth=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const prefix=`FOLIO_EVM_${chain.toUpperCase()}`;
  const env={PRIVY_APP_ID:'fixture-app',PRIVY_APP_SECRET:'synthetic-not-a-credential',[`${prefix}_KEY_QUORUM_ID`]:`${chain}-quorum`,
    [`${prefix}_AUTHORIZATION_KEY`]:auth.privateKey.export({format:'pem',type:'pkcs8'}).toString()};
  const evm_wallet={id:walletId,address:account.address};
  const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE person_wallets (namespace TEXT PRIMARY KEY, scope TEXT NOT NULL)');
  db.prepare('INSERT INTO person_wallets VALUES (?,?)').run(person,JSON.stringify({namespace:{kind:'live',person_id:'x'},wallet_address:owner,evm_wallet}));
  if(receiptPatch) {
    const r={...receiptFixture({chain,person,wallet:evm_wallet,ata,quorum:`${chain}-quorum`}),...receiptPatch} as Record<string,unknown>;
    db.exec(`CREATE TABLE permission_receipt (${Object.keys(r).join(',')})`);
    db.prepare(`INSERT INTO permission_receipt VALUES (${Object.keys(r).map(()=>'?').join(',')})`).run(...Object.values(r) as never[]);
  }
  db.close();
  const requests=permissionRequests(chain,ata,other),seen:HttpRequest[]=[];
  // Simulated Privy: only the exact allowed bodies are signed, unless a behaviour overrides a case.
  const privy=(behave:(r:PermissionRequest)=>Behaviour=()=>'sign'):PrivyTransport=>({async request(req) {
    seen.push(req);const body=JSON.parse(req.body!),r=requests.find(x=>isDeepStrictEqual(JSON.parse(JSON.stringify(evmSignBody(x.transaction))),body));
    assert.ok(r,'request is one of the vectors');
    const mode=behave(r),act=mode==='sign'&&!r.allowed?'deny':mode;
    if(act==='timeout')throw new PrivyError('PRIVY_TRANSPORT_TIMEOUT');
    if(act==='auth')return {status:401,body:{code:'invalid_authorization_signature'}};
    if(act==='http400')return {status:400,body:{code:'invalid_request'}};
    if(act==='deny')return {status:400,body:{code:'policy_violation'}};
    const t=act==='tamper'?{...r.transaction,nonce:r.transaction.nonce+1}:r.transaction;
    const signed=await (act==='wrong-key'?stranger:account).signTransaction({type:'eip1559',chainId:t.chainId,to:t.to,value:t.value,data:t.data,nonce:t.nonce,gas:t.gas,maxFeePerGas:t.maxFeePerGas,maxPriorityFeePerGas:t.maxPriorityFeePerGas});
    return {status:200,body:{data:{encoding:'rlp',signed_transaction:signed}}} satisfies HttpResponse;
  }});
  const args=(extra:string[]=[])=>['--execute','--i-am-the-director','--chain',chain,'--person',person,'--disposable-person',person,'--ata',ata,'--other-ata',other,'--db',dbPath,...extra];
  return {dir,dbPath,ata,env,auth,requests,seen,privy,args,prefix,cleanup:()=>rmSync(dir,{recursive:true})};
}
async function quiet<T>(run:()=>Promise<T>):Promise<{value?:T;error?:unknown;printed:any[]}> {
  const log=console.log,fetcher=globalThis.fetch,printed:any[]=[];console.log=(s:string)=>printed.push(JSON.parse(s));globalThis.fetch=async()=>{throw Error('live fetch forbidden in tests');};
  try {return {value:await run(),printed};}catch(error){return {error,printed};}finally{console.log=log;globalThis.fetch=fetcher;}
}
const summaryOf=(printed:any[])=>printed.find(p=>p && typeof p==='object' && 'permission_boundary' in p);
const deps=(f:Awaited<ReturnType<typeof fixture>>,transport:PrivyTransport)=>({transport,env:f.env,now:()=>new Date('2026-10-08T12:00:00Z'),revision:()=>'0199d6e'});

for(const chain of ['base','arc'] as const)test(`${chain}: allowed wires validated, every denial (other-chain included) explicit, PASS record printed, written to --out and verifiable`,async()=>{
  const f=await fixture({},chain),out=join(f.dir,'proof.json'),chainId=chain==='base'?8453:5042;
  try {
    const {value:record,error,printed}=await quiet(()=>prove(f.args(['--out',out]),deps(f,f.privy())));
    assert.equal(error,undefined);
    const summary=summaryOf(printed);assert.equal(summary.permission_boundary,'PASS');assert.equal(summary.broadcast,false);assert.equal(summary.results.length,15);
    assert.deepEqual(summary.results.find((r:any)=>r.name===`${chainId}-other-chain`),{name:`${chainId}-other-chain`,chain:chainId,allowed:false,privy:'policy_denied',validator:'not_run'});
    for(const r of summary.results)assert.deepEqual([r.privy,r.validator],r.allowed?['accepted','accepted']:['policy_denied','not_run'],r.name);
    const keyDigest=createHash('sha256').update(createPublicKey(f.auth.privateKey).export({format:'der',type:'spki'})).digest('hex');
    assert.deepEqual(record,{version:2,result:'PASS',template:`deposit.${chain}`,chain:chainId,proved_at:'2026-10-08T12:00:00.000Z',key_quorum_id:`${chain}-quorum`,authorization_public_key_sha256:keyDigest,
      policy_template_sha256:policyTemplateDigest(chain),cases:{allowed:2,denied:13},deployed_revision:'0199d6e'});
    assert.deepEqual(printed[2],record);
    const written=readFileSync(out,'utf8');assert.deepEqual(JSON.parse(written),record);assert.equal(statSync(out).mode&0o777,0o600);
    assert.deepEqual(verifyPermissionProof(written,{chain,keyQuorumId:`${chain}-quorum`,authorizationPublicKeySha256:keyDigest,policyTemplateSha256:policyTemplateDigest(chain)}),{ok:true});
    assert.equal(JSON.stringify(printed).includes('PRIVATE KEY'),false);assert.equal(written.includes(String(f.env[`${f.prefix}_AUTHORIZATION_KEY`]).split('\n')[1]!),false);
    // Sign-only: every provider call was eth_signTransaction on the bound wallet.
    assert.equal(f.seen.length,15);
    for(const req of f.seen) {assert.equal(req.method,'POST');assert.equal(req.url,`https://api.privy.io/v1/wallets/${walletId}/rpc`);assert.equal(JSON.parse(req.body!).method,'eth_signTransaction');}
    // A second run never overwrites evidence.
    assert.match(String((await quiet(()=>prove(f.args(['--out',out]),deps(f,f.privy())))).error),/EEXIST/);
  }finally{f.cleanup();}
});

test('a returned allowed wire that differs from the pinned transaction or wallet fails the proof',async()=>{
  for(const [target,mode,chain] of [['8453-allowed-burn','tamper','base'],['5042-allowed-approve','wrong-key','arc']] as const) {
    const f=await fixture({},chain),out=join(f.dir,'proof.json');
    try {
      const {error,printed}=await quiet(()=>prove(f.args(['--out',out]),deps(f,f.privy(r=>r.name===target?mode:'sign'))));
      assert.match(String(error),/PERMISSION_BOUNDARY_NOT_PROVEN/);assert.equal(summaryOf(printed).permission_boundary,'FAIL');
      assert.deepEqual(summaryOf(printed).results.find((r:any)=>r.name===target),{name:target,chain:Number(target.split('-')[0]),allowed:true,privy:'accepted',validator:'denied'});
      assert.equal(existsSync(out),false);
    }finally{f.cleanup();}
  }
});

test('timeouts, authorization failures and non-policy errors are unproven, never a deny pass; a negative-control success fails',async()=>{
  for(const [target,mode,chain] of [['8453-wrong-recipient','timeout','base'],['5042-wrong-spender','auth','arc'],['8453-nonzero-max-fee','http400','base'],['5042-allowed-burn','timeout','arc'],['8453-wrong-finality','accept','base'],['5042-other-chain','accept','arc']] as const) {
    const f=await fixture({},chain),out=join(f.dir,'proof.json');
    try {
      const {error,printed}=await quiet(()=>prove(f.args(['--out',out]),deps(f,f.privy(r=>r.name===target?mode:'sign'))));
      assert.match(String(error),/PERMISSION_BOUNDARY_NOT_PROVEN/,`${target}:${mode}`);assert.equal(summaryOf(printed).permission_boundary,'FAIL');
      const r=summaryOf(printed).results.find((x:any)=>x.name===target);assert.equal(r.privy,mode==='accept'?'accepted':'unproven_error');
      assert.equal(existsSync(out),false);
    }finally{f.cleanup();}
  }
});

test('receipt, quorum and ATA mismatches block before any provider IO',async()=>{
  const cases:[Record<string,unknown>|null,Record<string,string>,RegExp][]=[
    [null,{},/PERMISSION_RECEIPTS_UNAVAILABLE/],
    [{verified_at:null},{},/VERIFIED_RECEIPT_REQUIRED/],
    [{hold:'POLICY_DRIFT'},{},/VERIFIED_RECEIPT_REQUIRED/],
    [{revoke_requested_at:'2026-10-14T00:00:00.000Z'},{},/VERIFIED_RECEIPT_REQUIRED/],
    [{chain:'arc'},{},/VERIFIED_RECEIPT_REQUIRED/],
    [{ata:other},{},/PROVISIONED_TEST_PERSON_REQUIRED/],
    [{wallet_id:'another-wallet'},{},/PROVISIONED_TEST_PERSON_REQUIRED/],
    [{quorum_id:'another-quorum'},{},/PROOF_SIGNER_BINDING_MISMATCH/],
    [{},{FOLIO_EVM_BASE_KEY_QUORUM_ID:'rotated-quorum'},/PROOF_SIGNER_BINDING_MISMATCH/],
    // The retired single-quorum names configure no signer.
    [{},{FOLIO_EVM_BASE_KEY_QUORUM_ID:'',FOLIO_EVM_KEY_QUORUM_ID:'base-quorum'},/MISSING_FOLIO_EVM_BASE_KEY_QUORUM_ID/],
  ];
  for(const [patch,envPatch,expected] of cases) {
    const f=await fixture(patch);
    try {const {error}=await quiet(()=>prove(f.args(),{...deps(f,f.privy()),env:{...f.env,...envPatch}}));assert.match(String(error),expected);assert.equal(f.seen.length,0);}
    finally{f.cleanup();}
  }
  // A --chain that is not a deposit template.
  const c=await fixture();
  try {const {error}=await quiet(()=>prove(c.args().map(a=>a==='base'?'solana':a),deps(c,c.privy())));assert.match(String(error),/PROOF_CHAIN_REQUIRED/);assert.equal(c.seen.length,0);}
  finally{c.cleanup();}
  // --ata that the receipt carries but that is not the person's derived USDC ATA.
  const f=await fixture({ata:other});
  try {const {error}=await quiet(()=>prove(f.args().map(a=>a===f.ata?other:a===other?f.ata:a),deps(f,f.privy())));assert.match(String(error),/PERSON_ATA_MISMATCH/);assert.equal(f.seen.length,0);}
  finally{f.cleanup();}
  // Disposable acknowledgement is required too.
  const g=await fixture();
  try {const {error}=await quiet(()=>prove(g.args().filter((_,i,all)=>!(all[i-1]==='--disposable-person'||all[i]==='--disposable-person')),deps(g,g.privy())));assert.match(String(error),/DISPOSABLE_PERSON_ACK_REQUIRED/);assert.equal(g.seen.length,0);}
  finally{g.cleanup();}
});

test('a broadcast-capable method is never callable through the proof transport',async()=>{
  let calls=0;const inner:PrivyTransport={async request(){calls++;return {status:200,body:{}};}},guarded=signOnlyTransport(inner,walletId),url=`https://api.privy.io/v1/wallets/${walletId}/rpc`;
  const refused:HttpRequest[]=[
    {method:'POST',url,headers:{},body:JSON.stringify({method:'eth_sendTransaction',params:{transaction:{}}})},
    {method:'POST',url,headers:{},body:JSON.stringify({method:'signAndSendTransaction',caip2:'eip155:8453',sponsor:true,params:{}})},
    {method:'POST',url,headers:{},body:JSON.stringify({method:'eth_signTransaction',sponsor:true,params:{}})},
    {method:'POST',url:'https://api.privy.io/v1/wallets/someone-else/rpc',headers:{},body:JSON.stringify({method:'eth_signTransaction',params:{}})},
    {method:'PATCH',url:`https://api.privy.io/v1/wallets/${walletId}`,headers:{},body:JSON.stringify({additional_signers:[]})},
    {method:'POST',url:'https://api.privy.io/v1/policies',headers:{},body:JSON.stringify({method:'eth_signTransaction',params:{}})},
    {method:'GET',url,headers:{}},
  ];
  for(const req of refused)await assert.rejects(guarded.request(req),/SIGN_ONLY_TRANSPORT_REFUSED/);
  assert.equal(calls,0);
  await guarded.request({method:'POST',url,headers:{},body:JSON.stringify({method:'eth_signTransaction',params:{transaction:{}}})});assert.equal(calls,1);
  const source=readFileSync(new URL('./privy-evm-prove.ts',import.meta.url),'utf8');
  for(const forbidden of ['SponsoredSend','sendTransaction','sendRawTransaction','broadcast(','createPrivyAdmin','directorRest'])assert.equal(source.includes(forbidden),false,forbidden);
});

test('a declared PASS with the other template\'s vectors, or a missing case, is rejected',async()=>{
  const f=await fixture(),out=join(f.dir,'proof.json');
  try {
    const arcVectors=await quiet(()=>prove(f.args(['--out',out]),{...deps(f,f.privy()),requests:(_c,a,o)=>permissionRequests('arc',a,o)}));
    assert.match(String(arcVectors.error),/PERMISSION_BOUNDARY_NOT_PROVEN/);assert.equal(summaryOf(arcVectors.printed).permission_boundary,'FAIL');assert.match(summaryOf(arcVectors.printed).reason,/^UNEXPECTED_CASE:5042-/);
    assert.deepEqual(arcVectors.printed[0].chains,[5042]);
    const dropped=await quiet(()=>prove(f.args(['--out',out]),{...deps(f,f.privy()),requests:(c,a,o)=>permissionRequests(c,a,o).filter(r=>r.name!=='8453-other-chain')}));
    assert.match(String(dropped.error),/PERMISSION_BOUNDARY_NOT_PROVEN/);assert.equal(summaryOf(dropped.printed).reason,'MISSING_CASE:8453-other-chain');
    assert.equal(existsSync(out),false);
    // The record builder refuses the same incomplete evidence directly.
    const partial=permissionRequests('base',f.ata,other).filter(r=>r.kind!=='other-chain').map(r=>({name:r.name,chain:r.chain,allowed:r.allowed,privy:r.allowed?'accepted' as const:'policy_denied' as const,validator:r.allowed?'accepted' as const:'not_run' as const}));
    assert.throws(()=>permissionProofRecord({chain:'base',results:partial,provedAt:new Date(),keyQuorumId:'q',authorizationPublicKeySha256:'a'.repeat(64),deployedRevision:'0199d6e'}),/PERMISSION_PROOF_INCOMPLETE:MISSING_CASE:8453-other-chain/);
  }finally{f.cleanup();}
});
