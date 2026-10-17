export type SignatureDiagnostic = 'wire_encoding'|'message_changed'|'signer_missing'|'preserved_signature_changed'|'signature_invalid';
import { createPublicKey, verify } from 'node:crypto';
import { PrivyError } from './config.js';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes: Uint8Array): string {
  let value = 0n, zeroes = 0;
  for (const byte of bytes) value = value*256n+BigInt(byte);
  for (const byte of bytes) { if (byte) break; zeroes++; }
  let text = '';
  while (value) { text = alphabet[Number(value%58n)]+text; value /= 58n; }
  return '1'.repeat(zeroes)+text;
}

/** Read the compiled message, rather than trusting a host's resolved ALT view.
 * Provider predicates cannot resolve table addresses. Program ids must be static;
 * System Transfer.to and SPL TransferChecked.mint must be static as well. */
export function assertStaticPolicyAccounts(bytes: Uint8Array): void {
  try {
    if (bytes.length > 1232) throw new Error();
    let offset = 0;
    const byte = () => { if (offset >= bytes.length) throw new Error(); return bytes[offset++]; };
    const take = (n: number) => {
      if (offset + n > bytes.length) throw new Error();
      const value = bytes.slice(offset, offset + n); offset += n; return value;
    };
    const length = () => {
      let value = 0;
      for (let i = 0; i < 3; i++) {
        const next = byte();
        if (i === 2 && next > 3) throw new Error();
        value |= (next & 127) << (7 * i);
        if (!(next & 128)) { if (i > 0 && next === 0) throw new Error(); return value; }
      }
      throw new Error();
    };
    const signatures = length();
    if (!signatures || signatures > 16) throw new Error();
    take(signatures * 64);
    let required = byte();
    const versioned = (required & 128) !== 0;
    if (versioned) { if (required !== 128) throw new Error(); required = byte(); }
    const readonlySigned = byte(), readonlyUnsigned = byte(), keyCount = length();
    if (required !== signatures || keyCount < required || keyCount > 256
      || readonlySigned >= required || readonlyUnsigned > keyCount - required) throw new Error();
    const keys = Array.from({ length: keyCount }, () => base58(take(32)));
    take(32); // Blockhash is opaque to the policy evaluator.
    const count = length(), allIndexes: number[] = [];
    for (let i = 0; i < count; i++) {
      const programIndex = byte();
      if (programIndex >= keyCount) throw new Error();
      const accounts = [...take(length())], data = take(length()), program = keys[programIndex];
      allIndexes.push(...accounts);
      if (program === '11111111111111111111111111111111' && data.length >= 4
        && Buffer.from(data).readUInt32LE(0) === 2) {
        if (data.length !== 12 || accounts.length !== 2 || accounts[1] >= keyCount) throw new Error();
      }
      if (['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(program)
        && data[0] === 12) {
        if (data.length !== 10 || accounts.length < 4 || accounts[1] >= keyCount) throw new Error();
      }
    }
    let loaded = 0;
    if (versioned) {
      const tables = length();
      for (let i = 0; i < tables; i++) {
        take(32);
        loaded += take(length()).length;
        loaded += take(length()).length;
      }
    }
    if (offset !== bytes.length || keyCount + loaded > 256 || allIndexes.some(i => i >= keyCount + loaded)) throw new Error();
  } catch { throw new PrivyError('POLICY_RELEVANT_ACCOUNTS_MUST_BE_STATIC'); }
}
function transaction(bytes: Uint8Array) {
  if (bytes.length > 1232) throw new Error();
  let offset = 0;
  function length() {
    let n = 0, shift = 0, byte: number;
    do { byte = bytes[offset++]; if (byte === undefined || shift > 14) throw new Error(); n |= (byte&127)<<shift; shift += 7; } while (byte&128);
    return n;
  }
  const count = length();
  if (count < 1 || count > 16 || offset+count*64 >= bytes.length) throw new Error();
  const signatures = Array.from({ length: count }, () => { const sig = bytes.slice(offset,offset+64); offset+=64; return sig; });
  const message = bytes.slice(offset), version = bytes[offset]&128;
  if (version) { if (bytes[offset++] !== 128) throw new Error(); }
  if (bytes[offset] !== count) throw new Error();
  offset+=3;
  const keys = length();
  if (keys < count || offset+keys*32+32 > bytes.length) throw new Error();
  return { message, signatures, signers: Array.from({ length: count }, (_,i) => bytes.slice(offset+i*32,offset+(i+1)*32)) };
}
/** Check the exact compiled message and every required Ed25519 signature. Never sends. */
export async function verifySolanaSignedTransaction(original: Uint8Array, signed: Uint8Array, walletAddress: string, diagnostic?: (reason:SignatureDiagnostic)=>void): Promise<{ signature: string } | null> {
  const refuse=(reason:SignatureDiagnostic):null=>{try{diagnostic?.(reason);}catch{}return null;};
  try {
    const a = transaction(original), b = transaction(signed);
    if (!Buffer.from(a.message).equals(b.message)) return refuse('message_changed');
    if (!b.signers.some(k => base58(k) === walletAddress)) return refuse('signer_missing');
    for (let i=0; i<b.signers.length; i++) {
      if (a.signatures[i].some(x => x !== 0) && !Buffer.from(a.signatures[i]).equals(b.signatures[i])) return refuse('preserved_signature_changed');
      const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),b.signers[i]]), format:'der',type:'spki' });
      if (!verify(null,b.message,key,b.signatures[i])) return refuse('signature_invalid');
    }
    return { signature: base58(b.signatures[0]) };
  } catch { return refuse('wire_encoding'); }
}

/** Verify only the person's required signer slot over the unchanged message.
 * The fee-payer slot must still be empty; no other signer is accepted. */
export async function verifySolanaPartialTransaction(original: Uint8Array, partial: Uint8Array, walletAddress: string): Promise<boolean> {
  try {
    const a = transaction(original), b = transaction(partial);
    if (!Buffer.from(a.message).equals(b.message) || b.signers.length !== 2
      || base58(b.signers[1]) !== walletAddress || base58(b.signers[0]) === walletAddress
      || b.signatures[0].some(x => x !== 0) || a.signatures.some(sig => sig.some(x => x !== 0))) return false;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), b.signers[1]]), format: 'der', type: 'spki' });
    return verify(null, b.message, key, b.signatures[1]);
  } catch { return false; }
}
