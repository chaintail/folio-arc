/** Imported funding-interface fixture for local consumers; not wired into the live source worker. */
import { logDebug } from '../shims/log.js';
import { encodeFunctionData } from 'viem';
import { sourceAbi } from './source-calls.js';
import { route, TOKEN_MESSENGER } from './source-registry.js';
import { androidTransaction, SourceRefusal } from './source-service.js';
import type { PersonScope } from '../shims/person-scope.js';
const wallet = '0x0000000000000000000000000000000000000001';
/** Rehearsal fixture, no store, signer or broadcast port. */
export const fundingFixture = {
  addresses: (_scope:PersonScope) => ({addresses:[
    {chain:'solana',address:'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9',state:'available',estimate:'< 1 min',minimum:'0.000000'},
    {chain:'base',address:wallet,state:'available',estimate:'< 30 min',minimum:'20.000000'},
    {chain:'arc',address:wallet,state:'available',estimate:'< 1 min',minimum:'20.000000'},
  ]}),
  incoming: (_scope:PersonScope) => ({incoming:[{sweep:'fixture-base-27',chain:'base',amount:'27.000000',detected_at:'2026-10-02T12:00:00.000Z',state:'detected'}]}),
  async prepare(_scope:PersonScope,sweep:string,kind:'approve'|'burn') {
    logDebug('bridge_operator_run',{mode:'rehearsal',stage:'prepare',outcome:'read_only'});
    if(sweep!=='fixture-base-27')throw new SourceRefusal('SWEEP_NOT_FOUND',404);
    if(kind==='burn')throw new SourceRefusal('SOURCE_ATTEMPT_BLOCKED');
    return {sweep,attempt:'fixture-approve',transaction:{from:wallet,...androidTransaction({type:'eip1559',chainId:8453,
      to:route('base').usdc,value:0n,data:encodeFunctionData({abi:sourceAbi,functionName:'approve',args:[TOKEN_MESSENGER,27000000n]}),
      nonce:0,gas:168720n,maxFeePerGas:20000000n,maxPriorityFeePerGas:0n})}};
  },
  async submit(_scope:PersonScope,_sweep:string,_attempt:string,_signed:`0x${string}`) {throw new SourceRefusal('SIMULATION_SOURCE_SIGNING_DISABLED');},
};
