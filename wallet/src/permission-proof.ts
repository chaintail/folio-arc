import { createHash } from 'node:crypto';
import { DEPOSIT_CHAIN_IDS, depositPolicyDigest, isDepositChain, type DepositChain } from './evm-sweep-policy.js';

/** Pure helpers for the EVM permission proof records, one per deposit template. No IO: the proof
 * script produces records with these, and the server recomputes the same values to verify one. */
export const PROOF_TEMPLATES = {base:'deposit.base',arc:'deposit.arc'} as const satisfies Record<DepositChain,string>;
export type ProofTemplate = typeof PROOF_TEMPLATES[DepositChain];
export const PROOF_ALLOWED_KINDS = ['allowed-approve', 'allowed-burn'] as const;
/** `unsupported-chain` signs for chain 1; `other-chain` signs the allowed burn for the other deposit
 * chain, which this template must refuse now that each chain has its own policy. */
export const PROOF_DENIED_KINDS = [
  'wrong-recipient', 'wrong-spender', 'wrong-token', 'unsupported-chain', 'other-chain', 'wrong-destination-domain', 'wrong-destination-caller',
  'nonzero-value', 'nonzero-max-fee', 'wrong-finality', 'wrong-contract', 'wrong-function', 'unrelated-transfer',
] as const;
export type ProofCaseKind = typeof PROOF_ALLOWED_KINDS[number] | typeof PROOF_DENIED_KINDS[number];
export const proofCaseName = (chain: number, kind: string) => `${chain}-${kind}`;

/** One executed case. `privy` is the provider outcome, `validator` the local check of the returned wire. */
export interface ProofCaseResult {
  readonly name: string;
  readonly chain: number;
  readonly allowed: boolean;
  readonly privy: 'accepted' | 'policy_denied' | 'unproven_error';
  readonly validator: 'accepted' | 'denied' | 'not_run';
}
export interface PermissionProofRecord {
  readonly version: 2;
  readonly result: 'PASS';
  /** The template proven (`deposit.base` or `deposit.arc`) and its chain id. */
  readonly template: ProofTemplate;
  readonly chain: number;
  readonly proved_at: string;
  readonly key_quorum_id: string;
  readonly authorization_public_key_sha256: string;
  readonly policy_template_sha256: string;
  readonly cases: { readonly allowed: number; readonly denied: number };
  readonly deployed_revision: string;
}

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
/** SHA-256 (hex) of the DER SPKI bytes of an authorization public key given as base64 (as `authorizationPublicKey` returns it). */
export function authorizationPublicKeyDigest(publicKeySpkiBase64: string): string {
  const der = Buffer.from(publicKeySpkiBase64, 'base64');
  if (!der.length || der.toString('base64') !== publicKeySpkiBase64.trim()) throw new Error('INVALID_AUTHORIZATION_PUBLIC_KEY');
  return sha256(der);
}
/** [chain]'s template digest (`depositPolicyDigest`): the value a receipt's `template_digest` and the chain's proof name. */
export function policyTemplateDigest(chain: DepositChain): string { return depositPolicyDigest(chain); }

/** A case passes only on the exact expected evidence. Errors other than an explicit policy denial are unproven. */
export const casePassed = (r: ProofCaseResult) => r.allowed ? r.privy === 'accepted' && r.validator === 'accepted' : r.privy === 'policy_denied';

/** Every case of [chain]'s template present exactly once, nothing unexpected, every case passed. */
export function proofCoverage(results: readonly ProofCaseResult[], chain: DepositChain): { ok: true } | { ok: false; reason: string } {
  const chainId = DEPOSIT_CHAIN_IDS[chain], required = new Map<string, boolean>();
  for (const kind of PROOF_ALLOWED_KINDS) required.set(proofCaseName(chainId, kind), true);
  for (const kind of PROOF_DENIED_KINDS) required.set(proofCaseName(chainId, kind), false);
  const seen = new Set<string>();
  for (const r of results) {
    const allowed = required.get(r.name);
    if (allowed === undefined) return { ok: false, reason: `UNEXPECTED_CASE:${r.name}` };
    if (seen.has(r.name)) return { ok: false, reason: `DUPLICATE_CASE:${r.name}` };
    if (r.chain !== chainId || r.allowed !== allowed) return { ok: false, reason: `CASE_SHAPE_MISMATCH:${r.name}` };
    if (!casePassed(r)) return { ok: false, reason: `CASE_NOT_PROVEN:${r.name}` };
    seen.add(r.name);
  }
  for (const name of required.keys()) if (!seen.has(name)) return { ok: false, reason: `MISSING_CASE:${name}` };
  return { ok: true };
}

/** Build the PASS record for one template. Throws unless coverage is complete and every case passed. */
export function permissionProofRecord(input: {
  readonly chain: DepositChain;
  readonly results: readonly ProofCaseResult[];
  readonly provedAt: Date;
  readonly keyQuorumId: string;
  readonly authorizationPublicKeySha256: string;
  readonly deployedRevision: string;
}): PermissionProofRecord {
  if (!isDepositChain(input.chain)) throw new Error('PERMISSION_PROOF_CHAIN_REQUIRED');
  const coverage = proofCoverage(input.results, input.chain);
  if (!coverage.ok) throw new Error(`PERMISSION_PROOF_INCOMPLETE:${coverage.reason}`);
  if (!input.keyQuorumId) throw new Error('PERMISSION_PROOF_QUORUM_REQUIRED');
  if (!/^[a-f0-9]{64}$/.test(input.authorizationPublicKeySha256)) throw new Error('PERMISSION_PROOF_KEY_DIGEST_REQUIRED');
  if (!/^[a-f0-9]{7,40}$/.test(input.deployedRevision)) throw new Error('PERMISSION_PROOF_REVISION_REQUIRED');
  if (!Number.isFinite(input.provedAt.getTime())) throw new Error('PERMISSION_PROOF_TIME_REQUIRED');
  return { version: 2, result: 'PASS', template: PROOF_TEMPLATES[input.chain], chain: DEPOSIT_CHAIN_IDS[input.chain],
    proved_at: input.provedAt.toISOString(), key_quorum_id: input.keyQuorumId,
    authorization_public_key_sha256: input.authorizationPublicKeySha256, policy_template_sha256: policyTemplateDigest(input.chain),
    cases: { allowed: input.results.filter(r => r.allowed).length, denied: input.results.filter(r => !r.allowed).length },
    deployed_revision: input.deployedRevision };
}

/** Pure check of a (parsed or raw JSON) record against one chain's live configuration and this code's template. */
export function verifyPermissionProof(record: unknown, expected: {
  readonly chain: DepositChain;
  readonly keyQuorumId: string;
  readonly authorizationPublicKeySha256: string;
  readonly policyTemplateSha256: string;
}): { ok: true; reason?: undefined } | { ok: false; reason: string } {
  let r: Partial<PermissionProofRecord> & Record<string, unknown>;
  try { r = (typeof record === 'string' ? JSON.parse(record) : record) as typeof r; } catch { return { ok: false, reason: 'PROOF_UNPARSEABLE' }; }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, reason: 'PROOF_UNPARSEABLE' };
  if (r.version !== 2) return { ok: false, reason: 'PROOF_VERSION' };
  if (r.result !== 'PASS') return { ok: false, reason: 'PROOF_NOT_PASS' };
  if (!isDepositChain(expected.chain) || r.template !== PROOF_TEMPLATES[expected.chain] || r.chain !== DEPOSIT_CHAIN_IDS[expected.chain]) return { ok: false, reason: 'PROOF_CHAIN_MISMATCH' };
  if (typeof r.proved_at !== 'string' || !Number.isFinite(Date.parse(r.proved_at))) return { ok: false, reason: 'PROOF_TIME' };
  if (typeof r.deployed_revision !== 'string' || !/^[a-f0-9]{7,40}$/.test(r.deployed_revision)) return { ok: false, reason: 'PROOF_REVISION' };
  if (!expected.keyQuorumId || r.key_quorum_id !== expected.keyQuorumId) return { ok: false, reason: 'PROOF_QUORUM_MISMATCH' };
  if (!expected.authorizationPublicKeySha256 || r.authorization_public_key_sha256 !== expected.authorizationPublicKeySha256) return { ok: false, reason: 'PROOF_KEY_MISMATCH' };
  if (!expected.policyTemplateSha256 || r.policy_template_sha256 !== expected.policyTemplateSha256) return { ok: false, reason: 'PROOF_TEMPLATE_MISMATCH' };
  const cases = r.cases as { allowed?: unknown; denied?: unknown } | undefined;
  if (!cases || typeof cases !== 'object') return { ok: false, reason: 'PROOF_CASES_MISSING' };
  if (cases.allowed !== PROOF_ALLOWED_KINDS.length || cases.denied !== PROOF_DENIED_KINDS.length) return { ok: false, reason: 'PROOF_CASES_INCOMPLETE' };
  return { ok: true };
}
