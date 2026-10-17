// stand-in for the monorepo module log-fields; identical signature
import { createHash } from 'node:crypto';
import { errorFields as fields, logEvent, type Level } from './log.js';
import { PrivyError } from 'wallet-privy/server';
/** Provider exceptions can contain credentials, URLs and entire response bodies.
 * Keep only a bounded diagnostic classification (plus a PrivyError's redacted detail);
 * never serialize the exception. */
export function errorFields(error: unknown): Record<string, unknown> {
  const e = fields(error);
  const code = typeof e.code === 'number' ? e.code : typeof e.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.code) ? e.code : 'Error';
  const message = typeof e.message === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(e.message) ? e.message : undefined;
  // PrivyError.detail is Privy's own error text, redacted and capped at construction.
  const detail = error instanceof PrivyError && typeof error.detail === 'string' && error.detail ? error.detail.slice(0, 200) : undefined;
  const requestIds = error instanceof PrivyError && error.requestIds && Object.keys(error.requestIds).length ? error.requestIds : undefined;
  return { code, class: message ?? code, ...(message ? { message } : {}), ...(typeof e.status === 'number' ? { status: e.status } : {}), ...(detail ? { detail } : {}), ...(requestIds ? { request_ids: requestIds } : {}) };
}
export const ref8 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 8);
export const reasonCode = (value: string) => /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'UNCLASSIFIED';
/** Namespaces are person/account composites; only their person prefix leaves the server. */
export const personPrefix = (value: string) => value.replace(/^live:/, '').slice(0, 8);
export function eventSink(sink?: (event: object) => void) {
  return (record: object) => {
    const { event, ...fields } = record as { event: string; [key: string]: unknown };
    const level: Level = /failed|wallet_low|signer_missing|chain_refused|revoked|unconfirmed|mismatch/.test(event) ? 'error' : 'info';
    const safe = { ...fields, ...(typeof fields.person === 'string' ? { person: personPrefix(fields.person) } : {}),
      ...(typeof fields.attempt === 'string' ? { attempt: fields.attempt.slice(0, 12) } : {}),
      ...(typeof fields.tx_hash === 'string' ? { tx_hash: fields.tx_hash.slice(0, 12) } : {}) };
    logEvent(level, event, safe);
    sink?.({ event, level, ...safe });
  };
}

export function logRecord(level: Level, record: object): void {
  const { event, ...rest } = record as { event: string; [key: string]: unknown };
  logEvent(level, event, rest);
}
