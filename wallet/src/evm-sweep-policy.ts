import { createHash } from 'node:crypto';
import { address, getAddressEncoder } from '@solana/kit';
import type { Json } from './transport.js';
import { canonical } from './json.js';

export const EVM_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
export const EVM_USDC = {8453:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',5042:'0x3600000000000000000000000000000000000000'} as const;
export const EVM_ZERO32 = `0x${'00'.repeat(32)}`;
export const sweepAbi = [
  {type:'function',name:'approve',stateMutability:'nonpayable',inputs:[{name:'spender',type:'address'},{name:'amount',type:'uint256'}],outputs:[{type:'bool',name:''}]},
  {type:'function',name:'depositForBurn',stateMutability:'nonpayable',inputs:[
    {name:'amount',type:'uint256'},{name:'destinationDomain',type:'uint32'},{name:'mintRecipient',type:'bytes32'},
    {name:'burnToken',type:'address'},{name:'destinationCaller',type:'bytes32'},{name:'maxFee',type:'uint256'},{name:'minFinalityThreshold',type:'uint32'},
  ],outputs:[]},
] as const;
export function ataBytes32(ata:string) {return `0x${Buffer.from(getAddressEncoder().encode(address(ata))).toString('hex')}`;}
export type SweepCondition = {field_source:'ethereum_transaction'|'ethereum_calldata';field:string;operator:'eq';value:string|number;abi?:typeof sweepAbi};

/** Deposit chains. Each has its own policy per person, its own Folio key quorum and its own proof. */
export const DEPOSIT_CHAIN_IDS = {base:8453,arc:5042} as const;
export type DepositChain = keyof typeof DEPOSIT_CHAIN_IDS;
export const DEPOSIT_CHAINS = ['base','arc'] as const satisfies readonly DepositChain[];
export const isDepositChain = (value:unknown):value is DepositChain => value==='base' || value==='arc';

const personTag = (person:string) => createHash('sha256').update(person).digest('hex').slice(0,16);
/** The two calls Folio's quorum may sign on [chainId]: USDC `approve` to Circle's messenger, and
 * `depositForBurn` of that USDC to the person's own destination USDC account with Folio as no caller,
 * zero max fee and standard finality. No amount cap (owner ruling 2026-10-14): the recipient is
 * pinned, and the server's principal cap bounds each sweep. */
function sweepRules(chainId:keyof typeof EVM_USDC,ata:string) {
  const recipient=ataBytes32(ata),token=EVM_USDC[chainId];
  const tx=(field:string,value:string|number):SweepCondition=>({field_source:'ethereum_transaction',field,operator:'eq',value});
  const data=(field:string,value:string|number):SweepCondition=>({field_source:'ethereum_calldata',field,operator:'eq',value,abi:sweepAbi});
  return [
    {name:`approve-${chainId}`,method:'eth_signTransaction' as const,action:'ALLOW' as const,conditions:[tx('chain_id',String(chainId)),tx('to',token),tx('value','0'),data('function_name','approve'),data('approve.spender',EVM_MESSENGER)]},
    {name:`fund-${chainId}`,method:'eth_signTransaction' as const,action:'ALLOW' as const,conditions:[tx('chain_id',String(chainId)),tx('to',EVM_MESSENGER),tx('value','0'),data('function_name','depositForBurn'),
      data('depositForBurn.destinationDomain','5'),data('depositForBurn.mintRecipient',recipient),data('depositForBurn.burnToken',token),data('depositForBurn.destinationCaller',EVM_ZERO32),data('depositForBurn.maxFee','0'),data('depositForBurn.minFinalityThreshold','2000')]},
  ];
}

/**
 * One person's deposit policy for one chain (`deposit.base` or `deposit.arc`): the two sweep calls
 * on that chain id only; every other method, call and chain is default-denied (a wildcard DENY
 * would override the ALLOWs). Named `folio-deposit-<chain>-<tag>`, where tag is the first 16 hex of
 * SHA-256 of [key] (the person's namespace key, `live:<64 hex>`).
 *
 * No owner field: the permission registry (S1) adds `owner_id`, the person's owner key quorum
 * (P0: `{user_ids:[DID], public_keys:[FOLIO_POLICY_ADMIN_PUBLIC_KEY], authorization_threshold:1}`),
 * when it creates the policy. The rules digest (`evmPolicyDigest`) ignores the owner; the live check
 * compares `owner_id` with the receipt separately. Structurally a C0 `PrivyPolicyBody`.
 */
export function depositPolicy(chain:DepositChain,key:string,ata:string) {
  if (!isDepositChain(chain)) throw new Error('DEPOSIT_CHAIN_UNKNOWN');
  if (!key) throw new Error('PERSON_REQUIRED');
  return {version:'1.0' as const,name:`folio-deposit-${chain}-${personTag(key)}`,chain_type:'ethereum' as const,
    rules:sweepRules(DEPOSIT_CHAIN_IDS[chain],ata)} satisfies Json;
}
export type DepositPolicyBody = ReturnType<typeof depositPolicy>;

/** Fixed placeholders for a template: the System Program id (32 zero bytes) and a constant person. */
export const EVM_POLICY_TEMPLATE_ATA = '11111111111111111111111111111111';
export const EVM_POLICY_TEMPLATE_PERSON = 'folio-policy-template';
/** Pure: the policy every person receives on [chain], with person and ATA replaced by fixed
 * placeholders. Any change to the rules, the chain, the token or the messenger changes it, and so
 * its digest, the chain's proof and the receipts that name it. */
export function depositPolicyTemplate(chain:DepositChain) {return depositPolicy(chain,EVM_POLICY_TEMPLATE_PERSON,EVM_POLICY_TEMPLATE_ATA);}
/** [chain]'s template digest: lowercase hex SHA-256 of the canonical JSON of `depositPolicyTemplate`.
 * A receipt's `template_digest` is this value, and the chain's proof record names it. */
export function depositPolicyDigest(chain:DepositChain) {return createHash('sha256').update(canonical(depositPolicyTemplate(chain))).digest('hex');}
