/** Public RPC reads/simulation only. No wallet client, signing import or send RPC. */
import { writeFileSync } from 'node:fs';
import { address } from '@solana/kit';
import { createPublicClient, http, parseAbi, decodeErrorResult, keccak256, type Hex, type Address } from 'viem';
import { route, assertRoute, TOKEN_MESSENGER, MESSAGE_TRANSMITTER } from '../../src/bridge/source-registry.js';
import { sourceAbi, verifyDestination, sourceCalls } from '../../src/bridge/source-calls.js';
import { CALIBUR_CANDIDATE } from '../../src/bridge/source-7702.js';
const argv = process.argv.slice(2);
function option(name: string) { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; }
const known = new Set(['--rpc-read', '--dry-run', '--evm-wallet', '--owner', '--out']);
for (let i = 0; i < argv.length; i++) {
  if (!known.has(argv[i])) throw new Error('UNKNOWN_FLAG_OR_BROADCAST_FORBIDDEN');
  if (['--evm-wallet', '--owner', '--out'].includes(argv[i])) i++;
}
const sender = option('--evm-wallet');
if (sender && !/^0x[0-9a-fA-F]{40}$/.test(sender)) throw new Error('INVALID_PUBLIC_EVM_ADDRESS');
const evidence: Record<string, unknown> = { timestamp: new Date().toISOString(), broadcast: false, signing: false,
  chainMode: 'mainnet', amount: '1000000', mode: 'Standard', rpcRead: argv.includes('--rpc-read') };
const gasMeasurements = {
  base: { approve: 'BLOCKED_NOT_MEASURED', burn: 'BLOCKED_NOT_MEASURED', batch7702: 'BLOCKED_AUTHORIZATION_AND_EXECUTION_FIXTURE_REQUIRED' },
  arc: { approve: 'BLOCKED_NOT_MEASURED', burn: 'BLOCKED_NOT_MEASURED', batch7702: 'BLOCKED_AUTHORIZATION_AND_EXECUTION_FIXTURE_REQUIRED' },
};
evidence.gasMeasurements = gasMeasurements;
const endpoints = { base: 'https://mainnet.base.org', arc: 'https://rpc.mainnet.arc.io' } as const;
const solana = 'https://api.mainnet-beta.solana.com';
const owner = option('--owner');
if (!argv.includes('--rpc-read')) {
  evidence.result = 'DRY_RUN'; evidence.next = 'Add --rpc-read for public reads; --evm-wallet is the Director-approved public EVM sender.';
} else {
  if (!owner) throw new Error('DESTINATION_OWNER_REQUIRED');
  address(owner);
  async function solRead(method: string, params: unknown[]) {
    const response = await fetch(solana, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) });
    const json = await response.json() as { result?: any; error?: unknown };
    if (!response.ok || json.error) throw new Error('SOLANA_RPC_UNAVAILABLE'); return json.result;
  }
  let destination;
  try {
    destination = await verifyDestination(owner, async ata => {
      const result = await solRead('getAccountInfo', [address(ata), { encoding: 'base64', commitment: 'finalized' }]);
      return { exists: !!result.value, program: result.value?.owner ?? '', data: new Uint8Array(Buffer.from(result.value?.data[0] ?? '', 'base64')) };
    });
    evidence.destination = destination; evidence.destinationGenesis = await solRead('getGenesisHash', []);
  } catch { evidence.destination = { outcome: 'BLOCKED', reason: 'ATA_READ_OR_VERIFICATION_UNAVAILABLE' }; }
  for (const chain of ['base', 'arc'] as const) {
    const r = route(chain), results: Record<string, unknown> = { chainId: r.chainId, domain: r.domain, rpc: endpoints[chain], minFee: 'UNVERIFIED' };
    evidence[chain] = results;
    const client = createPublicClient({ transport: http(endpoints[chain], { retryCount: 0, timeout: 8000 }) });
    try { assertRoute(r, await client.getChainId(), r.domain); results.chainIdRead = 'PASS'; }
    catch { results.outcome = 'BLOCKED'; results.reason = 'PUBLIC_RPC_UNAVAILABLE_OR_CHAIN_MISMATCH'; continue; }
    for (const [name, a] of Object.entries({ usdc: r.usdc, tokenMessenger: TOKEN_MESSENGER, messageTransmitter: MESSAGE_TRANSMITTER, caliburCandidate: CALIBUR_CANDIDATE })) {
      try { const code = await client.getCode({ address: a }); results[name] = { address: a, bytes: ((code?.length ?? 2) - 2) / 2, hash: code && code !== '0x' ? keccak256(code) : null }; }
      catch { results[name] = { address: a, outcome: 'BLOCKED' }; }
    }
    try { results.minFee = String(await client.readContract({ address: TOKEN_MESSENGER, abi: sourceAbi, functionName: 'getMinFeeAmount', args: [1_000000n] })); }
    catch { results.minFee = 'UNVERIFIED_METHOD_UNAVAILABLE_OR_RPC_ERROR'; }
    if (!sender || !destination) { results.simulation = 'BLOCKED_PUBLIC_EVM_SENDER_OR_VERIFIED_ATA_MISSING'; }
    else {
      // Calldata comparison is permitted with zero maxFee; route readiness still requires fee proof.
      const calls = sourceCalls(r, 1_000000n, destination, 0n);
      for (const call of calls) {
        const request = { account: sender as Address, to: call.to, data: call.data, value: 0n };
        const result: Record<string, unknown> = { to: call.to, data: call.data };
        try { result.ethCall = (await client.call(request)).data ?? '0x'; }
        catch (e) {
          const error = e as { cause?: { data?: Hex }; data?: Hex }; const data = error.data ?? error.cause?.data;
          try { result.revert = data ? decodeErrorResult({ abi: parseAbi(['error Error(string)', 'error Panic(uint256)']), data }) : 'RPC_REVERT_OR_UNAVAILABLE'; }
          catch { result.revert = 'UNDECODED_REVERT'; }
        }
        try {
          result.estimatedGas = String(await client.estimateGas(request));
          gasMeasurements[chain][call.kind] = result.estimatedGas as string;
        }
        catch { result.estimatedGas = 'BLOCKED_OR_REVERTED'; }
        results[call.kind] = result;
      }
    }
    // Capture two real receipts with canonical emitters for Director fixture review, without a send.
    try {
      const head = await client.getBlock({ blockTag: 'finalized' });
      const logs = await client.getLogs({ address: r.emitter, fromBlock: head.number > 20n ? head.number - 20n : 0n, toBlock: head.number,
        event: parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])[0] });
      const hashes = [...new Set(logs.map(l => l.transactionHash))].slice(0, 2);
      results.receipts = await Promise.all(hashes.map(hash => client.getTransactionReceipt({ hash })));
    } catch { results.receipts = 'BLOCKED'; }
  }
}
const json = JSON.stringify(evidence, (_k, v) => typeof v === 'bigint' ? String(v) : v, 2) + '\n';
if (option('--out')) writeFileSync(option('--out')!, json); else process.stdout.write(json);
