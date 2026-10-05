import assert from 'node:assert/strict';
export function verifyWebFetchModel(report,origin){
 const {arrivals,events,completion}=report;
 assert.equal(report.exit,0);assert.equal(completion?.status,'completed');assert.equal(completion?.stopped,'');
 const expected=['/read','/index.html','/docs.html','/assets/model-packed.js','/curl-normal'].map(path=>({method:'GET',path}));
 const sort=rows=>[...rows].sort((a,b)=>a.path.localeCompare(b.path));
 // The native scheduler may run independent web_fetch calls concurrently.
 // Keep exact request multiplicity and redirect causality, not an artificial
 // total ordering between the two independent resources.
 assert.deepEqual(sort(arrivals),sort(expected));
 assert.ok(arrivals.findIndex(r=>r.path==='/index.html')<arrivals.findIndex(r=>r.path==='/docs.html'));
 assert.deepEqual(report.outsideArrivals,[]);
 const reads=events.filter(e=>e.type==='tool-result'&&e.name==='web_fetch');assert.equal(reads.length,2);
 const redirect=reads.find(e=>e.arguments.url===origin+'/index.html');
 assert.equal(redirect?.value?.url,origin+'/docs.html');assert.equal(redirect.value.statusCode,200);assert.equal(redirect.value.body.content,'synthetic');
 const gzip=reads.find(e=>e.arguments.url===origin+'/assets/model-packed.js');
 assert.equal(gzip?.value?.statusCode,200);assert.equal(gzip.value.truncated,true);assert.match(gzip.value.body.content,/^\/\* fixture-js-v1/);
 const authored=events.filter(e=>e.type==='assistant').flatMap(e=>e.content??[]).filter(c=>c.type==='tool-call');
 assert.equal(authored.filter(c=>c.name==='web_fetch').length,2);
 assert.ok(events.some(e=>e.type==='onboarding-user-scope'&&e.result?.result?.kind==='success'));
 assert.ok(events.some(e=>e.type==='tool-result'&&e.name==='src_http'&&e.arguments.method==='DELETE'&&e.value?.pendingApprovalId));
 return {passed:true,model:completion.model,arrivals,webFetchCalls:reads.length};
}
