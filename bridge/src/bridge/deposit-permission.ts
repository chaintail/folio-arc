import { depositPolicy, depositPolicyDigest, evmPolicyDigest, ownerQuorumMatches, PrivyError, signerAttachment, type DepositChain, type PrivyAdmin } from 'wallet-privy/server';
import type { PermissionReader, PermissionReceipt, PermissionReceiptHold } from '../shims/permission-types.js';

/**
 * The signing path's view of a person's consent for one deposit chain: the verified receipt (C0
 * `PermissionReader`), checked locally here and against Privy before every signing step.
 */

/**
 * No receipts: where no permission registry is composed (outside live), every chain is "not set up"
 * and nothing is signed; the funds stay at the person's address. Live passes the registry's reader
 * (`createPermissionsService(...).reader`, the `permission_receipt` table). Today's `evm_wallet` attachment
 * fields are deliberately not mapped into receipts: they describe the retired combined, ownerless
 * policy, which no live check can accept, and the owner ruled that everyone sets up again.
 */
export const noPermissionReceipts: SigningPermissions = { verified: () => null };
/** What the signing path consumes: the verified receipt per chain (C0 `PermissionReader.verified`), and
 * `hold` when the receipt store provides it. Without `hold` a drift still holds the intent and never
 * signs; the receipt itself is then marked by the next verify or revoke. */
export type SigningPermissions = Pick<PermissionReader, 'verified'> & Partial<Pick<PermissionReader, 'hold'>>;

/**
 * A verified receipt may gate a sweep only when it is this chain's template in this code, bound to
 * the person's current wallet and (when configured) this chain's quorum, and its stored digest is
 * the digest of the policy this code builds for that person, destination and owner. No IO.
 */
export function receiptUsable(receipt: PermissionReceipt | null | undefined, expected: { chain: DepositChain;
  wallet?: { readonly id: string; readonly address: string }; quorumId?: string }): receipt is PermissionReceipt {
  if (!receipt || !expected.wallet) return false;
  if (receipt.chain !== expected.chain || receipt.template_id !== `deposit.${expected.chain}`) return false;
  if (!receipt.verified_at || receipt.revoke_requested_at || receipt.revoked_at || receipt.hold) return false;
  if (receipt.wallet_id !== expected.wallet.id || receipt.wallet_address.toLowerCase() !== expected.wallet.address.toLowerCase()) return false;
  if (expected.quorumId && receipt.quorum_id !== expected.quorumId) return false;
  if (receipt.template_digest !== depositPolicyDigest(expected.chain) || !receipt.policy_owner) return false;
  try { return receipt.instantiated_digest === evmPolicyDigest(depositPolicy(expected.chain, receipt.person, receipt.ata)); }
  catch { return false; }
}

export type PolicyCheckResult = { readonly ok: true } | { readonly ok: false; readonly code: PermissionReceiptHold; readonly cause: string };
/** The live read failed (transport, timeout, a non-404 provider answer): retry later, never sign blind. */
export class PolicyReadUnavailable extends Error {
  constructor(readonly code: string, readonly kind: string) { super('POLICY_READ_UNAVAILABLE'); }
}
export type PolicyLiveCheck = (receipt: PermissionReceipt, user: string) => Promise<PolicyCheckResult>;

/**
 * Reads the receipt's policy, its owner quorum and the wallet with app credentials (three GETs, in
 * parallel) and compares them with the receipt:
 * - the policy's rules digest equals the receipt's, else POLICY_DRIFT;
 * - the policy's `owner_id` is the receipt's owner quorum, and that quorum is exactly the person
 *   (Privy DID [user]) plus at most Folio's policy admin key at threshold 1, else POLICY_OWNER_MISMATCH;
 * - the wallet is the receipt's and shows exactly one entry for the chain's quorum carrying exactly
 *   `[policy_id]`, else POLICY_DRIFT.
 * A 404 is an answer (the resource is gone: drift or foreign owner). Any other failure throws
 * PolicyReadUnavailable.
 */
export function createPolicyLiveCheck(options: { reads: Pick<PrivyAdmin, 'read'>; adminPublicKey: string }): PolicyLiveCheck {
  type Read = { readonly gone: true } | { readonly gone: false; readonly body: Record<string, unknown> };
  const read = (kind: 'policies' | 'key_quorums' | 'wallets', id: string): Promise<Read> => options.reads.read(kind, id).then(
    body => body && typeof body === 'object' && !Array.isArray(body) ? { gone: false as const, body: body as Record<string, unknown> } : Promise.reject(new PolicyReadUnavailable('PRIVY_RESPONSE_INVALID', kind)),
    error => {
      if (error instanceof PolicyReadUnavailable) throw error;
      if (error instanceof PrivyError && error.code === 'PRIVY_HTTP_404') return { gone: true as const };
      throw new PolicyReadUnavailable(error instanceof PrivyError ? error.code : 'PRIVY_READ_FAILED', kind);
    });
  const fail = (code: PermissionReceiptHold, cause: string): PolicyCheckResult => ({ ok: false, code, cause });
  return async (receipt, user) => {
    const [policy, owner, wallet] = await Promise.all([read('policies', receipt.policy_id), read('key_quorums', receipt.policy_owner), read('wallets', receipt.wallet_id)]);
    if (policy.gone) return fail('POLICY_DRIFT', 'policy_gone');
    if (policy.body.id !== receipt.policy_id || evmPolicyDigest(policy.body) !== receipt.instantiated_digest) return fail('POLICY_DRIFT', 'policy_digest');
    if (policy.body.owner_id !== receipt.policy_owner) return fail('POLICY_OWNER_MISMATCH', 'policy_owner');
    if (owner.gone || !ownerQuorumMatches(owner.body, receipt.policy_owner, user, options.adminPublicKey)) return fail('POLICY_OWNER_MISMATCH', 'owner_members');
    if (wallet.gone || wallet.body.chain_type !== 'ethereum' || typeof wallet.body.address !== 'string'
      || wallet.body.address.toLowerCase() !== receipt.wallet_address.toLowerCase()) return fail('POLICY_DRIFT', 'wallet');
    if (!signerAttachment(wallet.body, receipt.quorum_id, receipt.policy_id).exact) return fail('POLICY_DRIFT', 'signer_entry');
    return { ok: true };
  };
}
