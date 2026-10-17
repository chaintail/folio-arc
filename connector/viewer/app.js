'use strict';
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (cls) node.className = cls; return node; };
let csrf = '';
async function api(path, options) { const r = await fetch(path, { credentials: 'same-origin', ...options }); if (r.status === 401) { location.assign('/demo/login'); throw new Error('Sign in required'); } if (!r.ok) throw new Error(`Request failed (${r.status})`); return r.json(); }
async function refresh() {
 const status = document.getElementById('status'); status.textContent = 'Loading…';
 try {
  const profile = await api('/demo/api/profile'); csrf = profile.csrf_token;
  document.getElementById('identity').textContent = `${profile.name} (${profile.id}) · ${profile.identity_mode === 'privy' ? 'Privy identity' : 'DEVELOPMENT local identity'}`;
  const [portfolio, records] = await Promise.all([api('/demo/api/portfolio'), api('/demo/api/research')]);
  const holdings = document.getElementById('portfolio'); holdings.replaceChildren();
  for (const item of portfolio.portfolio) holdings.append(el('li', `${item.symbol}: ${item.quantity}`));
  const cards = document.getElementById('research'); cards.replaceChildren();
  if (!records.research.length) cards.append(el('p', 'No research saved yet. Ask your linked MCP client to save a recommendation.'));
  for (const record of records.research) {
   const card = el('article', undefined, 'card'); card.append(el('h3', record.title), el('time', record.created_at), el('p', record.body, 'body'));
   for (const proposal of record.proposals || []) { const row = el('section', undefined, 'proposal'); row.append(el('h4', `${proposal.symbol} · ${proposal.action}${proposal.target_weight_pct === undefined ? '' : ` · ${proposal.target_weight_pct}%`}`), el('p', proposal.rationale)); card.append(row); }
   cards.append(card);
  }
  status.textContent = 'Updated. Recommendations are inert research only.';
 } catch (e) { status.textContent = e.message; }
}
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('logout').addEventListener('click', async () => { try { const result=await api('/demo/logout', {method:'POST',headers:{'X-CSRF-Token':csrf}}); location.assign(result.identity_logout ? '/demo/logout-identity' : '/demo/login'); } catch (e) { document.getElementById('status').textContent=e.message; } });
refresh();
