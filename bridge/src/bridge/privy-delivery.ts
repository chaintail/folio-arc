import { errorFields, reasonCode } from '../shims/log-fields.js';
import { logDebug, logError } from '../shims/log.js';
import { CCTP } from './registry.js';
import { randomUUID } from 'node:crypto';
import { address, blockhash, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, getTransactionDecoder, getSignatureFromTransaction, getBase64EncodedWireTransaction } from '@solana/kit';
import type { FeePayerSigner } from 'wallet-privy/server';
import type { GuardedDeliveryPort } from './worker.js';
import { simulate, type ReadRpc } from './solana.js';
/** The worker persists the signature before submit. Signed wires remain memory-only. */
export function createPrivyDeliveryPort(options:{execute:boolean;signer:FeePayerSigner;rpc:ReadRpc;maxCost:bigint;send(wire:string):Promise<string>}):GuardedDeliveryPort {
  if(!options.execute || options.maxCost<=0n)throw loggedRefusal('DELIVERY_EXECUTION_DISABLED');
  const pending=new Map<string,string>();
  return {live:true,payer:options.signer.address,async prepare(ix, remainingCost=options.maxCost) {
    const maxCost=remainingCost<options.maxCost?remainingCost:options.maxCost;
    const simulation=await simulate(options.rpc,[ix],options.signer.address);
    if(simulation.value.err)throw loggedRefusal('clean receive simulation required');
    const latest=await options.rpc.call<{value:{blockhash:string;lastValidBlockHeight:number}}>('getLatestBlockhash',[{commitment:'finalized'}]);
    const tx=compileTransaction(appendTransactionMessageInstructions([ix],setTransactionMessageLifetimeUsingBlockhash({blockhash:blockhash(latest.value.blockhash),lastValidBlockHeight:BigInt(latest.value.lastValidBlockHeight)},setTransactionMessageFeePayer(address(options.signer.address),createTransactionMessage({version:0})))));
    const fee=(await options.rpc.call<{value:number|null}>('getFeeForMessage',[Buffer.from(tx.messageBytes).toString('base64'),{commitment:'finalized'}])).value;
    const rent=await options.rpc.call<number>('getMinimumBalanceForRentExemption',[ix.programAddress===CCTP.associatedTokenProgram?165:9,{commitment:'finalized'}]);
    const balance=(await options.rpc.call<{value:number}>('getBalance',[options.signer.address,{commitment:'finalized'}])).value;
    if(fee===null || ![fee,rent,balance].every(n=>Number.isSafeInteger(n)&&n>=0) || BigInt(fee)+BigInt(rent)>maxCost || BigInt(balance)<maxCost)throw loggedRefusal('DELIVERY_COST_CAP_EXCEEDED');
    // Same verified fee-payer signing port used by trades.
    const bytes=await options.signer.signTransaction(Buffer.from(getBase64EncodedWireTransaction(tx),'base64'));
    const signed=getTransactionDecoder().decode(bytes),signature=getSignatureFromTransaction(signed);
    if(!Buffer.from(signed.messageBytes).equals(Buffer.from(tx.messageBytes)))throw loggedRefusal('DELIVERY_SIGNED_MESSAGE_MISMATCH');
    pending.set(signature,getBase64EncodedWireTransaction(signed));
    return {signature,requestId:randomUUID(),evidence:{payer:options.signer.address,fee_cap_raw:String(maxCost),last_valid_block_height:String(latest.value.lastValidBlockHeight)}};
  },async submit(signature) {
    const wire=pending.get(signature);if(!wire)throw loggedRefusal('DELIVERY_WIRE_UNAVAILABLE');
    pending.delete(signature);
    if(await options.send(wire)!==signature)throw loggedRefusal('DELIVERY_SIGNATURE_MISMATCH');
  }};
}
/** Construct only under the live execution gate; public read port cannot send. */
export function destinationSender(fetcher:typeof fetch,url:string) {
  return async(wire:string)=>{
    const started = Date.now();
    let status: number | undefined, rpc_code: number | undefined;
    logDebug('bridge_delivery_rpc', { method: 'sendTransaction', phase: 'start' });
    try {const response=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'sendTransaction',params:[wire,{encoding:'base64',skipPreflight:false,preflightCommitment:'finalized',maxRetries:0}]}),signal:AbortSignal.timeout(20000)});
      status = response.status;
      const body=await response.json() as {result?:string;error?:unknown};rpc_code = typeof (body.error as {code?:unknown})?.code === 'number' ? (body.error as {code:number}).code : undefined; if(!response.ok || body.error || !body.result)throw new Error();logDebug('bridge_delivery_rpc', { method: 'sendTransaction', phase: 'end', status, ms: Date.now()-started });return body.result;
    }catch (caughtError){ logError('bridge_delivery_rpc_failed', { method: 'sendTransaction', status, rpc_code, ms: Date.now()-started, ...errorFields(caughtError) }); throw loggedRefusal('DELIVERY_SUBMISSION_UNCERTAIN');}
  };
}

function loggedRefusal(reason:string) { logError('bridge_signing_guard',{stage:'validation',reason:reasonCode(reason)}); return new Error(reason); }
