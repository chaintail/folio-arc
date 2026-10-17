/** Keep only the provider's diagnostic string; never serialize its response or request. */
export function privyErrorDetail(body: unknown, secrets: readonly string[]): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = body as { error?: unknown; message?: unknown };
  let detail = typeof value.error === 'string' ? value.error : typeof value.message === 'string' ? value.message : undefined;
  if (!detail) return undefined;
  // Redact complete PEM blocks before individual credentials, including escaped newlines.
  detail = detail.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted]');
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    detail = detail.split(secret).join('[redacted]');
    detail = detail.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
  }
  return detail
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted]')
    .replace(/wallet-auth:[A-Za-z0-9+/=_-]+/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/[A-Za-z0-9+/_=-]{48,}/g, '[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').slice(0, 200);
}
