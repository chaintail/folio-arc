// stand-in for the monorepo module capabilities/sourceSignerDiagnostic; identical signature
import { authorizationPublicKey, authorizationPublicKeySpki, depositSignerEnv, POLICY_ADMIN_ENV, type DepositChain } from 'wallet-privy/server';
import { permissionProofEnv, permissionProofStatus } from './permission-proof.js';
type InputState = 'present' | 'absent' | 'invalid';
const chains = ['base', 'arc'] as const;
const evmInputs = (chain: DepositChain) => ['PRIVY_APP_ID', 'PRIVY_APP_SECRET',
  depositSignerEnv(chain).authorizationKey, depositSignerEnv(chain).keyQuorumId, permissionProofEnv(chain), POLICY_ADMIN_ENV.publicKey];
const publicKeyOf = (key: string | undefined) => { try { return key?.trim() ? authorizationPublicKey(key.trim()) : undefined; } catch { return undefined; } };
const adminPublicKeyOf = (env: NodeJS.ProcessEnv) => { try { const v = env[POLICY_ADMIN_ENV.publicKey]?.trim(); return v ? authorizationPublicKeySpki(v) : undefined; } catch { return undefined; } };
function capabilityInput(env: NodeJS.ProcessEnv, name: string): InputState {
  const value = env[name]?.trim();
  if (!value) return 'absent';
  let valid = true;
  const proof = chains.find(chain => permissionProofEnv(chain) === name);
  if (proof) valid = permissionProofStatus(env, proof).ok;
  if (name.endsWith('_AUTHORIZATION_KEY')) { try { authorizationPublicKey(value); } catch { valid = false; } }
  const quorumChain = chains.find(chain => depositSignerEnv(chain).keyQuorumId === name);
  if (quorumChain && [env.PRIVY_KEY_QUORUM_ID?.trim(), env[depositSignerEnv(quorumChain === 'base' ? 'arc' : 'base').keyQuorumId]?.trim()].includes(value)) valid = false;
  const keyChain = chains.find(chain => depositSignerEnv(chain).authorizationKey === name);
  if (keyChain && valid) {
    const own = publicKeyOf(value);
    valid = ![publicKeyOf(env.PRIVY_AUTHORIZATION_KEY), publicKeyOf(env[depositSignerEnv(keyChain === 'base' ? 'arc' : 'base').authorizationKey]), adminPublicKeyOf(env)].includes(own);
  }
  if (name === POLICY_ADMIN_ENV.publicKey) {
    const admin = adminPublicKeyOf(env), privateKey = env[POLICY_ADMIN_ENV.authorizationKey]?.trim();
    valid = !!admin && (!privateKey || publicKeyOf(privateKey) === admin)
      && ![publicKeyOf(env.PRIVY_AUTHORIZATION_KEY), ...chains.map(chain => publicKeyOf(env[depositSignerEnv(chain).authorizationKey])),
        publicKeyOf(env.FOLIO_PAY_BASE_AUTHORIZATION_KEY)].includes(admin);
  }
  return valid ? 'present' : 'invalid';
}
export function sourceSignerDiagnostic(env: NodeJS.ProcessEnv, chain: 'base' | 'arc') {
  return { capability: `bridge_source_${chain}` as `bridge_source_${DepositChain}`,
    missing_inputs: evmInputs(chain).filter(name => capabilityInput(env, name) !== 'present') };
}
