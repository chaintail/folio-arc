// stand-in for the monorepo module permissions/types; identical signature
export type PermissionChain = 'base' | 'arc';
export type PermissionId = 'deposit.base' | 'deposit.arc';
export type PermissionLocale = 'en';
export type PermissionReceiptHold = 'POLICY_DRIFT' | 'POLICY_OWNER_MISMATCH';
export type PermissionState = 'none' | 'wallet_ready' | 'policy_created' | 'signer_reported' | 'verified' | 'held' | 'revoking' | 'revoked';
export type PolicyJson = null | boolean | number | string | readonly PolicyJson[] | { readonly [key: string]: PolicyJson };
export type PrivyPolicyOperator = 'eq';
export type PrivyPolicyCondition = {
  readonly field_source: 'ethereum_transaction' | 'ethereum_calldata';
  readonly field: string;
  readonly operator: PrivyPolicyOperator;
  readonly value: string | number;
  readonly abi?: readonly PolicyJson[];
};
export type PrivyPolicyRule = {
  readonly name: string;
  readonly method: 'eth_signTransaction';
  readonly action: 'ALLOW';
  readonly conditions: readonly PrivyPolicyCondition[];
};
export type PrivyPolicyBody = {
  readonly version: '1.0';
  readonly name: string;
  readonly chain_type: 'ethereum';
  readonly owner_id?: string;
  readonly rules: readonly PrivyPolicyRule[];
};
export type DepositPolicyBuilder = (chain: PermissionChain, key: string, ata: string) => PrivyPolicyBody;
export interface PermissionReceipt {
  readonly id: string;
  readonly person: string;
  readonly template_id: PermissionId;
  readonly template_version: number;
  readonly chain: PermissionChain;
  readonly wallet_id: string;
  readonly wallet_address: string;
  readonly policy_id: string;
  readonly instantiated_digest: string;
  readonly template_digest: string;
  readonly policy_owner: string;
  readonly quorum_id: string;
  readonly ata: string;
  readonly copy_json: string;
  readonly copy_sha256: string;
  readonly locale: PermissionLocale;
  readonly app_version: string;
  readonly accepted_at: string;
  readonly signer_reported_at: string | null;
  readonly verified_at: string | null;
  readonly revoke_requested_at: string | null;
  readonly revoked_at: string | null;
  readonly hold: PermissionReceiptHold | null;
}
export interface PermissionReader {
  verified(person: string, chain: PermissionChain): PermissionReceipt | null;
  hold(receiptId: string, code: PermissionReceiptHold): void;
}
export function permissionStateOf(receipt: PermissionReceipt | null, walletReady: boolean): PermissionState {
  if (!receipt) return walletReady ? 'wallet_ready' : 'none';
  if (receipt.revoked_at) return 'revoked';
  if (receipt.revoke_requested_at) return 'revoking';
  if (receipt.verified_at) return receipt.hold ? 'held' : 'verified';
  if (receipt.signer_reported_at) return 'signer_reported';
  return 'policy_created';
}
