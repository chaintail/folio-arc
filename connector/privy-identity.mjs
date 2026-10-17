import {verifyAccessToken} from '@privy-io/node';
import {createRemoteJWKSet} from 'jose';
const appId=process.env.PRIVY_APP_ID;
const url=process.env.PRIVY_JWKS_URL;
let resolver;
export function privyConfig(){
 if(typeof appId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(appId))throw Error('Missing Privy app configuration');
 const jwks=new URL(url);
 if(jwks.protocol!=='https:'||jwks.hostname!=='auth.privy.io'||jwks.username||jwks.password||jwks.search||jwks.hash||jwks.pathname!==`/api/v1/apps/${appId}/jwks.json`)throw Error('Untrusted Privy JWKS configuration');
 return {appId,jwks};
}
export async function verifiedPrivy(input,{verificationKey,now=Date.now()/1000}={}){
 const {appId,jwks}=privyConfig();
 if(typeof input!=='string'||input.length>16384)throw Error('Invalid identity credential');
 resolver ||= createRemoteJWKSet(jwks,{timeoutDuration:5000,cooldownDuration:30000,cacheMaxAge:300000});
 const identity=await verifyAccessToken({access_token:input,app_id:appId,verification_key:verificationKey||resolver});
 if(!/^did:privy:[a-zA-Z0-9_-]{1,128}$/.test(identity.user_id)||!Number.isFinite(identity.issued_at)||identity.issued_at>now+30||identity.issued_at<now-7200||identity.expiration<=now||identity.expiration<=identity.issued_at||identity.expiration-identity.issued_at>7200)throw Error('Invalid identity claims');
 return {provider:'privy.io',app_id:appId,did:identity.user_id};
}
