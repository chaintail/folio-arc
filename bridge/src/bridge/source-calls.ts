import { logInfo, logDebug } from '../shims/log.js';
import { address, getAddressDecoder, getAddressEncoder } from '@solana/kit';
import { bytesToHex, hexToBytes, decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { associatedTokenAddress } from '../shims/associated-token.js';
import { PROGRAMS } from '../shims/programs.js';
import { USDC_MINT } from '../shims/usdc.js';
import { assertRoute, SOLANA_DOMAIN, TOKEN_MESSENGER, type SourceRoute } from './source-registry.js';
export const sourceAbi = parseAbi([
  'function approve(address spender,uint256 amount) returns (bool)',
  'function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold)',
  'function getMinFeeAmount(uint256 amount) view returns (uint256)',
]);
export const ZERO32 = `0x${'00'.repeat(32)}` as Hex;
export const recipientBytes = (ata: string): Hex => bytesToHex(new Uint8Array(getAddressEncoder().encode(address(ata))));
export const recipientAddress = (bytes: Hex): string => {
  const raw = hexToBytes(bytes);
  if (raw.length !== 32) throw refusal('RECIPIENT_LENGTH');
  return getAddressDecoder().decode(raw);
};
export interface AtaRead { readonly exists: boolean; readonly program: string; readonly data: Uint8Array; }
const verifiedDestinations = new WeakSet<object>();
export interface Destination { readonly owner: string; readonly ata: string; readonly bytes32: Hex; }
/** Verify actual classic token account data, not an ATA-exists flag supplied by the phone. */
export async function verifyDestination(owner: string, read: (ata: string) => Promise<AtaRead>): Promise<Destination> {
  const ata = await associatedTokenAddress(owner, USDC_MINT, PROGRAMS.token);
  const account = await read(ata);
  if (!account.exists || account.program !== PROGRAMS.token || account.data.length !== 165
    || getAddressDecoder().decode(account.data.subarray(0, 32)) !== USDC_MINT
    || getAddressDecoder().decode(account.data.subarray(32, 64)) !== owner || account.data[108] !== 1) throw refusal('DESTINATION_NOT_READY');
  const result = Object.freeze({ owner, ata, bytes32: recipientBytes(ata) });
  verifiedDestinations.add(result); return result;
}
export function requireZeroFee(minFee: bigint | undefined) {
  if (minFee === undefined || minFee !== 0n) throw refusal('STANDARD_FEE_UNVERIFIED_OR_NONZERO');
}
export function sourceCalls(r: SourceRoute, amount: bigint, destination: Destination, minFee: bigint | undefined) {
  assertRoute(r, r.chainId, r.domain); requireZeroFee(minFee);
  if (!verifiedDestinations.has(destination)) throw refusal('DESTINATION_NOT_VERIFIED');
  if (amount <= 0n || amount >= 2n ** 256n || recipientAddress(destination.bytes32) !== destination.ata) throw refusal('SOURCE_AMOUNT_OR_RECIPIENT_INVALID');
  return [
    { kind: 'approve' as const, to: r.usdc, value: 0n, data: encodeFunctionData({ abi: sourceAbi, functionName: 'approve', args: [TOKEN_MESSENGER, amount] }) },
    { kind: 'burn' as const, to: TOKEN_MESSENGER, value: 0n, data: encodeFunctionData({ abi: sourceAbi, functionName: 'depositForBurn', args: [amount, SOLANA_DOMAIN, destination.bytes32, r.usdc, ZERO32, 0n, 2000] }) },
  ];
}
export function decodeSource(data: Hex) { return decodeFunctionData({ abi: sourceAbi, data }); }
export async function assertPinnedDestination(d: Destination, read: (ata: string) => Promise<AtaRead>) {
  const current = await verifyDestination(d.owner, read);
  if (current.ata !== d.ata || current.bytes32 !== d.bytes32) throw refusal('DESTINATION_BINDING_MISMATCH');
  return current;
}

function refusal(reason:string) { logInfo('bridge_delivery_validation',{check:reason.replace(/[^A-Za-z0-9]+/g,'_').toLowerCase(),outcome:'refused'});return new Error(reason); }
