import { generateKeyPairSync } from 'node:crypto';
import { DEPOSIT_CHAIN_IDS, PROOF_ALLOWED_KINDS, PROOF_DENIED_KINDS, authorizationPublicKey, authorizationPublicKeyDigest, depositPolicy, evmPolicyDigest,
  permissionProofRecord, policyTemplateDigest, proofCaseName, type DepositChain, type PermissionProofRecord, type ProofCaseResult } from 'wallet-privy/server';
import type { PermissionReader, PermissionReceipt, PermissionReceiptHold } from '../src/shims/permission-types.js';

/** Every case of one template's sign-only proof passing. */
export const passingProofCases = (chain: DepositChain): ProofCaseResult[] => { const id = DEPOSIT_CHAIN_IDS[chain]; return [
  ...PROOF_ALLOWED_KINDS.map(k => ({ name: proofCaseName(id, k), chain: id, allowed: true, privy: 'accepted' as const, validator: 'accepted' as const })),
  ...PROOF_DENIED_KINDS.map(k => ({ name: proofCaseName(id, k), chain: id, allowed: false, privy: 'policy_denied' as const, validator: 'not_run' as const }))]; };

export const evmAuthorizationKey = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

/** A PASS record for [chain] with this key (PEM) and quorum, as privy-evm-prove.ts prints it. */
export function proofRecord(key: string, quorum: string, chain: DepositChain = 'base'): PermissionProofRecord {
  return permissionProofRecord({ chain, results: passingProofCases(chain), provedAt: new Date('2026-10-08T12:00:00Z'), keyQuorumId: quorum,
    authorizationPublicKeySha256: authorizationPublicKeyDigest(authorizationPublicKey(key)), deployedRevision: '0199d6e' });
}

/** Both chains' signing inputs (own key, own quorum `<quorum>-base`/`<quorum>-arc`, a valid proof
 * each) and the policy admin key. [baseKey] pins the Base key when a test needs to know it. */
export function provenEvmEnv(quorum: string, baseKey: string = evmAuthorizationKey(), arcKey: string = evmAuthorizationKey(), adminKey: string = evmAuthorizationKey()) {
  return {
    FOLIO_EVM_BASE_AUTHORIZATION_KEY: baseKey, FOLIO_EVM_BASE_KEY_QUORUM_ID: `${quorum}-base`, FOLIO_EVM_PERMISSION_PROOF_BASE: JSON.stringify(proofRecord(baseKey, `${quorum}-base`, 'base')),
    FOLIO_EVM_ARC_AUTHORIZATION_KEY: arcKey, FOLIO_EVM_ARC_KEY_QUORUM_ID: `${quorum}-arc`, FOLIO_EVM_PERMISSION_PROOF_ARC: JSON.stringify(proofRecord(arcKey, `${quorum}-arc`, 'arc')),
    FOLIO_POLICY_ADMIN_PUBLIC_KEY: authorizationPublicKey(adminKey),
  };
}

/** A verified receipt that passes the signing path's local checks for [chain]. */
export function verifiedReceipt(input: { chain: DepositChain; person: string; wallet: { id: string; address: string }; ata: string; quorum: string;
  policyId?: string; owner?: string; id?: string }): PermissionReceipt {
  const owner = input.owner ?? 'owner-quorum', policy = depositPolicy(input.chain, input.person, input.ata);
  return { id: input.id ?? `receipt-${input.chain}`, person: input.person, template_id: `deposit.${input.chain}`, template_version: 1, chain: input.chain,
    wallet_id: input.wallet.id, wallet_address: input.wallet.address, policy_id: input.policyId ?? `policy-${input.chain}`,
    instantiated_digest: evmPolicyDigest(policy)!, template_digest: policyTemplateDigest(input.chain), policy_owner: owner, quorum_id: input.quorum,
    ata: input.ata, copy_json: '{}', copy_sha256: '0'.repeat(64), locale: 'en', app_version: 'test', accepted_at: '2026-10-14T00:00:00.000Z',
    signer_reported_at: '2026-10-14T00:00:01.000Z', verified_at: '2026-10-14T00:00:02.000Z', revoke_requested_at: null, revoked_at: null, hold: null };
}

/** An in-memory PermissionReader: the latest verified, unheld receipt per person and chain; holds are recorded. */
export function fakeReceipts(...initial: PermissionReceipt[]) {
  const rows = [...initial], holds: { id: string; code: PermissionReceiptHold }[] = [];
  const reader: PermissionReader = {
    verified: (person, chain) => rows.filter(r => r.person === person && r.chain === chain && r.verified_at && !r.hold && !r.revoke_requested_at && !r.revoked_at).at(-1) ?? null,
    hold: (id, code) => { holds.push({ id, code }); const i = rows.findIndex(r => r.id === id); if (i >= 0) rows[i] = { ...rows[i]!, hold: code }; },
  };
  return { reader, rows, holds, add: (r: PermissionReceipt) => { rows.push(r); } };
}
