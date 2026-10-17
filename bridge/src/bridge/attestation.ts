import { errorFields } from '../shims/log-fields.js';
import { logEvent, logDebug } from '../shims/log.js';
import { validateMessage, hexBytes, messageDigest, type MessageExpectation } from './message.js';
/** Shared per process; deployments with multiple workers must share one instance/service. */
export class IrisLimiter {
  private next=0;
  constructor(private readonly now=Date.now,private readonly sleep=(ms:number) => new Promise<void>(r=>setTimeout(r,ms))) {}
  async acquire() { const time=this.now(), slot=Math.max(time,this.next); this.next=slot+1000; logDebug('circle_attestation',{stage:'limiter',delay_ms:Math.max(0,slot-time)}); await this.sleep(Math.max(0,slot-time)); }
  cooldown(ms:number) { this.next=Math.max(this.next,this.now()+ms); }
}
export const sharedIrisLimiter=new IrisLimiter(); // At most 60 requests/minute; transport budget also persists across restarts.
export type AttestationResult = {kind:'ready';message:string;attestation:string;nonce:string;messageHash:string} | {kind:'retry';reason:'pending'|'rate_limited'|'malformed'|'network'|'mismatch';delayMs:number};
const retry=(reason:Extract<AttestationResult,{kind:'retry'}>['reason'],failures:number):AttestationResult => ({kind:'retry',reason,delayMs:reason==='rate_limited'?300_000:Math.min(300_000,30_000*2**Math.min(9,Math.max(0,failures)))});
let attestationCalls=0;
export function createAttestationClient(options: {fetch?:typeof fetch;limiter?:IrisLimiter}={}) {
  const request=options.fetch ?? fetch, limiter=options.limiter ?? sharedIrisLimiter;
  return { async lookup(burnHash:string, expected:MessageExpectation, failures=0):Promise<AttestationResult> {
    if(!/^0x[\da-f]{64}$/i.test(burnHash)) throw new Error('invalid burn hash');
    if(![6,26].includes(expected.sourceDomain)) throw new Error('unsupported source domain');
    await limiter.acquire();
    const started = Date.now();
    let status: number | undefined;
    const call_id=String(++attestationCalls);
    logDebug('circle_iris', { call_id,source_domain:expected.sourceDomain,retry_index:failures,phase: 'start' });
    const delayed = (reason: Extract<AttestationResult,{kind:'retry'}>['reason']): AttestationResult => { const result = retry(reason, failures); logEvent(reason === 'pending' ? 'debug' : 'info', 'circle_iris', { call_id,source_domain:expected.sourceDomain,retry_index:failures,status, reason, ms: Date.now() - started, cooldown_ms: result.kind === 'retry' ? result.delayMs : 0 }); return result; };
    try {
      const response=await request(`https://iris-api.circle.com/v2/messages/${expected.sourceDomain}?transactionHash=${burnHash}`,{method:'GET',signal:AbortSignal.timeout(15_000)});
      status = response.status;
      if(response.status===429) { limiter.cooldown(300_000); return delayed('rate_limited'); }
      if(response.status===404) return delayed('pending');
      if(!response.ok) return delayed('network');
      let body:unknown; try {body=await response.json();} catch (e) {logDebug('circle_iris_decode_failed', errorFields(e));return delayed('malformed');}
      if(!body || typeof body!=='object' || !('messages' in body) || !Array.isArray(body.messages)) return delayed('malformed');
      const matches:{message:string;attestation:string;nonce:string}[]=[];
      let pending=false,malformed=false;
      for(const value of body.messages) {
        if(!value || typeof value!=='object') {malformed=true;continue;}
        const row=value as Record<string,unknown>;
        if(row.status==='pending' || row.attestation==='PENDING') {pending=true;continue;}
        if(row.status!=='complete' || typeof row.message!=='string' || typeof row.attestation!=='string') {malformed=true;continue;}
        try {
          const d=validateMessage(row.message,expected), attestation=hexBytes(row.attestation);
          if(attestation.length===0 || attestation.length%65!==0) {malformed=true;continue;}
          matches.push({message:row.message,attestation:row.attestation,nonce:d.nonce});
        } catch (e) { logDebug('circle_iris_message_rejected', {call_id,source_domain:expected.sourceDomain,reason:'wire_mismatch',...errorFields(e)}); /* Select by independently decoded wire fields, never provider decoded JSON. */ }
      }
      if(matches.length!==1) return delayed(matches.length>1?'malformed':pending?'pending':malformed?'malformed':'mismatch');
      logDebug('circle_iris', { call_id,source_domain:expected.sourceDomain,candidate_count:matches.length,status, reason: 'attested', ms: Date.now() - started });
      return {kind:'ready',...matches[0]!,messageHash:messageDigest(matches[0]!.message)};
    } catch (e) {logDebug('circle_iris_failed', errorFields(e));return delayed('network');}
  }};
}
