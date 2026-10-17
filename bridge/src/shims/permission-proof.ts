// stand-in for the monorepo module permission-proof; identical signature
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { authorizationPublicKey, authorizationPublicKeyDigest, depositSignerEnv, policyTemplateDigest, verifyPermissionProof, type DepositChain } from 'wallet-privy/server';

/** One proof per deposit template: `FOLIO_EVM_PERMISSION_PROOF_BASE` and `..._ARC`. */
export const permissionProofEnv = (chain: DepositChain) => `FOLIO_EVM_PERMISSION_PROOF_${chain.toUpperCase()}` as const;
export type PermissionProofStatus =
  | { ok: true; reason?: undefined; proved_at: string; template: string; deployed_revision: string; signer_ref: string; template_ref: string }
  | { ok: false; reason: string; proved_at?: string; template?: string; deployed_revision?: string; signer_ref?: string; template_ref?: string };

/** The record is the value itself, or a mode-600 file when the value is an absolute path. */
function readRecord(value: string): { raw: string } | { reason: string } {
  if (!value.startsWith('/')) return { raw: value };
  try {
    if (statSync(value).mode & 0o077) return { reason: 'PROOF_FILE_MODE' };
    return { raw: readFileSync(value, 'utf8') };
  } catch { return { reason: 'PROOF_FILE_UNREADABLE' }; }
}

function expectedKeyDigest(key: string | undefined): string {
  try { return key?.trim() ? authorizationPublicKeyDigest(authorizationPublicKey(key.trim())) : ''; } catch { return ''; }
}

/** Verify [chain]'s proof against that chain's quorum and key and its policy template in this
 * code. Pure apart from reading the proof file; no hash beyond an 8-character prefix leaves. */
export function verifyEnvPermissionProof(env: NodeJS.ProcessEnv, chain: DepositChain): PermissionProofStatus {
  const value = env[permissionProofEnv(chain)]?.trim(), names = depositSignerEnv(chain);
  if (!value) return { ok: false, reason: 'PROOF_ABSENT' };
  const read = readRecord(value);
  if ('reason' in read) return { ok: false, reason: read.reason };
  let record: Record<string, unknown> | undefined;
  try { const parsed = JSON.parse(read.raw); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) record = parsed; } catch { /* unparseable below */ }
  if (!record) return { ok: false, reason: 'PROOF_UNPARSEABLE' };
  const verdict = verifyPermissionProof(record, { chain, keyQuorumId: env[names.keyQuorumId]?.trim() ?? '',
    authorizationPublicKeySha256: expectedKeyDigest(env[names.authorizationKey]), policyTemplateSha256: policyTemplateDigest(chain) });
  const prefix = (v: unknown) => typeof v === 'string' ? v.slice(0, 8) : undefined;
  const facts = { proved_at: typeof record.proved_at === 'string' ? record.proved_at : undefined,
    template: typeof record.template === 'string' ? record.template.slice(0, 32) : undefined,
    deployed_revision: typeof record.deployed_revision === 'string' ? record.deployed_revision.slice(0, 40) : undefined,
    signer_ref: prefix(record.authorization_public_key_sha256), template_ref: prefix(record.policy_template_sha256) };
  return verdict.ok ? { ok: true, ...facts } as PermissionProofStatus : { ok: false, reason: verdict.reason, ...facts };
}

const cache = new Map<string, PermissionProofStatus>();
/** One verification per chain and configuration: boot, the capability snapshot, the source service
 * and the readiness gate all read the same parsed result. */
export function permissionProofStatus(env: NodeJS.ProcessEnv, chain: DepositChain): PermissionProofStatus {
  const names = depositSignerEnv(chain);
  const id = createHash('sha256').update(JSON.stringify([chain, env[permissionProofEnv(chain)] ?? '', env[names.keyQuorumId] ?? '', env[names.authorizationKey] ?? ''])).digest('hex');
  let status = cache.get(id);
  if (!status) { status = verifyEnvPermissionProof(env, chain); if (cache.size > 64) cache.clear(); cache.set(id, status); }
  return status;
}
/** The boot event, one per chain: outcome and record facts, never a full hash. */
export function permissionProofEvent(status: PermissionProofStatus, chain: DepositChain) {
  return { event: 'permission_proof', chain, ok: status.ok, reason: status.reason ?? null, proved_at: status.proved_at ?? null,
    template: status.template ?? null, deployed_revision: status.deployed_revision ?? null, signer_ref: status.signer_ref ?? null, template_ref: status.template_ref ?? null };
}
