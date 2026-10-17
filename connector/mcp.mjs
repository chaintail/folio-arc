import {introspectBearer,validatePrincipal} from './introspection.mjs';
import express from 'express';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {z} from 'zod';
import {AS,AS_INTERNAL,RESOURCE,CORE,scopes,secret,researchSchema,users,PUBLIC} from './common.mjs';
const app=express();if(PUBLIC)app.use((q,r,next)=>{if(q.headers.host!==new URL(RESOURCE).host)return r.sendStatus(421);next()});app.use(express.json({limit:'32kb'}));
app.get('/.well-known/oauth-protected-resource/mcp',(_req,res)=>res.json({resource:RESOURCE,authorization_servers:[AS],scopes_supported:scopes,bearer_methods_supported:['header']}));
const challenge=res=>res.set('WWW-Authenticate',`Bearer resource_metadata="${new URL(RESOURCE).origin}/.well-known/oauth-protected-resource/mcp"`);
app.post('/mcp',async(req,res)=>{
 const bearer=req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
 const deny=()=>{challenge(res);return res.status(401).json({error:'invalid_token'})};if(!bearer)return deny();
 let token;try{token=await introspectBearer(bearer,'mcp-resource','introspection');validatePrincipal(token)}catch{return deny()}
 async function callCore(route,body){const r=await fetch(CORE+route,{method:body?'POST':'GET',headers:{authorization:`Bearer ${secret('core-mcp')}`,'x-delegated-bearer':bearer,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error(r.status===409?'Conflicting request_id reuse':'Core request denied');return r.json()}
 try{await callCore('/eligibility')}catch{return deny()}
 const server=new McpServer({name:'folio',version:'0.2.1'});
 const wrap=(scope,fn)=>async(args)=>{if(!token.scope?.split(' ').includes(scope))return {isError:true,content:[{type:'text',text:'Insufficient scope'}],_meta:{'mcp/www_authenticate':[`Bearer error="insufficient_scope", scope="${scope}"`]}};try{return {content:[{type:'text',text:JSON.stringify(await fn(args))}]}}catch(e){return {isError:true,content:[{type:'text',text:e.message}]}}};
 const meta=scope=>({securitySchemes:[{type:'oauth2',scopes:[scope]}]});
 server.registerTool('get_profile',{title:'Get Folio profile',description:'Read the connected person\'s Folio account identity. Call this once at the start of a conversation.',inputSchema:z.object({}).strict(),annotations:{readOnlyHint:true,destructiveHint:false},_meta:meta(scopes[0])},wrap(scopes[0],()=>callCore('/profile')));
 server.registerTool('get_portfolio',{title:'Read Folio portfolio',description:'Read the person\'s current Folio portfolio: total value, cash, holdings with quantities and prices, and recent orders. Call this before giving any advice about their money.',inputSchema:z.object({}).strict(),annotations:{readOnlyHint:true,destructiveHint:false},_meta:meta(scopes[1])},wrap(scopes[1],()=>callCore('/portfolio')));
 server.registerTool('save_research',{title:'Save research to Folio',description:'Send a research report with proposed target weights (summing to 100%) to the person\'s Folio app, where they review it and decide whether to buy with one tap. Nothing is traded by this call.',inputSchema:researchSchema,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true},_meta:meta(scopes[2])},wrap(scopes[2],args=>callCore('/research',args)));
 const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});res.on('close',()=>{transport.close();server.close()});await server.connect(transport);await transport.handleRequest(req,res,req.body);
});
app.all('/mcp',(_q,r)=>r.sendStatus(405));app.use((_e,_q,r,_n)=>r.sendStatus(400));
app.listen(38313,'0.0.0.0');
