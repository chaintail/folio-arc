// Seed before oidc-provider renders: its inline-script helper appends the exact
// generated SHA256 only when script-src is already present on the response.
export const PROVIDER_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://chatgpt.com";
export function providerCsp(_req, res, next) {
  if (!res.hasHeader('Content-Security-Policy')) {
    res.setHeader('Content-Security-Policy', PROVIDER_CSP);
  }
  next();
}
