import { logDebug, logInfo } from '../shims/log.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { getAddressDecoder, getAddressEncoder, address } from '@solana/kit';
import { CCTP } from './registry.js';
export function hexBytes(hex: string): Buffer {
  if (!/^0x(?:[\da-f]{2})+$/i.test(hex)) throw new Error('malformed hex');
  return Buffer.from(hex.slice(2),'hex');
}
export const addressBytes32 = (value: string): string => `0x${Buffer.from(getAddressEncoder().encode(address(value))).toString('hex')}`;
export const bytes32Address = (value: string): string => {
  const bytes=hexBytes(value); if(bytes.length!==32) throw new Error('invalid bytes32'); return getAddressDecoder().decode(bytes);
};
export interface DecodedMessage {
  version:number; sourceDomain:number; destinationDomain:number; nonce:string; sender:string; recipient:string;
  destinationCaller:string; minFinalityThreshold:number; finalityThresholdExecuted:number; bodyVersion:number;
  burnToken:string; mintRecipient:string; amount:string; messageSender:string; maxFee:string; feeExecuted:string;
  expirationBlock:string; hookData:string;
}
export function decodeMessage(hex: string): DecodedMessage {
  const b=hexBytes(hex); if(b.length<376) throw new Error('malformed V2 message length');
  const h=(offset:number) => `0x${b.subarray(offset,offset+32).toString('hex')}`;
  const n=(offset:number) => BigInt(h(offset)).toString();
  return { version:b.readUInt32BE(0), sourceDomain:b.readUInt32BE(4), destinationDomain:b.readUInt32BE(8), nonce:h(12), sender:h(44), recipient:h(76), destinationCaller:h(108), minFinalityThreshold:b.readUInt32BE(140), finalityThresholdExecuted:b.readUInt32BE(144), bodyVersion:b.readUInt32BE(148), burnToken:h(152), mintRecipient:h(184), amount:n(216), messageSender:h(248), maxFee:n(280), feeExecuted:n(312), expirationBlock:n(344), hookData:`0x${b.subarray(376).toString('hex')}` };
}
export interface MessageExpectation {
  sourceDomain:number; burnToken:string; amount:string; mintRecipient:string; minFinalityThreshold:2000;
  sender:string; messageSender:string; nonce?:string; messageHash?:string;
}
/** Circle's protocol message hash (Keccak-256), including finalized attestation fields. */
export const messageDigest = (message:string) => `0x${Buffer.from(keccak_256(hexBytes(message))).toString('hex')}`;
export function validateMessage(message: string, expected: MessageExpectation): DecodedMessage {
  const d=decodeMessage(message);
  const check=(ok:boolean,field:string) => { if(!ok) {logInfo('bridge_delivery_validation',{check:field.replace(/[^A-Za-z0-9]+/g,'_').toLowerCase(),outcome:'refused',source_domain:d.sourceDomain,destination_domain:d.destinationDomain});throw new Error(`CCTP mismatch: ${field}`);} };
  check(d.version===1 && d.bodyVersion===1,'version'); check(d.sourceDomain===expected.sourceDomain,'source domain');
  check(d.destinationDomain===5,'destination domain'); check(d.recipient===addressBytes32(CCTP.tokenMessengerMinter),'protocol recipient');
  check(d.burnToken===expected.burnToken.toLowerCase(),'burn token'); check(d.amount===expected.amount && BigInt(d.amount)>0n && BigInt(d.amount)<=0xffffffffffffffffn,'amount');
  check(d.mintRecipient===expected.mintRecipient.toLowerCase(),'mint recipient'); check(d.sender===expected.sender.toLowerCase(),'sender');
  check(d.messageSender===expected.messageSender.toLowerCase(),'message sender');
  check(d.minFinalityThreshold===2000 && d.minFinalityThreshold===expected.minFinalityThreshold && d.finalityThresholdExecuted===2000,'Standard finality');
  check(d.destinationCaller===`0x${'00'.repeat(32)}`,'unrestricted caller');
  check(d.maxFee==='0' && d.feeExecuted==='0' && d.expirationBlock==='0' && d.hookData==='0x','zero fees / no hooks / no expiry');
  if(expected.nonce) check(d.nonce===expected.nonce,'nonce');
  if(expected.messageHash) check(messageDigest(message)===expected.messageHash,'message hash');
  logDebug('bridge_delivery_validation',{check:'message',outcome:'verified',source_domain:d.sourceDomain,destination_domain:d.destinationDomain,evidence_ref:messageDigest(message).slice(0,12)});
  return d;
}
