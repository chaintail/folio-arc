import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, verify } from 'node:crypto';
import { loadDepositSigner, loadDepositSigners, loadPaySigner, paySignerEnv, PAY_SIGNER_ENV, depositSignerEnv, loadPolicyAdmin, createEvmSigner, createPrivyAdmin, evmPolicyDigest, signerAttachment, ownerQuorumMatches } from '../src/evm.js';
import { depositPolicy, depositPolicyDigest, depositPolicyTemplate } from '../src/evm-sweep-policy.js';
import { authorizationPublicKey } from '../src/authorization-signature.js';
import { PrivyError } from '../src/config.js';
import { createPrivyRest, canonical, type HttpRequest } from '../src/transport.js';
const pair=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const pem=(p:ReturnType<typeof pair>)=>p.privateKey.export({format:'pem',type:'pkcs8'}).toString();
function fixture() {
  const evm=pair(),arc=pair(),fee=pair(),admin=pair(),user=pair();
  const env:Record<string,string|undefined>={PRIVY_APP_ID:'fixture-app',PRIVY_APP_SECRET:'fixture-secret',PRIVY_KEY_QUORUM_ID:'fee-quorum',PRIVY_AUTHORIZATION_KEY:pem(fee),
    FOLIO_EVM_BASE_KEY_QUORUM_ID:'base-quorum',FOLIO_EVM_BASE_AUTHORIZATION_KEY:pem(evm),FOLIO_EVM_ARC_KEY_QUORUM_ID:'arc-quorum',FOLIO_EVM_ARC_AUTHORIZATION_KEY:pem(arc),
    FOLIO_POLICY_ADMIN_KEY:pem(admin),FOLIO_POLICY_ADMIN_PUBLIC_KEY:authorizationPublicKey(pem(admin))};
  return {evm,arc,fee,admin,user,env,config:loadDepositSigner(env,'base')};
}
test('per-chain deposit signers: separate keys and quorums from each other, the fee payer and the policy admin',()=>{
  const f=fixture();assert.equal(JSON.stringify(f.config),'{}');
  assert.equal(f.config.keyQuorumId,'base-quorum');assert.equal(loadDepositSigner(f.env,'arc').keyQuorumId,'arc-quorum');
  assert.deepEqual(Object.keys(loadDepositSigners(f.env)),['base','arc']);
  assert.deepEqual(Object.keys(loadDepositSigners({...f.env,FOLIO_EVM_ARC_KEY_QUORUM_ID:undefined,FOLIO_EVM_ARC_AUTHORIZATION_KEY:undefined})),['base']);
  const code=(fn:()=>unknown)=>{try{fn();}catch(e){return e instanceof PrivyError?e.code:String(e);}return 'ok';};
  assert.equal(code(()=>loadDepositSigner({...f.env,FOLIO_EVM_BASE_AUTHORIZATION_KEY:f.env.PRIVY_AUTHORIZATION_KEY},'base')),'EVM_FEE_PAYER_AUTHORITY_SHARED');
  assert.equal(code(()=>loadDepositSigner({...f.env,FOLIO_EVM_BASE_KEY_QUORUM_ID:'fee-quorum'},'base')),'EVM_FEE_PAYER_AUTHORITY_SHARED');
  assert.equal(code(()=>loadDepositSigner({...f.env,FOLIO_EVM_ARC_AUTHORIZATION_KEY:f.env.FOLIO_EVM_BASE_AUTHORIZATION_KEY},'arc')),'DEPOSIT_AUTHORITY_SHARED');
  assert.equal(code(()=>loadDepositSigner({...f.env,FOLIO_EVM_ARC_KEY_QUORUM_ID:'base-quorum'},'base')),'DEPOSIT_AUTHORITY_SHARED');
  assert.equal(code(()=>loadDepositSigners({...f.env,FOLIO_EVM_ARC_KEY_QUORUM_ID:'base-quorum'})),'DEPOSIT_AUTHORITY_SHARED');
  assert.equal(code(()=>loadDepositSigner({...f.env,FOLIO_EVM_BASE_AUTHORIZATION_KEY:undefined},'base')),'MISSING_FOLIO_EVM_BASE_AUTHORIZATION_KEY');
  assert.equal(code(()=>loadDepositSigner({...f.env,FOLIO_EVM_BASE_KEY_QUORUM_ID:' '},'base')),'MISSING_FOLIO_EVM_BASE_KEY_QUORUM_ID');
  // The retired single-quorum names configure nothing.
  assert.deepEqual(loadDepositSigners({PRIVY_APP_ID:'a',PRIVY_APP_SECRET:'s',FOLIO_EVM_KEY_QUORUM_ID:'old-quorum',FOLIO_EVM_AUTHORIZATION_KEY:pem(f.evm)}),{});
});
test('pay signer: its own key and quorum, parsed like a deposit signer, apart from the fee payer and both deposit signers',()=>{
  const f=fixture(),pay=pair();
  assert.deepEqual(paySignerEnv(),{authorizationKey:'FOLIO_PAY_BASE_AUTHORIZATION_KEY',keyQuorumId:'FOLIO_PAY_BASE_KEY_QUORUM_ID'});
  assert.equal(paySignerEnv(),PAY_SIGNER_ENV);
  const depositNames:string[]=(['base','arc'] as const).flatMap(chain=>Object.values(depositSignerEnv(chain)));
  assert.ok(!Object.values(paySignerEnv()).some(name=>depositNames.includes(name)));
  const env={...f.env,FOLIO_PAY_BASE_AUTHORIZATION_KEY:pem(pay),FOLIO_PAY_BASE_KEY_QUORUM_ID:' pay-quorum '};
  const config=loadPaySigner(env);
  assert.equal(JSON.stringify(config),'{}');assert.equal(config.keyQuorumId,'pay-quorum');assert.equal(config.appId,'fixture-app');
  assert.equal(authorizationPublicKey(config.authorizationKey),authorizationPublicKey(pem(pay)));
  // The same parser as the deposit loader: DER and Privy's wallet-auth form of the same key load too.
  const der=pay.privateKey.export({format:'der',type:'pkcs8'}).toString('base64');
  for (const form of [der,`wallet-auth:${der}`]) assert.equal(authorizationPublicKey(loadPaySigner({...env,FOLIO_PAY_BASE_AUTHORIZATION_KEY:form}).authorizationKey),authorizationPublicKey(pem(pay)));
  // Loading the pay signer leaves the deposit signers as they were.
  assert.equal(loadDepositSigner(env,'base').keyQuorumId,'base-quorum');
  const code=(fn:()=>unknown)=>{try{fn();}catch(e){return e instanceof PrivyError?e.code:String(e);}return 'ok';};
  assert.equal(code(()=>loadPaySigner({...env,FOLIO_PAY_BASE_AUTHORIZATION_KEY:f.env.PRIVY_AUTHORIZATION_KEY})),'EVM_FEE_PAYER_AUTHORITY_SHARED');
  assert.equal(code(()=>loadPaySigner({...env,FOLIO_PAY_BASE_KEY_QUORUM_ID:'fee-quorum'})),'EVM_FEE_PAYER_AUTHORITY_SHARED');
  for (const chain of ['BASE','ARC']) {
    assert.equal(code(()=>loadPaySigner({...env,FOLIO_PAY_BASE_AUTHORIZATION_KEY:f.env[`FOLIO_EVM_${chain}_AUTHORIZATION_KEY`]})),'PAY_AUTHORITY_SHARED');
    assert.equal(code(()=>loadPaySigner({...env,FOLIO_PAY_BASE_KEY_QUORUM_ID:f.env[`FOLIO_EVM_${chain}_KEY_QUORUM_ID`]})),'PAY_AUTHORITY_SHARED');
  }
  // Deposit signers not configured: nothing to compare against, the pay signer still loads.
  assert.equal(loadPaySigner({PRIVY_APP_ID:'a',PRIVY_APP_SECRET:'s',FOLIO_PAY_BASE_AUTHORIZATION_KEY:pem(pay),FOLIO_PAY_BASE_KEY_QUORUM_ID:'q'}).keyQuorumId,'q');
  assert.equal(code(()=>loadPaySigner({...env,FOLIO_PAY_BASE_AUTHORIZATION_KEY:undefined})),'MISSING_FOLIO_PAY_BASE_AUTHORIZATION_KEY');
  assert.equal(code(()=>loadPaySigner({...env,FOLIO_PAY_BASE_KEY_QUORUM_ID:' '})),'MISSING_FOLIO_PAY_BASE_KEY_QUORUM_ID');
  assert.notEqual(code(()=>loadPaySigner({...env,FOLIO_PAY_BASE_AUTHORIZATION_KEY:'not-a-key'})),'ok');
  assert.equal(code(()=>loadPaySigner({...env,PRIVY_APP_SECRET:undefined})),'MISSING_PRIVY_APP_SECRET');
});
test('policy admin: public key required, private key optional but the same pair (distinctness is the capabilities check)',()=>{
  const f=fixture(),admin=loadPolicyAdmin(f.env);
  assert.equal(admin.publicKey,authorizationPublicKey(pem(f.admin)));assert.equal(JSON.stringify(admin).includes('PRIVATE'),false);
  assert.equal(admin.authorizationKey,f.env.FOLIO_POLICY_ADMIN_KEY!.trim());
  // PEM public key input normalizes to Privy's base64 DER SPKI.
  assert.equal(loadPolicyAdmin({...f.env,FOLIO_POLICY_ADMIN_PUBLIC_KEY:f.admin.publicKey.export({format:'pem',type:'spki'}).toString(),FOLIO_POLICY_ADMIN_KEY:undefined}).publicKey,admin.publicKey);
  const code=(env:Record<string,string|undefined>)=>{try{loadPolicyAdmin(env);}catch(e){return (e as PrivyError).code;}return 'ok';};
  assert.equal(code({...f.env,FOLIO_POLICY_ADMIN_PUBLIC_KEY:undefined}),'MISSING_FOLIO_POLICY_ADMIN_PUBLIC_KEY');
  assert.equal(code({...f.env,FOLIO_POLICY_ADMIN_PUBLIC_KEY:'not-a-key'}),'INVALID_PRIVY_PUBLIC_KEY');
  assert.equal(code({...f.env,FOLIO_POLICY_ADMIN_KEY:pem(pair())}),'POLICY_ADMIN_KEY_MISMATCH');
});
test('exact signed/idempotent EVM wire contract with the chain signer key',async()=>{
  const f=fixture();
  const calls:any[]=[];
  const rest=createPrivyRest(f.config,{async request(r){calls.push(r);const signedHeaders={'privy-app-id':r.headers['privy-app-id'],'privy-idempotency-key':r.headers['privy-idempotency-key']};
    const payload=canonical({version:1,method:r.method,url:r.url,body:JSON.parse(r.body!),headers:signedHeaders});
    assert.equal(verify('sha256',Buffer.from(payload),f.evm.publicKey,Buffer.from(r.headers['privy-authorization-signature']!,'base64')),true);
    assert.equal(verify('sha256',Buffer.from(payload),f.fee.publicKey,Buffer.from(r.headers['privy-authorization-signature']!,'base64')),false);
    return {status:200,body:{data:{encoding:'rlp',signed_transaction:'0x0201'}}};}},Date.now);
  const signer=createEvmSigner(rest),tx={chainId:5042,to:'0x3600000000000000000000000000000000000000',value:0n,data:'0x1234',nonce:1,gas:200000n,maxFeePerGas:40000000000n,maxPriorityFeePerGas:0n};
  await signer.sign('evm','attempt',tx);await signer.sign('evm','attempt',tx);await signer.sign('evm','another',tx);
  assert.equal(calls[0].headers['privy-idempotency-key'],calls[1].headers['privy-idempotency-key']);assert.notEqual(calls[1].headers['privy-idempotency-key'],calls[2].headers['privy-idempotency-key']);
  const t=JSON.parse(calls[0].body).params.transaction;assert.equal(t.chain_id,5042);assert.equal(t.gas_limit,'0x30d40');assert.equal(t.type,2);
  await assert.rejects(rest.request('POST','/v1/wallets/evm/rpc',{method:'eth_sendTransaction'}),/SIGNATURE_ONLY/);
});
test('app-authenticated reads carry Basic auth only, never an authorization signature or a user token',async()=>{
  const f=fixture(),calls:HttpRequest[]=[];
  const admin=createPrivyAdmin(f.config,{async request(r){calls.push(r);return {status:200,body:{id:'x'}};}});
  await admin.read('wallets','evm');await admin.read('policies','alice-policy');await admin.read('key_quorums','alice-owner');
  assert.deepEqual(calls.map(c=>`${c.method} ${c.url}`),['GET https://api.privy.io/v1/wallets/evm','GET https://api.privy.io/v1/policies/alice-policy','GET https://api.privy.io/v1/key_quorums/alice-owner']);
  for(const c of calls){
    assert.equal(c.headers.authorization,`Basic ${Buffer.from(`${f.config.appId}:${f.config.appSecret}`).toString('base64')}`);
    assert.equal(c.headers['privy-app-id'],f.config.appId);assert.equal(c.body,undefined);
    assert.equal(c.headers['privy-authorization-signature'],undefined);assert.equal(c.headers['privy-idempotency-key'],undefined);
  }
  await assert.rejects(admin.read('wallets','../evil'),/PRIVY_RESOURCE_ID_INVALID/);assert.equal(calls.length,3);
});
test('admin DELETE is Basic auth with no body; a signed DELETE sends and signs {} (P0 wire format)',async()=>{
  const f=fixture(),calls:HttpRequest[]=[];
  const admin=createPrivyAdmin(f.config,{async request(r){calls.push(r);return {status:200,body:{id:'gone'}};}});
  await admin.delete('policies','old-policy');
  assert.deepEqual({method:calls[0]!.method,url:calls[0]!.url,body:calls[0]!.body,signature:calls[0]!.headers['privy-authorization-signature'],idem:calls[0]!.headers['privy-idempotency-key']},
    {method:'DELETE',url:'https://api.privy.io/v1/policies/old-policy',body:undefined,signature:undefined,idem:undefined});
  assert.equal(calls[0]!.headers.authorization,`Basic ${Buffer.from('fixture-app:fixture-secret').toString('base64')}`);
  await assert.rejects(admin.delete('policies','../x'),/PRIVY_RESOURCE_ID_INVALID/);
  const signedCalls:HttpRequest[]=[],adminKey=loadPolicyAdmin(f.env);
  const owner={appId:'fixture-app',appSecret:'fixture-secret',jwksUrl:'',keyQuorumId:'unused',authorizationKey:adminKey.authorizationKey!};
  const rest=createPrivyRest(owner,{async request(r){signedCalls.push(r);return {status:200,body:{}};}},Date.now);
  await rest.request('DELETE','/v1/policies/owned-policy');await rest.request('DELETE','/v1/key_quorums/owner-quorum');
  for(const [i,path] of ['/v1/policies/owned-policy','/v1/key_quorums/owner-quorum'].entries()) {
    const r=signedCalls[i]!;assert.equal(r.method,'DELETE');assert.equal(r.body,'{}');assert.equal(r.headers['content-type'],'application/json');
    const payload=canonical({version:1,method:'DELETE',url:`https://api.privy.io${path}`,body:{},headers:{'privy-app-id':'fixture-app'}});
    assert.equal(verify('sha256',Buffer.from(payload),f.admin.publicKey,Buffer.from(r.headers['privy-authorization-signature']!,'base64')),true);
  }
  // DELETE names one policy or key quorum; never a wallet or a collection.
  for(const path of ['/v1/wallets/w','/v1/policies','/v1/wallets/w/rpc'])await assert.rejects(rest.request('DELETE',path),/INVALID_PRIVY_PATH/);
  assert.equal(signedCalls.length,2);
});
test('owner-authority refusals: all four observed 401 messages are PRIVY_AUTHORIZATION_DENIED; other 401s stay generic',async()=>{
  const f=fixture();
  const answer=(status:number,body:unknown)=>createPrivyRest(f.config,{async request(){return {status,body};}},Date.now).request('PATCH','/v1/policies/p',{rules:[]});
  for(const error of ['No valid authorization signatures were provided. Your payload may be malformed or your signing keys may be incorrect or expired. Docs: https://docs.privy.io/api-reference/authorization-signatures',
    'No valid authorization keys or user signing keys available',
    'Missing `privy-authorization-signature` header or no signatures provided. Learn more about authorization signatures here: https://docs.privy.io/api-reference/authorization-signatures',
    'Not enough valid authorization signatures provided in `privy-authorization-signature` header. Your payload may be malformed or your signing keys may be incorrect or expired.'])
    await assert.rejects(answer(401,{error}),(e:unknown)=>e instanceof PrivyError && e.code==='PRIVY_AUTHORIZATION_DENIED');
  await assert.rejects(answer(401,{error:'Invalid app secret'}),(e:unknown)=>e instanceof PrivyError && e.code==='PRIVY_HTTP_401');
  await assert.rejects(answer(400,{error:'RPC request denied due to policy violation',code:'policy_violation'}),(e:unknown)=>e instanceof PrivyError && e.code==='PRIVY_POLICY_DENIED');
});
test('owner quorum: the membership check that tells the person\'s quorum from a foreign owner',()=>{
  const f=fixture(),adminKey=loadPolicyAdmin(f.env).publicKey,did='did:privy:cmalice';
  const read={id:'oq',display_name:null,authorization_threshold:1,authorization_keys:[{public_key:adminKey,display_name:null}],user_ids:[did],key_quorum_ids:[]};
  assert.equal(ownerQuorumMatches(read,'oq',did,adminKey),true);
  // After the one-way switch to person-only, the quorum still belongs to the person.
  assert.equal(ownerQuorumMatches({...read,authorization_keys:[]},'oq',did,adminKey),true);
  for(const foreign of [{...read,id:'other'},{...read,user_ids:['did:privy:cmbob']},{...read,user_ids:[did,'did:privy:cmbob']},{...read,user_ids:[]},
    {...read,authorization_keys:[{public_key:authorizationPublicKey(pem(pair()))}]},{...read,authorization_keys:[read.authorization_keys[0],read.authorization_keys[0]]},
    {...read,authorization_threshold:2},{...read,key_quorum_ids:['nested']},null,[],'oq'])
    assert.equal(ownerQuorumMatches(foreign,'oq',did,adminKey),false,JSON.stringify(foreign));
});
test('deposit policy golden per chain: one chain id each, eq conditions only, no owner field (the registry adds owner_id), default deny',()=>{
  const golden=JSON.parse(readFileSync(new URL('./fixtures/deposit-policy-golden.json',import.meta.url),'utf8'));
  const {person,ata}=golden.input;
  for(const [chain,other] of [['base','5042'],['arc','8453']] as const) {
    const body=depositPolicy(chain,person,ata);
    assert.deepEqual(JSON.parse(JSON.stringify(body)),golden[chain].policy);
    assert.equal(evmPolicyDigest(body),golden[chain].instantiated_digest);
    assert.equal(depositPolicyDigest(chain),golden[chain].template_digest);
    assert.match(depositPolicyDigest(chain),/^[a-f0-9]{64}$/);assert.notEqual(depositPolicyDigest(chain),evmPolicyDigest(depositPolicyTemplate(chain)));
    assert.equal(body.name,`folio-deposit-${chain}-7db02c491b313c53`);assert.equal('owner_id' in body,false);assert.equal('owner' in body,false);
    const text=JSON.stringify(body);assert.equal(text.includes(other),false);
    for(const rule of body.rules) {assert.equal(rule.action,'ALLOW');assert.equal(rule.method,'eth_signTransaction');
      assert.ok(rule.conditions.every(c=>c.operator==='eq'));assert.ok(!rule.conditions.some(c=>/amount/.test(c.field)));}
    // The registry adds owner_id at creation; the rules digest is unchanged by it.
    assert.equal(evmPolicyDigest({...body,owner_id:'owner-quorum'}),golden[chain].instantiated_digest);
  }
  // The digest covers the name and rules, so another person's or chain's policy never matches.
  assert.notEqual(evmPolicyDigest(depositPolicy('base','live:bob',ata)),golden.base.instantiated_digest);
  assert.throws(()=>depositPolicy('base','',ata),/PERSON_REQUIRED/);
  assert.throws(()=>depositPolicy('solana' as 'base',person,ata),/DEPOSIT_CHAIN_UNKNOWN/);
});
test('policy digest ignores provider ids and rule order, and changes with any rule content',()=>{
  const body=depositPolicy('base','live:alice','9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
  const digest=evmPolicyDigest(body)!;assert.match(digest,/^[a-f0-9]{64}$/);
  const remote={id:'../shims/namespace.js',owner_id:null,created_at:1,...body,rules:[...body.rules].reverse().map((r,i)=>({id:`rule-${i}`,...r}))};
  assert.equal(evmPolicyDigest(JSON.parse(JSON.stringify(remote))),digest);
  const changed=JSON.parse(JSON.stringify(remote));changed.rules[0].conditions[0].value='1';
  assert.notEqual(evmPolicyDigest(changed),digest);
  assert.notEqual(evmPolicyDigest({...remote,rules:remote.rules.slice(1)}),digest);
  assert.equal(evmPolicyDigest({...remote,chain_type:'solana'}),undefined);
});
test('signer attachment counts only our quorum and requires exactly one policy',()=>{
  const q='evm-quorum';
  assert.deepEqual(signerAttachment({additional_signers:[{signer_id:'other',override_policy_ids:['p']},{signer_id:q,override_policy_ids:['p']}]},q,'p'),{count:1,exact:true});
  assert.deepEqual(signerAttachment({additional_signers:[{signer_id:q,override_policy_ids:['p','x']}]},q,'p'),{count:1,exact:false});
  assert.deepEqual(signerAttachment({additional_signers:[{signer_id:q,override_policy_ids:['p']},{signer_id:q,override_policy_ids:['p']}]},q,'p'),{count:2,exact:false});
  assert.deepEqual(signerAttachment({},q,'p'),{count:0,exact:false});
});
test('lost policy creation response retries one resource; a new consent nonce is a new resource',async()=>{
  const f=fixture(),keys:(string|undefined)[]=[];let lost=true;
  const admin=createPrivyAdmin(f.config,{async request(r){keys.push(r.headers['privy-idempotency-key']);if(lost){lost=false;throw Error('lost response');}return {status:200,body:{id:'../shims/namespace.js'}};}});
  await assert.rejects(admin.request('/v1/policies',{name:'alice'}),/TRANSPORT_UNAVAILABLE/);
  await admin.request('/v1/policies',{name:'alice'});await admin.request('/v1/policies',{name:'bob'});
  assert.match(keys[0]!,/^[a-f0-9]{64}$/);assert.equal(keys[0],keys[1]);assert.notEqual(keys[1],keys[2]);
  // Privy matches on the key alone (P0): the same body after a revoke must carry the new consent's nonce.
  await admin.request('/v1/policies',{name:'alice'},{nonce:'receipt-1'});await admin.request('/v1/policies',{name:'alice'},{nonce:'receipt-1'});
  await admin.request('/v1/policies',{name:'alice'},{nonce:'receipt-2'});
  assert.equal(keys[3],keys[4]);assert.notEqual(keys[3],keys[0]);assert.notEqual(keys[5],keys[3]);
  await assert.rejects(admin.request('/v1/policies',{name:'alice'},{nonce:'bad nonce!'}),/PRIVY_IDEMPOTENCY_NONCE_INVALID/);assert.equal(keys.length,6);
});
