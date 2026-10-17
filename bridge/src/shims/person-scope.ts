// stand-in for the monorepo module person-scope; identical signature
import { createHash } from 'node:crypto';
import type { PersonNamespace } from './namespace.js';
export interface PersonScope {
  readonly namespace: PersonNamespace;
  readonly wallet_address: string | null;
  readonly user: string;
  readonly evm_wallet?: { readonly id: string; readonly address: string };
}
export const personNamespaceOf = (user: string): PersonNamespace => ({ kind: 'live', person_id: createHash('sha256').update(user).digest('hex') });
