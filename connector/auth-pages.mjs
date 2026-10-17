// Self-contained presentation for the development identity pages.
export function html(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
export function document(title,body,nonce){return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${nonce?`<meta property="csp-nonce" content="${html(nonce)}">`:""}<title>${html(title)} · Folio Connector</title><link rel="stylesheet" href="/demo/auth-pages.css"></head><body><main><section class="card" aria-labelledby="page-title"><p class="brand">Folio Connector</p><h1 id="page-title">${html(title)}</h1><p class="notice">${process.env.PRIVY_LOGIN==='1'?'Real Privy identity — isolated local portfolios and research. No transactions.':'Development local identity — fake Folio data. No real account or transactions.'}</p>${body}</section></main></body></html>`}
export function credentials(){return '<label for="username">Development username</label><input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false"><label for="password">Development passcode</label><input id="password" name="password" type="password" autocomplete="current-password">'}

export const expiredAuthorizationBody = '<p>This authorization page expired or its sign-in session changed. Return to ChatGPT and connect Folio again.</p>';
export function renewableConsentCopy(window, accessTTL) {
  const duration = (seconds) => seconds % 3600 === 0 ? `${seconds / 3600} hours` : seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;
  return `<label><input type="checkbox" name="renewable_consent" value="yes"> Allow ChatGPT to renew access for ${duration(window)} from first issuance.</label><p>Access already issued can last up to ${duration(accessTTL)} longer. Signing out of Folio does not disconnect ChatGPT. Ask the connector operator to revoke access.</p>`;
}
