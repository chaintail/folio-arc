import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { encodeFunctionData, type Hex } from 'viem';
import { createEvmSigner, createPrivyRest, createFetchTransport, loadDepositSigner, authorizationPublicKey, evmSignBody, EVM_MESSENGER, EVM_USDC, EVM_ZERO32, sweepAbi, ataBytes32, PrivyError,
  DEPOSIT_CHAIN_IDS, isDepositChain, proofCaseName, proofCoverage, casePassed, permissionProofRecord, authorizationPublicKeyDigest,
  type DepositChain, type PrivyTransport, type ProofCaseResult, type ProofCaseKind } from 'wallet-privy/server';
import { validateSigned, type PreparedTransaction } from '../../src/bridge/source-executor.js';
import { associatedTokenAddress } from '../../src/shims/associated-token.js';
import { CCTP } from '../../src/bridge/registry.js';
import { allowedPath } from './private-file.js';
import { guardedArgs, boundPerson, scriptMain, verifiedReceipt } from './privy-common.js';

export interface PermissionRequest { name:string; chain:number; kind:ProofCaseKind; allowed:boolean; transaction:PreparedTransaction; pinned:PreparedTransaction }
// Unambiguously invalid fixtures: no deployed contract or authority on any chain.
const WRONG_SPENDER='0x1111111111111111111111111111111111111111' as Hex, WRONG_CONTRACT='0x2222222222222222222222222222222222222222' as Hex;
const STRANGER='0x3333333333333333333333333333333333333333' as Hex, WRONG_CALLER=`0x${'44'.repeat(32)}` as Hex;
const offPolicyAbi=[
  {type:'function',name:'increaseAllowance',stateMutability:'nonpayable',inputs:[{name:'spender',type:'address'},{name:'increment',type:'uint256'}],outputs:[{type:'bool',name:''}]},
  {type:'function',name:'transfer',stateMutability:'nonpayable',inputs:[{name:'to',type:'address'},{name:'value',type:'uint256'}],outputs:[{type:'bool',name:''}]},
] as const;
const bodyKey=(t:PreparedTransaction)=>JSON.stringify(evmSignBody(t));

/** Vectors for one template, using its chain's USDC and the CCTP v2 messenger (same address on Base and Arc). */
export function chainRequests(template:DepositChain,ata:string,otherAta:string):PermissionRequest[] {
  const chain=DEPOSIT_CHAIN_IDS[template], otherChain=DEPOSIT_CHAIN_IDS[template==='base'?'arc':'base'];
  const token=EVM_USDC[chain] as Hex, otherToken=EVM_USDC[otherChain] as Hex, amount=1000000n;
  const tx:PreparedTransaction={type:'eip1559',chainId:chain,to:token,value:0n,data:'0x',nonce:0,gas:400000n,maxFeePerGas:40000000000n,maxPriorityFeePerGas:0n};
  const approve={...tx,data:encodeFunctionData({abi:sweepAbi,functionName:'approve',args:[EVM_MESSENGER,amount]})};
  const base=[amount,5,ataBytes32(ata) as Hex,token,EVM_ZERO32 as Hex,0n,2000] as const;
  type BurnArgs=[bigint,number,Hex,Hex,Hex,bigint,number];
  const burnData=(change:(a:BurnArgs)=>void)=>{const a=[...base] as BurnArgs;change(a);return encodeFunctionData({abi:sweepAbi,functionName:'depositForBurn',args:a});};
  const burn={...tx,to:EVM_MESSENGER as Hex,data:burnData(()=>{})};
  const c=(kind:ProofCaseKind,allowed:boolean,transaction:PreparedTransaction,pinned:PreparedTransaction):PermissionRequest=>({name:proofCaseName(chain,kind),chain,kind,allowed,transaction,pinned});
  return [
    c('allowed-approve',true,approve,approve),
    c('allowed-burn',true,burn,burn),
    c('wrong-recipient',false,{...burn,data:burnData(a=>{a[2]=ataBytes32(otherAta) as Hex;})},burn),
    c('wrong-spender',false,{...approve,data:encodeFunctionData({abi:sweepAbi,functionName:'approve',args:[WRONG_SPENDER,amount]})},approve),
    c('wrong-token',false,{...burn,data:burnData(a=>{a[3]=otherToken;})},burn),
    c('unsupported-chain',false,{...burn,chainId:1},burn),
    // The other deposit chain's own allowed burn: the retired combined policy signed it; a per-chain policy must not.
    c('other-chain',false,{...burn,chainId:otherChain,data:burnData(a=>{a[3]=otherToken;})},burn),
    c('wrong-destination-domain',false,{...burn,data:burnData(a=>{a[1]=6;})},burn),
    c('wrong-destination-caller',false,{...burn,data:burnData(a=>{a[4]=WRONG_CALLER;})},burn),
    c('nonzero-value',false,{...burn,value:1n},burn),
    c('nonzero-max-fee',false,{...burn,data:burnData(a=>{a[5]=1n;})},burn),
    c('wrong-finality',false,{...burn,data:burnData(a=>{a[6]=1000;})},burn),
    c('wrong-contract',false,{...burn,to:WRONG_CONTRACT},burn),
    c('wrong-function',false,{...approve,data:encodeFunctionData({abi:offPolicyAbi,functionName:'increaseAllowance',args:[EVM_MESSENGER,amount]})},approve),
    c('unrelated-transfer',false,{...approve,data:encodeFunctionData({abi:offPolicyAbi,functionName:'transfer',args:[STRANGER,amount]})},approve),
  ];
}
export function permissionRequests(template:DepositChain,ata:string,otherAta:string):PermissionRequest[] {
  if(ata===otherAta)throw Error('DISTINCT_TEST_ATA_REQUIRED');
  if(!isDepositChain(template))throw Error('UNSUPPORTED_PROOF_CHAIN');
  const requests=chainRequests(template,ata,otherAta);
  // A mutation identical to an allowed body would prove nothing.
  const allowed=new Set(requests.filter(r=>r.allowed).map(r=>bodyKey(r.transaction)));
  for(const r of requests)if(!r.allowed && (allowed.has(bodyKey(r.transaction)) || bodyKey(r.transaction)===bodyKey(r.pinned)))throw Error(`MUTATION_NOT_DISTINCT:${r.name}`);
  return requests;
}

/** Sign-only boundary below the REST client: exactly one wallet, POST, eth_signTransaction.
 * Any other method, extra field (such as sponsor), wallet, verb or admin path is refused before IO. */
export function signOnlyTransport(inner:PrivyTransport,walletId:string):PrivyTransport {
  if(!/^[A-Za-z0-9_-]+$/.test(walletId))throw Error('PROOF_WALLET_REQUIRED');
  const url=`https://api.privy.io/v1/wallets/${walletId}/rpc`;
  return {async request(request) {
    let body:unknown;try {body=JSON.parse(request.body??'');}catch{throw Error('SIGN_ONLY_TRANSPORT_REFUSED');}
    const keys=body && typeof body==='object' && !Array.isArray(body)?Object.keys(body).sort().join(','):'';
    if(request.method!=='POST' || request.url!==url || keys!=='method,params' || (body as {method?:unknown}).method!=='eth_signTransaction')throw Error('SIGN_ONLY_TRANSPORT_REFUSED');
    return inner.request(request);
  }};
}

export interface ProveDeps {
  transport?:PrivyTransport;
  env?:Readonly<Record<string,string|undefined>>;
  now?:()=>Date;
  revision?:()=>string;
  /** Test seam only: lets a test simulate a reverted chain expansion. */
  requests?:typeof permissionRequests;
}
const gitRevision=()=>execFileSync('git',['rev-parse','--short','HEAD'],{cwd:new URL('../..',import.meta.url),encoding:'utf8'}).trim();

export async function prove(args:readonly string[],deps:ProveDeps={}) {
  const a=guardedArgs(args,['chain','person','ata','other-ata','db','disposable-person','out']),chain=a.get('chain'),person=a.get('person'),ata=a.get('ata'),other=a.get('other-ata'),out=a.get('out');
  if(!isDepositChain(chain))throw Error('PROOF_CHAIN_REQUIRED');
  if(!person || !ata || !other)throw Error('PROOF_IDENTITIES_REQUIRED');
  const requests=(deps.requests??permissionRequests)(chain,ata,other);
  console.log(JSON.stringify({mode:a.live?'DIRECTOR_SIGN_ONLY':'DRY_RUN',template:`deposit.${chain}`,chains:[...new Set(requests.map(r=>r.chain))],
    requests:requests.map(r=>({name:r.name,chain:r.chain,allowed:r.allowed,body:evmSignBody(r.transaction)})),broadcast:false},null,2));
  if(!a.live)return;
  if(!a.get('db') || a.get('disposable-person')!==person)throw Error('DISPOSABLE_PERSON_ACK_REQUIRED');
  const outPath=out?allowedPath(out):undefined;
  const config=loadDepositSigner(deps.env??process.env,chain);
  const {db,scope}=boundPerson(a.get('db')!,person);
  try {
    const w=scope.evm_wallet!;
    // Every binding is checked before the first provider request: the person consented on this
    // chain, to this destination, on this wallet, under this chain's configured quorum.
    const receipt=verifiedReceipt(db,person,chain);
    if(receipt.ata!==ata)throw Error('PROVISIONED_TEST_PERSON_REQUIRED');
    if(await associatedTokenAddress(scope.wallet_address!,CCTP.usdc,CCTP.tokenProgram)!==ata)throw Error('PERSON_ATA_MISMATCH');
    if(receipt.wallet_id!==w.id || receipt.wallet_address.toLowerCase()!==w.address.toLowerCase())throw Error('PROVISIONED_TEST_PERSON_REQUIRED');
    if(receipt.quorum_id!==config.keyQuorumId)throw Error('PROOF_SIGNER_BINDING_MISMATCH');
    const signer=createEvmSigner(createPrivyRest(config,signOnlyTransport(deps.transport??createFetchTransport(fetch),w.id),Date.now)),results:ProofCaseResult[]=[];
    for(const r of requests) {
      const shape={name:r.name,chain:r.chain,allowed:r.allowed};
      try {
        // Deliberately bypass the local allowlist so refusal evidence comes from Privy.
        const wire=await signer.sign(w.id,`proof:${Date.now()}:${r.name}`,r.transaction);
        let validator:ProofCaseResult['validator']='accepted';
        try {await validateSigned({sweepId:'proof',attemptId:r.name,wallet:w.address as Hex,unsignedTransactions:[r.pinned]},wire);}catch{validator='denied';}
        results.push({...shape,privy:'accepted',validator});
      }catch(e){results.push({...shape,privy:e instanceof PrivyError && e.code==='PRIVY_POLICY_DENIED'?'policy_denied':'unproven_error',validator:'not_run'});}
    }
    const coverage=proofCoverage(results,chain),passed=coverage.ok && results.every(casePassed);
    console.log(JSON.stringify({person,results,permission_boundary:passed?'PASS':'FAIL',...(coverage.ok?{}:{reason:coverage.reason}),broadcast:false},null,2));
    if(!passed)throw Error('PERMISSION_BOUNDARY_NOT_PROVEN');
    const record=permissionProofRecord({chain,results,provedAt:(deps.now??(()=>new Date()))(),keyQuorumId:config.keyQuorumId,
      authorizationPublicKeySha256:authorizationPublicKeyDigest(authorizationPublicKey(config.authorizationKey)),deployedRevision:(deps.revision??gitRevision)()});
    console.log(JSON.stringify(record));
    if(outPath)writeFileSync(outPath,`${JSON.stringify(record,null,2)}\n`,{flag:'wx',mode:0o600});
    return record;
  }finally{db.close();}
}
scriptMain('/privy-evm-prove.ts',async args=>{await prove(args);});
