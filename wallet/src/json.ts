import { PrivyError } from './config.js';
import type { Json } from './transport.js';

export function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, Json>)[k])}`).join(',')}}`;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new PrivyError('INVALID_JSON');
  return JSON.stringify(value);
}
