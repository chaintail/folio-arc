import { errorFields } from '../shims/log-fields.js';
import { logDebug, logInfo, logError } from '../shims/log.js';
import type { DatabaseSync } from 'node:sqlite';
export class BridgeBudgetExceeded extends Error {
  constructor(readonly retryAt: number) { super('BRIDGE_READ_BUDGET'); }
}
/** Sliding windows are shared by every adapter and survive worker/server restart.
 * Reserve before transport, counting failed calls and each constituent of a batch. */
export function bridgeReadBudget(db: DatabaseSync, now=Date.now) {
  db.exec('CREATE TABLE IF NOT EXISTS bridge_rpc_read(id INTEGER PRIMARY KEY,lane TEXT NOT NULL,at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS bridge_rpc_window ON bridge_rpc_read(lane,at);');
  db.exec('CREATE TABLE IF NOT EXISTS bridge_rpc_method_clock(lane TEXT NOT NULL,method TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(lane,method))');
  return (lane: 'base'|'arc'|'solana'|'iris', request: typeof fetch): typeof fetch => async (url, init) => {
    const at=now();
    const exceeded = (retryAt: number) => { logDebug('bridge_budget_wait', { lane, operation:'defer',requested:count,limit:lane==='solana'?120:60,retry_at:retryAt,reason:'budget_or_cooldown' }); return new BridgeBudgetExceeded(retryAt); };
    let count=1,methods:string[]=[];
    if(lane!=='iris' && typeof init?.body==='string') { const body=JSON.parse(init.body); count=Array.isArray(body)?body.length:1;methods=(Array.isArray(body)?body:[body]).map(x=>x.method); }
    const cooldown=db.prepare("SELECT at FROM bridge_rpc_method_clock WHERE lane=? AND method='cooldown'").get(lane);
    if(cooldown && at<Number(cooldown.at))throw exceeded(Number(cooldown.at));
    db.exec('SAVEPOINT bridge_budget');
    try {
      if(lane==='solana' && methods.includes('getSignatureStatuses')) {
        const last=db.prepare("SELECT at FROM bridge_rpc_method_clock WHERE lane='solana' AND method='getSignatureStatuses'").get();
        if(last && at<Number(last.at)+5000)throw exceeded(Number(last.at)+5000);
        db.prepare("INSERT OR REPLACE INTO bridge_rpc_method_clock VALUES ('solana','getSignatureStatuses',?)").run(at);
      }
      db.prepare('DELETE FROM bridge_rpc_read WHERE at<=?').run(at-60_000);
      const rows=db.prepare('SELECT at FROM bridge_rpc_read WHERE lane=? ORDER BY at').all(lane);
      if(rows.length+count>(lane==='solana'?120:60))throw exceeded(Number(rows[0]?.at??at)+60_000);
      for(let i=0;i<count;i++)db.prepare('INSERT INTO bridge_rpc_read(lane,at) VALUES (?,?)').run(lane,at);
      db.exec('RELEASE bridge_budget'); logDebug('bridge_read_budget',{lane,operation:'allow',used:rows.length,requested:count,limit:lane==='solana'?120:60});
    } catch(error) { logError('bridge_read_budget', { lane, operation:'rollback', requested:count, ...errorFields(error) });  db.exec('ROLLBACK TO bridge_budget; RELEASE bridge_budget'); throw error; }
    const response=await request(url,init);
    if(response.status===429) {
      logInfo('bridge_read_budget',{lane,operation:'cooldown',status:429,requested:count});
      const hint=response.headers.get('retry-after'),seconds=hint?Number(hint):NaN;
      const deadline=hint && !Number.isFinite(seconds)?Date.parse(hint):at+(Number.isFinite(seconds)?seconds*1000:30_000);
      db.prepare("INSERT OR REPLACE INTO bridge_rpc_method_clock VALUES (?,'cooldown',?)").run(lane,Math.max(at+30_000,Number.isFinite(deadline)?deadline:at+30_000));
    }
    return response;
  };
}
