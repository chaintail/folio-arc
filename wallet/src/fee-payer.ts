import { observe, type PrivyObservation } from './observe.js';
import { PrivyError } from './config.js';
import type { createPrivyRest } from './transport.js';
import { verifySolanaSignedTransaction } from './solana.js';

/** Signs only the fee payer slot. User keys never enter this port. */
export interface FeePayerSigner {
  readonly address: string;
  signTransaction(partial: Uint8Array): Promise<Uint8Array>;
}

export function createPrivyFeePayerSigner(deps: {
  observe?: PrivyObservation['observe'];
  walletId: string; address: string; rest: ReturnType<typeof createPrivyRest>;
}): FeePayerSigner {
  if (!/^[A-Za-z0-9_-]+$/.test(deps.walletId)) throw new PrivyError('INVALID_FEE_PAYER_WALLET_ID');
  return {
    address: deps.address,
    async signTransaction(partial) {
      const original = Uint8Array.from(partial);
      const response = await deps.rest.request('POST', `/v1/wallets/${deps.walletId}/rpc`, {
        method: 'signTransaction', params: { transaction: Buffer.from(original).toString('base64'), encoding: 'base64' },
      }, undefined, deps) as { data?: { signed_transaction?: unknown; encoding?: unknown } } | null;
      const encoded = response?.data?.signed_transaction;
      if (response?.data?.encoding !== 'base64' || typeof encoded !== 'string') { observe(deps,{op:'privy_signature_validation',role:'fee_payer',stage:'decode',outcome:'refused',reason:'wire_encoding'}); observe(deps, { op: 'wallets_rpc', outcome: 'refused', code: 'INVALID_FEE_PAYER_SIGNATURE' }); throw new PrivyError('INVALID_FEE_PAYER_SIGNATURE'); }
      const signed = Buffer.from(encoded, 'base64');
      const canonical=signed.toString('base64') === encoded;
      if(!canonical)observe(deps,{op:'privy_signature_validation',role:'fee_payer',stage:'decode',outcome:'refused',reason:'wire_encoding'});
      if (!canonical || !await verifySolanaSignedTransaction(original, signed, deps.address, reason=>observe(deps,{op:'privy_signature_validation',role:'fee_payer',stage:'verify',outcome:'refused',reason,bytes_count:signed.length})))
        { observe(deps, { op: 'wallets_rpc', outcome: 'refused', code: 'INVALID_FEE_PAYER_SIGNATURE' }); throw new PrivyError('INVALID_FEE_PAYER_SIGNATURE'); }
      observe(deps,{op:'privy_signature_validation',role:'fee_payer',stage:'verify',outcome:'ok',bytes_count:signed.length});
      return signed;
    },
  };
}
