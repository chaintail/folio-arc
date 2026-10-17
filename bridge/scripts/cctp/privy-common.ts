import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { realpathSync } from 'node:fs';
import { loadDepositSigner, createPrivyAdmin, createPrivyRest, createFetchTransport, type DepositChain, type PrivyServerConfig, type PrivyTransport } from 'wallet-privy/server';
import { permissionStateOf, type PermissionReceipt } from '../../src/shims/permission-types.js';
import type { PersonScope } from '../../src/shims/person-scope.js';
import { allowedPath } from './private-file.js';
export function guardedArgs(args:readonly string[],strings:readonly string[]) {
  const options:Record<string,{type:'string'|'boolean'}>=Object.fromEntries(strings.map(k=>[k,{type:'string'}]));
  for(const k of ['execute','i-am-the-director','dry-run'])options[k]={type:'boolean'};
  const {values}=parseArgs({args:[...args],options});
  if(values.execute && (!values['i-am-the-director'] || values['dry-run']))throw Error('DIRECTOR_EXECUTION_REQUIRED');
  return {get:(key:string)=>typeof values[key]==='string'?values[key] as string:undefined,live:values.execute===true};
}
/** One deposit chain's signer credentials (FOLIO_EVM_<CHAIN>_*) with its REST and admin clients. */
export function directorRest(chain:DepositChain):{config:PrivyServerConfig;transport:PrivyTransport;rest:ReturnType<typeof createPrivyRest>;admin:ReturnType<typeof createPrivyAdmin>} {const config=loadDepositSigner(process.env,chain),transport=createFetchTransport(fetch);return {config,transport,rest:createPrivyRest(config,transport,Date.now),admin:createPrivyAdmin(config,transport)};}
export function adminRest():ReturnType<typeof createPrivyAdmin> {
  const appId=process.env.PRIVY_APP_ID,appSecret=process.env.PRIVY_APP_SECRET;
  if(!appId || !appSecret)throw Error('PRIVY_ADMIN_CONFIG_REQUIRED');
  return createPrivyAdmin({appId,appSecret},createFetchTransport(fetch));
}
export function boundPerson(path:string,person:string,readOnly=true) {
  allowedPath(realpathSync(allowedPath(path)));
  const db=new DatabaseSync(path,{readOnly});
  try {const row=db.prepare('SELECT scope FROM person_wallets WHERE namespace=?').get(person) as {scope:string}|undefined;
    if(!row)throw Error('BOUND_PERSON_REQUIRED');const scope=JSON.parse(row.scope) as PersonScope;
    if(!scope.evm_wallet || !scope.wallet_address)throw Error('BOUND_WALLETS_REQUIRED');return {db,scope};
  }catch(e){db.close();throw e;}
}
/** The person's verified deposit receipt for [chain] in the person-store file (S1's `permission_receipt`, columns as
 * the C0 PermissionReceipt fields), or a refusal. Read-only; before any provider request. Only `deposit.<chain>`:
 * a `pay.base` receipt (Folio Pay, r072) is on the same chain and never stands in for it. */
export function verifiedReceipt(db:DatabaseSync,person:string,chain:DepositChain):PermissionReceipt {
  let rows:PermissionReceipt[];
  try {rows=db.prepare('SELECT * FROM permission_receipt WHERE person=? AND chain=? AND template_id=?').all(person,chain,`deposit.${chain}`) as unknown as PermissionReceipt[];}
  catch {throw Error('PERMISSION_RECEIPTS_UNAVAILABLE');}
  const verified=rows.filter(r=>permissionStateOf(r,true)==='verified');
  if(verified.length!==1)throw Error('VERIFIED_RECEIPT_REQUIRED');
  return verified[0]!;
}

export function scriptMain(path:string,run:(args:string[])=>Promise<void>) {
  if(process.argv[1]?.endsWith(path))run(process.argv.slice(2)).catch(()=>{process.stderr.write('DIRECTOR_SCRIPT_REFUSED\n');process.exitCode=1;});
}
