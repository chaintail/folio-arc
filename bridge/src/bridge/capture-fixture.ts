/** Imported opt-in public-read fixture capture utility; no CLI or scheduled worker entry point. */
import { logInfo, logError } from '../shims/log.js';
import { errorFields } from '../shims/log-fields.js';
/** Bounded read-only Base burn search for destination fixtures. */
import { keccak_256 } from '@noble/hashes/sha3';
import { CCTP, PUBLIC_BASE_RPC } from './registry.js';
import { addressBytes32, decodeMessage, type MessageExpectation } from './message.js';
import { createAttestationClient } from './attestation.js';
export const DEPOSIT_FOR_BURN_TOPIC=`0x${Buffer.from(keccak_256(Buffer.from('DepositForBurn(address,uint256,address,bytes32,uint32,bytes32,bytes32,uint256,uint32,bytes)'))).toString('hex')}`;
const requireRecipient=()=>addressBytes32(CCTP.tokenMessengerMinter);
interface BurnLog {address:string;transactionHash:string;blockNumber:string;logIndex:string;topics:string[];data:string;removed?:boolean}
export function decodeBurnLog(log:BurnLog):MessageExpectation|undefined {
  if(log.removed || log.address.toLowerCase()!==`0x${CCTP.base.tokenMessenger.slice(-40)}` || log.topics[0]!==DEPOSIT_FOR_BURN_TOPIC || log.topics.length!==4 || log.topics[1]?.toLowerCase()!==CCTP.base.burnToken || BigInt(log.topics[3]!)!==2000n) return undefined;
  if(!/^0x[\da-f]+$/i.test(log.data))return undefined;
  const b=Buffer.from(log.data.slice(2),'hex');if(b.length!==256)return undefined;
  const word=(n:number)=>`0x${b.subarray(n*32,(n+1)*32).toString('hex')}`;
  if(BigInt(word(2))!==5n || word(3)!==requireRecipient() || BigInt(word(4))!==0n || BigInt(word(5))!==0n || BigInt(word(6))!==224n || BigInt(word(7))!==0n) return undefined;
  return {sourceDomain:6,burnToken:CCTP.base.burnToken,amount:BigInt(word(0)).toString(),mintRecipient:word(1),minFinalityThreshold:2000,sender:CCTP.base.tokenMessenger,messageSender:log.topics[2]!};
}
export async function captureCompletedBaseFixture(options:{fetch?:typeof fetch;maxPages?:number}={}) {
  logInfo('bridge_operator_run',{mode:'read_only',stage:'capture_start'});
  const request=options.fetch ?? fetch;
  const rpc=async<T>(method:string,params:unknown[]):Promise<T>=>{
    if(!['eth_blockNumber','eth_getLogs','eth_getTransactionReceipt','eth_chainId'].includes(method))throw new Error('write RPC forbidden');
    try {const response=await request(PUBLIC_BASE_RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20_000)});const body=await response.json() as {result?:T;error?:unknown};if(!response.ok||body.error||body.result===undefined)throw new Error('unavailable');return body.result;}catch(e){logError('bridge_operator_run',{mode:'read_only',stage:'rpc',method,...errorFields(e)});throw new Error(`Public Base RPC unavailable: ${method}`);}
  };
  if(BigInt(await rpc<string>('eth_chainId',[]))!==8453n)throw new Error('wrong Base chain');
  const head=BigInt(await rpc<string>('eth_blockNumber',[])),iris=createAttestationClient({fetch:request});
  let candidates=0;
  for(let page=0;page<Math.min(20,options.maxPages ?? 10);page++) {
    const to=head-BigInt(page*1000),from=to-999n;if(from<0n)break;
    const logs=await rpc<BurnLog[]>('eth_getLogs',[{address:`0x${CCTP.base.tokenMessenger.slice(-40)}`,fromBlock:`0x${from.toString(16)}`,toBlock:`0x${to.toString(16)}`,topics:[DEPOSIT_FOR_BURN_TOPIC,CCTP.base.burnToken,null,`0x${(2000n).toString(16).padStart(64,'0')}`]}]);
    for(const log of [...logs].reverse()) {
      const expected=decodeBurnLog(log);if(!expected)continue;
      if(++candidates>100)throw new Error('bounded fixture candidate limit reached');
      const receipt=await rpc<{status:string;blockNumber:string}>('eth_getTransactionReceipt',[log.transactionHash]);if(receipt.status!=='0x1'||receipt.blockNumber!==log.blockNumber)continue;
      const response=await iris.lookup(log.transactionHash,expected);
      if(response.kind==='retry' && response.reason==='rate_limited') throw new Error('Iris rate limited: retry after shared five-minute cooldown');
      if(response.kind!=='ready')continue;
      logInfo('bridge_operator_run',{mode:'read_only',stage:'capture',outcome:'complete',candidate_count:candidates});
      return {evidence_mode:'RPC_READ' as const,captured_at:new Date().toISOString(),burn:log.transactionHash,log,receipt,expected,message:response.message,attestation:response.attestation,messageHash:response.messageHash,decoded:decodeMessage(response.message)};
    }
  }
  throw new Error('no completed Base to Solana Standard fixture in bounded recent search');
}
