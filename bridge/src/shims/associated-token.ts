// stand-in for the monorepo module assembly/precondition; identical signature
import { address, getAddressEncoder, getProgramDerivedAddress, type Address } from '@solana/kit';
import { logInfo } from './log.js';
import { errorFields } from './log-fields.js';
import { PROGRAMS } from './programs.js';
const tokenPdas = new Map<string, Promise<Address>>();
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): Promise<Address> {
  const key = `${owner}/${mint}/${tokenProgram}`;
  const hit = tokenPdas.get(key);
  if (hit) return hit;
  const derived = deriveAssociatedTokenAddress(owner, mint, tokenProgram);
  if (tokenPdas.size >= 256) tokenPdas.delete(tokenPdas.keys().next().value!);
  tokenPdas.set(key, derived);
  void derived.catch(error => { logInfo('precondition_read_failed', { key_kind: 'token_pda', kind: 'token_pda', ...errorFields(error) }); if (tokenPdas.get(key) === derived) tokenPdas.delete(key); });
  return derived;
}
async function deriveAssociatedTokenAddress(owner: string, mint: string, tokenProgram: string): Promise<Address> {
  const encode = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(PROGRAMS.associatedToken),
    seeds: [encode.encode(address(owner)), encode.encode(address(tokenProgram)), encode.encode(address(mint))],
  });
  return pda;
}
