import {z} from 'zod';
export const REPORT_INPUT_MAX_BYTES=24*1024;
const sourceId=z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{
 const parsed=new Date(value+'T00:00:00.000Z');
 return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
});
const source=z.object({
 id:sourceId,title:z.string().min(1).max(200),url:z.string().min(1).max(2048).refine(value=>{
  try{const url=new URL(value);return value.startsWith('https://')&&url.protocol==='https:'&&!!url.hostname&&!url.username&&!url.password}catch{return false}
 }),publisher:z.string().min(1).max(100),published_at:date.optional(),accessed_at:date,
}).strict();
const paragraph=z.string().min(1).max(1200);
const company=z.object({
 symbol:z.string().min(1).max(16).regex(/^[A-Z0-9][A-Z0-9.-]{0,15}$/),allocation_bps:z.number().int().min(0).max(10000),
 thesis:paragraph,catalyst:paragraph,risk:paragraph,invalidation:paragraph,citation_ids:z.array(sourceId).max(16),
}).strict();
export const reportSchema=z.object({
 schema_version:z.literal(1),thesis:z.string().min(1).max(400),summary:z.string().max(2000),horizon:z.string().max(100),
 companies:z.array(company).min(1).max(10),sources:z.array(source).max(16),
}).strict().superRefine((report,ctx)=>{
 const ids=new Set(report.sources.map(source=>source.id));
 const invalid=ids.size!==report.sources.length||new Set(report.companies.map(company=>company.symbol)).size!==report.companies.length
  ||report.companies.reduce((sum,company)=>sum+company.allocation_bps,0)!==10000
  ||report.companies.some(company=>new Set(company.citation_ids).size!==company.citation_ids.length||company.citation_ids.some(id=>!ids.has(id)));
 if(invalid)ctx.addIssue({code:'custom',message:'Invalid report references or allocations'});
});
export function boundedReportInput(input){return input.report===undefined||Buffer.byteLength(JSON.stringify(input),'utf8')<=REPORT_INPUT_MAX_BYTES}
