import {scopes} from './common.mjs';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const moduleRoot=fileURLToPath(new URL('./',import.meta.url));
// Only coordinates in shipped source files may reach logs; stack messages and
// function names can contain request data and are never copied.
const stackFiles=new Set(fs.readdirSync(moduleRoot).filter(name=>name.endsWith('.mjs')));
const providerRoot='node_modules/oidc-provider/lib/';
for(const name of fs.readdirSync(moduleRoot+providerRoot,{recursive:true}))
 if(name.endsWith('.js'))stackFiles.add(providerRoot+name);
const errorNames=new Set(['Error','TypeError','RangeError','ReferenceError','SyntaxError','URIError','AggregateError','EvalError']);
export function safeServerError(error){
 const frames=[];
 const stack=typeof error?.stack==='string'?error.stack.slice(0,16384):'';
 for(const line of stack.split('\n').slice(1,65)){
  const match=line.match(/^\s+at (?:.* \()?((?:file:\/\/)?\/[^\s()]+):(\d{1,7}):(\d{1,7})\)?$/);
  if(!match)continue;
  const filename=match[1].replace(/^file:\/\//,'');
  if(!filename.startsWith(moduleRoot))continue;
  const file=filename.slice(moduleRoot.length);
  if(!stackFiles.has(file))continue;
  const row=Number(match[2]),column=Number(match[3]);
  if(row<1||column<1)continue;
  frames.push({file,line:row,column});
  if(frames.length===8)break;
 }
 return {error_name:errorNames.has(error?.name)?error.name:'other',frames};
}
const knownScopes=new Set(['openid','offline_access',...scopes]);
const knownPrompts=new Set(['none','login','consent','select_account']);
let count=0;
const list=(value,known)=>typeof value==='string'?value.split(/\s+/).filter(x=>known.has(x)).slice(0,8):[];
const schemas={
 oauth_server_error:['error_name','frames'],
 oauth_userinfo_result:['status'],
 oauth_userinfo_rejected:['error_code','status'],
 oauth_authorization_rejected:['error_code','reason','id_token_hint_present','login_hint_present','request_uri_present','code_challenge_present','s256'],
 oauth_authorization_requested:['client_class','scopes','prompts','code_response','resource_match','prompt_present','scope_present'],
 oauth_authorization_accepted:['scopes','refresh_allowed','client_auth'],
 oauth_token_result:['grant_type','status','scopes','access_token_present','refresh_token_present','expires_in'],
 oauth_token_rejected:['grant_type','status'],
};
const enums={error_code:['invalid_request','invalid_client','invalid_redirect_uri','invalid_scope','invalid_target','invalid_token','insufficient_scope','unauthorized_client','unsupported_response_type','access_denied','login_required','interaction_required','server_error'],reason:['id_token_hint_invalid','redirect_invalid','pkce_invalid','other'],client_class:['metadata','registered'],client_auth:['none','private_key_jwt','client_secret_basic','client_secret_post','other'],grant_type:['authorization_code','refresh_token','other']};
export function diagnostic(event,details={}){
 if(process.env.REFRESH_DIAGNOSTICS!=='1'||!schemas[event]||count>=200)return;
 const safe={event};
 for(const key of schemas[event]){
  const value=details[key];
  if(key==='error_name')safe[key]=errorNames.has(value)?value:'other';
  else if(key==='frames')safe[key]=Array.isArray(value)?value.filter(frame=>stackFiles.has(frame?.file)&&Number.isInteger(frame.line)&&frame.line>0&&frame.line<=9999999&&Number.isInteger(frame.column)&&frame.column>0&&frame.column<=9999999).slice(0,8).map(({file,line,column})=>({file,line,column})):[];
  else if(key==='scopes'||key==='prompts')safe[key]=Array.isArray(value)?value.filter(x=>(key==='scopes'?knownScopes:knownPrompts).has(x)).slice(0,8):[];
  else if(enums[key])safe[key]=enums[key].includes(value)?value:'other';
  else if(key==='status')safe[key]=Number.isInteger(value)&&value>=100&&value<=599?value:null;
  else if(key==='expires_in')safe[key]=Number.isFinite(value)&&value>=0&&value<=86400?value:null;
  else safe[key]=typeof value==='boolean'?value:false;
 }
 count++;console.info(JSON.stringify(safe));
}
export function observeServerError(_ctx,error){diagnostic('oauth_server_error',safeServerError(error))}
export function observeAuthorization(q,resource){diagnostic('oauth_authorization_requested',{client_class:typeof q.query.client_id==='string'&&q.query.client_id.startsWith('https://')?'metadata':'registered',scopes:list(q.query.scope,knownScopes),prompts:list(q.query.prompt,knownPrompts),code_response:q.query.response_type==='code',resource_match:q.query.resource===resource,prompt_present:typeof q.query.prompt==='string',scope_present:typeof q.query.scope==='string'})}
export function observeAccepted(d,client){diagnostic('oauth_authorization_accepted',{scopes:list(d.params.scope,knownScopes),refresh_allowed:client.grantTypeAllowed('refresh_token'),client_auth:['none','private_key_jwt','client_secret_basic','client_secret_post'].includes(client.tokenEndpointAuthMethod)?client.tokenEndpointAuthMethod:'other'})}
export function observeEffective(ctx){const client=ctx.oidc.client;observeAccepted({params:ctx.oidc.params},client)}
export function observeToken(ctx){const body=ctx.body||{};diagnostic('oauth_token_result',{grant_type:['authorization_code','refresh_token'].includes(ctx.oidc?.params?.grant_type)?ctx.oidc.params.grant_type:'other',status:ctx.status,scopes:list(body.scope,knownScopes),access_token_present:typeof body.access_token==='string',refresh_token_present:typeof body.refresh_token==='string',expires_in:Number.isFinite(body.expires_in)?body.expires_in:null})}

export function observeAuthorizationRejected(ctx,error){
 const p=ctx.oidc?.params||{};
 const description=typeof error?.error_description==='string'?error.error_description:'';
 const reason=description==='could not validate id_token_hint'?'id_token_hint_invalid':description.includes('redirect_uri')?'redirect_invalid':description.includes('code_challenge')?'pkce_invalid':'other';
 diagnostic('oauth_authorization_rejected',{error_code:error?.error,reason,id_token_hint_present:typeof p.id_token_hint==='string',login_hint_present:typeof p.login_hint==='string',request_uri_present:typeof p.request_uri==='string',code_challenge_present:typeof p.code_challenge==='string',s256:p.code_challenge_method==='S256'});
}
