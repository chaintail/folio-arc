// stand-in for the monorepo module policy/namespaceKey; identical signature
export type PersonNamespace = { readonly kind: 'live'; readonly person_id: string };
export type Namespace = { readonly kind: 'live'; readonly person_id?: string } | { readonly kind: 'simulation'; readonly branch_id: string; readonly seed_ref: string };
export function namespaceKey(ns: Namespace): string {
  if (ns.kind === 'live' && 'person_id' in ns) {
    if (typeof ns.person_id !== 'string' || !/^[a-f0-9]{64}$/.test(ns.person_id)) throw new Error('Invalid person namespace');
    return `live:${ns.person_id}`;
  }
  return ns.kind === 'live' ? 'live' : JSON.stringify(['simulation', ns.branch_id, ns.seed_ref]);
}
