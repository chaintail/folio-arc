/** Director supplies previously authorized fixture material. This script never signs or sends. */
/** Optional comparison CLI for source-7702.ts, separate from the source executor's transfer path. */
import { readFileSync, writeFileSync } from 'node:fs';
import { keccak256, numberToHex } from 'viem';
import { route } from '../../src/bridge/source-registry.js';
import { verifyDestination } from '../../src/bridge/source-calls.js';
import { require7702Ready, type BatchInput } from '../../src/bridge/source-7702.js';
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
for (let i = 0; i < args.length; i++) {
  if (['--input','--out'].includes(args[i])) i++;
  else if (!['--rpc-read','--dry-run'].includes(args[i])) throw new Error('UNKNOWN_FLAG_OR_BROADCAST_FORBIDDEN');
}
const output: Record<string, unknown> = { broadcast: false, signing: false, result: 'DRY_RUN', timestamp: new Date().toISOString() };
async function rpc(url: string, method: string, params: unknown[]) {
  if (!['eth_chainId','eth_getCode','eth_call','eth_estimateGas','getAccountInfo'].includes(method)) throw new Error('RPC_WRITE_FORBIDDEN');
  const response = await fetch(url, { method: 'POST', headers: { 'content-type':'application/json' },
    body: JSON.stringify({ jsonrpc:'2.0',id:1,method,params }), signal: AbortSignal.timeout(8000) });
  const json = await response.json() as { result?: any; error?: { code: number; message: string } };
  if (!response.ok || json.error) throw new Error(json.error ? `RPC_ERROR_${json.error.code}` : 'RPC_UNAVAILABLE'); return json.result;
}
if (args.includes('--rpc-read')) {
  if (!option('--input')) throw new Error('DIRECTOR_PUBLIC_ROUTE_AND_AUTHORIZATION_FIXTURE_REQUIRED');
  // This is an authorization fixture, never a credential or environment file.
  const path = option('--input')!;
  if (path.split('/').some(p => p === '.secrets' || p === '.env' || p.startsWith('.env.'))) throw new Error('FORBIDDEN_INPUT_PATH');
  const fixture = JSON.parse(readFileSync(path, 'utf8'));
  if (!['base','arc'].includes(fixture.chain) || !fixture.expectedCodeHash || fixture.minFee !== '0') throw new Error('ROUTE_AND_ZERO_FEE_PROOF_REQUIRED');
  const r = route(fixture.chain), url = r.chain === 'base' ? 'https://mainnet.base.org' : 'https://rpc.mainnet.arc.io';
  output.chain = r.chain;
  try {
    if (Number(BigInt(await rpc(url, 'eth_chainId', []))) !== r.chainId) throw new Error('SOURCE_CHAIN_MISMATCH');
    const code = await rpc(url, 'eth_getCode', [fixture.delegate, 'finalized']);
    if (!code || code === '0x') throw new Error('DELEGATE_CODE_MISSING');
    const d = await verifyDestination(fixture.destinationOwner, async ata => {
      const result = await rpc('https://api.mainnet-beta.solana.com','getAccountInfo',[ata,{encoding:'base64',commitment:'finalized'}]);
      return { exists: !!result.value, program: result.value?.owner ?? '', data: new Uint8Array(Buffer.from(result.value?.data[0] ?? '', 'base64')) };
    });
    const input: BatchInput = { ...fixture, route:r, destination:d, delegateCodeHash:keccak256(code),
      amount: BigInt(fixture.amount), executionNonce:BigInt(fixture.executionNonce), deadline:BigInt(fixture.deadline),
      gas:BigInt(fixture.gas), maxFeePerGas:BigInt(fixture.maxFeePerGas), maxPriorityFeePerGas:BigInt(fixture.maxPriorityFeePerGas) };
    if (input.amount !== 1_000000n) throw new Error('TEST_AMOUNT_MUST_BE_ONE_USDC');
    const built = require7702Ready(input), t = built.transaction;
    const auth = t.authorizationList[0];
    const call = { from:input.gasWallet,to:t.to,type:'0x4',value:'0x0',data:t.data,gas:numberToHex(t.gas),
      maxFeePerGas:numberToHex(t.maxFeePerGas),maxPriorityFeePerGas:numberToHex(t.maxPriorityFeePerGas),
      authorizationList:[{address:auth.address,chainId:numberToHex(auth.chainId),nonce:numberToHex(auth.nonce),r:auth.r,s:auth.s,yParity:numberToHex(auth.yParity ?? 0)}] };
    // Only status and gas are exported, never authorizations or unsubmitted signed payloads.
    output.delegate = input.delegate; output.codeHash = input.delegateCodeHash;
    try { await rpc(url,'eth_call',[call,'latest']); output.ethCall = 'PASS'; }
    catch (e) { output.ethCall = e instanceof Error ? e.message : 'SIMULATION_FAILED'; }
    try { output.estimatedGas = String(BigInt(await rpc(url,'eth_estimateGas',[call]))); }
    catch (e) { output.estimatedGas = e instanceof Error ? e.message : 'SIMULATION_FAILED'; }
    output.result = 'SIMULATION_ONLY';
  } catch { output.result = 'BLOCKED_ROUTE_DELEGATE_ATA_OR_RPC'; }
}
const json = JSON.stringify(output,null,2)+'\n';
if (option('--out')) writeFileSync(option('--out')!,json); else process.stdout.write(json);
