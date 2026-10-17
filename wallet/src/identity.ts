import { observe, type JwtMetadata, type PrivyObservation } from './observe.js';
import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { PrivyError, type PrivyServerConfig } from './config.js';
import type { PrivyTransport } from './transport.js';

export interface VerifiedIdentity { readonly user: string; readonly expiresAt: number; readonly walletIds: readonly string[]; readonly walletAddresses: readonly string[]; readonly evmWallets?: readonly { readonly id: string; readonly address: string }[] }
type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string; key_ops?: string[] };
const invalid = () => new PrivyError('PRIVY_IDENTITY_INVALID');
function decode(part: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw invalid();
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw invalid();
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  return parsed as Record<string, unknown>;
}
/** Identity JWT signature + issuer/audience/time verification. No bearer token retained. */
export function createIdentityVerifier(config: Pick<PrivyServerConfig, 'appId' | 'jwksUrl'>, transport: PrivyTransport,
  now: () => number, cacheMs = 300_000, observation: PrivyObservation = {}) {
  if (!Number.isFinite(cacheMs) || cacheMs <= 0 || cacheMs > 300_000) throw invalid();
  let keys: Jwk[] = [], validUntil = 0, pending: Promise<void> | undefined;
  async function refresh() {
    observe(observation, { op: 'privy_identity', stage: 'jwks', cache_decision: pending ? 'join' : 'refresh', key_count: keys.length });
    pending ??= (async () => {
      const r = await transport.request({ method: 'GET', url: config.jwksUrl, headers: {} });
      const body = r.body as { keys?: Jwk[] } | null;
      if (r.status !== 200 || !body || !Array.isArray(body.keys) || body.keys.length > 100) throw invalid();
      const seen = new Set<string>();
      for (const k of body.keys) {
        if (!k.kid || seen.has(k.kid)) throw invalid();
        seen.add(k.kid);
      }
      keys = structuredClone(body.keys); validUntil = now() + cacheMs;
    })().finally(() => { pending = undefined; });
    return pending;
  }
  async function verifyToken(token: string, requireLinkedAccounts: boolean): Promise<VerifiedIdentity> {
    const started = Date.now();
    let reason = 'claims', jwks: 'cache_hit' | 'fetched' | 'fetch_failed' = 'cache_hit';
    observe(observation, { op: 'identity_verify', phase: 'start' });
    try {
      if (typeof token !== 'string' || token.length > 32_768) throw invalid();
      const parts = token.split('.');
      if (parts.length !== 3) throw invalid();
      const [encodedHeader, encodedClaims, signature] = parts;
      const header = decode(encodedHeader), claims = decode(encodedClaims);
      reason = 'alg';
      if (header.alg !== 'ES256' || typeof header.kid !== 'string' || header.crit !== undefined
        || (header.typ !== undefined && header.typ !== 'JWT')) throw invalid();
      reason = claims.iss !== 'privy.io' ? 'iss' : claims.aud !== config.appId ? 'aud' : typeof claims.exp !== 'number' || claims.exp <= now() / 1000 ? 'exp' : 'claims';
      const seconds = now() / 1000;
      if (!Number.isFinite(seconds) || claims.iss !== 'privy.io' || claims.aud !== config.appId
        || typeof claims.sub !== 'string' || !claims.sub.startsWith('did:privy:')
        || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= seconds
        || typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat > seconds + 60 || claims.iat >= claims.exp
        || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > seconds))) throw invalid();
      observe(observation, { op: 'privy_identity', stage: 'jwks', cache_decision: validUntil <= now() ? 'expired' : 'hit', jwks_age_ms: Math.max(0, now() - (validUntil - cacheMs)), key_count: keys.length });
      if (validUntil <= now()) { jwks = 'fetch_failed'; await refresh(); jwks = 'fetched'; }
      reason = 'kid_unknown';
      const jwk = keys.find(k => k.kid === header.kid);
      // Unknown kid fails without repeatedly fetching attacker-selected identifiers.
      if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || jwk.d !== undefined
        || (jwk.alg !== undefined && jwk.alg !== 'ES256') || (jwk.use !== undefined && jwk.use !== 'sig')
        || (jwk.key_ops !== undefined && !jwk.key_ops.includes('verify'))) throw invalid();
      reason = 'sig';
      const sig = Buffer.from(signature, 'base64url');
      if (sig.length !== 64 || sig.toString('base64url') !== signature || !verify('sha256', Buffer.from(`${encodedHeader}.${encodedClaims}`),
        { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, sig)) throw invalid();
      reason = 'linked_accounts';
      if (!requireLinkedAccounts) {observe(observation,{op:'identity_verify',phase:'end',outcome:'ok',jwks,ms:Date.now()-started});return Object.freeze({ user: claims.sub, expiresAt: claims.exp * 1000, walletIds: [], walletAddresses: [] });}
      const linked: unknown = typeof claims.linked_accounts === 'string' ? JSON.parse(claims.linked_accounts) : claims.linked_accounts;
      if (!Array.isArray(linked)) throw invalid();
      const wallets = linked.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && x.type === 'wallet'
        && x.chain_type === 'solana' && x.wallet_client_type === 'privy' && typeof x.address === 'string');
      const evmWallets = linked.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object'
        && x.type === 'wallet' && x.chain_type === 'ethereum' && x.wallet_client_type === 'privy'
        && typeof x.id === 'string' && typeof x.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x.address));
      observe(observation, { op: 'identity_verify', phase: 'end', outcome: 'ok', jwks, ms: Date.now() - started });
      return Object.freeze({ user: claims.sub, expiresAt: claims.exp * 1000,
        evmWallets: Object.freeze(evmWallets.map(w => Object.freeze({ id: w.id as string, address: w.address as string }))),
        walletIds: Object.freeze(wallets.flatMap(w => typeof w.id === 'string' ? [w.id] : [])),
        walletAddresses: Object.freeze(wallets.map(w => w.address as string)) });
    } catch { observe(observation, { op: 'identity_verify', phase: 'end', outcome: 'refused', reason, jwks, ms: Date.now() - started, code: 'PRIVY_IDENTITY_INVALID' }); throw invalid(); }
  }
  return {
    verify: (token: string) => verifyToken(token, true),
    async jwtDiagnostics(token: string, user: string): Promise<JwtMetadata> {
      let valid = false;
      try { await verifyToken(token, false); valid = true; } catch { /* Closed metadata reports verification failure. */ }
      return jwtMetadata(token, config.appId, user, now(), valid);
    },
  };
}
/** Only the explicitly permitted JWT metadata leaves this helper. No token is retained. */
export function jwtMetadata(token: string, appId: string, user: string, now: number, localValid = false): JwtMetadata {
  let header: Record<string, unknown> = {}, claims: Record<string, unknown> = {};
  try {
    if (token.length <= 32_768) { const parts = token.split('.'); if (parts.length === 3) { header = decode(parts[0]); claims = decode(parts[1]); } }
  } catch { /* Invalid wire encoding has no diagnostic claims. */ }
  // Metadata strings are bounded identifiers, never arbitrary JWT-shaped text.
  const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,96}$/.test(value) && value.split('.').length < 3 ? value : null;
  const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const exp = numeric(claims.exp);
  return Object.freeze({ alg: identifier(header.alg), kid: identifier(header.kid),
    aud_matches_app: claims.aud === appId, iss: identifier(claims.iss), sub_matches_person: claims.sub === user,
    iat: numeric(claims.iat), exp, remaining_ttl_s: exp === null ? null : Math.floor(exp - now / 1000),
    local_valid: localValid, token_kind: claims.linked_accounts !== undefined ? 'identity' : claims.iss === 'privy.io' && typeof claims.sub === 'string' ? 'access' : 'unknown' });
}
