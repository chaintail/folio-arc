/** Director read/prepare control. This file has no signer or broadcast transport. */
import {parseArgs} from 'node:util';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createPublicClient,http,type Address,type Hex} from 'viem';
import {SourceStore} from '../../src/bridge/transfer-record.js';
import {route,type SourceChain} from '../../src/bridge/source-registry.js';
import {publicSolanaRpc,inspectUsdcAta,readAccount,type ReadRpc} from '../../src/bridge/solana.js';
const actions=['prepare','validate','receipt','attestation','ata-check','resume'];
function readPublic(path:string){if(path.split('/').some(p=>p==='.secrets'||p==='.env'||p.startsWith('.env.')))throw Error('FORBIDDEN_INPUT_PATH');return readFileSync(path,'utf8');}
export async function runControl(args:readonly string[],options:{solanaRpc?:ReadRpc}={}) {
const {values:v}=parseArgs({args:[...args],options:{action:{type:'string'},input:{type:'string'},out:{type:'string'},'dry-run':{type:'boolean'},'i-am-the-director':{type:'boolean'}}});
if(!v.action || !actions.includes(v.action) || !v.input)throw Error('action and public run JSON required; no execute action exists');
const input=JSON.parse(readPublic(v.input));
if(!existsSync(input.db)||!['base','arc'].includes(input.chain))throw Error('existing shared database and chain required');
const r=route(input.chain as SourceChain,BigInt(input.minimum_6??'20000000')),store=new SourceStore(input.db);
try {
 if(v.action==='resume') {
  if(!v['i-am-the-director'] || v['dry-run'] || typeof input.reason!=='string' || !input.reason.trim())throw Error('AUDITED_DIRECTOR_REPAIR_REQUIRED');
  const {DepositIntents}=await import('../../src/bridge/deposit-intent.js');
  const intents=new DepositIntents(store);
  const record=input.intent?intents.owned(input.intent,input.person):store.sweep(input.sweep);
  const owner='owner' in record?record.owner:record.destination_owner;
  if(record.person!==input.person || record.chain!==input.chain || record.wallet!==String(input.wallet).toLowerCase() || owner!==input.owner)throw Error('REPAIR_IDENTITY_MISMATCH');
  if(input.intent)intents.resume(input.intent,input.person,input.reason,Date.now());
  else store.shared.resume(input.sweep,input.person,input.reason,Date.now());
  const output=JSON.stringify({action:'resume',record:record.id,signing:false,broadcast:false,reason:input.reason})+'\n';
  if(v.out)writeFileSync(v.out,output);else process.stdout.write(output);
  return;
 }
 const s=store.sweep(input.sweep);
 if(s.chain!==r.chain || s.person!==input.person || s.wallet!==String(input.wallet).toLowerCase() || s.destination_owner!==input.owner || s.amount_6!=='1000000')throw Error('one-USDC pinned identity required');
 const client=createPublicClient({transport:http(r.chain==='base'?'https://mainnet.base.org':'https://rpc.mainnet.arc.io',{timeout:10000,retryCount:0})});
 if(v.action!=='ata-check' && await client.getChainId()!==r.chainId)throw Error('chain mismatch');
 const rpc=options.solanaRpc??publicSolanaRpc(),readAta=async(a:string)=>{const x=await readAccount(rpc,a);return {exists:!!x,program:x?.owner??'',data:Buffer.from(x?.data[0]??'','base64')};};
 let output:unknown;
 if(v.action==='ata-check')output=await inspectUsdcAta(rpc,s.destination_owner,s.mint_recipient);
 else if(v.action==='attestation'){
  const {createAttestationClient}=await import('../../src/bridge/attestation.js');
  const {expectationFor}=await import('../../src/bridge/delivery.js');
  const t=store.shared.getTransfer(s.id);if(!t)throw Error('confirmed cross-chain leg missing');
  const a=await createAttestationClient().lookup(t.burn_tx_hash,expectationFor(s,t),t.failures);
  if(a.kind!=='ready')throw Error(`attestation ${a.reason}; wait ${a.delayMs} ms`);
  if(t.state==='burn_confirmed'){store.shared.saveAttestation(s.id,{message_nonce:a.nonce,message_hash:a.messageHash,message:a.message,attestation:a.attestation});store.shared.transition(s.id,'attested');}
  output={burn:t.burn_tx_hash,nonce:a.nonce,messageHash:a.messageHash,message:a.message,attestation:a.attestation};
 }else if(v.action==='validate'){
  const {submitSource}=await import('../../src/bridge/source-executor.js');
  if(!input.signedFile)throw Error('private signed wire file required, never exported');
  output=await submitSource(store,input.attempt,input.person,readPublic(input.signedFile).trim() as Hex,{dryRun:true,readAta});
 }else {
  const {GasLedger}=await import('../../src/bridge/source-gas.js');
  const {prepareSource,reconcileSource}=await import('../../src/bridge/source-executor.js');
  const ledger=new GasLedger(r.chain),saved=store.readLedger(r.chain,s.wallet);if(!saved)throw Error('durable confirmed Folio gas ledger required');ledger.restore(saved);
  if(v.action==='prepare'){
   if(r.minimum!==1_000000n)throw Error('test minimum must be explicitly configured to one USDC');
   if(input.minFee!=='0'||!input.feeProofReference)throw Error('independently verified zero minimum fee reference required');
   if(!['approve','burn'].includes(input.kind))throw Error('source kind required');
   output=await prepareSource(store,ledger,s.id,input.kind,{person:input.person,wallet:input.wallet as Address,attemptId:input.attempt,nonce:await client.getTransactionCount({address:input.wallet,blockTag:'pending'}),gas:BigInt(input.gas),maxFeePerGas:BigInt(input.maxFeePerGas),maxPriorityFeePerGas:BigInt(input.maxPriorityFeePerGas),maxAdditionalFee:BigInt(input.maxAdditionalFee??'0'),minFee:0n,principalCap:1_000000n,readAta});
  }else{
   const a=store.attempt(input.attempt);if(!a?.tx_hash||a.sweep_id!==s.id)throw Error('stored source submission hash required');
   const receipt=await client.getTransactionReceipt({hash:a.tx_hash as Hex}),head=await client.getBlock({blockTag:'finalized'}),block=await client.getBlock({blockNumber:receipt.blockNumber});
   if(receipt.blockNumber>head.number || block.hash!==receipt.blockHash)throw Error('source receipt not canonical/finalized');
   const raw=await client.request({method:'eth_getTransactionReceipt',params:[a.tx_hash as Hex]}) as unknown as {l1Fee?:Hex};
   if(r.chain==='base' && raw.l1Fee===undefined)throw Error('Base L1 fee missing');
   reconcileSource(store,ledger,a.id,{txHash:a.tx_hash as Hex,success:receipt.status==='success',gasUsed:receipt.gasUsed,effectiveGasPrice:receipt.effectiveGasPrice,additionalFee:BigInt(raw.l1Fee??'0x0'),finalized:true});
   output={txHash:a.tx_hash,receipt,ledger:store.shared.gasLedger(s.wallet,r.chain)};
  }
 }
 const json=JSON.stringify({action:v.action,signing:false,broadcast:false,sourceChain:r.chain,minimum6:String(r.minimum),result:output},(_k,x)=>typeof x==='bigint'?String(x):x,2)+'\n';
 if(v.out)writeFileSync(v.out,json);else process.stdout.write(json);
}finally{store.close();}
}
if(process.argv[1]?.endsWith('/run-control.ts'))await runControl(process.argv.slice(2));
