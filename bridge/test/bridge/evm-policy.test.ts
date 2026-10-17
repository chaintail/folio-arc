import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionData, type Hex } from 'viem';
import { depositPolicy, sweepAbi, ataBytes32, DEPOSIT_CHAIN_IDS, EVM_USDC, EVM_MESSENGER, EVM_ZERO32 } from 'wallet-privy/server';
import { owner, destination } from './support.js';
// Independent evaluator of the emitted provider JSON; this is not provider enforcement evidence.
function matches(policy:ReturnType<typeof depositPolicy>,method:string,tx:{chainId:number;to:string;value:bigint;data:string}) {
  let decoded:ReturnType<typeof decodeFunctionData>;
  try {decoded=decodeFunctionData({abi:sweepAbi,data:tx.data as Hex});}catch{return false;}
  return policy.rules.some(rule=>rule.method===method && rule.conditions.every(c=>{
    let actual:unknown;
    if(c.field_source==='ethereum_transaction')actual=({chain_id:tx.chainId,to:tx.to,value:tx.value} as Record<string,unknown>)[c.field];
    else if(c.field==='function_name')actual=decoded.functionName;
    else {
      const [fn,param]=c.field.split('.');if(fn!==decoded.functionName)return false;
      const abi=c.abi!.find(a=>a.name===fn)!;actual=decoded.args?.[abi.inputs.findIndex(i=>i.name===param)];
    }
    if(actual===undefined)return false;
    if(typeof actual==='bigint' || typeof actual==='number')return BigInt(actual)===BigInt(c.value);
    return String(actual).toLowerCase()===String(c.value).toLowerCase();
  }));
}
test('per-person, per-chain policy JSON allows only its own chain and pins every Standard argument; the other chain and all mutations are default-denied',async()=>{
  const d=await destination();
  assert.equal(sweepAbi[1].inputs.length,7);
  for(const [chain,chainId] of Object.entries(DEPOSIT_CHAIN_IDS) as ['base'|'arc',8453|5042][]) {
    const p=depositPolicy(chain,'live:alice',d.ata),other=chainId===8453?5042:8453;
    assert.equal(p.rules.length,2);assert.notEqual(p.name,depositPolicy(chain,'live:bob',d.ata).name);
    assert.notEqual(p.name,depositPolicy(chain==='base'?'arc':'base','live:alice',d.ata).name);
    const args=[1000000n,5,ataBytes32(d.ata) as Hex,EVM_USDC[chainId],EVM_ZERO32 as Hex,0n,2000] as const;
    const approve={chainId,to:EVM_USDC[chainId],value:0n,data:encodeFunctionData({abi:sweepAbi,functionName:'approve',args:[EVM_MESSENGER,1000000n]})};
    const burn={chainId,to:EVM_MESSENGER,value:0n,data:encodeFunctionData({abi:sweepAbi,functionName:'depositForBurn',args})};
    assert.equal(matches(p,'eth_signTransaction',approve),true);assert.equal(matches(p,'eth_signTransaction',burn),true);
    // The other deposit chain's exact calls, with that chain's own token: refused by this chain's policy.
    const otherArgs=[1000000n,5,ataBytes32(d.ata) as Hex,EVM_USDC[other],EVM_ZERO32 as Hex,0n,2000] as const;
    assert.equal(matches(p,'eth_signTransaction',{chainId:other,to:EVM_USDC[other],value:0n,data:approve.data}),false);
    assert.equal(matches(p,'eth_signTransaction',{chainId:other,to:EVM_MESSENGER,value:0n,data:encodeFunctionData({abi:sweepAbi,functionName:'depositForBurn',args:otherArgs})}),false);
    for(const tx of [{...approve,chainId:1},{...burn,chainId:1},{...burn,chainId:other},{...approve,chainId:other},{...burn,value:1n},{...approve,value:1n},{...burn,to:EVM_USDC[chainId]},
      {...approve,data:encodeFunctionData({abi:sweepAbi,functionName:'approve',args:['0x1111111111111111111111111111111111111111',1000000n]})},
      ...[1,2,3,4,5,6].map(i=>{const mutated:any[]=[...args];mutated[i]=[null,6,ataBytes32(owner),EVM_USDC[chainId===8453?5042:8453],`0x${'01'.repeat(32)}`,1n,1000][i];return {...burn,data:encodeFunctionData({abi:sweepAbi,functionName:'depositForBurn',args:mutated as any})};}),
      {...approve,data:'0xa9059cbb'+ '00'.repeat(64)}, {...burn,data:'0x'},
    ])assert.equal(matches(p,'eth_signTransaction',tx),false);
    for(const method of ['eth_sendTransaction','personal_sign','eth_signTypedData_v4','eth_sign7702Authorization','wallet_sendCalls','exportPrivateKey'])assert.equal(matches(p,method,burn),false);
  }
});
