// stand-in for the monorepo module log; identical signature
import { AsyncLocalStorage } from "node:async_hooks";
export type Level = "error" | "info" | "debug";
const order: Record<Level, number> = { error: 0, info: 1, debug: 2 };
const configured = ((process.env.FOLIO_LOG_LEVEL ?? "debug").toLowerCase() as Level);
const threshold = order[configured] ?? order.debug;
export const requestContext = new AsyncLocalStorage<{ request_id: string; person?: string; attempt_id?: string }>();
const SENSITIVE_SUFFIXES = ["token", "secret", "jwt", "authorization", "password", "seed", "mnemonic", "private_key", "api_key", "secret_key", "access_token", "refresh_token", "id_token", "signing_key"];
const SENSITIVE_SUBSTRINGS = ["secret", "password", "mnemonic", "jwt", "authorization", "access_token", "refresh_token", "private_key"];
export function isSensitiveFieldName(name: string): boolean {
  const n = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[-.]/g, "_");
  return SENSITIVE_SUBSTRINGS.some((s) => n.includes(s)) || SENSITIVE_SUFFIXES.some((s) => n === s || n.endsWith("_" + s));
}
function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = isSensitiveFieldName(k) ? "[redacted]" : typeof v === "string" && v.length > 2000 ? v.slice(0, 2000) + "…" : v;
  return out;
}
export function logEvent(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (order[level] > threshold) return;
  const ctx = requestContext.getStore();
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...(ctx ? { request_id: ctx.request_id, ...(ctx.person ? { person: ctx.person } : {}), ...(ctx.attempt_id ? { attempt_id: ctx.attempt_id } : {}) } : {}), ...redact(fields) }));
}
export const logError = (event: string, fields?: Record<string, unknown>) => logEvent("error", event, fields);
export const logInfo = (event: string, fields?: Record<string, unknown>) => logEvent("info", event, fields);
export const logDebug = (event: string, fields?: Record<string, unknown>) => logEvent("debug", event, fields);
export function errorFields(e: unknown): Record<string, unknown> {
  const err = e as { code?: unknown; name?: string; message?: string; status?: unknown; detail?: unknown };
  return { code: err?.code ?? err?.name ?? "Error", message: typeof err?.message === "string" ? err.message.slice(0, 300) : undefined, ...(err?.status !== undefined ? { status: err.status } : {}), ...(err?.detail !== undefined ? { detail: String(err.detail).slice(0, 300) } : {}) };
}
