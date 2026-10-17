import { errorFields } from '../shims/log-fields.js';
import { logDebug, logInfo } from '../shims/log.js';
import { BridgeBudgetExceeded } from './read-budget.js';
import { createHash } from 'node:crypto';
import { AccountChunkReadError, readAccountChunks, rpcMultiAccountCap, type MultiAccountResult } from '../shims/multi-account.js';
import { address, getAddressEncoder, getAddressDecoder, getProgramDerivedAddress, AccountRole, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions, compileTransaction, getTransactionEncoder, type Address, type Instruction, blockhash } from '@solana/kit';
import { CCTP, PUBLIC_SOLANA_RPC } from './registry.js';
import { decodeMessage, hexBytes, bytes32Address } from './message.js';
const enc={encode:(a:Address)=>new Uint8Array(getAddressEncoder().encode(a))}, text=(s:string)=>Buffer.from(s,'utf8');
export const discriminator=(name:string)=>createHash('sha256').update(name).digest().subarray(0,8);
const pda=async(programAddress:Address,seeds:readonly Uint8Array[]) => (await getProgramDerivedAddress({programAddress,seeds:[...seeds]}))[0];
export interface AccountInfo { owner:string; executable:boolean; data:[string,string]; lamports:number }
export interface ReadRpc { call<T>(method:string,params:unknown[]):Promise<T> }
const allowed=new Set(['getFeeForMessage','getMinimumBalanceForRentExemption','getBalance','getGenesisHash','getAccountInfo','getMultipleAccounts','getLatestBlockhash','getBlockHeight','getSignatureStatuses','getSignaturesForAddress','getTransaction','simulateTransaction']);
/** Fixed public endpoint, no credential loading, no send method. */
export function publicSolanaRpc(request:typeof fetch=fetch):ReadRpc {
  const multiCap = rpcMultiAccountCap();
  return { async call<T>(method:string,params:unknown[]):Promise<T> {
    if(!allowed.has(method)) throw new Error('write RPC forbidden');
    const started = Date.now();
    logDebug('bridge_solana_rpc', { method, phase: 'start' });
    let status: number | undefined, rpc_code: number | undefined;
    try {
      const send = async (params: unknown[]) => {
        const r=await request(PUBLIC_SOLANA_RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20_000)});
        status = r.status;
        if(!r.ok) throw new Error('RPC status');
        const b=await r.json() as {result?:T;error?:unknown}; if (typeof (b.error as {code?:unknown})?.code === 'number') rpc_code = (b.error as {code:number}).code; if(b.error || b.result===undefined) throw new Error('RPC error'); logDebug('bridge_solana_rpc', { method, phase: 'end', status, ms: Date.now()-started }); return b.result;
      };
      if (method === 'getMultipleAccounts' && Array.isArray(params[0]) && params[0].length > multiCap) {
        const batch = await readAccountChunks(params[0] as string[], (params[1] ?? {}) as Record<string, unknown>, multiCap,
          (keys, config) => send([keys, config]), reply => reply as MultiAccountResult);
        return batch.result as T;
      }
      return await send(params);
    } catch (error) {
      logInfo('bridge_solana_rpc_failed', { method, status, rpc_code, ms: Date.now()-started, ...errorFields(error) });
      if (error instanceof BridgeBudgetExceeded) throw error;
      if (error instanceof AccountChunkReadError) throw error;
      throw new Error(`Public Solana RPC unavailable: ${method}`);
    }
  }};
}
export async function readAccount(rpc:ReadRpc,key:string):Promise<AccountInfo|null> {
  const r=await rpc.call<{value:AccountInfo|null}>('getAccountInfo',[key,{encoding:'base64',commitment:'finalized'}]); return r.value;
}
export async function verifyPrograms(rpc:ReadRpc) {
  const genesis=await rpc.call<string>('getGenesisHash',[]); if(genesis!==CCTP.mainnetGenesis) throw new Error('wrong Solana cluster');
  const r=await rpc.call<{context:{slot:number};value:(AccountInfo|null)[]}>('getMultipleAccounts',[[CCTP.messageTransmitter,CCTP.tokenMessengerMinter],{encoding:'base64',commitment:'finalized'}]);
  if(r.value.length!==2 || r.value.some(a=>!a?.executable)) throw new Error('missing/nonexecutable CCTP program');
  return {genesis,slot:r.context.slot,programs:r.value.map((a,i)=>({address:[CCTP.messageTransmitter,CCTP.tokenMessengerMinter][i],owner:a!.owner,executable:a!.executable}))};
}
export async function deriveUsdcAta(owner:string):Promise<Address> {return pda(CCTP.associatedTokenProgram,[enc.encode(address(owner)),enc.encode(CCTP.tokenProgram),enc.encode(CCTP.usdc)]);}
export async function validateUsdcAta(owner:string,recipient:string,account:AccountInfo|null):Promise<Address> {
  const expected=await deriveUsdcAta(owner);
  if(address(recipient)!==expected) throw new Error('recipient is not owner USDC ATA');
  if(!account) throw new Error('USDC ATA missing');
  if(account.owner!==CCTP.tokenProgram || account.executable) throw new Error('classic Token account required');
  if(account.data[1]!=='base64') throw new Error('token account encoding');
  const b=Buffer.from(account.data[0],'base64');
  if(b.length!==165 || b[108]!==1) throw new Error('malformed/uninitialized token account');
  const dec=getAddressDecoder();
  if(dec.decode(b.subarray(0,32))!==CCTP.usdc) throw new Error('wrong mint');
  if(dec.decode(b.subarray(32,64))!==address(owner)) throw new Error('wrong authority');
  return expected;
}
export async function reverifyAta(rpc:ReadRpc,owner:string,recipient:string) {return validateUsdcAta(owner,recipient,await readAccount(rpc,recipient));}
/** Read-only inspection for Director diagnostics, including an ATA that has not been created. */
export async function inspectUsdcAta(rpc:ReadRpc,owner:string,recipient:string) {
  const expected=await deriveUsdcAta(owner),account=await readAccount(rpc,recipient);
  const bytes=account?.data[1]==='base64'?Buffer.from(account.data[0],'base64'):undefined;
  const decoder=getAddressDecoder();
  return {ata:recipient,expectedAta:expected,exists:!!account,
    owner:bytes && bytes.length>=64?decoder.decode(bytes.subarray(32,64)):null,
    mint:bytes && bytes.length>=32?decoder.decode(bytes.subarray(0,32)):null,
    programOwner:account?.owner??null};
}
export async function createAtaInstruction(owner:string,payer:string):Promise<Instruction> {
  if(owner===payer) throw new Error('Folio payer must differ from person');
  return {programAddress:CCTP.associatedTokenProgram,data:Uint8Array.of(1),accounts:[
    {address:address(payer),role:AccountRole.WRITABLE_SIGNER},{address:await deriveUsdcAta(owner),role:AccountRole.WRITABLE},
    {address:address(owner),role:AccountRole.READONLY},{address:CCTP.usdc,role:AccountRole.READONLY},
    {address:CCTP.systemProgram,role:AccountRole.READONLY},{address:CCTP.tokenProgram,role:AccountRole.READONLY}]};
}
export async function receivePdas(message:string):Promise<Record<'authority'|'messageTransmitter'|'usedNonce'|'mtEvent'|'tokenMessenger'|'remoteTokenMessenger'|'tokenMinter'|'localToken'|'tokenPair'|'custody'|'tmEvent',Address>> {
  const d=decodeMessage(message), mt=CCTP.messageTransmitter, tm=CCTP.tokenMessengerMinter;
  const domain=text(String(d.sourceDomain)),mint=enc.encode(CCTP.usdc);
  const keys=await Promise.all([
    pda(mt,[text('message_transmitter_authority'),enc.encode(tm)]),pda(mt,[text('message_transmitter')]),pda(mt,[text('used_nonce'),hexBytes(d.nonce)]),pda(mt,[text('__event_authority')]),
    pda(tm,[text('token_messenger')]),pda(tm,[text('remote_token_messenger'),domain]),pda(tm,[text('token_minter')]),
    pda(tm,[text('local_token'),mint]),pda(tm,[text('token_pair'),domain,hexBytes(d.burnToken)]),pda(tm,[text('custody'),mint]),pda(tm,[text('__event_authority')])]);
  return {authority:keys[0]!,messageTransmitter:keys[1]!,usedNonce:keys[2]!,mtEvent:keys[3]!,tokenMessenger:keys[4]!,remoteTokenMessenger:keys[5]!,tokenMinter:keys[6]!,localToken:keys[7]!,tokenPair:keys[8]!,custody:keys[9]!,tmEvent:keys[10]!};
}
/** fee_recipient is Borsh Pubkey at 8 + 32*3 + 4 + 1 = 109 in TokenMessenger. */
export function decodeFeeRecipient(account:AccountInfo):Address {
  const b=Buffer.from(account.data[0],'base64');
  if(account.owner!==CCTP.tokenMessengerMinter || b.length<141 || !b.subarray(0,8).equals(discriminator('account:TokenMessenger'))) throw new Error('invalid TokenMessenger state');
  return getAddressDecoder().decode(b.subarray(109,141));
}
/** Outer Anchor event accounts precede remaining V2 accounts, including mandatory fee ATA. */
export async function receiveInstruction(message:string,attestation:string,payer:string,feeRecipientOwner:string):Promise<Instruction> {
  const d=decodeMessage(message), p=await receivePdas(message);
  const recipient=address(bytes32Address(d.mintRecipient)), payerAddress=address(payer);
  const m=hexBytes(message), a=hexBytes(attestation);
  if(a.length%65!==0 || a.length===0) throw new Error('malformed attestation');
  const len=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
  const ro=(key:Address)=>({address:key,role:AccountRole.READONLY}), rw=(key:Address)=>({address:key,role:AccountRole.WRITABLE});
  return {programAddress:CCTP.messageTransmitter,data:Buffer.concat([discriminator('global:receive_message'),len(m.length),m,len(a.length),a]),accounts:[
    {address:payerAddress,role:AccountRole.WRITABLE_SIGNER},{address:payerAddress,role:AccountRole.READONLY_SIGNER},ro(p.authority),ro(p.messageTransmitter),rw(p.usedNonce),ro(CCTP.tokenMessengerMinter),ro(CCTP.systemProgram),ro(p.mtEvent),ro(CCTP.messageTransmitter),
    ro(p.tokenMessenger),ro(p.remoteTokenMessenger),ro(p.tokenMinter),rw(p.localToken),ro(p.tokenPair),rw(await deriveUsdcAta(feeRecipientOwner)),rw(recipient),rw(p.custody),ro(CCTP.tokenProgram),ro(p.tmEvent),ro(CCTP.tokenMessengerMinter)]};
}
export function unsignedTransaction(instructions:readonly Instruction[],payer:string):Uint8Array {
  const message=appendTransactionMessageInstructions(instructions,setTransactionMessageLifetimeUsingBlockhash({blockhash:blockhash('11111111111111111111111111111111'),lastValidBlockHeight:0n},setTransactionMessageFeePayer(address(payer),createTransactionMessage({version:0}))));
  const bytes=new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
  if(bytes.length>1232) throw new Error('receive exceeds Solana packet limit; lookup table required');
  return bytes;
}
export async function simulate(rpc:ReadRpc,instructions:readonly Instruction[],payer:string) {
  return rpc.call<{context:{slot:number};value:{err:unknown;logs:string[];unitsConsumed:number}}>('simulateTransaction',[Buffer.from(unsignedTransaction(instructions,payer)).toString('base64'),{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'finalized'}]);
}
