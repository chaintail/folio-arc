import {interactionPolicy} from 'oidc-provider';
import {boundBrowser,requireFreshBinding} from './security-policy.mjs';

export function accountInteractionPolicy(){
 const policy=interactionPolicy.base();
 policy.get('login').checks.add(new interactionPolicy.Check(
  'account_unavailable','End-User authentication is required','login_required',
  ({oidc})=>Boolean(oidc.session.accountId&&!oidc.account),
 ));
 return policy;
}
export function recoveringAccount(details){
 return details.prompt?.name==='login'&&details.prompt.reasons?.includes('account_unavailable')===true;
}
export async function prepareInteractionSession(details,current,{eligible,retire}){
 if(current&&recoveringAccount(details)&&!(await eligible(current.id,details.params.client_id))){
  await retire(current);
  return null;
 }
 return current;
}
export async function verifiedInteractionLogin(details,current,binding,body,{verifyIdentity,eligible}){
 requireFreshBinding(binding);
 if(recoveringAccount(details)&&body.session_login==='yes')throw Error('Fresh identity required');
 const id=body.session_login==='yes'&&current?current.id:await verifyIdentity(body);
 requireFreshBinding(binding);
 if(!boundBrowser(binding,current,id)||!(await eligible(id,details.params.client_id)))
  throw Error('Account unavailable');
 return id;
}
