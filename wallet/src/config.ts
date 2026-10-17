import { observe, type PrivyObservation } from './observation.js';
/** Doc 04 §16: call once at server startup. Never load files or serialize config. */
export interface PrivyServerConfig {
  readonly appId: string;
  readonly appSecret: string;
  readonly jwksUrl: string;
  readonly authorizationKey: string;
  readonly keyQuorumId: string;
}
export class PrivyError extends Error {
  constructor(readonly code: string, readonly detail?: string, readonly requestIds?: Readonly<Record<string, string>>) { super(code); this.name = 'PrivyError'; }
}
export function loadPrivyServerConfig(env: Readonly<Record<string, string | undefined>>, observation: PrivyObservation = {}): PrivyServerConfig {
  const need = (name: string) => {
    // KEEP: identity and signing credentials.
    const value = env[name]?.trim();
    if (!value) {observe(observation,{op:'privy_configuration_gate',stage:'startup',outcome:'refused',reason:'missing_capability',code:`MISSING_${name}`});throw new PrivyError(`MISSING_${name}`);}
    return value;
  };
  const appId = need('PRIVY_APP_ID'), appSecret = need('PRIVY_APP_SECRET'), jwksUrl = need('PRIVY_JWKS_URL');
  const authorizationKey = need('PRIVY_AUTHORIZATION_KEY'), keyQuorumId = need('PRIVY_KEY_QUORUM_ID');
  let url: URL;
  const invalidUrl=()=>{observe(observation,{op:'privy_configuration_gate',stage:'startup',outcome:'refused',reason:'invalid_jwks_url',code:'INVALID_PRIVY_JWKS_URL'});return new PrivyError('INVALID_PRIVY_JWKS_URL');};
  try { url = new URL(jwksUrl); } catch { throw invalidUrl(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw invalidUrl();
  observe(observation,{op:'privy_configuration_gate',stage:'startup',outcome:'ok'});
  // Non-enumerable credentials guard accidental JSON/console serialization.
  return Object.freeze(Object.defineProperties({}, Object.fromEntries(Object.entries({ appId, appSecret, jwksUrl, authorizationKey, keyQuorumId })
    .map(([name, value]) => [name, { value, enumerable: false }])))) as PrivyServerConfig;
}
