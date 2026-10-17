import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { authorizationSignature, type AuthorizationPayload } from '../src/authorization-signature.js';
import { canonical } from '../src/json.js';
import { createPrivyRest } from '../src/transport.js';
import { loadPrivyServerConfig } from '../src/config.js';

const vector = JSON.parse(readFileSync(new URL('./fixtures/authorization-vector.json', import.meta.url), 'utf8'));
const payload: AuthorizationPayload = { version: 1, method: 'POST', url: 'https://api.privy.io/v1/policies',
  headers: { 'privy-app-id': 'fixture-app' }, body: { rules: [], name: 'fixture-policy', version: '1.0', chain_type: 'solana' } };

test('fixture_id=delegated_signing_on invariant_id=EXEC-INV-010 authorization canonical JSON matches independent fixed P256 SHA256 DER vector', async () => {
  const bytes = Buffer.from(vector.canonical_json);
  assert.equal(canonical({ ...payload }), vector.canonical_json);
  assert.ok(verify('sha256', bytes, vector.public_key, Buffer.from(vector.signature_base64_der, 'base64')));
  const key = createPrivateKey(vector.private_key);
  const prefixed = `wallet-auth:${key.export({ format: 'der', type: 'pkcs8' }).toString('base64')}`;
  for (const encoding of [vector.private_key, prefixed]) {
    const signature = authorizationSignature(encoding, payload), der = Buffer.from(signature, 'base64');
    assert.equal(der.toString('base64'), signature);
    assert.equal(der[0], 0x30); // ASN.1 SEQUENCE, not 64-byte JWT/P1363.
    assert.ok(verify('sha256', bytes, { key: createPublicKey(vector.public_key), dsaEncoding: 'der' }, der));
    for (const changed of [
      { ...payload, method: 'PATCH' }, { ...payload, url: payload.url + '/policy' },
      { ...payload, body: {} }, { ...payload, headers: { 'privy-app-id': 'another-app' } },
      { ...payload, headers: { ...payload.headers, 'privy-request-expiry': '1' } },
    ]) assert.equal(verify('sha256', Buffer.from(canonical(changed)), vector.public_key, der), false);
  }
  const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.throws(() => authorizationSignature(wrongCurve, payload), /INVALID_PRIVY_AUTHORIZATION_KEY/);
  const config = loadPrivyServerConfig({ PRIVY_APP_ID: 'fixture-app', PRIVY_APP_SECRET: 'fixture-only',
    PRIVY_AUTHORIZATION_KEY: prefixed, PRIVY_KEY_QUORUM_ID: 'fixture-quorum', PRIVY_JWKS_URL: 'https://fixture.invalid/jwks' });
  const rest = createPrivyRest(config, { async request(request) {
    assert.equal(request.url, payload.url);
    assert.equal(request.body, canonical(payload.body));
    assert.equal(request.headers['privy-request-expiry'], undefined);
    assert.ok(verify('sha256', bytes, vector.public_key, Buffer.from(request.headers['privy-authorization-signature'], 'base64')));
    return { status: 200, body: { id: 'fixture-policy' } };
  } }, () => 0);
  await rest.request('POST', '/v1/policies', payload.body);
});
