/** Public, pinned-block contract reads only. Never signs or submits. */
import {createPublicClient,http,parseAbi,keccak256,type Hex} from 'viem';
import {TOKEN_MESSENGER} from '../../src/bridge/source-registry.js';
const out:Record<string,unknown>={mode:'RPC_READ',captured_at:new Date().toISOString(),contract:TOKEN_MESSENGER};
for(const [chain,url] of [['base','https://mainnet.base.org'],['arc','https://rpc.mainnet.arc.io']] as const) {
 const c=createPublicClient({transport:http(url,{timeout:15000,retryCount:0})}), b=await c.getBlock({blockTag:'finalized'});
 const r:Record<string,unknown>={chainId:await c.getChainId(),block:String(b.number),blockHash:b.hash};
 const slot='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex;
 const impl=await c.getStorageAt({address:TOKEN_MESSENGER,slot,blockNumber:b.number});r.implementationSlot=impl;
 const addr=`0x${impl!.slice(-40)}` as Hex;
 r.proxyCodeHash=keccak256((await c.getCode({address:TOKEN_MESSENGER,blockNumber:b.number}))!);
 r.implementationCodeHash=keccak256((await c.getCode({address:addr,blockNumber:b.number}))!);
 for(const [name,signature,args] of [
  ['feeRecipient','function feeRecipient() view returns (address)',[]],
  ['minFee','function minFee() view returns (uint256)',[]],
  ['minFeeController','function minFeeController() view returns (address)',[]],
  ['getMinFeeAmount','function getMinFeeAmount(uint256 amount) view returns (uint256)',[1000000n]],
 ] as const) {
  try{r[name]=String(await c.readContract({address:TOKEN_MESSENGER,abi:parseAbi([signature]),functionName:name,args,blockNumber:b.number} as never));}
  catch{r[name]='METHOD_UNAVAILABLE_OR_RPC_ERROR';}
 }
 out[chain]=r;
}
process.stdout.write(JSON.stringify(out,null,2)+'\n');
