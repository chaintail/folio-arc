/** Director's separate signer: no RPC, no environment key, no broadcast. */
import {parseArgs} from 'node:util';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {privateKeyToAccount} from 'viem/accounts';
import {type Hex} from 'viem';
import {allowedPath,privateFile} from './private-file.js';
export function parseSignerArgs(args:readonly string[]) {
 const {values:v}=parseArgs({args:[...args],options:{transaction:{type:'string'},'key-file':{type:'string'},out:{type:'string'},'i-am-the-director':{type:'boolean'}}});
 if(!v['i-am-the-director']||!v.transaction||!v['key-file']||!v.out)throw Error('DIRECTOR_SIGNING_GATE_REQUIRED');
 return {transaction:allowedPath(v.transaction),keyFile:allowedPath(v['key-file']),out:allowedPath(v.out)};
}
export async function signWithKey(args:readonly string[]) {
 const v=parseSignerArgs(args);allowedPath(realpathSync(v.transaction));
 const prepared=JSON.parse(readFileSync(v.transaction,'utf8')),t=prepared.transaction??prepared.result?.transaction;
 const fields=['from','type','chainId','to','value','data','nonce','gas','maxFeePerGas','maxPriorityFeePerGas'];
 if(!t||Object.keys(t).some(k=>!fields.includes(k))||fields.some(k=>typeof t[k]!=='string')||t.type!=='0x2'||!['0x2105','0x13b2'].includes(t.chainId))throw Error('PREPARED_TRANSACTION_REQUIRED');
 const key=privateFile(v.keyFile).trim();if(!/^0x[\da-f]{64}$/i.test(key))throw Error('PRIVATE_KEY_FORMAT');
 const account=privateKeyToAccount(key as Hex);if(account.address.toLowerCase()!==t.from.toLowerCase())throw Error('SOURCE_IDENTITY_MISMATCH');
 const nonce=Number(BigInt(t.nonce));if(!Number.isSafeInteger(nonce)||nonce<0)throw Error('SOURCE_NONCE_INVALID');
 const signed=await account.signTransaction({type:'eip1559',chainId:Number(BigInt(t.chainId)),to:t.to,value:BigInt(t.value),data:t.data,
  nonce,gas:BigInt(t.gas),maxFeePerGas:BigInt(t.maxFeePerGas),maxPriorityFeePerGas:BigInt(t.maxPriorityFeePerGas)});
 writeFileSync(v.out,signed+'\n',{mode:0o600,flag:'wx'});process.stdout.write('Signed wire written to the private output file. Nothing sent.\n');
}
if(process.argv[1]?.endsWith('/sign-with-key.ts'))signWithKey(process.argv.slice(2)).catch(()=>{process.stderr.write('DIRECTOR_SIGNING_REFUSED\n');process.exitCode=1;});
