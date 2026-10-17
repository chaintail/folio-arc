import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { authorizationPublicKey } from 'wallet-privy/server';
import { privateFile, allowedPath } from './private-file.js';
import { guardedArgs, adminRest, scriptMain } from './privy-common.js';
export async function evmKey(args:readonly string[]) {
  const a=guardedArgs(args,['private-key-out','register-key-file']);
  let publicKey:string;
  if(a.get('register-key-file')) {
    if(a.get('private-key-out'))throw Error('CHOOSE_GENERATE_OR_REGISTER');
    publicKey=authorizationPublicKey(privateFile(a.get('register-key-file')!));
  } else {
    const out=a.get('private-key-out');if(!out || a.live)throw Error('GENERATE_DRY_RUN_REQUIRES_PRIVATE_KEY_OUT');
    allowedPath(realpathSync(dirname(allowedPath(out))));
    const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    // Exclusive creation, no overwrite and no private material on stdout or in environment.
    writeFileSync(allowedPath(out),pair.privateKey.export({format:'pem',type:'pkcs8'}),{flag:'wx',mode:0o600});
    publicKey=pair.publicKey.export({format:'der',type:'spki'}).toString('base64');
  }
  const body={display_name:'Folio EVM funding only',authorization_threshold:1,public_keys:[publicKey]};
  console.log(JSON.stringify({mode:a.live?'DIRECTOR_EXECUTION':'DRY_RUN',public_key:publicKey,request:{method:'POST',path:'/v1/key_quorums',body}},null,2));
  if(a.live) {const response=await adminRest().request('/v1/key_quorums',body) as {id?:string};if(!response.id)throw Error('QUORUM_ID_REQUIRED');console.log(JSON.stringify({key_quorum_id:response.id}));}
}
scriptMain('/privy-evm-key.ts',evmKey);
