import { parseArgs } from 'node:util';
import { address } from '@solana/kit';
/** Public mainnet reads + state-override simulation; no signing or broadcast client. */
import {createPublicClient,custom,encodeAbiParameters,keccak256,toHex,encodeFunctionData,parseAbi,serializeTransaction,type Hex,type Address} from 'viem';
import {route,TOKEN_MESSENGER} from '../../src/bridge/source-registry.js';
import {verifyDestination,sourceCalls} from '../../src/bridge/source-calls.js';
const wallet='0x000000000000000000000000000000000000dEaD' as Address;
const target='0x1111111111111111111111111111111111111111' as Address;
const reads=new Set(['eth_chainId','eth_call','eth_getStorageAt','eth_getBalance','eth_getBlockByNumber','eth_estimateGas','eth_gasPrice','eth_getTransactionReceipt','eth_getCode']);
const endpoints={base:'https://mainnet.base.org',arc:'https://rpc.mainnet.arc.io'};
const result:any={timestamp:new Date().toISOString(),signing:false,broadcast:false,amount6:'1000000',chains:{}};
async function solRead(a:string){const body=await(await fetch('https://api.mainnet-beta.solana.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getAccountInfo',params:[a,{encoding:'base64',commitment:'finalized'}]}),signal:AbortSignal.timeout(10000)})).json();if(body.error)throw Error(JSON.stringify(body.error));return {exists:!!body.result.value,program:body.result.value?.owner??'',data:Buffer.from(body.result.value?.data[0]??'','base64')};}
const {values: args}=parseArgs({options:{owner:{type:'string'}}});
if(!args.owner)throw Error('DESTINATION_OWNER_REQUIRED');
const destination=await verifyDestination(address(args.owner),solRead);
const mapping=(who:Address,slot:bigint)=>keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[who,slot]));
for(const chain of ['base','arc'] as const){
 const r=route(chain),out:any={chainId:r.chainId,domain:r.domain,simulations:{},probes:[]};result.chains[chain]=out;
 const rpc=async(method:string,params:any[])=>{await new Promise(r=>setTimeout(r,350));if(!reads.has(method))throw Error('READ_ONLY');const body=await(await fetch(endpoints[chain],{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)})).json();if(body.error)throw Error(JSON.stringify(body.error));return body.result;};
 const client=createPublicClient({transport:custom({request:({method,params})=>rpc(method,params??[])},{retryCount:3,retryDelay:2000})});
 out.chainIdRead=await client.getChainId();out.block=await rpc('eth_getBlockByNumber',['latest',false]);delete out.block.transactions;
 out.gasPrice=String(await client.getGasPrice());
 async function l1Fee(to:Address,data:Hex,value:bigint,gas:bigint) {
  if(chain!=='base')return '0';
  const unsigned=serializeTransaction({type:'eip1559',chainId:r.chainId,to,data,value,gas,nonce:0,maxFeePerGas:BigInt(out.gasPrice),maxPriorityFeePerGas:0n});
  return String(await client.readContract({address:'0x420000000000000000000000000000000000000F',abi:parseAbi(['function getL1Fee(bytes) view returns(uint256)']),functionName:'getL1Fee',args:[unsigned]}));
 }
 const tokenAbi=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function transfer(address,uint256) returns(bool)']);
 const calls=sourceCalls(r,1000000n,destination,0n);
 let balanceSlot:Hex|undefined,allowanceSlot:Hex|undefined;
 const nativeOverride={address:wallet,balance:100n*10n**18n};
 if(chain==='base'){
  for(const slot of [9n]){
   const key=mapping(wallet,slot); const raw=await client.getStorageAt({address:r.usdc,slot:key});
   const test=await client.readContract({address:r.usdc,abi:tokenAbi,functionName:'balanceOf',args:[wallet],stateOverride:[nativeOverride,{address:r.usdc,stateDiff:[{slot:key,value:toHex(1000000n,{size:32})}]}]});
   out.probes.push({kind:'balance',slot:String(slot),key,original:raw,overrideRead:String(test)});
   if(test===1000000n){balanceSlot=key;break;}
  }
 }else{
  const actual=await client.readContract({address:r.usdc,abi:tokenAbi,functionName:'balanceOf',args:[wallet],stateOverride:[nativeOverride]});
  out.nativeUSDCBalanceOverrideRead=String(actual);
 }
 for(const slot of [10n,0n,1n,2n,3n,4n,5n,6n,7n,8n,9n,11n,12n]){
  const key=keccak256(encodeAbiParameters([{type:'address'},{type:'bytes32'}],[TOKEN_MESSENGER,mapping(wallet,slot)]));
  const raw=await client.getStorageAt({address:r.usdc,slot:key});
  const test=await client.readContract({address:r.usdc,abi:tokenAbi,functionName:'allowance',args:[wallet,TOKEN_MESSENGER],stateOverride:[nativeOverride,{address:r.usdc,stateDiff:[{slot:key,value:toHex(1000000n,{size:32})}]}]});
  out.probes.push({kind:'allowance',slot:String(slot),key,original:raw,overrideRead:String(test)});
  if(test===1000000n){allowanceSlot=key;break;}
 }
 out.balanceSlot=balanceSlot??'native account balance';out.allowanceSlot=allowanceSlot;
 const override=[nativeOverride,{address:r.usdc,stateDiff:[...(balanceSlot?[{slot:balanceSlot,value:toHex(1000000n,{size:32})}]:[]),...(allowanceSlot?[{slot:allowanceSlot,value:toHex(1000000n,{size:32})}]:[])]}];
 for(const call of [...calls,{kind:'native_topup',to:target,data:'0x' as Hex,value:1000000000000000n},{kind:'erc20_transfer',to:r.usdc,data:encodeFunctionData({abi:tokenAbi,functionName:'transfer',args:[target,1000000n]}),value:0n}]){
  const req={account:wallet,to:call.to,data:call.data,value:call.value,stateOverride:call.kind==='approve'?[nativeOverride,{address:r.usdc,stateDiff:balanceSlot?[{slot:balanceSlot,value:toHex(1000000n,{size:32})}]:[]}]:override};
  const measurement:any={to:call.to,data:call.data,stateOverride:call.kind==='approve'?[nativeOverride,{address:r.usdc,stateDiff:balanceSlot?[{slot:balanceSlot,value:toHex(1000000n,{size:32})}]:[]}]:override};out.simulations[call.kind]=measurement;
  try{measurement.ethCall=(await client.call(req)).data??'0x';measurement.gas=String(await client.estimateGas(req));measurement.l1FeeWei=await l1Fee(call.to,call.data,call.value,BigInt(measurement.gas));measurement.outcome='PASS';}catch(e:any){measurement.outcome='BLOCKED';measurement.error=e.shortMessage??e.message;}
 }
 // Delegated owner-call batch measures execution only, no synthetic signature acceptance.
 // A sponsor-relayed signed batch still needs real authorization material and is not claimed.
 const code=await client.getCode({address:'0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00'});
 const abi=parseAbi(['function execute(((address to,uint256 value,bytes data)[] calls,bool revertOnFailure) batchedCall)']);
 const batch=encodeFunctionData({abi,functionName:'execute',args:[{calls:calls.map(c=>({to:c.to,value:c.value,data:c.data})),revertOnFailure:true}]});
 try{const gas=await client.estimateGas({account:wallet,to:wallet,data:batch,stateOverride:[{...nativeOverride,code},{address:r.usdc,stateDiff:balanceSlot?[{slot:balanceSlot,value:toHex(1000000n,{size:32})}]:[]}] });out.batchOwnerExecution={gas:String(gas),l1FeeWei:await l1Fee(wallet,batch,0n,gas),scope:'owner-call code override; excludes authorization processing and sponsor signature validation'};}catch(e:any){out.batchOwnerExecution={outcome:'BLOCKED',error:e.shortMessage??e.message};}
 if(chain==='base'){const receipt=await rpc('eth_getTransactionReceipt',['0xbbe13450ed0b84ab3c52afd05e9c2b712ac503e8bfaaf0dd8a3ef3c33ef15b6f']);out.recentReceipt=Object.fromEntries(['transactionHash','blockNumber','gasUsed','effectiveGasPrice','l1Fee','l1GasUsed','l1GasPrice','l1BaseFeeScalar','l1BlobBaseFee','l1BlobBaseFeeScalar'].map(k=>[k,receipt[k]]));}
}
process.stdout.write(JSON.stringify(result,(_k,v)=>typeof v==='bigint'?String(v):v,2)+'\n');
