// stand-in for the monorepo module assembly/kamino; identical signature
// Retains only the bridge-facing address derivation, not the complete module.
// Delivery excludes these owner-controlled accounts from external deposit totals.
// Public market/program constants and seeds preserve the original vanilla PDA:
// tag 0, account id, owner, market, two zero public keys. No trading or RPC here.
import { address, getAddressEncoder, getProgramDerivedAddress, type Address } from '@solana/kit';
type Account = 'spot' | 'margin' | 'crypto';
const accounts = {
  spot: { market: '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua', id: 1 },
  margin: { market: '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua', id: 0 },
  crypto: { market: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF', id: 0 },
} as const;
const program = address('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const encode = getAddressEncoder();
const zero = encode.encode(address('11111111111111111111111111111111'));
export async function obligationAddress(account: Account, owner: string): Promise<Address> {
  const { market, id } = accounts[account];
  const [derived] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: [Uint8Array.of(0), Uint8Array.of(id), encode.encode(address(owner)), encode.encode(address(market)), zero, zero],
  });
  return derived;
}
