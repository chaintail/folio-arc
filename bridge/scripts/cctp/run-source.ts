import { address } from '@solana/kit';
import { createEvmSigner, createPrivyAdmin, createPrivyRest, createFetchTransport, loadDepositSigner, loadPolicyAdmin, evmSignBody } from 'wallet-privy/server';
import { createPolicyLiveCheck } from '../../src/bridge/deposit-permission.js';
import type { PermissionReceipt } from '../../src/shims/permission-types.js';
import { verifiedReceipt } from './privy-common.js';
/** Director source run: dry-run by default; shared release service and durable no-resend attempts. */
import {parseArgs} from 'node:util';
import {existsSync,mkdirSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {type Hex} from 'viem';
import {personNamespaceOf,type PersonScope} from '../../src/shims/person-scope.js';
import {namespaceKey} from '../../src/shims/namespace.js';
import {SourceStore} from '../../src/bridge/transfer-record.js';
import {readBridgeConfig} from '../../src/bridge/config.js';
import {createSourceService,SourceRefusal,androidTransaction} from '../../src/bridge/source-service.js';
import {createSourceRpc} from '../../src/bridge/source-rpc.js';
import {route,type SourceChain} from '../../src/bridge/source-registry.js';
import {GasLedger} from '../../src/bridge/source-gas.js';
import {submitSource} from '../../src/bridge/source-executor.js';
import {assertPinnedDestination} from '../../src/bridge/source-calls.js';
import {publicSolanaRpc,readAccount,verifyPrograms} from '../../src/bridge/solana.js';
import {createAttestationClient} from '../../src/bridge/attestation.js';
import {expectationFor} from '../../src/bridge/delivery.js';
import {allowedPath,privateFile} from './private-file.js';
export function parseSourceArgs(args:readonly string[]) {
 const {values:v}=parseArgs({args:[...args],options:{db:{type:'string'},chain:{type:'string'},sweep:{type:'string'},'run-dir':{type:'string'},
  'approve-signed':{type:'string'},'burn-signed':{type:'string'},'authorization-ref':{type:'string'},'max-topup-raw':{type:'string'},
  'max-source-fee-raw':{type:'string'},'implementation-hash':{type:'string'},execute:{type:'boolean'},'i-am-the-director':{type:'boolean'},'dry-run':{type:'boolean'},'timeout-ms':{type:'string'},
  'register-person':{type:'string'},wallet:{type:'string'},owner:{type:'string'},'amount-6':{type:'string'},privy:{type:'boolean'}}});
 if(!v.db||!v.chain||!['base','arc'].includes(v.chain)||!v['run-dir'])throw Error('SOURCE_RUN_ARGUMENTS_REQUIRED');
 if(!v.privy && !v.owner)throw Error('DESTINATION_OWNER_REQUIRED');
 if(v.execute&&(!v['i-am-the-director']||v['dry-run']||!v['authorization-ref']||!v['max-topup-raw']||!v['max-source-fee-raw']||!v['implementation-hash']))throw Error('DIRECTOR_EXECUTION_GATE_REQUIRED');
 if(v['register-person']&&(!v.wallet||!/^0x[\da-f]{40}$/i.test(v.wallet)||!v.owner||v.execute))throw Error('SOURCE_REGISTRATION_INVALID');
 if(v.owner)address(v.owner);
 if(!v['register-person']&&!v.sweep)throw Error('NAMED_SWEEP_REQUIRED');
 for(const k of ['max-topup-raw','max-source-fee-raw','timeout-ms'] as const)if(v[k]&&!/^[1-9]\d*$/.test(v[k]!))throw Error('SOURCE_RUN_CAP_INVALID');
 if(v['implementation-hash']&&!/^0x[\da-f]{64}$/i.test(v['implementation-hash']))throw Error('SOURCE_IMPLEMENTATION_HASH_INVALID');
 const timeout=Number(v['timeout-ms']??'1800000');if(!Number.isSafeInteger(timeout)||timeout>3600000)throw Error('SOURCE_RUN_TIMEOUT_INVALID');
 return {db:allowedPath(v.db),chain:v.chain as SourceChain,sweep:v.sweep,dir:allowedPath(v['run-dir']),
  approve:v['approve-signed']?allowedPath(v['approve-signed']):undefined,burn:v['burn-signed']?allowedPath(v['burn-signed']):undefined,
  implementationHash:v['implementation-hash'],execute:!!v.execute,authorization:v['authorization-ref'],topupCap:v['max-topup-raw'],feeCap:v['max-source-fee-raw'],timeout,
  register:v['register-person'],wallet:v.wallet,owner:v.owner,amount6:v['amount-6'],privy:!!v.privy};
}
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
export async function runSource(args:readonly string[],runtime:NodeJS.ProcessEnv=process.env) {
 const v=parseSourceArgs(args);
 if(v.execute&&(runtime.FOLIO_NAMESPACE_MODE!=='live'||runtime.FOLIO_BRIDGE_SOURCE!=='1'||runtime.FOLIO_BRIDGE_EXECUTE!=='1'))throw Error('SOURCE_EXECUTION_DISABLED');
 if(!existsSync(v.db))throw Error('EXISTING_SHARED_DATABASE_REQUIRED');allowedPath(realpathSync(v.db));
 mkdirSync(v.dir,{recursive:true,mode:0o700});
 const evidence=(name:string,value:unknown)=>{
  const path=join(v.dir,name+'.json');writeFileSync(path,JSON.stringify({mode:v.execute?'DIRECTOR_EXECUTION':'DRY_RUN',captured_at:new Date().toISOString(),...value as object},(_k,x)=>typeof x==='bigint'?String(x):x,2)+'\n',{mode:0o600,flag:'wx'});
  process.stdout.write(`${name}: evidence recorded\n`);
 };
 let evidenceTime=0;
 const waitEvidence=(name:string,value:unknown)=>{
  evidenceTime=Math.max(Date.now(),evidenceTime+1);
  evidence(`${name}-${evidenceTime}`,value);
 };
 const store=new SourceStore(v.db);let step='preflight';
 try {
 const env:NodeJS.ProcessEnv={...runtime,FOLIO_BRIDGE_EXECUTE:v.execute?'1':'0',
  ...(v.topupCap?{[`FOLIO_BRIDGE_TOPUP_CAP_${v.chain.toUpperCase()}_RAW`]:v.topupCap}:{})};
 const config=readBridgeConfig(env,'live'),c=config.chains[v.chain];
 if(!config.source||!c.enabled||c.paused||store.paused(v.chain))throw Error('SOURCE_DISABLED_OR_PAUSED');
 const rpc=createSourceRpc(v.chain,env[c.rpcEnv]??(v.chain==='base'?'https://mainnet.base.org':'https://rpc.mainnet.arc.io'),fetch,{env,mode:env.FOLIO_NAMESPACE_MODE??'simulation'});
 if(await rpc.chainId()!==c.route.chainId)throw Error('SOURCE_ROUTE_MISMATCH');
 const solana=publicSolanaRpc(),readAta=async(a:string)=>{const x=await readAccount(solana,a);return {exists:!!x,program:x?.owner??'',data:Buffer.from(x?.data[0]??'','base64')};};
 if(v.register) {
  const person=namespaceKey(personNamespaceOf(v.register));
  const binding=store.db.prepare('SELECT scope FROM person_wallets WHERE namespace=?').get(person);
  const bound=binding?JSON.parse(String(binding.scope)):null;
  if(!bound || bound.user!==v.register || bound.wallet_address!==v.owner || bound.evm_wallet?.address.toLowerCase()!==v.wallet!.toLowerCase())throw Error('VERIFIED_PERSON_BINDING_REQUIRED');
  const block=await rpc.finalizedBlock();
  const balance=v.chain==='arc'?await rpc.balance(v.wallet as Hex):await rpc.tokenBalance(v.wallet as Hex);
  if(balance!==0n)throw Error('FRESH_EMPTY_DEPOSIT_ADDRESS_REQUIRED');
  const start=store.assignment(v.chain,v.wallet!,person,block);
  evidence('00-assignment',{chain:v.chain,person,wallet:v.wallet,owner:v.owner,assignment_block:start,finalized_balance_raw:balance});return;
 }
 const amount6=v.amount6??'1000000'; if(!/^[1-9]\d{0,8}$/.test(amount6))throw Error('AMOUNT_6_INVALID'); const amountN=BigInt(amount6);
 let s=store.sweep(v.sweep!);
 if(s.chain!==v.chain||s.amount_6!==amount6||(!v.privy && (!v.owner || s.destination_owner!==v.owner))||c.route.minimum!==1000000n)throw Error('PINNED_SWEEP_AMOUNT_MISMATCH');
 if(!c.feeProof)throw Error('DIRECTOR_FEE_PROOF_REQUIRED');
 const deployment=await rpc.deployment();if(v.implementationHash && deployment.implementationCodeHash.toLowerCase()!==v.implementationHash.toLowerCase())throw Error('SOURCE_DEPLOYMENT_CHANGED');
 if(v.chain==='arc' && await rpc.minimumFee(amountN)!==0n)throw Error('STANDARD_FEE_UNVERIFIED_OR_NONZERO');
 const programs=await verifyPrograms(solana);
 await assertPinnedDestination({owner:s.destination_owner,ata:s.mint_recipient,bytes32:s.mint_recipient_bytes32 as Hex},readAta);
 const match=/^live:([a-f0-9]{64})$/.exec(s.person);if(!match)throw Error('PERSON_NAMESPACE_INVALID');
 let scope:PersonScope={namespace:{kind:'live',person_id:match[1]},user:'Director-run',wallet_address:s.destination_owner,evm_wallet:{id:'Director-test',address:s.wallet}};
 let receipt:PermissionReceipt|undefined;
 if(v.privy) {
  const binding=store.db.prepare('SELECT scope FROM person_wallets WHERE namespace=?').get(s.person);
  const bound=binding?JSON.parse(String(binding.scope)) as PersonScope:undefined;
  if(!bound?.evm_wallet || bound.evm_wallet.address.toLowerCase()!==s.wallet || bound.wallet_address!==s.destination_owner)throw Error('PROVISIONED_SWEEP_BINDING_REQUIRED');
  // The person's verified consent for this chain, to this destination, on this wallet.
  receipt=verifiedReceipt(store.db,s.person,v.chain);
  if(receipt.ata!==s.mint_recipient || receipt.wallet_id!==bound.evm_wallet.id || receipt.wallet_address.toLowerCase()!==s.wallet)throw Error('PROVISIONED_SWEEP_BINDING_REQUIRED');
  scope=bound;
  if(v.execute && !env[`FOLIO_EVM_PERMISSION_PROOF_${v.chain.toUpperCase()}`])throw Error('PRIVY_PERMISSION_PROOF_REQUIRED');
 }
 const evm=v.privy&&v.execute?loadDepositSigner(env,v.chain):undefined,transport=createFetchTransport(fetch);
 const service=createSourceService({store,config,rpc:{[v.chain]:rpc},people:()=>[],readAta,credited:()=>false,env,
  signers:evm?{[v.chain]:{keyQuorumId:evm.keyQuorumId,signer:createEvmSigner(createPrivyRest(evm,transport,Date.now))}}:{},
  // The receipt store is the permission service's: a hold found here is evidence and refuses the run; it writes nothing.
  permissions:{verified:(person,chain)=>receipt && person===s.person && chain===v.chain?receipt:null,hold:(id,code)=>evidence(`receipt-hold-${Date.now()}`,{receipt_ref:id.slice(0,8),code})},
  ...(evm?{policyCheck:createPolicyLiveCheck({reads:createPrivyAdmin(evm,transport),adminPublicKey:loadPolicyAdmin(env).publicKey})}:{}),
  log:event=>evidence(`event-${Date.now()}-${Math.random().toString(16).slice(2)}`,event)});
 // A landed transaction can change finalized balances while the process is down.
 // Reconcile retained hashes before comparing those balances with the durable ledger.
 await service.tick();s=store.sweep(s.id);
 const assignment=store.db.prepare('SELECT block FROM bridge_wallet_assignment WHERE chain=? AND wallet=? AND person=?').get(v.chain,s.wallet,s.person);
 if(!assignment || store.cursor(v.chain,s.wallet)===undefined)throw Error('FINALIZED_ASSIGNMENT_HISTORY_REQUIRED');
 const ledger=store.shared.gasLedger(s.wallet,v.chain),balance=v.chain==='arc'?await rpc.balance(s.wallet as Hex):await rpc.tokenBalance(s.wallet as Hex);
 const local=new GasLedger(v.chain),saved=store.readLedger(v.chain,s.wallet);if(!saved)throw Error('SOURCE_LEDGER_REQUIRED');local.restore(saved);
 if(local.customerPrincipal!==ledger.customer_principal||local.folioResidual!==ledger.folio_residual)throw Error('SOURCE_LEDGER_DISAGREEMENT');
 if(balance!==ledger.customer_principal+(v.chain==='arc'?ledger.folio_residual:0n))throw Error('SOURCE_BALANCE_UNEXPLAINED');
 const principal = v.chain==='arc'?amountN*1000000000000n:amountN;
 if(!['burn_confirmed','attested','delivery_submitted','delivery_uncertain','settled'].includes(s.state)&&ledger.customer_principal!==principal)throw Error('FULL_CUSTOMER_PRINCIPAL_MUST_BE_ONE_DOLLAR');
 evidence('01-preflight',{chain:v.chain,sweep:s.id,person:s.person,wallet:s.wallet,owner:s.destination_owner,amount_6:s.amount_6,
  assignment,cursor:String(store.cursor(v.chain,s.wallet)),balance_raw:balance,ledger,fee_proof:c.feeProof,deployment,programs,authorization_ref:v.authorization??null,broadcast:false});
 const deadline=Date.now()+v.timeout;
 async function boundedWait() {if(Date.now()>=deadline)throw Error('SOURCE_RUN_WAIT_TIMEOUT');await sleep(2000);}
 for(const kind of ['approve','burn'] as const) {
  step=kind;let current=store.sweep(s.id);
  if(kind==='approve'&&current.state!=='planned'&&current.state!=='approval_pending')continue;
  if(kind==='burn'&&!['approved','burn_pending','burn_uncertain'].includes(current.state))continue;
  let attempt=store.attempts(s.id).filter(a=>a.kind===kind).at(-1);
  if(!attempt||attempt.state==='failed') {
   let lastTopupHold:string|undefined;
   for(;;)try {
    const prepared=await service.prepare(scope,s.id,kind,amountN,v.feeCap?BigInt(v.feeCap):undefined);
    if(lastTopupHold!==undefined)waitEvidence(`02-${kind}-topup`,{state:'resolved',attempts:store.attempts(s.id).filter(a=>a.kind==='gas_topup'),ledger:store.shared.gasLedger(s.wallet,v.chain),broadcast:v.execute});
    evidence(`02-${kind}-unsigned`,prepared);attempt=store.attempt(prepared.attempt);break;
   }catch(e) {
    if(!(e instanceof SourceRefusal)||!['FOLIO_TOPUP_PENDING','FOLIO_TOPUP_REQUIRED'].includes(e.code))throw e;
    const topups=store.attempts(s.id).filter(a=>a.kind==='gas_topup'),hold=JSON.stringify([e.code,topups.map(a=>[a.id,a.state])]);
    if(hold!==lastTopupHold){waitEvidence(`02-${kind}-topup`,{state:e.code,attempts:topups,ledger:store.shared.gasLedger(s.wallet,v.chain),broadcast:v.execute});lastTopupHold=hold;}
    if(!v.execute)return;
    try{await boundedWait();}catch(error){waitEvidence(`02-${kind}-topup`,{state:'timed_out',attempts:store.attempts(s.id).filter(a=>a.kind==='gas_topup'),ledger:store.shared.gasLedger(s.wallet,v.chain),broadcast:v.execute});throw error;}
    await service.tick();
   }
  }
  if(attempt!.state==='prepared_dry_run')throw Error('DRY_RUN_ATTEMPT_TERMINAL_USE_REHEARSAL_COPY');
  if(attempt!.state==='prepared') {
   const raw=JSON.parse(attempt!.evidence_json),max=BigInt(raw.gas)*BigInt(raw.maxFeePerGas);
   if(!existsSync(join(v.dir,`02-${kind}-unsigned.json`))) {
    const transaction={...raw,value:BigInt(raw.value),gas:BigInt(raw.gas),maxFeePerGas:BigInt(raw.maxFeePerGas),maxPriorityFeePerGas:BigInt(raw.maxPriorityFeePerGas)};
    evidence(`02-${kind}-unsigned`,{sweep:s.id,attempt:attempt!.id,transaction:{from:s.wallet,...androidTransaction(transaction)},resumed:true});
   }
   const reservation=new GasLedger(v.chain);reservation.restore(store.readLedger(v.chain,s.wallet)!);
   const cap=reservation.reservations.get(attempt!.id);if(cap===undefined||v.execute&&(!v.feeCap||cap>BigInt(v.feeCap))||cap<max)throw Error('SOURCE_FEE_CAP_EXCEEDED');
   if(v.privy) {
    const transaction={...raw,value:BigInt(raw.value),gas:BigInt(raw.gas),maxFeePerGas:BigInt(raw.maxFeePerGas),maxPriorityFeePerGas:BigInt(raw.maxPriorityFeePerGas)};
    evidence(`03-${kind}-privy-request`,{request:{method:'POST',path:`/v1/wallets/${scope.evm_wallet!.id}/rpc`,body:evmSignBody(transaction)},broadcast:false});
    if(!v.execute)return;
    const result=await service.execute(scope,s.id,amountN,BigInt(v.feeCap!));evidence(`04-${kind}-submit`,result);
   } else {
   const file=kind==='approve'?v.approve:v.burn;
   if(!file){evidence(`03-${kind}-awaiting-wire`,{attempt:attempt!.id,state:'awaiting_signed_wire',broadcast:false});return;}
   if(!v.execute&&!existsSync(file)){evidence(`03-${kind}-awaiting-wire`,{attempt:attempt!.id,state:'awaiting_signed_wire',broadcast:false});return;}
   while(!existsSync(file))await boundedWait();
   const signed=privateFile(file).trim() as Hex;
   const checked=await submitSource(store,attempt!.id,s.person,signed,{dryRun:true,readAta});evidence(`03-${kind}-validation`,{attempt:attempt!.id,...checked});
   const result=await service.submit(scope,s.id,attempt!.id,signed);evidence(`04-${kind}-submit`,result);
   if(!v.execute)return;
   }
  }
  // submitted/uncertain restart paths never touch the signed file or broadcast again.
  while(!['confirmed','failed'].includes(store.attempt(attempt!.id)!.state)) {await service.reconcile(attempt!.id).catch(()=>{});if(!['confirmed','failed'].includes(store.attempt(attempt!.id)!.state))await boundedWait();}
  const landed=store.attempt(attempt!.id)!;evidence(`05-${kind}-receipt`,{attempt:landed,receipt:await rpc.charge(landed.tx_hash as Hex),ledger:store.shared.gasLedger(s.wallet,v.chain)});
  if(landed.state==='failed')throw Error('SOURCE_ATTEMPT_FAILED_STOP');
 }
 step='attestation';const t=store.shared.getTransfer(s.id);if(!t){evidence('06-attestation-not-ready',{state:store.sweep(s.id).state,broadcast:false});return;}
 const iris=createAttestationClient();let failures=t.failures,lastAttestationHold:string|undefined;
 for(;;){const a=await iris.lookup(t.burn_tx_hash,expectationFor(store.sweep(s.id),t),failures++);
  if(a.kind==='ready'){if(lastAttestationHold!==undefined)waitEvidence('06-attestation-pending',{state:'resolved',kind:a.kind});
   if(store.sweep(s.id).state==='burn_confirmed'){store.shared.saveAttestation(s.id,{message_nonce:a.nonce,message_hash:a.messageHash,message:a.message,attestation:a.attestation});store.shared.transition(s.id,'attested');}
   evidence('06-attestation',a);return;}
  const attestationHold=JSON.stringify([a.kind,a.delayMs]);
  if(attestationHold!==lastAttestationHold){waitEvidence('06-attestation-pending',a);lastAttestationHold=attestationHold;}
  if(!v.execute)return;
  let remaining=a.delayMs;while(remaining>0){if(Date.now()>=deadline){waitEvidence('06-attestation-pending',{state:'timed_out',kind:a.kind,delayMs:a.delayMs});throw Error('SOURCE_RUN_WAIT_TIMEOUT');}const ms=Math.min(remaining,2000);await sleep(ms);remaining-=ms;}
 }
 }catch(e){evidence(`refused-${step}-${Date.now()}`,{step,code:e instanceof SourceRefusal?e.code:e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'SOURCE_RUN_UNAVAILABLE',detail:e instanceof Error?e.message.replace(/https?:\/\/\S+/g,'<url>').slice(0,400):String(e).slice(0,200)});throw Error('SOURCE_RUN_REFUSED_REVIEW_EVIDENCE');}
 finally{store.close();}
}
if(process.argv[1]?.endsWith('/run-source.ts'))runSource(process.argv.slice(2)).catch(e=>{process.stderr.write(`${e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'SOURCE_RUN_UNAVAILABLE'}\n`);process.exitCode=1;});
