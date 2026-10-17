import { errorFields, reasonCode } from '../shims/log-fields.js';
import { logDebug, logInfo, logError } from '../shims/log.js';
import { sourceSignerDiagnostic } from '../shims/capabilities.js';
import { permissionProofStatus } from '../shims/permission-proof.js';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import type { PersonScope } from '../shims/person-scope.js';
import type { BridgeConfig } from './config.js';
import type { SourceRpc } from './source-rpc.js';
import { sourceCalls, verifyDestination, type AtaRead } from './source-calls.js';
import { createAtaInstruction, deriveUsdcAta, type ReadRpc } from './solana.js';
import type { GuardedDeliveryPort } from './worker.js';
import type { DepositIntent, DepositIntents } from './deposit-intent.js';
import type { PermissionReceipt } from '../shims/permission-types.js';
import { receiptUsable } from './deposit-permission.js';
export class ReadinessHold extends Error {
  constructor(code: string, readonly diagnostic?: ReturnType<typeof sourceSignerDiagnostic>) { super(code); logInfo('bridge_readiness',{stage:'gate',outcome:'refused',reason:reasonCode(code)}); }
}
export async function verifyDeployment(rpc: SourceRpc, proof: string|undefined, now=Date.now()) {
  let pin: {implementation:string;proxyCodeHash:string;implementationCodeHash:string;expiresAt:number;zeroFee:boolean};
  try { pin=JSON.parse(proof??''); } catch (caughtError) { logDebug('deposit_readiness_error', { stage: 'verifyDeployment', ...errorFields(caughtError) });  throw new ReadinessHold('STANDARD_FEE_UNVERIFIED_OR_NONZERO'); }
  if(!pin.implementation || !pin.proxyCodeHash || !pin.implementationCodeHash)throw new ReadinessHold('SOURCE_DEPLOYMENT_UNPINNED');
  if(!Number.isFinite(pin.expiresAt) || pin.expiresAt<=now || pin.zeroFee!==true)throw new ReadinessHold('STANDARD_FEE_PROOF_STALE');
  const actual=await rpc.deployment();
  if((['implementation','proxyCodeHash','implementationCodeHash'] as const).some(k=>actual[k].toLowerCase()!==pin[k].toLowerCase()))throw new ReadinessHold('SOURCE_DEPLOYMENT_CHANGED');
}
/** A verified receipt recorded under a quorum other than the chain's configured one: the
 * configuration moved, the person did not. */
export const quorumDrift = (receipt: PermissionReceipt | null | undefined, quorum?: string) =>
  !!(quorum && receipt && receipt.quorum_id !== quorum);
/** [signer]: this chain's signer is built; [quorum]: this chain's configured quorum; [receipt]: the
 * person's verified receipt for this chain (PermissionReader), or null. */
export function assertReadinessLocal(scope: PersonScope, i: DepositIntent, config: BridgeConfig, signer: boolean, env: NodeJS.ProcessEnv,
  quorum: string | undefined, receipt: PermissionReceipt | null) {
  logDebug('bridge_readiness',{chain:i.chain,intent_id:i.id.slice(0,12),stage:'local_gate',outcome:'start'});
  const w=scope.evm_wallet,c=config.chains[i.chain];
  if(!config.source || !c.enabled || c.paused)throw new ReadinessHold('SOURCE_PAUSED');
  if(!config.execute)throw new ReadinessHold('SOURCE_EXECUTION_DISABLED');
  // KEEP: delivery spend limit.
  if(!config.worker || !/^[1-9]\d*$/.test(env.FOLIO_BRIDGE_DELIVERY_MAX_COST_LAMPORTS??''))throw new ReadinessHold('DELIVERY_EXECUTION_DISABLED');
  // KEEP: EVM signing authority and proof, per chain.
  // Configuration: no signer for this chain, no verified proof for its template, or a receipt
  // recorded under another configured quorum. Never a fact about the person.
  if(!signer || !permissionProofStatus(env, i.chain).ok || quorumDrift(receipt, quorum))throw new ReadinessHold('SOURCE_SIGNER_UNCONFIGURED', sourceSignerDiagnostic(env, i.chain));
  // The person: no verified receipt for this chain (never set up, revoked, held or stale).
  if(!receiptUsable(receipt, {chain:i.chain, wallet:w, quorumId:quorum}))throw new ReadinessHold('PERMISSION_REQUIRED', sourceSignerDiagnostic(env, i.chain));
  if(w!.address.toLowerCase()!==i.wallet || scope.wallet_address!==i.owner)throw new ReadinessHold('SOURCE_IDENTITY_MISMATCH');
  if(config.principalCap<c.route.minimum)throw new ReadinessHold('SOURCE_CAP_REQUIRED');
  // KEEP: segregated gas signing authority.
  try {if(privateKeyToAccount(env[c.gasKeyEnv] as `0x${string}`).address.toLowerCase()!==env[c.gasWalletEnv]?.toLowerCase())throw new Error();}
  catch (caughtError) { logDebug('deposit_readiness_error', { stage: 'assertReadinessLocal', ...errorFields(caughtError) }); throw new ReadinessHold('GAS_WALLET_NOT_CONFIGURED');}
}
export interface SetupPorts { rpc: ReadRpc; delivery: GuardedDeliveryPort; maxCost: bigint; }
/** A setup signature belongs to the intent before its submission, independently of a sweep. */
export async function ensureIntentAta(intents: DepositIntents, i: DepositIntent, read: (ata:string)=>Promise<AtaRead>, setup?: SetupPorts, assertLease:()=>void=()=>{}) {
  const fields={chain:i.chain,intent_id:i.id.slice(0,12),stage:'ata_setup'};
  logDebug('bridge_readiness',{...fields,outcome:'start'});
  const ata=await deriveUsdcAta(i.owner), account=await read(ata);
  const db=intents.store.db;
  if(account.exists) {
    logDebug('bridge_readiness',{...fields,outcome:'account_exists'});
    const d=await verifyDestination(i.owner,async()=>account);
    const pending=db.prepare("SELECT * FROM bridge_setup_attempt WHERE intent_id=? AND state IN ('submitted','uncertain')").get(i.id);
    if(pending && !setup)return;
    if(pending && setup) {
      const status=(await setup.rpc.call<{value:({confirmationStatus:string;err:unknown}|null)[]}>('getSignatureStatuses',[[pending.signature],{searchTransactionHistory:true}])).value[0];
      if(status?.confirmationStatus!=='finalized') {
        const evidence=JSON.parse(String(pending.evidence_json));
        const expired=!status && evidence.last_valid_block_height && BigInt(await setup.rpc.call<number>('getBlockHeight',[{commitment:'finalized'}]))>BigInt(evidence.last_valid_block_height);
        if(!expired)return;
        db.prepare("UPDATE bridge_setup_attempt SET state='superseded' WHERE id=?").run(pending.id!);
        return d;
      }
      const tx=await setup.rpc.call<{meta:{fee:number;preBalances:number[];postBalances:number[]}}|null>('getTransaction',[pending.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}]);
      if(!tx || !Number.isSafeInteger(tx.meta.fee))throw new Error('SETUP_RECEIPT_UNAVAILABLE');
      const cost=tx.meta.preBalances?.[0]-tx.meta.postBalances?.[0];
      if(!Number.isSafeInteger(cost) || cost<tx.meta.fee)throw new Error('SETUP_COST_UNAVAILABLE');
      db.prepare("UPDATE bridge_setup_attempt SET state=?,cost_raw=? WHERE id=?").run(status.err?'failed':'confirmed',String(cost),pending.id!);
    }
    return d;
  }
  if(!setup || setup.maxCost<=0n || setup.delivery.payer===i.owner)throw new ReadinessHold('ATA_PAYER_UNAVAILABLE');
  const attempts=db.prepare('SELECT * FROM bridge_setup_attempt WHERE intent_id=? ORDER BY rowid').all(i.id);
  logDebug('bridge_readiness',{...fields,attempt_count:attempts.length,cost_cap_raw:String(setup.maxCost)});
  const pending=attempts.find(a=>['submitted','uncertain'].includes(String(a.state)));
  if(pending) {
    const status=(await setup.rpc.call<{value:({confirmationStatus:string;err:unknown}|null)[]}>('getSignatureStatuses',[[pending.signature],{searchTransactionHistory:true}])).value[0];
    const evidence=JSON.parse(String(pending.evidence_json));
    const failed=status?.confirmationStatus==='finalized' && !!status.err;
    const expired=!status && evidence.last_valid_block_height && BigInt(await setup.rpc.call<number>('getBlockHeight',[{commitment:'finalized'}]))>BigInt(evidence.last_valid_block_height);
    if(!failed && !expired)return;
    let cost=0;
    if(failed) {const tx=await setup.rpc.call<{meta:{fee:number}}|null>('getTransaction',[pending.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}]);if(!tx || !Number.isSafeInteger(tx.meta.fee))throw new Error('SETUP_RECEIPT_UNAVAILABLE');cost=tx.meta.fee;}
    db.prepare("UPDATE bridge_setup_attempt SET state='failed',cost_raw=? WHERE id=?").run(String(cost),pending.id!);
    return;
  }
  if(attempts.filter(a=>a.state==='failed').length-Number(db.prepare('SELECT failed_baseline FROM bridge_retry_allowance WHERE record_id=? AND phase=?').get(i.id,'ata_create')?.failed_baseline??0)>=3)throw new ReadinessHold('ATA_ATTEMPTS_EXHAUSTED');
  const spent=attempts.reduce((n,a)=>n+BigInt(String(a.cost_raw)),0n);
  if(spent>=setup.maxCost)throw new ReadinessHold('ATA_BUDGET_EXHAUSTED');
  if(db.prepare("SELECT 1 FROM bridge_setup_attempt a JOIN bridge_deposit_intent i ON i.id=a.intent_id WHERE i.owner=? AND a.state IN ('submitted','uncertain')").get(i.owner))return;
  assertLease();
  const prepared=await setup.delivery.prepare(await createAtaInstruction(i.owner,setup.delivery.payer),setup.maxCost-spent).catch(error=>{ logDebug('deposit_readiness_error', { stage: 'operation', ...errorFields(error) });
    if(error instanceof Error && /COST_CAP|AUTHORIZATION|POLICY_DENIED|HTTP_40[13]|clean receive simulation/.test(error.message))throw new ReadinessHold('ATA_SETUP_REPAIR_REQUIRED');
    throw error;
  });
  assertLease();
  db.prepare("INSERT INTO bridge_setup_attempt(id,intent_id,signature,state,evidence_json) VALUES (?,?,?,'submitted',?)")
    .run(prepared.requestId,i.id,prepared.signature,JSON.stringify(prepared.evidence));
  logInfo('bridge_readiness',{...fields,setup_attempt_id:prepared.requestId.slice(0,12),outcome:'submitted',cost_cap_raw:String(setup.maxCost-spent)});
  try {await setup.delivery.submit(prepared.signature);} catch (caughtError) { logError('bridge_readiness', { ...fields,setup_attempt_id:prepared.requestId.slice(0,12),outcome:'uncertain', ...errorFields(caughtError) }); db.prepare("UPDATE bridge_setup_attempt SET state='uncertain' WHERE id=?").run(prepared.requestId);}
}
/** Our own spend caps. They hold a sweep (retried on the backoff schedule) and never hide an address. */
export const SPEND_CAP_HOLDS: ReadonlySet<string> = new Set(['SOURCE_FEE_CAP_EXCEEDED','FOLIO_TOPUP_CAP_EXCEEDED']);
export const spendCapHold = (code: string|null|undefined) => !!code && SPEND_CAP_HOLDS.has(code);
/** Readiness gates the address on safety only: deployment and fee proof, zero standard fee, the gas
 * and delivery payers. The source fee and top-up caps are compared exactly as at execution, but only
 * recorded: `congested` when the rehearsed cost exceeds either cap. The caps are enforced at execution. */
export async function checkSponsorship(i: DepositIntent, config: BridgeConfig, rpc: SourceRpc, env: NodeJS.ProcessEnv, destination: Awaited<ReturnType<typeof verifyDestination>>, setup?: SetupPorts, store?: import('./transfer-record.js').SourceStore, now=Date.now()): Promise<{congested: boolean}> {
  const c=config.chains[i.chain];
  await verifyDeployment(rpc,c.feeProof,now);
  if(i.chain==='arc' && await rpc.minimumFee(config.principalCap)!==0n)throw new ReadinessHold('STANDARD_FEE_UNVERIFIED_OR_NONZERO');
  // KEEP: source fee spend limit (recorded here, enforced at execution).
  const feeCap=BigInt(env[`FOLIO_BRIDGE_SOURCE_FEE_CAP_${i.chain.toUpperCase()}_RAW`]??'0');
  // KEEP: gas top-up spend limit (recorded here, enforced at execution).
  const topupCap=BigInt(env[`FOLIO_BRIDGE_TOPUP_CAP_${i.chain.toUpperCase()}_RAW`]??'0');
  const calls=sourceCalls(c.route,config.principalCap,destination,0n);
  let total=0n, congested=false;
  // Before a send, an unfunded token balance/allowance cannot simulate a burn. Quote conservative
  // gas limits here; execution still estimates the real funded call before signing.
  for(const call of calls) {const b=await rpc.budget(i.wallet as Address,call,call.kind==='approve'?150_000n:500_000n),cost=b.gas*b.maxFeePerGas+b.maxAdditionalFee;
    if(cost>feeCap)congested=true;total+=cost;}
  // KEEP: segregated gas wallet.
  const payer=env[c.gasWalletEnv] as Address;
  const ledger=store?.shared.gasLedger(i.wallet,i.chain);
  const shortfall=total>(ledger?.folio_residual??0n)?total-(ledger?.folio_residual??0n):0n;
  const b=await rpc.budget(payer,{to:i.wallet as Address,data:'0x',value:shortfall});
  const needed=shortfall===0n?0n:shortfall+b.gas*b.maxFeePerGas+b.maxAdditionalFee;
  const payerCosts=store?.sweeps(i.chain,i.wallet).flatMap(s=>store.attempts(s.id)).filter(a=>a.kind==='gas_topup').reduce((n,a)=>n+BigInt(JSON.parse(a.evidence_json).payer_cost_raw??'0'),0n)??0n;
  if(needed>topupCap-(ledger?.folio_contribution??0n)-payerCosts)congested=true;
  if(await rpc.balance(payer)<needed)throw new ReadinessHold('FOLIO_TOPUP_UNAVAILABLE');
  if(!setup)throw new ReadinessHold('DELIVERY_PAYER_UNAVAILABLE');
  const balance=(await setup.rpc.call<{value:number}>('getBalance',[setup.delivery.payer,{commitment:'finalized'}])).value;
  // KEEP: delivery spend limit.
  const deliveryCap=BigInt(env.FOLIO_BRIDGE_DELIVERY_MAX_COST_LAMPORTS??'0');
  if(deliveryCap<=0n || !Number.isSafeInteger(balance) || BigInt(balance)<(deliveryCap>setup.maxCost?deliveryCap:setup.maxCost))throw new ReadinessHold('DELIVERY_PAYER_UNAVAILABLE');
  logInfo('bridge_readiness',{chain:i.chain,intent_id:i.id.slice(0,12),stage:'sponsorship',outcome:'ready',congested,fee_cap_raw:String(feeCap),topup_cap_raw:String(topupCap),rehearsed_cost_raw:String(total)});
  return {congested};
}
