import { observe, requestEvent, hashRef, type PrivyObservation } from './observe.js';
import { createHash, randomUUID } from 'node:crypto';
import { authorizationSignature } from './authorization-signature.js';
import { canonical } from './json.js';
export { authorizationSignature } from './authorization-signature.js';
export { canonical } from './json.js';
import { PrivyError, type PrivyServerConfig } from './config.js';

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export interface HttpRequest { readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string }
export interface HttpResponse { readonly status: number; readonly body: unknown; /** Privy's response request ids (`privy-request-id`, `x-request-id`, `cf-ray`), when present. */ readonly requestIds?: Readonly<Record<string, string>> }
const REQUEST_ID_HEADERS = ['privy-request-id', 'x-request-id', 'cf-ray'] as const;
/** Only these three headers, each bounded and charset-limited, so no token can ride along. */
export function pickRequestIds(get: (name: string) => string | null | undefined): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const name of REQUEST_ID_HEADERS) { const v = get(name)?.trim(); if (v && /^[A-Za-z0-9._:-]{1,100}$/.test(v)) out[name] = v; }
  return Object.keys(out).length ? out : undefined;
}
/** Privy's owner-authority refusals: HTTP 401 with no `code`, told apart only by the message
 * (all four observed live, P0 2026-10-14). A signature from a key that is not a signer is the
 * first one, never a policy 400. */
export const AUTHORIZATION_REFUSALS = [
  'No valid authorization signatures were provided',
  'No valid authorization keys or user signing keys available',
  'Missing `privy-authorization-signature` header',
  'Not enough valid authorization signatures',
] as const;
/** All provider IO, including JWKS, is injected. Tests replay a checked-in transcript. */
export interface PrivyTransport { request(request: HttpRequest): Promise<HttpResponse> }
/** One authorization-signed request to the provider's REST API. Both factories
 * below go through this; neither exposes it. */
async function signedRequest(config: PrivyServerConfig, transport: PrivyTransport,
  method: HttpRequest['method'], path: string, body?: Json, options?: { idempotencyKey: string }, observation: PrivyObservation = {}): Promise<unknown> {
  const started = Date.now(), event = { call_id: randomUUID().slice(0,12), ...requestEvent(method, path, body && typeof body === 'object' && 'method' in body ? body.method : undefined, options?.idempotencyKey) };
  observe(observation, { ...event, phase: 'start' });
  const origin = 'https://api.privy.io';
  const url = origin + path;
  if (options && !/^[a-f0-9]{64}$/.test(options.idempotencyKey)) throw new PrivyError('INVALID_IDEMPOTENCY_KEY');
  // Every `privy-` header the request carries must also be signed, and the
  // idempotency header is named `privy-idempotency-key` on the wire.
  const signedHeaders = { 'privy-app-id': config.appId, ...(options ? { 'privy-idempotency-key': options.idempotencyKey } : {}) };
  // A signed DELETE must send and sign `{}` (P0 2026-10-14: no body, or a body left out of the
  // signature, is refused 401). Other methods send exactly what they sign.
  const sent = method === 'DELETE' ? body ?? {} : body;
  const payload = { version: 1 as const, method, url, body: sent ?? {}, headers: signedHeaders };
  let authSignature: string;
  try { authSignature = authorizationSignature(config.authorizationKey, payload); }
  catch (error) { observe(observation, { ...event, phase: 'end', stage: 'authorization', outcome: 'refused', code: 'PRIVY_AUTHORIZATION_SIGNING_FAILED' }); throw error; }
  const headers = { ...signedHeaders, 'content-type': 'application/json',
    authorization: `Basic ${Buffer.from(`${config.appId}:${config.appSecret}`).toString('base64')}`,
    'privy-authorization-signature': authSignature };
  let response: HttpResponse;
  try { response = await transport.request({ method, url, headers, ...(sent === undefined ? {} : { body: canonical(sent) }) }); }
  catch (error) { const code = error instanceof PrivyError && ['PRIVY_TRANSPORT_TIMEOUT','PRIVY_RESPONSE_DECODE_FAILED'].includes(error.code) ? error.code : 'PRIVY_TRANSPORT_UNAVAILABLE'; observe(observation, { ...event, phase: 'end', ms: Date.now() - started, code }); throw new PrivyError(code); }
  const done = (code?: string) => observe(observation, { ...event, phase: 'end', status: response.status, ms: Date.now() - started, ...(code ? { code } : {}) });
  const fail = (code: string): never => { done(code); throw new PrivyError(code); };
  if (response.status < 200 || response.status >= 300) {
    // Narrow protocol codes; a generic 400/401/403 is NOT policy/revocation proof.
    // Live-verified wire shapes: a policy refusal is HTTP 400 with
    // `code: 'policy_violation'`; an owner-authority refusal is HTTP 401
    // carrying no `code`, identified by its authorization-signature message.
    const body = response.body as { code?: unknown; error?: unknown } | null;
    const code = body?.code, error = typeof body?.error === 'string' ? body.error : '';
    if ((response.status === 400 || response.status === 403) && code === 'policy_violation') fail('PRIVY_POLICY_DENIED');
    if ((response.status === 401 || response.status === 403)
      && (code === 'invalid_authorization_signature' || AUTHORIZATION_REFUSALS.some(prefix => error.startsWith(prefix))))
      fail('PRIVY_AUTHORIZATION_DENIED');
    fail(`PRIVY_HTTP_${response.status}`);
  }
  done();
  return response.body;
}

/** REST request signing. No broadcast method exists on this server transport. */
export function createPrivyRest(config: PrivyServerConfig, transport: PrivyTransport, now: () => number, observation: PrivyObservation = {}) {
  return {
    async request(method: HttpRequest['method'], path: string, body?: Json, options?: { idempotencyKey: string }, perCallObservation?: PrivyObservation): Promise<unknown> {
      if (!/^\/v1\/(policies(?:\/[A-Za-z0-9_-]+)?|key_quorums(?:\/[A-Za-z0-9_-]+)?|wallets(?:\/[A-Za-z0-9_-]+(?:\/rpc)?)?)$/.test(path)) throw new PrivyError('INVALID_PRIVY_PATH');
      // DELETE names one resource: a policy or a key quorum the signing key owns.
      if (method === 'DELETE' && !/^\/v1\/(policies|key_quorums)\/[A-Za-z0-9_-]+$/.test(path)) throw new PrivyError('INVALID_PRIVY_PATH');
      if (path.endsWith('/rpc') && (!body || typeof body !== 'object' || Array.isArray(body)
        || !['signTransaction', 'signMessage', 'eth_signTransaction'].includes(String((body as Record<string, Json>).method)))) throw new PrivyError('SIGNATURE_ONLY_REQUIRED');
      return signedRequest(config, transport, method, path, body, options, perCallObservation?.observe ? perCallObservation : observation);
    },
  };
}

/**
 * Sponsored send (2026-09-22 22:16 ET). The only broadcast this package can
 * make, and a separate value from `createPrivyRest`, which stays signature-only:
 * the release builds this one only where the operator turned live broadcast on.
 *
 * One call: `signAndSendTransaction` on the wallet's RPC with `sponsor: true`,
 * so Privy's managed fee payer pays the network fee (Privy rewrites the fee
 * payer and the recent blockhash, signs with the wallet, and sends). The answer
 * is the signature Privy sent, which is the one the chain confirms. The
 * idempotency key is the SHA-256 of the transaction bytes, so a retried call
 * cannot send the same transaction twice.
 */
export function createPrivySponsoredSend(config: PrivyServerConfig, transport: PrivyTransport, observation: PrivyObservation = {}) {
  return {
    async send(input: {
      readonly wallet_id: string; readonly caip2: string; readonly transaction: Uint8Array;
      /** Defaults to SHA-256 of the bytes. A resend of a dropped transaction
       * passes a new key, so Privy sends it rather than answering from cache. */
      readonly idempotency_key?: string;
    }): Promise<{ readonly signature: string }> {
      if (!/^[A-Za-z0-9_-]+$/.test(input.wallet_id)) throw new PrivyError('INVALID_PRIVY_PATH');
      if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.caip2)) throw new PrivyError('INVALID_CAIP2');
      const transaction = Buffer.from(input.transaction).toString('base64');
      const idempotencyKey = input.idempotency_key ?? createHash('sha256').update(input.transaction).digest('hex');
      const answer = await signedRequest(config, transport, 'POST', `/v1/wallets/${input.wallet_id}/rpc`, {
        method: 'signAndSendTransaction', caip2: input.caip2, sponsor: true,
        params: { transaction, encoding: 'base64' },
      }, { idempotencyKey }, observation) as { data?: { hash?: unknown } } | null;
      // Privy's documented answer: `data.hash` is the transaction signature.
      const signature = answer?.data?.hash;
      if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) { observe(observation, { op: 'privy_send_unconfirmed', code: 'PRIVY_SEND_UNCONFIRMED', idem_ref: hashRef(idempotencyKey) }); throw new PrivyError('PRIVY_SEND_UNCONFIRMED'); }
      return { signature };
    },
  };
}
export type PrivySponsoredSend = ReturnType<typeof createPrivySponsoredSend>;
/** Director/host opt-in only. Construction and tests never invoke fetch. */
export function createFetchTransport(fetcher: typeof fetch, observation: PrivyObservation = {}): PrivyTransport {
  return { async request(request) {
    const started = Date.now(), call_id = randomUUID().slice(0,12);
    let stage = 'transport', status: number | undefined;
    observe(observation, { op: 'privy_fetch', call_id, phase: 'start', stage });
    try {
      const response = await fetcher(request.url, { method: request.method, headers: request.headers, body: request.body,
        redirect: 'error', signal: AbortSignal.timeout(15_000) });
      status = response.status; stage = 'decode';
      const requestIds = pickRequestIds(name => response.headers?.get(name));
      const body = await response.json();
      observe(observation, { op: 'privy_fetch', call_id, phase: 'end', stage, status, ms: Date.now()-started, outcome: 'ok' });
      return { status, body, ...(requestIds ? { requestIds } : {}) };
    } catch (error) { const code = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'PRIVY_TRANSPORT_TIMEOUT' : stage === 'decode' ? 'PRIVY_RESPONSE_DECODE_FAILED' : 'PRIVY_TRANSPORT_UNAVAILABLE'; observe(observation, { op:'privy_fetch', call_id, phase:'end', stage, status, code, ms:Date.now()-started }); throw new PrivyError(code); }
  } };
}
