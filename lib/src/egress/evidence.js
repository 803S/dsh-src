import { createHash } from 'node:crypto';
import { clip, requestSecrets, sanitizeEvidence, safeHeaders, safeRequestBody } from '../evidence-output.js';
import { saveResponseSnapshot } from '../write-safety.js';
import { gateError } from './plan.js';

export function proxyResponse(input) {
  if(!input||Object.keys(input).some(key=>!['status','headers','bodyBase64'].includes(key)))throw gateError('INVALID_PROXY_RESPONSE');
  if(!Number.isInteger(input.status)||input.status<200||input.status>599||!Array.isArray(input.headers)||input.headers.length>128)throw gateError('INVALID_PROXY_RESPONSE');
  if(typeof input.bodyBase64!=='string'||input.bodyBase64.length>87384)throw gateError('RESPONSE_LIMIT');
  const bytes=Buffer.from(input.bodyBase64,'base64');
  if(bytes.length>65536||bytes.toString('base64')!==input.bodyBase64)throw gateError('INVALID_PROXY_RESPONSE');
  const headers=new Headers();let size=0;
  for(const pair of input.headers){if(!Array.isArray(pair)||pair.length!==2||pair.some(value=>typeof value!=='string'))throw gateError('INVALID_PROXY_RESPONSE');size+=pair[0].length+pair[1].length;if(size>32768)throw gateError('RESPONSE_LIMIT');headers.append(...pair);}
  return new Response([204,205,304].includes(input.status)?null:bytes,{status:input.status,headers});
}
export function createEgressEvidenceRecorder({home,store,append}) {
  return async(session,{request,response,grant})=>{
    const bytes=Buffer.from(await response.clone().arrayBuffer());
    const requestHeaders=Object.fromEntries(request.headers);
    const secrets=requestSecrets(requestHeaders);
    const encoded=response.headers.get('content-encoding');
    const textual=!encoded&&/text|json|xml|javascript/i.test(response.headers.get('content-type')??'');
    const raw=textual?bytes.toString('utf8'):'';
    let snapshotRef;
    if(request.method==='GET'&&response.status>=200&&response.status<300&&textual){
      snapshotRef=await saveResponseSnapshot(home,session,request.url,raw,response.headers.get('content-type')??'');
    }
    const row=await store.upsertObservation(session,{
      method:request.method,path:sanitizeEvidence(request.url,secrets),httpStatus:response.status,
      reqHeaders:safeHeaders(requestHeaders,secrets),reqBodySnippet:safeRequestBody(Buffer.from(request.bodyBase64,'base64').toString('utf8'),secrets),
      respHeaders:safeHeaders(response.headers,secrets),respBodySnippet:textual?clip(sanitizeEvidence(raw,secrets),32000):`encoded/binary bytes=${bytes.length}, sha256=${createHash('sha256').update(bytes).digest('hex')}`,
      source:'raw',decision:`目标出口真实响应；task=${grant.taskId}; dispatch=${grant.dispatchId}`,...(snapshotRef?{snapshotRef}:{}),
    });
    await append?.(session,row);
    return {evidenceId:row.id,...(snapshotRef?{snapshotRef,snapshotSha256:createHash('sha256').update(raw).digest('hex')}:{})};
  };
}
