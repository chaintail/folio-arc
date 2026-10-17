import { logError } from '../shims/log.js';
const constraint=(reason:string)=>{logError('bridge_source_transition',{stage:'gas_constraint',reason});return new Error(reason);};
import type { SourceChain } from './source-registry.js';
import type { Hex } from 'viem';
export interface GasCharge { readonly attemptId: string; readonly txHash: Hex; readonly paid: bigint; readonly failed: boolean; }
export interface GasTopup { readonly attemptId: string; readonly txHash: Hex; readonly contribution: bigint; }
/** Arc principal, contribution and charges are all raw 18-decimal integers.
 * Base principal is token raw6; contribution/charges are native ETH raw18, never added to principal. */
export class GasLedger {
  readonly topups = new Map<string, GasTopup>();
  readonly charges = new Map<string, GasCharge>();
  readonly reservations = new Map<string, bigint>();
  customerPrincipal = 0n;
  readonly customerEvents = new Map<string, bigint>();
  constructor(readonly chain: SourceChain) {}
  get folioContribution() { return [...this.topups.values()].reduce((sum, t) => sum + t.contribution, 0n); }
  get gasCharged() { return [...this.charges.values()].reduce((sum, c) => sum + c.paid, 0n); }
  get folioResidual() { return this.folioContribution - this.gasCharged; }
  get availableResidual() { return this.folioResidual - [...this.reservations.values()].reduce((a, b) => a + b, 0n); }
  snapshot(): string {
    return JSON.stringify({ principal: this.customerPrincipal, customerEvents: [...this.customerEvents], topups: [...this.topups], charges: [...this.charges], reservations: [...this.reservations] },
      (_k, v) => typeof v === 'bigint' ? { integer: String(v) } : v);
  }
  restore(snapshot: string) {
    const data = JSON.parse(snapshot, (_k, v) => v && typeof v === 'object' && 'integer' in v ? BigInt(v.integer) : v);
    this.customerPrincipal = data.principal;
    this.customerEvents.clear(); this.topups.clear(); this.charges.clear(); this.reservations.clear();
    for (const [k, v] of data.customerEvents ?? []) this.customerEvents.set(k, v);
    for (const [k, v] of data.topups) this.topups.set(k, v);
    for (const [k, v] of data.charges) this.charges.set(k, v);
    for (const [k, v] of data.reservations) this.reservations.set(k, v);
  }
  observeCustomer(eventId: string, raw: bigint) {
    const existing = this.customerEvents.get(eventId);
    if (existing !== undefined) { if (existing !== raw) throw constraint('CUSTOMER_EVENT_CHANGED'); return; }
    this.receiveCustomer(raw); this.customerEvents.set(eventId, raw);
  }
  receiveCustomer(raw: bigint) { if (raw <= 0n) throw constraint('INVALID_PRINCIPAL'); this.customerPrincipal += raw; }
  confirmTopup(t: GasTopup) {
    if (t.contribution <= 0n) throw constraint('INVALID_TOPUP');
    const prior = this.topups.get(t.attemptId);
    if (prior && (prior.txHash !== t.txHash || prior.contribution !== t.contribution)) throw constraint('TOPUP_CHANGED');
    if ([...this.topups.values()].some(x => x.txHash === t.txHash && x.attemptId !== t.attemptId)) throw constraint('TOPUP_HASH_REUSED');
    this.topups.set(t.attemptId, Object.freeze({ ...t }));
  }
  topupRequired(maxGas: bigint) {
    if (maxGas <= 0n) throw constraint('INVALID_GAS_CAP');
    return this.availableResidual < maxGas ? maxGas - this.availableResidual : 0n;
  }
  beforeSigning(attemptId: string, maxGas: bigint) {
    if (this.charges.has(attemptId) || this.reservations.has(attemptId)) throw constraint('ATTEMPT_ALREADY_USED');
    if (this.topupRequired(maxGas) > 0n) throw constraint('FOLIO_TOPUP_REQUIRED');
    this.reservations.set(attemptId, maxGas);
  }
  reconcile(c: GasCharge) {
    const previous = this.charges.get(c.attemptId);
    if (previous) {
      if (previous.txHash !== c.txHash || previous.paid !== c.paid || previous.failed !== c.failed) throw constraint('CHARGE_CHANGED');
      return;
    }
    const cap = this.reservations.get(c.attemptId);
    if (cap === undefined || c.paid < 0n || c.paid > cap || c.paid > this.folioResidual) throw constraint('GAS_PRINCIPAL_VIOLATION');
    this.charges.set(c.attemptId, Object.freeze({ ...c })); this.reservations.delete(c.attemptId);
  }
  sweep(amount6: bigint) {
    const scale = this.chain === 'arc' ? 1_000_000_000_000n : 1n;
    if (amount6 <= 0n || amount6 * scale > this.customerPrincipal) throw constraint('PRINCIPAL_SHORT');
    this.customerPrincipal -= amount6 * scale;
  }
}
export function prepareTopup(wallet: Hex, folioGasWallet: Hex | undefined, amount: bigint) {
  if (!folioGasWallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet) || !/^0x[0-9a-fA-F]{40}$/.test(folioGasWallet)
    || amount <= 0n || wallet.toLowerCase() === folioGasWallet.toLowerCase()) throw constraint('GAS_WALLET_NOT_CONFIGURED');
  return { from: folioGasWallet, to: wallet, value: amount, data: '0x' as const };
}
