import {DatabaseSync} from 'node:sqlite';
import {errors} from 'oidc-provider';
import path from 'node:path';
const db=new DatabaseSync(path.join(process.env.STATE_DIR||'/state','oauth.sqlite'),{timeout:2000,defensive:true,allowExtension:false});
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS models(model TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,expires_at INTEGER,consumed_at INTEGER,grant_id TEXT,uid TEXT,user_code TEXT,PRIMARY KEY(model,id)) STRICT;
CREATE INDEX IF NOT EXISTS models_grant ON models(grant_id);
CREATE INDEX IF NOT EXISTS models_uid ON models(model,uid);
CREATE INDEX IF NOT EXISTS models_code ON models(model,user_code);
CREATE TABLE IF NOT EXISTS revoked_grants(grant_id TEXT PRIMARY KEY,revoked_at INTEGER NOT NULL,reason TEXT NOT NULL) STRICT;`);
const row=db.prepare('SELECT * FROM models WHERE model=? AND id=?');
const tombstone=db.prepare('SELECT 1 FROM revoked_grants WHERE grant_id=?');
function invalidate(grantId,reason){if(!grantId)return;db.prepare('INSERT INTO revoked_grants VALUES(?,?,?) ON CONFLICT(grant_id) DO NOTHING').run(grantId,Date.now(),reason);db.prepare('DELETE FROM models WHERE grant_id=? OR (model=? AND id=?)').run(grantId,'Grant',grantId)}
function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value}catch(e){db.exec('ROLLBACK');throw e}}
function payload(r){if(!r||r.expires_at!==null&&r.expires_at<=Date.now()||r.grant_id&&tombstone.get(r.grant_id)||r.model==='Grant'&&tombstone.get(r.id))return undefined;const p=JSON.parse(r.payload);if(r.consumed_at)p.consumed=r.consumed_at;return p}
export class SQLiteAdapter {
 constructor(model){this.model=model}
 async upsert(id,p,expiresIn){transaction(()=>{if(p.grantId&&tombstone.get(p.grantId)||this.model==='Grant'&&tombstone.get(id))throw new errors.InvalidGrant('grant revoked');if(p.grantId&&!payload(row.get('Grant',p.grantId)))throw new errors.InvalidGrant('grant missing or expired');const previous=row.get(this.model,id);const consumed=previous?.consumed_at||p.consumed||null;const fixedExpiry=['AuthorizationCode','RefreshToken','AccessToken','DeviceCode','BackchannelAuthenticationRequest'].includes(this.model);if(fixedExpiry&&previous?.expires_at!==null&&previous?.expires_at!==undefined&&previous.expires_at<=Date.now())throw new errors.InvalidGrant('token expired');const expires=fixedExpiry&&previous?previous.expires_at:typeof expiresIn==='number'?Date.now()+expiresIn*1000:typeof p.exp==='number'?p.exp*1000:null;const body={...p,...(consumed?{consumed}: {})};db.prepare('INSERT INTO models VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(model,id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at,consumed_at=excluded.consumed_at,grant_id=excluded.grant_id,uid=excluded.uid,user_code=excluded.user_code').run(this.model,id,JSON.stringify(body),expires,consumed,p.grantId||null,p.uid||null,p.userCode||null)})}
 async find(id){return payload(row.get(this.model,id))}
 async findByUid(uid){return payload(db.prepare('SELECT * FROM models WHERE model=? AND uid=?').get(this.model,uid))}
 async findByUserCode(code){return payload(db.prepare('SELECT * FROM models WHERE model=? AND user_code=?').get(this.model,code))}
 async consume(id){let rejected=false;transaction(()=>{const r=row.get(this.model,id);if(!r||r.expires_at!==null&&r.expires_at<=Date.now()||r.grant_id&&tombstone.get(r.grant_id)){rejected=true;return}if(r.consumed_at){invalidate(r.grant_id,'duplicate-consume');rejected=true;return}const changed=db.prepare('UPDATE models SET consumed_at=? WHERE model=? AND id=? AND consumed_at IS NULL').run(Math.floor(Date.now()/1000),this.model,id);if(changed.changes!==1){invalidate(r.grant_id,'consume-conflict');rejected=true}});if(rejected)throw new errors.InvalidGrant('token already consumed, expired, missing or revoked')}
 async destroy(id){transaction(()=>{if(this.model==='Grant')invalidate(id,'grant-destroy');else db.prepare('DELETE FROM models WHERE model=? AND id=?').run(this.model,id)})}
 async revokeByGrantId(id){transaction(()=>invalidate(id,'provider-revoke'))}
 static grantsFor(account,client){return db.prepare("SELECT id,payload FROM models WHERE model='Grant'").all().filter(r=>{const p=JSON.parse(r.payload);return p.accountId===account&&p.clientId===client}).map(r=>r.id)}
 static version(){return db.prepare('SELECT sqlite_version() version').get().version}
}
