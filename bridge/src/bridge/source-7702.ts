/** Wire-format comparison for read-7702.ts; the source executor does not use this signing path. */
import { logInfo, logDebug } from '../shims/log.js';
import { encodeFunctionData, parseAbi, serializeTransaction, parseTransaction, type Hex, type Address, type SignedAuthorization } from 'viem';
import { sourceCalls, type Destination } from './source-calls.js';
import { type SourceRoute } from './source-registry.js';
/** Calibur v1.0.0 candidate. Base newer v1.1.0 differs; never assume matching code on Arc. */
export const CALIBUR_CANDIDATE = '0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00' as const;
export const caliburAbi = parseAbi([
  'function execute(((address to,uint256 value,bytes data)[] calls,bool revertOnFailure) batchedCall)',
  'function execute((((address to,uint256 value,bytes data)[] calls,bool revertOnFailure) batchedCall,uint256 nonce,bytes32 keyHash,address executor,uint256 deadline) signedBatchedCall,bytes wrappedSignature)',
]);
export interface BatchInput {
  route: SourceRoute; wallet: Address; gasWallet: Address; destination: Destination; amount: bigint;
  authorization: SignedAuthorization; delegate: Address; delegateCodeHash: Hex | undefined;
  expectedCodeHash: Hex | undefined; executionSignature: Hex; executionNonce: bigint; deadline: bigint;
  sponsorNonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
}
/** Wire-format comparison only. A 7702 authorization does NOT authorize a relayer batch.
 * Calibur requires a separately signed EIP-712 batch bound to executor/nonce/deadline. */
export function build7702Comparison(input: BatchInput) {
  if (input.authorization.chainId !== input.route.chainId || input.authorization.address.toLowerCase() !== input.delegate.toLowerCase()) throw refusal('AUTHORIZATION_ROUTE_MISMATCH');
  const calls = sourceCalls(input.route, input.amount, input.destination, 0n).map(({ to, value, data }) => ({ to, value, data }));
  const batch = { batchedCall: { calls, revertOnFailure: true }, nonce: input.executionNonce,
    keyHash: `0x${'00'.repeat(32)}` as Hex, executor: input.gasWallet, deadline: input.deadline };
  const data = encodeFunctionData({ abi: caliburAbi, functionName: 'execute', args: [batch, input.executionSignature] });
  const transaction = { type: 'eip7702' as const, chainId: input.route.chainId, to: input.wallet, value: 0n, data,
    nonce: input.sponsorNonce, gas: input.gas, maxFeePerGas: input.maxFeePerGas, maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    authorizationList: [input.authorization] };
  const serialized = serializeTransaction(transaction);
  return { from: input.gasWallet, transaction, serialized, decoded: parseTransaction(serialized), batch };
}
export function require7702Ready(input: BatchInput) {
  if (!input.delegateCodeHash || !input.expectedCodeHash || input.delegateCodeHash !== input.expectedCodeHash
    || input.executionSignature === '0x' || input.deadline <= 0n) throw refusal('DELEGATE_OR_EXECUTION_AUTHORIZATION_UNVERIFIED');
  if (input.gasWallet.toLowerCase() === input.wallet.toLowerCase()) throw refusal('CUSTOMER_MUST_NOT_PAY_GAS');
  return build7702Comparison(input);
}

function refusal(reason:string) { logInfo('bridge_signing_guard',{check:reason.replace(/[^A-Za-z0-9]+/g,'_').toLowerCase(),outcome:'refused'});return new Error(reason); }
