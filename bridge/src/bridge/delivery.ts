import { logInfo, logDebug } from '../shims/log.js';
import { obligationAddress } from '../shims/obligation.js';
import { getBase58Encoder } from '@solana/kit';
import { CCTP } from './registry.js';
import { validateMessage, messageDigest, hexBytes, addressBytes32, type MessageExpectation } from './message.js';
import { discriminator, receivePdas, readAccount, reverifyAta, type ReadRpc } from './solana.js';
import type { Sweep, Transfer } from './transfer-record.js';
export function expectationFor(sweep:Sweep,transfer:Transfer,route?:{burnToken:string;sender:string}):MessageExpectation {
  if((sweep.chain==='base' && transfer.source_domain!==6)||(sweep.chain==='arc' && transfer.source_domain!==26)||sweep.chain==='solana') throw refusal('source chain/domain mismatch');
  const source = transfer.source_domain===6 ? CCTP.base : transfer.source_domain===26 ? CCTP.arc : undefined;
  route ??= source ? {burnToken:source.burnToken,sender:source.tokenMessenger} : undefined;
  if(!route || (transfer.source_domain!==6 && route.burnToken===CCTP.base.burnToken)) throw refusal('source route registry required');
  if(!/^0x[\da-f]{40}$/i.test(sweep.wallet)) throw refusal('invalid source wallet');
  if(addressBytes32(sweep.mint_recipient)!==sweep.mint_recipient_bytes32.toLowerCase()) throw refusal('pinned ATA bytes mismatch');
  return {sourceDomain:transfer.source_domain,burnToken:route.burnToken,sender:route.sender,amount:sweep.amount_6,mintRecipient:sweep.mint_recipient_bytes32,minFinalityThreshold:2000,messageSender:`0x${'0'.repeat(24)}${sweep.wallet.slice(2).toLowerCase()}`,...(transfer.message_nonce?{nonce:transfer.message_nonce}:{}),...(transfer.message_hash?{messageHash:transfer.message_hash}:{})};
}
interface ParsedInstruction {programId:string;data?:string;accounts?:string[];parsed?:{type:string;info:Record<string,unknown>}}
interface TokenBalance {accountIndex:number;mint:string;owner?:string}
export interface DeliveryTransaction {
  slot:number;blockTime?:number|null;
  meta:{err:unknown;fee:number;preBalances?:number[];postBalances?:number[];preTokenBalances:TokenBalance[];postTokenBalances:TokenBalance[];innerInstructions:{index:number;instructions:ParsedInstruction[]}[]};
  transaction:{signatures:string[];message:{accountKeys:(string|{pubkey:string})[];instructions:ParsedInstruction[]}};
}
const verified=new WeakSet<object>();
export interface VerifiedDelivery {
  readonly sweepId:string;readonly person:string;readonly owner:string;readonly recipient:string;
  readonly sourceDomain:number;readonly nonce:string;readonly signature:string;readonly slot:string;
  readonly feePayer:string;readonly feePaidRaw:string;readonly payerCostRaw:string;
  readonly amount6:string;readonly totalExternalAmount6:string;readonly observedAt:string;
}
/** Runtime provenance check: arbitrary request objects cannot use the relay exception. */
export function assertVerifiedDelivery(value:VerifiedDelivery):void {if(!verified.has(value)) throw refusal('unverified CCTP delivery');}
/** Decoder used only after finalized signature and nonce checks; exported for offline fixtures. */
export async function decodeDeliveryTransaction(sweep:Sweep,transfer:Transfer,signature:string,tx:DeliveryTransaction,ownSources:readonly string[]=[]) {
  if(!transfer.message || !transfer.attestation) throw refusal('stored attestation missing');
  if(!Number.isSafeInteger(tx.meta.fee) || tx.meta.fee<0) throw refusal('receipt fee unavailable');
  if(tx.meta.err || !Number.isSafeInteger(tx.slot) || !tx.transaction.signatures.includes(signature)) throw refusal('failed/mismatched transaction');
  const message=hexBytes(transfer.message),p=await receivePdas(transfer.message),disc=discriminator('global:receive_message');
  const all=[...tx.transaction.message.instructions,...tx.meta.innerInstructions.flatMap(g=>g.instructions)];
  const receives=all.filter(ix=>ix.programId===CCTP.messageTransmitter && ix.data && Buffer.from(getBase58Encoder().encode(ix.data)).subarray(0,8).equals(disc));
  if(receives.length!==1) throw refusal('exactly one receive per transaction required');
  const ix=receives[0]!,data=Buffer.from(getBase58Encoder().encode(ix.data!));
  if(data.length<16 || data.readUInt32LE(8)!==message.length || !data.subarray(12,12+message.length).equals(message)) throw refusal('receipt message mismatch');
  const att=hexBytes(transfer.attestation),attStart=12+message.length;
  if(data.length!==attStart+4+att.length || data.readUInt32LE(attStart)!==att.length || !data.subarray(attStart+4).equals(att)) throw refusal('receipt attestation mismatch');
  if(ix.accounts?.[4]!==p.usedNonce || ix.accounts?.[15]!==sweep.mint_recipient) throw refusal('receipt accounts mismatch');
  const keys=tx.transaction.message.accountKeys.map(k=>typeof k==='string'?k:k.pubkey),balances=[...tx.meta.preTokenBalances,...tx.meta.postTokenBalances];
  let total=0n,delivered=0n;
  const own=new Set([sweep.destination_owner,...ownSources]);
  for(const instruction of all) {
    if(instruction.programId!==CCTP.tokenProgram || !['transfer','transferChecked'].includes(instruction.parsed?.type ?? '')) continue;
    const info=instruction.parsed!.info;
    if(info.destination!==sweep.mint_recipient || typeof info.source!=='string' || info.source===info.destination) continue;
    const src=balances.find(b=>b.accountIndex===keys.indexOf(info.source as string));
    if(!src?.owner || src.mint!==CCTP.usdc) throw refusal('incoming transfer source unavailable');
    if(info.mint!==undefined && info.mint!==CCTP.usdc) throw refusal('incoming transfer wrong mint');
    const tokenAmount=info.tokenAmount as {amount?:unknown;decimals?:number}|undefined;
    if(tokenAmount && tokenAmount.decimals!==6) throw refusal('incoming transfer precision');
    const raw=tokenAmount?.amount ?? info.amount;
    if(typeof raw!=='string' || !/^\d+$/.test(raw)) throw refusal('incoming transfer amount');
    if(info.source===p.custody) delivered+=BigInt(raw);
    if(!own.has(src.owner) && !own.has(info.authority as string) && !own.has(info.source)) total+=BigInt(raw);
  }
  if(delivered!==BigInt(sweep.amount_6) || total<delivered) throw refusal('delivered principal mismatch');
  const pre=tx.meta.preBalances?.[0],post=tx.meta.postBalances?.[0];
  const payerCost=pre!==undefined && post!==undefined && Number.isSafeInteger(pre) && Number.isSafeInteger(post)?BigInt(pre)-BigInt(post):BigInt(tx.meta.fee);
  return {totalExternalAmount6:total.toString(),slot:String(tx.slot),feePayer:keys[0]!,feePaidRaw:String(tx.meta.fee),payerCostRaw:payerCost.toString()};
}
/** Never settle from nonce existence alone: require successful finalized matching transaction too. */
export async function verifyDelivery(rpc:ReadRpc,sweep:Sweep,transfer:Transfer,signature:string,expected:MessageExpectation,ownSources?:readonly string[]):Promise<VerifiedDelivery> {
  if(!transfer.message || !transfer.message_hash || !transfer.message_nonce) throw refusal('message not durable');
  if(expected.sourceDomain!==transfer.source_domain || expected.amount!==sweep.amount_6 || expected.mintRecipient.toLowerCase()!==sweep.mint_recipient_bytes32.toLowerCase()) throw refusal('expectation differs from pinned transfer');
  const d=validateMessage(transfer.message,expected);
  if(messageDigest(transfer.message)!==transfer.message_hash || d.nonce!==transfer.message_nonce) throw refusal('stored identity mismatch');
  await reverifyAta(rpc,sweep.destination_owner,sweep.mint_recipient);
  const status=await rpc.call<{value:({confirmationStatus:string;err:unknown}|null)[]}>('getSignatureStatuses',[[signature],{searchTransactionHistory:true}]);
  if(status.value[0]?.confirmationStatus!=='finalized' || status.value[0].err) throw refusal('delivery not finalized');
  const p=await receivePdas(transfer.message),nonce=await readAccount(rpc,p.usedNonce);
  const b=nonce?Buffer.from(nonce.data[0],'base64'):Buffer.alloc(0);
  if(!nonce || nonce.owner!==CCTP.messageTransmitter || !b.subarray(0,8).equals(discriminator('account:UsedNonce')) || b[8]!==1) throw refusal('nonce not consumed');
  const tx=await rpc.call<DeliveryTransaction|null>('getTransaction',[signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'finalized'}]);
  if(!tx) throw refusal('delivery transaction unavailable');
  const internal=ownSources ?? await Promise.all((['spot','margin','crypto'] as const).map(account=>obligationAddress(account,sweep.destination_owner)));
  const decoded=await decodeDeliveryTransaction(sweep,transfer,signature,tx,internal);
  const result=Object.freeze({sweepId:sweep.id,person:sweep.person,owner:sweep.destination_owner,recipient:sweep.mint_recipient,sourceDomain:d.sourceDomain,nonce:d.nonce,signature,amount6:sweep.amount_6,...decoded,observedAt:new Date().toISOString()});
  logDebug('bridge_delivery_validation',{sweep_id:sweep.id.slice(0,12),check:'finalized_receipt',outcome:'verified',slot:decoded.slot,expected_amount_raw:sweep.amount_6,observed_amount_raw:decoded.totalExternalAmount6});
  verified.add(result);return result;
}
/** Finds an external relayer's delivery using the per-message nonce account history. */
export async function discoverDelivery(rpc:ReadRpc,transfer:Transfer):Promise<string[]> {
  if(!transfer.message) return [];
  const p=await receivePdas(transfer.message),account=await readAccount(rpc,p.usedNonce);
  if(!account) return [];
  const rows=await rpc.call<{signature:string;err:unknown;confirmationStatus:string}[]>('getSignaturesForAddress',[p.usedNonce,{commitment:'finalized',limit:20}]);
  return rows.filter(r=>!r.err && r.confirmationStatus==='finalized').map(r=>r.signature);
}

function refusal(reason:string) { logInfo('bridge_delivery_validation',{check:reason.replace(/[^A-Za-z0-9]+/g,'_').toLowerCase(),outcome:'refused'});return new Error(reason); }
