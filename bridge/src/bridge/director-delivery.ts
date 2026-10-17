import { logInfo, logError } from '../shims/log.js';
import { errorFields } from '../shims/log-fields.js';
/** Director-only first-delivery harness. Dry run loads no key and never signs/sends.
 * Live execution submits destination receive only; settled row remains the person-credit outbox.
 * No source adapter, source signing authority, wallet creation or second burn exists here. */
import { existsSync,readFileSync,statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { address,blockhash,appendTransactionMessageInstructions,compileTransaction,createTransactionMessage,setTransactionMessageFeePayer,setTransactionMessageLifetimeUsingBlockhash,createKeyPairFromBytes,getAddressFromPublicKey,signTransaction,getSignatureFromTransaction,getBase64EncodedWireTransaction } from '@solana/kit';
import { CCTP,PUBLIC_SOLANA_RPC } from './registry.js';
import { openTransferStore,type Sweep,type Transfer } from './transfer-record.js';
import { createAttestationClient } from './attestation.js';
import { expectationFor,verifyDelivery,discoverDelivery } from './delivery.js';
import { publicSolanaRpc,verifyPrograms,reverifyAta,receiveInstruction,receivePdas,readAccount,decodeFeeRecipient,simulate,unsignedTransaction } from './solana.js';
export function parseDeliveryArgs(args:readonly string[]) {
  const {values:v}=parseArgs({args:[...args],options:{db:{type:'string'},sweep:{type:'string'},'burn-hash':{type:'string'},owner:{type:'string'},'fee-payer':{type:'string'},'payer-keypair':{type:'string'},'max-amount-6':{type:'string'},'max-cost-lamports':{type:'string'},execute:{type:'boolean'},'i-am-the-director':{type:'boolean'},'dry-run':{type:'boolean'}}});
  for(const key of ['db','sweep','burn-hash','owner','fee-payer','max-amount-6','max-cost-lamports'] as const)if(!v[key])throw new Error(`missing --${key}`);
  address(v.owner!);
  address(v['fee-payer']!);if(v['fee-payer']===v.owner)throw new Error('person cannot pay');
  if(!/^0x[\da-f]{64}$/i.test(v['burn-hash']!))throw new Error('invalid pinned burn hash');
  for(const key of ['max-amount-6','max-cost-lamports'] as const)if(!/^[1-9]\d*$/.test(v[key]!))throw new Error(`invalid --${key}`);
  if(v.execute && (!v['i-am-the-director'] || v['dry-run'] || !v['payer-keypair']))throw new Error('live requires --execute --i-am-the-director --payer-keypair and no --dry-run');
  return {db:v.db!,sweep:v.sweep!,burn:v['burn-hash']!,owner:v.owner!,payer:v['fee-payer']!,keypair:v['payer-keypair'],maxAmount:BigInt(v['max-amount-6']!),maxCost:BigInt(v['max-cost-lamports']!),live:!!v.execute};
}
export async function directorDelivery(args:readonly string[],out:(value:unknown)=>void=console.log) {
  let options:ReturnType<typeof parseDeliveryArgs>;try{options=parseDeliveryArgs(args);}catch(e){logInfo('bridge_operator_run',{stage:'arguments',outcome:'refused',reason:'guard_refused'});throw e;}
  logInfo('bridge_operator_run',{mode:options.live?'live':'dry_run',stage:'start',sweep_id:options.sweep.slice(0,12)});if(!existsSync(options.db))throw new Error('existing transfer database required');
  const readDb=new DatabaseSync(options.db,{readOnly:true});
  const sweep=readDb.prepare('SELECT * FROM bridge_sweep WHERE id=?').get(options.sweep) as unknown as Sweep|undefined;
  let row=readDb.prepare('SELECT * FROM bridge_transfer WHERE sweep_id=?').get(options.sweep) as unknown as Transfer|undefined;readDb.close();
  if(!sweep || !row || sweep.destination_owner!==options.owner || row.burn_tx_hash!==options.burn || !((sweep.chain==='base' && row.source_domain===6)||(sweep.chain==='arc' && row.source_domain===26)) || BigInt(sweep.amount_6)>options.maxAmount || BigInt(sweep.amount_6)<=0n)throw new Error('stored route/owner/burn/full amount cap mismatch');
  if(!['burn_confirmed','attested','delivery_submitted','delivery_uncertain','settled'].includes(row.state))throw new Error('transfer not ready for destination recovery');
  const rpc=publicSolanaRpc();await verifyPrograms(rpc);await reverifyAta(rpc,options.owner,sweep.mint_recipient);
  const att=await createAttestationClient().lookup(row.burn_tx_hash,expectationFor(sweep,row));
  if(att.kind!=='ready')throw new Error(`attestation ${att.reason}; retry after ${att.delayMs} ms`);
  row={...row,message:att.message,attestation:att.attestation,message_hash:att.messageHash,message_nonce:att.nonce,attestation_state:'complete'};
  const candidates=[...new Set([...(row.settled_signature?[row.settled_signature]:[]),...(row.destination_signature?[row.destination_signature]:[]),...await discoverDelivery(rpc,row)])];
  for(const signature of candidates) {
    try {const delivery=await verifyDelivery(rpc,sweep,row,signature,expectationFor(sweep,row));out({mode:options.live?'LIVE_RECONCILE':'DRY_RUN',already_delivered:delivery,credit_replay_required:true});return;}catch(e){logInfo('bridge_operator_run',{stage:'discovery',outcome:'rejected',...errorFields(e)});/* never consider a failed or mismatched receipt settled */}
  }
  if(['delivery_submitted','delivery_uncertain','settled'].includes(row.state))throw new Error('existing destination attempt unresolved; run worker reconciliation before any new submission');
  const pdas=await receivePdas(row.message!),config=await readAccount(rpc,pdas.tokenMessenger);if(!config)throw new Error('TokenMessenger state missing');
  const ix=await receiveInstruction(row.message!,row.attestation!,options.payer,decodeFeeRecipient(config));
  const simulation=await simulate(rpc,[ix],options.payer);
  out({mode:options.live?'LIVE_GUARDED':'DRY_RUN',sweep_id:sweep.id,burn_hash:row.burn_tx_hash,amount_6:sweep.amount_6,recipient:sweep.mint_recipient,owner:options.owner,payer:options.payer,message_nonce:row.message_nonce,message_hash:row.message_hash,packet_bytes:unsignedTransaction([ix],options.payer).length,simulation});
  if(!options.live){logInfo('bridge_operator_run',{mode:'dry_run',stage:'complete',outcome:'validated'});return;}
  if(simulation.value.err)throw new Error('clean receive simulation required before signing');
  // The execution boundary is below every route, recipient, amount and simulation guard.
  const privateRpc=async<T>(method:string,params:unknown[]):Promise<T>=>{
    if(!['getLatestBlockhash','getFeeForMessage','getMinimumBalanceForRentExemption','getBalance','sendTransaction'].includes(method))throw new Error('director RPC method refused');
    try{const response=await fetch(PUBLIC_SOLANA_RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20_000)});const body=await response.json() as {result?:T;error?:unknown};if(!response.ok||body.error||body.result===undefined)throw new Error('RPC error');return body.result;}catch{throw new Error(`Director RPC unavailable: ${method}; reconcile stored signature before retry`);}
  };
  const latest=await privateRpc<{value:{blockhash:string;lastValidBlockHeight:number}}>('getLatestBlockhash',[{commitment:'finalized'}]);
  const tx=compileTransaction(appendTransactionMessageInstructions([ix],setTransactionMessageLifetimeUsingBlockhash({blockhash:blockhash(latest.value.blockhash),lastValidBlockHeight:BigInt(latest.value.lastValidBlockHeight)},setTransactionMessageFeePayer(address(options.payer),createTransactionMessage({version:0})))));
  const fee=(await privateRpc<{value:number|null}>('getFeeForMessage',[Buffer.from(tx.messageBytes).toString('base64'),{commitment:'finalized'}])).value;
  const rent=await privateRpc<number>('getMinimumBalanceForRentExemption',[9,{commitment:'finalized'}]);
  if(fee===null || !Number.isSafeInteger(fee) || BigInt(fee)+BigInt(rent)>options.maxCost)throw new Error('Folio destination fee+nonce-rent cap exceeded');
  const balance=(await privateRpc<{value:number}>('getBalance',[options.payer,{commitment:'finalized'}])).value;
  if(BigInt(balance)<options.maxCost)throw new Error('Folio payer balance below approved budget');
  // Resolve the key only in the Director-executed branch; never load it in dry run.
  if(statSync(options.keypair!).mode & 0o077)throw new Error('payer keypair must have mode 600');
  let raw:unknown;try {raw=JSON.parse(readFileSync(options.keypair!,'utf8'));}catch {throw new Error('payer keypair could not be decoded');}
  if(!Array.isArray(raw)||raw.length!==64||raw.some(n=>!Number.isInteger(n)||n<0||n>255))throw new Error('invalid payer keypair');
  const bytes=Uint8Array.from(raw);let key:Awaited<ReturnType<typeof createKeyPairFromBytes>>;
  try {key=await createKeyPairFromBytes(bytes,false);}catch {throw new Error('payer keypair rejected');}finally {bytes.fill(0);raw.fill(0);}
  if(await getAddressFromPublicKey(key.publicKey)!==options.payer)throw new Error('fee payer key does not match approved public address');
  await reverifyAta(rpc,options.owner,sweep.mint_recipient);
  const signed=await signTransaction([key],tx),signature=getSignatureFromTransaction(signed),store=openTransferStore(options.db);
  try {
    const current=store.getTransfer(sweep.id)!;
    if(current.state==='burn_confirmed'){store.saveAttestation(sweep.id,{message:row.message!,attestation:row.attestation!,message_nonce:row.message_nonce!,message_hash:row.message_hash!});store.transition(sweep.id,'attested');}
    if(store.getTransfer(sweep.id)?.state!=='attested')throw new Error('concurrent delivery already advanced');
    store.addAttempt({id:`receive:${signature}`,sweep_id:sweep.id,kind:'receive',chain:'solana',request_id:`receive:${signature}`,tx_hash:signature,nonce:row.message_nonce,state:'signed',gas_paid_raw:'0',evidence_json:JSON.stringify({last_valid_block_height:String(latest.value.lastValidBlockHeight),fee_cap_raw:options.maxCost.toString(),payer:options.payer})});
    store.destination(sweep.id,signature);store.transition(sweep.id,'delivery_submitted');
    out({destination_signature:signature,persisted_before_submit:true});
    try {const returned=await privateRpc<string>('sendTransaction',[getBase64EncodedWireTransaction(signed),{encoding:'base64',skipPreflight:false,preflightCommitment:'finalized',maxRetries:0}]);if(returned!==signature)throw new Error('unexpected returned signature');store.updateAttempt(`receive:${signature}`,'submitted','0',{last_valid_block_height:String(latest.value.lastValidBlockHeight),payer:options.payer});}
    catch (e) {logError('bridge_operator_run',{mode:'live',stage:'submit',outcome:'uncertain',sweep_id:sweep.id.slice(0,12),...errorFields(e)});store.updateAttempt(`receive:${signature}`,'uncertain','0',{last_valid_block_height:String(latest.value.lastValidBlockHeight),payer:options.payer});store.transition(sweep.id,'delivery_uncertain');throw new Error('submission uncertain; signature retained; worker must reconcile');}
    out({state:'delivery_submitted',destination_signature:signature,next:'worker must verify finalized receipt, settle row, then call creditCctpDelivery; never re-burn'});
  }finally{store.close();}
}
