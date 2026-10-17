import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { PrivyError } from './config.js';
import { canonical } from './json.js';
import type { Json } from './transport.js';

export interface AuthorizationPayload {
  readonly version: 1;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly body: Json;
  /** Every `privy-`-prefixed header on the request, and nothing else. */
  readonly headers: { readonly 'privy-app-id': string; readonly 'privy-idempotency-key'?: string };
}

export function authorizationPrivateKey(key: string): KeyObject {
  try {
    const value = key.trim();
    // OpenSSL `pkey -outform DER` emits SEC1 for EC keys, even when its PEM input is PKCS#8.
    const encoded = value.startsWith('wallet-auth:') ? value.slice('wallet-auth:'.length) : value;
    const privateKey = encoded.includes('-----BEGIN') ? createPrivateKey(encoded) : (() => {
      const der = Buffer.from(encoded, 'base64');
      try { return createPrivateKey({key: der, format: 'der', type: 'pkcs8'}); }
      catch { return createPrivateKey({key: der, format: 'der', type: 'sec1'}); }
    })();
    if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
    return privateKey;
  } catch { throw new PrivyError('INVALID_PRIVY_AUTHORIZATION_KEY'); }
}

export function authorizationPublicKey(key: string): string {
  return createPublicKey(authorizationPrivateKey(key)).export({ format: 'der', type: 'spki' }).toString('base64');
}

/** A P-256 public key given as base64 DER SPKI (Privy's `public_keys` form) or PEM, normalized to
 * base64 DER SPKI, the form `authorizationPublicKey` returns and Privy reads back. */
export function authorizationPublicKeySpki(key: string): string {
  try {
    const value = key.trim();
    const publicKey = value.includes('-----BEGIN') ? createPublicKey(value)
      : createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
    return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  } catch { throw new PrivyError('INVALID_PRIVY_PUBLIC_KEY'); }
}

/** Director's verified wire contract: canonical JSON, ECDSA P-256/SHA-256,
 * ASN.1 DER signature, standard base64 (not JWT's P1363/base64url). */
export function authorizationSignature(key: string, payload: AuthorizationPayload): string {
  const bytes = canonical({ version: 1, method: payload.method, url: payload.url, body: payload.body,
    headers: { 'privy-app-id': payload.headers['privy-app-id'],
      ...(payload.headers['privy-idempotency-key'] === undefined ? {} : { 'privy-idempotency-key': payload.headers['privy-idempotency-key'] }) } });
  return sign('sha256', Buffer.from(bytes, 'utf8'), {
    key: authorizationPrivateKey(key), dsaEncoding: 'der',
  }).toString('base64');
}
