// stand-in for the monorepo module protocol-kamino/rpc-multi-accounts; identical signature
/** KEEP: FOLIO_RPC_MAX_MULTI_ACCOUNTS enforces the provider plan limit.
 * Provider limits may be smaller than the public 100-account limit. */
export function rpcMultiAccountCap(value: string | number | undefined = process.env.FOLIO_RPC_MAX_MULTI_ACCOUNTS): number {
  const cap = value === undefined ? 100 : Number(value);
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 100) throw new Error('Invalid FOLIO_RPC_MAX_MULTI_ACCOUNTS (expected 1..100)');
  return cap;
}

export interface MultiAccountResult {
  readonly context: { readonly slot: number | bigint; readonly [key: string]: unknown };
  readonly value: readonly unknown[];
}
export class AccountChunkReadError extends Error {
  readonly code = 'CHAIN_READ_FAILED';
  constructor(reason: string) { super(`CHAIN_READ_FAILED: ${reason}`); }
}

function slotNumber(value: unknown): number {
  const slot = typeof value === 'bigint' ? Number(value) : value;
  if (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 0) throw new AccountChunkReadError('invalid chunk slot');
  return slot;
}

/** Each callback is a real, independently paced RPC read. minContextSlot is a
 * lower bound, not a historical-slot selector: keep checking exact equality.
 * Return the selected replies too, so raw hashes from superseded reads can be
 * retained as diagnostics without claiming they belong to the final snapshot. */
export async function readAccountChunks<T>(keys: readonly string[], options: Readonly<Record<string, unknown>>, cap: number,
  send: (keys: string[], options: Record<string, unknown>) => Promise<T>, resultOf: (reply: T) => MultiAccountResult,
): Promise<{ result: MultiAccountResult; replies: T[] }> {
  rpcMultiAccountCap(cap);
  if (!keys.length) throw new AccountChunkReadError('empty chunk plan');
  const chunks: { keys: string[]; reply: T; result: MultiAccountResult; slot: number }[] = [];
  const read = async (part: string[], minimum?: number) => {
    const config = { ...options, ...(minimum === undefined ? {} : { minContextSlot: minimum }) };
    const reply = await send(part, config), result = resultOf(reply);
    if (!Array.isArray(result?.value) || result.value.length !== part.length) throw new AccountChunkReadError('incomplete chunk');
    const slot = slotNumber(result.context?.slot);
    if (config.minContextSlot !== undefined && slot < slotNumber(config.minContextSlot)) throw new AccountChunkReadError('chunk below minContextSlot');
    return { keys: part, reply, result, slot };
  };
  for (let i = 0; i < keys.length; i += cap) chunks.push(await read(keys.slice(i, i + cap)));
  // At most three alignment passes; a moving node must never create an unbounded loop.
  for (let pass = 0; ; pass++) {
    const newest = Math.max(...chunks.map(chunk => chunk.slot));
    if (chunks.every(chunk => chunk.slot === newest)) break;
    if (pass === 3) throw new AccountChunkReadError('chunk slots did not converge');
    for (let i = 0; i < chunks.length; i++) if (chunks[i].slot < newest) chunks[i] = await read(chunks[i].keys, newest);
  }
  const context = { ...chunks[0].result.context };
  // Optional transaction-boundary evidence may only survive if all chunks agree.
  for (const key of ['blockTime', 'transactionIndex']) {
    const values = chunks.map(chunk => chunk.result.context[key]);
    if (values.some(value => value === undefined)) delete context[key];
    else if (values.some(value => String(value) !== String(values[0]))) throw new AccountChunkReadError('inconsistent chunk boundary');
  }
  return { result: { context, value: chunks.flatMap(chunk => [...chunk.result.value]) }, replies: chunks.map(chunk => chunk.reply) };
}
