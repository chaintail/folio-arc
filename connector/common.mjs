import fs from 'node:fs';
import path from 'node:path';
import {timingSafeEqual,scryptSync,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {reportSchema,boundedReportInput} from './research-report.mjs';
export const AS = process.env.ISSUER || 'http://localhost:38312';
export const RESOURCE = process.env.RESOURCE || 'http://localhost:38313/mcp';
export const AS_INTERNAL = process.env.AS_INTERNAL || 'http://as:38312';
export const CORE = process.env.CORE_INTERNAL || 'http://core:38316';
export const PUBLIC = process.env.PUBLIC_MODE === '1';
export const TEST = process.env.TEST_PROFILE === '1' && !PUBLIC;
export const scopes = ['folio:profile:read','folio:portfolio:read','folio:research:write'];
export const users = {'folio-alice':{id:'folio-alice',privy:'did:privy:local-alice',portfolio:[{symbol:'AAPL',quantity:10}]},'folio-bob':{id:'folio-bob',privy:'did:privy:local-bob',portfolio:[{symbol:'MSFT',quantity:20}]}};
export const proposal = z.object({symbol:z.string().regex(/^[A-Z0-9][A-Z0-9.-]{0,15}$/),action:z.enum(['buy','sell','hold']),target_weight_pct:z.number().min(0).max(100).optional(),rationale:z.string().max(1000)}).strict();
export const researchSchema = z.object({request_id:z.string().min(1).max(128),title:z.string().min(1).max(200),body:z.string().max(8000),proposals:z.array(proposal).max(20).optional(),report:reportSchema.optional()}).strict().refine(boundedReportInput,{message:'Report-bearing research input exceeds byte limit'});
export const dir = path.resolve(process.env.STATE_DIR || '/state');
export const read = (name,fallback={}) => {try{return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}};
export const write = (name,value) => {const dest=path.join(dir,name);fs.writeFileSync(dest+'.tmp',JSON.stringify(value),{mode:0o600});fs.renameSync(dest+'.tmp',dest)};
export function secret(name){return fs.readFileSync(`/secrets/${name}`,'utf8').trim()}
export function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y)}
export async function coreCall(route,subject,credential,body){const r=await fetch(CORE+route,{method:body?'POST':'GET',headers:{authorization:`Bearer ${credential}`,'x-folio-subject':subject,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error(`core denied ${r.status}`);return r.json()}
const passwordHashes=new Map();
export function preloadLocalPasswords(){for(const username of ['alice','bob']){if(passwordHashes.has(username))continue;const salt=randomBytes(16);passwordHashes.set(username,{salt,hash:scryptSync(secret(`password-${username}`),salt,64)})}}
export async function verifyIdentity(input){
 if(process.env.PRIVY_LOGIN==='1'){
  const {verifiedPrivy}=await import('./privy-identity.mjs');
  const identity=await verifiedPrivy(input.privy_access_token);
  const result=await coreCall('/identity/resolve','',secret('core-as'),identity);
  if(typeof result.id!=='string')throw Error('Identity not eligible');
  return result.id;
 }
 if(TEST&&process.env.DEV_IDENTITY_STUB==='1'&&input.identity_token){const u=Object.values(users).find(x=>equal(input.identity_token,`DEV:${x.privy}`));if(u)return u.id;throw Error('invalid development identity')}
 if(process.env.MOCK_PASSWORD_LOGIN==='1'&&input.username&&input.password){const u=users[`folio-${input.username}`];if(u&&typeof input.password==='string'&&input.password.length<=256){preloadLocalPasswords();const {salt,hash}=passwordHashes.get(input.username);const presented=scryptSync(input.password,salt,64);if(timingSafeEqual(presented,hash))return u.id}}
 throw Error('Identity verifier unavailable or credential invalid; real Privy not configured');
}
