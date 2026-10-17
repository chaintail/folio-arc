import { observe, requestEvent, type PrivyObservation } from './observe.js';
import { createHash } from 'node:crypto';
import { authorizationPublicKey, authorizationPublicKeySpki } from './authorization-signature.js';
import { DEPOSIT_CHAINS, type DepositChain } from './evm-sweep-policy.js';
import { PrivyError, type PrivyServerConfig } from './config.js';
import { createPrivyRest, type PrivyTransport, type Json } from './transport.js';
import { canonical } from './json.js';
import { privyErrorDetail } from './error-detail.js';

/** Env prefix per deposit chain: `FOLIO_EVM_BASE_{AUTHORIZATION_KEY,KEY_QUORUM_ID}`, and the same for Arc. */
export const DEPOSIT_SIGNER_ENV = {base:'FOLIO_EVM_BASE',arc:'FOLIO_EVM_ARC'} as const satisfies Record<DepositChain,string>;
export const depositSignerEnv = (chain:DepositChain) => ({authorizationKey:`${DEPOSIT_SIGNER_ENV[chain]}_AUTHORIZATION_KEY`,keyQuorumId:`${DEPOSIT_SIGNER_ENV[chain]}_KEY_QUORUM_ID`} as const);
/** Folio's Base pay signer (r071, Yodl rail): its own P-256 key and its own 1-of-1 key quorum, apart
 * from the deposit signers, because Privy takes at most one override policy per additional signer. */
export const PAY_SIGNER_ENV = {authorizationKey:'FOLIO_PAY_BASE_AUTHORIZATION_KEY',keyQuorumId:'FOLIO_PAY_BASE_KEY_QUORUM_ID'} as const;
export const paySignerEnv = () => PAY_SIGNER_ENV;
/** The member Folio holds in each person's owner quorum (development: 1-of-2 with the person). */
export const POLICY_ADMIN_ENV = {authorizationKey:'FOLIO_POLICY_ADMIN_KEY',publicKey:'FOLIO_POLICY_ADMIN_PUBLIC_KEY'} as const;
/** Retired with per-chain quorums: no code reads these. The old quorum record stays in Privy (it
 * cannot be deleted while any wallet signer, policy or wallet references it). */
export const RETIRED_EVM_ENV = ['FOLIO_EVM_AUTHORIZATION_KEY','FOLIO_EVM_KEY_QUORUM_ID','FOLIO_EVM_PERMISSION_PROOF'] as const;

type Env = Readonly<Record<string,string|undefined>>;
const trimmed = (env:Env,name:string) => env[name]?.trim() || undefined;
const publicKeyOrUndefined = (key:string|undefined) => {try {return key ? authorizationPublicKey(key) : undefined;} catch {return undefined;}};
const frozenCredentials = <T extends object>(fields:Record<string,string>) =>
  Object.freeze(Object.defineProperties({},Object.fromEntries(Object.entries(fields).map(([k,value])=>[k,{value,enumerable:false}])))) as T;

type SignerEnv = {readonly authorizationKey:string;readonly keyQuorumId:string};
const FEE_PAYER_ENV:SignerEnv = {authorizationKey:'PRIVY_AUTHORIZATION_KEY',keyQuorumId:'PRIVY_KEY_QUORUM_ID'};
/** One signing authority named by [names]: its key and quorum, refused with [code] when either equals
 * one of [apart] (a key compared by public key, so PEM, DER and `wallet-auth:` forms of one key match). */
function loadSigner(env:Env,names:SignerEnv,apart:readonly {readonly names:SignerEnv;readonly code:string}[]):PrivyServerConfig {
  const need=(n:string)=>{const v=trimmed(env,n);if(!v)throw new PrivyError(`MISSING_${n}`);return v;};
  const authorizationKey=need(names.authorizationKey), keyQuorumId=need(names.keyQuorumId);
  const publicKey=authorizationPublicKey(authorizationKey);
  for (const other of apart)
    if (publicKey===publicKeyOrUndefined(trimmed(env,other.names.authorizationKey)) || keyQuorumId===trimmed(env,other.names.keyQuorumId))
      throw new PrivyError(other.code);
  // KEEP: Privy identity and signing credentials.
  return frozenCredentials<PrivyServerConfig>({appId:need('PRIVY_APP_ID'),appSecret:need('PRIVY_APP_SECRET'),authorizationKey,keyQuorumId,jwksUrl:env.PRIVY_JWKS_URL??''});
}

/**
 * One deposit chain's signing authority: its own P-256 key and its own 1-of-1 key quorum. Refused
 * when the key or quorum is the fee payer's (EVM_FEE_PAYER_AUTHORITY_SHARED) or the other deposit
 * chain's (DEPOSIT_AUTHORITY_SHARED). The policy admin key is kept apart by capabilities (one check).
 */
export function loadDepositSigner(env:Env,chain:DepositChain):PrivyServerConfig {
  // KEEP: EVM signing authority uses a separate key and quorum per deposit chain.
  // KEEP: fee payer credentials must remain distinct from EVM authority.
  // Revoking one chain must never remove the other: separate keys and separate quorums.
  return loadSigner(env,depositSignerEnv(chain),[{names:FEE_PAYER_ENV,code:'EVM_FEE_PAYER_AUTHORITY_SHARED'},
    {names:depositSignerEnv(chain==='base'?'arc':'base'),code:'DEPOSIT_AUTHORITY_SHARED'}]);
}
/**
 * The Base pay signer (FOLIO_PAY_BASE_AUTHORIZATION_KEY, FOLIO_PAY_BASE_KEY_QUORUM_ID), parsed as a
 * deposit signer is. Refused when its key or quorum is the fee payer's (EVM_FEE_PAYER_AUTHORITY_SHARED)
 * or either deposit chain's (PAY_AUTHORITY_SHARED): one wallet entry per quorum carries one policy,
 * so a shared quorum would put the pay policy on the deposit entry or the reverse.
 */
// Retained for authority-separation checks; not exported by server.ts or used by the bridge, and no payment policy is shipped.
export function loadPaySigner(env:Env):PrivyServerConfig {
  return loadSigner(env,PAY_SIGNER_ENV,[{names:FEE_PAYER_ENV,code:'EVM_FEE_PAYER_AUTHORITY_SHARED'},
    ...DEPOSIT_CHAINS.map(chain=>({names:depositSignerEnv(chain),code:'PAY_AUTHORITY_SHARED'}))]);
}
/** Every deposit chain whose key or quorum is configured; throws on the first that is invalid or shared. */
export function loadDepositSigners(env:Env):Partial<Record<DepositChain,PrivyServerConfig>> {
  return Object.fromEntries(DEPOSIT_CHAINS.filter(chain=>{const n=depositSignerEnv(chain);return !!(trimmed(env,n.authorizationKey) || trimmed(env,n.keyQuorumId));})
    .map(chain=>[chain,loadDepositSigner(env,chain)]));
}
export interface PolicyAdminConfig {
  /** Base64 DER SPKI: the key Folio holds in each person's owner quorum. */
  readonly publicKey:string;
  /** Present only where the server administers policies (PATCH, DELETE); never enumerable. */
  readonly authorizationKey?:string;
}
/**
 * The policy admin as the signing path needs it: FOLIO_POLICY_ADMIN_PUBLIC_KEY (required, P-256) and
 * FOLIO_POLICY_ADMIN_KEY (optional; must be the same key pair). That it differs from the fee payer's
 * and both deposit signer keys is enforced once, by capabilities (FOLIO_POLICY_ADMIN_PUBLIC_KEY invalid).
 */
export function loadPolicyAdmin(env:Env):PolicyAdminConfig {
  const configured=trimmed(env,POLICY_ADMIN_ENV.publicKey);
  if (!configured) throw new PrivyError(`MISSING_${POLICY_ADMIN_ENV.publicKey}`);
  const publicKey=authorizationPublicKeySpki(configured), authorizationKey=trimmed(env,POLICY_ADMIN_ENV.authorizationKey);
  if (authorizationKey && authorizationPublicKey(authorizationKey)!==publicKey) throw new PrivyError('POLICY_ADMIN_KEY_MISMATCH');
  return Object.freeze(Object.defineProperties({publicKey},authorizationKey?{authorizationKey:{value:authorizationKey,enumerable:false}}:{})) as PolicyAdminConfig;
}
export interface EvmTransaction {chainId:number;to:string;value:bigint;data:string;nonce:number;gas:bigint;maxFeePerGas:bigint;maxPriorityFeePerGas:bigint}
export const evmSignBody=(t:EvmTransaction)=>({method:'eth_signTransaction',params:{transaction:{type:2,chain_id:t.chainId,to:t.to,value:`0x${t.value.toString(16)}`,data:t.data,nonce:t.nonce,gas_limit:`0x${t.gas.toString(16)}`,max_fee_per_gas:`0x${t.maxFeePerGas.toString(16)}`,max_priority_fee_per_gas:`0x${t.maxPriorityFeePerGas.toString(16)}`}}});
export function createEvmSigner(rest:ReturnType<typeof createPrivyRest>, observation: PrivyObservation = {}) {
  return {async sign(walletId:string,attemptId:string,transaction:EvmTransaction):Promise<`0x${string}`> {
    observe(observation,{op:'privy_evm_operation',stage:'sign',phase:'start',attempt_id:attemptId.slice(0,12),chain_id:transaction.chainId});
    const response=await rest.request('POST',`/v1/wallets/${walletId}/rpc`,evmSignBody(transaction),
      {idempotencyKey:createHash('sha256').update(`folio-evm:${walletId}:${attemptId}`).digest('hex')}, observation) as {data?:{encoding?:string;signed_transaction?:string}};
    if(response?.data?.encoding!=='rlp' || !/^0x(?:[a-f0-9]{2})+$/i.test(response.data.signed_transaction??'')){ observe(observation, { op: 'wallets_rpc', outcome: 'refused', code: 'INVALID_EVM_SIGNATURE' }); throw new PrivyError('INVALID_EVM_SIGNATURE'); }
    observe(observation,{op:'privy_evm_operation',stage:'verify_shape',outcome:'ok',attempt_id:attemptId.slice(0,12),chain_id:transaction.chainId});
    return response.data.signed_transaction as `0x${string}`;
  }};
}
export type EvmSigner=ReturnType<typeof createEvmSigner>;
/** App-secret administration is deliberately separate from sign-only wallet RPC. */
export function createPrivyAdmin(config:Pick<PrivyServerConfig,'appId'|'appSecret'>,transport:PrivyTransport, observation: PrivyObservation = {}) {
  const basic=()=>`Basic ${Buffer.from(`${config.appId}:${config.appSecret}`).toString('base64')}`;
  async function send(method:'GET'|'POST'|'DELETE',path:string,body?:Json,nonce?:string) {
    // Creation retries must retain the same identity/policy after a lost response. Privy matches on
    // the key alone (P0): a create made for a new consent passes that consent's nonce, or the same
    // body within 24 hours answers the earlier (perhaps revoked) policy's id.
    const idempotency:Record<string,string>=method==='POST'?{'privy-idempotency-key':createHash('sha256').update(`${config.appId}:${path}:${nonce?`${nonce}:`:''}${canonical(body!)}`).digest('hex')}:{};
    const started = Date.now(), event = requestEvent(method, path, undefined, idempotency['privy-idempotency-key']);
    observe(observation, { ...event, phase: 'start' });
    let response;try {response=await transport.request({method,url:`https://api.privy.io${path}`,headers:{...(method==='POST'?{'content-type':'application/json'}:{}),'privy-app-id':config.appId,...idempotency,authorization:basic()},...(method==='POST'?{body:canonical(body!)}:{})});}catch(error){const code=error instanceof PrivyError && ['PRIVY_TRANSPORT_TIMEOUT','PRIVY_RESPONSE_DECODE_FAILED'].includes(error.code)?error.code:'PRIVY_TRANSPORT_UNAVAILABLE';observe(observation,{...event,phase:'end',ms:Date.now()-started,code});throw new PrivyError(code);}
    observe(observation, {...event, phase:'end', status:response.status, ms:Date.now()-started, ...(response.status<200||response.status>=300?{code:`PRIVY_HTTP_${response.status}`}:{})});
    if(response.status<200||response.status>=300)
      throw new PrivyError(`PRIVY_HTTP_${response.status}`,privyErrorDetail(response.body,[config.appSecret,Buffer.from(`${config.appId}:${config.appSecret}`).toString('base64')]),response.requestIds);
    return response.body;
  }
  const validId=(id:string)=>/^[A-Za-z0-9_-]{1,128}$/.test(id);
  return {
    /** [options.nonce]: the consent's nonce (receipt id) for a person's policy or owner quorum, 1-128 of `[A-Za-z0-9_:.-]`. */
    request(path:'/v1/key_quorums'|'/v1/policies',body:Json,options?:{readonly nonce?:string}) {
      if(options?.nonce!==undefined && !/^[A-Za-z0-9_:.-]{1,128}$/.test(options.nonce))return Promise.reject(new PrivyError('PRIVY_IDEMPOTENCY_NONCE_INVALID'));
      return send('POST',path,body,options?.nonce);
    },
    /** App-authenticated reads (live probe: app Basic auth answers 200, owned or not). No owner authority. */
    read(kind:'wallets'|'policies'|'key_quorums',id:string) {
      if(!validId(id))return Promise.reject(new PrivyError('PRIVY_RESOURCE_ID_INVALID'));
      return send('GET',`/v1/${kind}/${id}`);
    },
    /** App-secret DELETE, no body: works only for an ownerless policy no wallet signer uses (P0). An
     * owned policy needs its owner's signature: `createPrivyRest(...).request('DELETE', ...)`. */
    delete(kind:'policies',id:string) {
      if(!validId(id))return Promise.reject(new PrivyError('PRIVY_RESOURCE_ID_INVALID'));
      return send('DELETE',`/v1/${kind}/${id}`);
    },
  };
}
export type PrivyAdmin=ReturnType<typeof createPrivyAdmin>;
/** Order-independent digest of a sweep policy's rule set and identity. Privy stores each rule with a
 * provider-assigned `id` and adds metadata (`id`, `owner_id`, `created_at`); only those are ignored. */
export function evmPolicyDigest(policy:unknown):string|undefined {
  if(!policy || typeof policy!=='object' || Array.isArray(policy))return undefined;
  const p=policy as Record<string,Json>;
  if(typeof p.version!=='string' || typeof p.name!=='string' || p.chain_type!=='ethereum' || !Array.isArray(p.rules) || !p.rules.length)return undefined;
  const rules:string[]=[];
  for(const entry of p.rules as Json[]) {
    if(!entry || typeof entry!=='object' || Array.isArray(entry))return undefined;
    const {id,...rule}=entry as Record<string,Json>;
    if(id!==undefined && (typeof id!=='string' || !id))return undefined;
    rules.push(canonical(rule));
  }
  return createHash('sha256').update(canonical({version:p.version,name:p.name,chain_type:p.chain_type,rules:rules.sort()})).digest('hex');
}
export interface AdditionalSigner {readonly signer_id?:unknown;readonly override_policy_ids?:unknown}
/** Our quorum's entries in a wallet's additional_signers, and whether exactly one carries exactly [policyId]. */
export function signerAttachment(wallet:{additional_signers?:unknown},keyQuorumId:string,policyId:string) {
  const all=Array.isArray(wallet.additional_signers)?wallet.additional_signers as AdditionalSigner[]:[];
  const ours=all.filter(s=>s && typeof s==='object' && s.signer_id===keyQuorumId);
  const exact=ours.length===1 && Array.isArray(ours[0].override_policy_ids) && ours[0].override_policy_ids.length===1 && ours[0].override_policy_ids[0]===policyId;
  return {count:ours.length,exact};
}

/**
 * Whether a key quorum read back from Privy is the person's owner quorum: exactly the person
 * among users, no nested quorums, threshold 1, and no key other than Folio's policy admin (none
 * once the person-only switch has been made). Anything else is a foreign owner.
 */
export function ownerQuorumMatches(quorum:unknown,id:string,user:string,adminPublicKey:string):boolean {
  if(!quorum || typeof quorum!=='object' || Array.isArray(quorum))return false;
  const q=quorum as Record<string,unknown>;
  if(q.id!==undefined && q.id!==id)return false;
  if(!Array.isArray(q.user_ids) || q.user_ids.length!==1 || q.user_ids[0]!==user)return false;
  if(q.key_quorum_ids!==undefined && (!Array.isArray(q.key_quorum_ids) || q.key_quorum_ids.length))return false;
  if(q.authorization_threshold!==1)return false;
  const keys=q.authorization_keys===undefined?[]:q.authorization_keys;
  if(!Array.isArray(keys) || keys.length>1)return false;
  return keys.every(k=>!!k && typeof k==='object' && (k as {public_key?:unknown}).public_key===adminPublicKey);
}
