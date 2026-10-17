export interface PrivyEvent {
  readonly op: 'policies' | 'key_quorums' | 'wallets_rpc' | 'wallets_get' | 'wallets_patch' | 'wallets' | 'authenticate' | 'identity_verify' | 'delegated_scope_refused' | 'privy_attach_stage' | 'privy_gate2_state' | 'privy_send_unconfirmed' | 'privy_wallet_auth_jwt' | 'privy_identity' | 'privy_evm_operation' | 'privy_delegated_sign' | 'privy_signature_validation' | 'privy_policy_decision' | 'privy_configuration_gate' | 'privy_proof_or_client' | 'privy_fetch';
  readonly call_id?: string; readonly attempt_id?: string; readonly chain_id?: number; readonly cache_decision?: string; readonly jwks_age_ms?: number; readonly key_count?: number; readonly wallet_count?: number;
  readonly metadata?: JwtMetadata; readonly policy_version?: string; readonly reservation_id?: string; readonly prompted_fallback?: boolean; readonly decision?: string; readonly role?: string; readonly bytes_count?: number; readonly message_ref?: string; readonly token_count?: number; readonly rule_count?: number; readonly scope_kind?: string; readonly case_id?: string; readonly evidence_version?: number;
  readonly phase?: 'start' | 'end';
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path_kind?: 'policies' | 'key_quorums' | 'wallets_rpc' | 'wallets_get' | 'wallets_patch' | 'wallets' | 'authenticate';
  readonly rpc_method?: 'signTransaction' | 'signAndSendTransaction' | 'eth_signTransaction' | 'signMessage';
  readonly status?: number; readonly ms?: number; readonly code?: string;
  readonly wallet_ref?: string; readonly idem_ref?: string;
  readonly outcome?: 'ok' | 'refused'; readonly reason?: string;
  readonly jwks?: 'cache_hit' | 'fetched' | 'fetch_failed';
  readonly check?: string; readonly stage?: string; readonly state?: 'proven' | 'unproven';
}
export interface JwtMetadata {
  readonly alg: string | null; readonly kid: string | null; readonly aud_matches_app: boolean;
  readonly iss: string | null; readonly sub_matches_person: boolean;
  readonly iat: number | null; readonly exp: number | null; readonly remaining_ttl_s: number | null;
  readonly local_valid: boolean; readonly token_kind: 'access' | 'identity' | 'unknown';
}
export interface PrivyObservation {
  observe?: (event: PrivyEvent) => void;
}
/** Observability must never change a signing or verification outcome. */
export function observe(options: PrivyObservation, event: PrivyEvent): void {
  try { options.observe?.(Object.freeze(event)); } catch { /* An observer is an optional, non-authoritative sink. */ }
}
