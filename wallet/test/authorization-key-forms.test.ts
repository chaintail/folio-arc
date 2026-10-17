import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {authorizationPublicKey} from '../src/authorization-signature.js';
import {loadPrivyServerConfig} from '../src/config.js';

test('generated P-256 PEM, PKCS#8 DER, OpenSSL-style SEC1 DER and wallet-auth forms share a public key', () => {
  const key = generateKeyPairSync('ec', {namedCurve: 'prime256v1'}).privateKey;
  const pem = key.export({format: 'pem', type: 'pkcs8'}).toString();
  const pkcs8 = key.export({format: 'der', type: 'pkcs8'}).toString('base64');
  const sec1 = key.export({format: 'der', type: 'sec1'}).toString('base64');
  const expected = authorizationPublicKey(pem);
  for (const encoded of [pkcs8, `wallet-auth:${pkcs8}`, sec1, `wallet-auth:${sec1}`]) {
    assert.equal(authorizationPublicKey(encoded), expected);
    const config = loadPrivyServerConfig({PRIVY_APP_ID: 'fixture', PRIVY_APP_SECRET: 'fixture',
      PRIVY_JWKS_URL: 'https://fixture.invalid/jwks', PRIVY_AUTHORIZATION_KEY: `  ${encoded}  `,
      PRIVY_KEY_QUORUM_ID: 'fixture'});
    assert.equal(authorizationPublicKey(config.authorizationKey), expected);
  }
});
