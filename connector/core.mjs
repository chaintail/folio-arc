import {initializeIdentityStore,resolveIdentity,account} from './identity-store.mjs';
// The public connector uses its isolated local core.
import express from 'express';
import {introspectBearer,validatePrincipal} from './introspection.mjs';
import {randomUUID} from 'node:crypto';
import {secret,equal,read,write,users,researchSchema,TEST} from './common.mjs';
if(process.env.PRIVY_LOGIN==='1')initializeIdentityStore();
const user=id=>process.env.PRIVY_LOGIN==='1'?account(id):users[id];
const app=express();app.use(express.json({limit:'32kb'}));
app.get('/health',(_q,r)=>r.json({ok:true}));
app.use((q,r,next)=>{const token=q.headers.authorization?.replace(/^Bearer /,'');q.role=['mcp','as','operator'].find(role=>equal(token,secret(`core-${role}`)));if(!q.role)return r.sendStatus(401);next()});
// The Folio-server adapter is supplied separately in production.
app.post('/identity/resolve',(q,r)=>{if(q.role!=='as'||process.env.PRIVY_LOGIN!=='1')return r.sendStatus(403);const id=resolveIdentity(q.body);if(!id||read('policy.json')[id]?.suspended)return r.sendStatus(403);r.json({id})});
app.post('/policy',(q,r)=>{if(q.role!=='operator')return r.sendStatus(403);const {account,client,suspended,disconnect,reconnect}=q.body;if(!user(account))return r.sendStatus(400);const p=read('policy.json');const row=p[account]||{clients:{}};if(typeof suspended==='boolean')row.suspended=suspended;if(disconnect||reconnect){if(typeof client!=='string'||!client)return r.sendStatus(400);row.clients[client]=!!disconnect}p[account]=row;write('policy.json',p);r.json({ok:true})});
app.get('/policy',(q,r)=>{if(q.role!=='as')return r.sendStatus(403);r.json({...read('policy.json')[q.headers['x-folio-subject']],eligible:!!user(q.headers['x-folio-subject'])})});
app.use(async(q,r,next)=>{if(Object.keys(q.query).length)return r.sendStatus(400);if(q.role==='operator')return r.sendStatus(403);let subject,client;if(q.role==='mcp'){try{q.principal=validatePrincipal(await introspectBearer(q.headers['x-delegated-bearer'],'core-resource','core-introspection'));subject=q.principal.subject;client=q.principal.client}catch{return r.sendStatus(401)}}else subject=q.headers['x-folio-subject'];if(!user(subject))return r.sendStatus(400);q.subject=subject;const p=read('policy.json')[subject];if(p?.suspended||q.role==='mcp'&&p?.clients?.[client])return r.sendStatus(403);next()});
app.get('/eligibility',(q,r)=>q.role==='mcp'?r.json({ok:true}):r.sendStatus(403));
app.use((q,r,next)=>{if(q.role==='mcp'){const needed=q.path==='/profile'?'folio:profile:read':q.path==='/portfolio'?'folio:portfolio:read':q.path==='/research'&&q.method==='POST'?'folio:research:write':null;if(!needed||!q.principal.scopes.has(needed))return r.sendStatus(403)}next()});
app.get('/profile',(q,r)=>r.json({id:q.subject}));
app.get('/portfolio',(q,r)=>r.json(user(q.subject).portfolio));
app.get('/research',(q,r)=>r.json({research:Object.values(read('research.json')).filter(x=>x.owner_id===q.subject)}));
app.post('/research',(q,r)=>{if(q.role!=='mcp')return r.sendStatus(403);const parsed=researchSchema.safeParse(q.body);if(!parsed.success)return r.sendStatus(400);const payload=parsed.data;const db=read('research.json');const key=JSON.stringify([q.subject,payload.request_id]);const existing=db[key];if(existing){const {id,owner_id,created_at,...old}=existing;if(JSON.stringify(old)!==JSON.stringify(payload))return r.status(409).json({error:'Conflicting request_id reuse'});return r.json(existing)}const value={id:randomUUID(),owner_id:q.subject,created_at:new Date().toISOString(),...payload};db[key]=value;write('research.json',db);r.json(value)});
app.use((_e,_q,r,_n)=>r.status(400).json({error:'invalid request'}));
app.listen(38316,'0.0.0.0');
