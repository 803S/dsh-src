import test from 'node:test';
import assert from 'node:assert/strict';
import {assertKnownTarget,localAddressNotice,renderBrowserNetwork} from '../lib/src/egress/target-context.js';
import {validateToolIdentity} from '../lib/src/egress/host-integration.js';
import {surfaceClusters,scanHints} from '../lib/src/scan-analysis.js';
import {renderHttp,renderScan} from '../lib/src/evidence-output.js';
test('remote target never authorizes page-derived localhost aliases or a different port',()=>{
 const scope={origins:['https://fixture.test:3000'],domains:[]};
 for(const url of ['http://127.0.0.1:5001/','http://localhost:5001/','http://127.1:5001/','http://2130706433:5001/','http://[::1]:5001/','http://[::ffff:127.0.0.1]:5001/','http://a.localhost:5001/'])assert.throws(()=>assertKnownTarget(scope,url),{code:'SRC_GATE_LOCAL_TARGET_NOT_AUTHORIZED'});
 for(const url of ['https://fixture.test:5001/','http://fixture.test:3000/','https://another.test/'])assert.throws(()=>assertKnownTarget(scope,url),{code:'SRC_GATE_OUT_OF_SCOPE'});
 assert.doesNotThrow(()=>assertKnownTarget(scope,'https://fixture.test:3000/apps'));
 assert.throws(()=>assertKnownTarget(undefined,'http://localhost:5001/'),{code:'SRC_GATE_LOCAL_TARGET_NOT_AUTHORIZED'});
 assert.doesNotThrow(()=>assertKnownTarget({origins:['http://127.0.0.1:5001']},'http://127.0.0.1:5001/'));
});
test('local gate provenance uses trusted records, not target response text; mixed results stay qualified',()=>{
 assert.equal(renderBrowserNetwork([]),'');
 const text=renderBrowserNetwork([{kind:'denied',origin:'http://127.0.0.1:5001',code:'SRC_GATE_LOCAL_TARGET_NOT_AUTHORIZED'}]);
 assert.match(text,/本地被阻断/);assert.match(text,/不代表其他已获准请求均未发送/);
 assert.match(localAddressNotice('<body data-api-prefix="http://127.0.0.1:5001/api">'),/不是新增测试目标/);
 assert.match(renderHttp({}, {approval:'allowed-egress',status:200,responseBody:'http://localhost:5001',method:'GET',path:'/apps'})[0].text,/浏览器所在机器/);
});
test('404 template, failed paths and common SPA shell do not produce multi-backend discovery',()=>{
 const html='<title>Not found</title><script src="/_next/static/a.js"></script>';
 assert.deepEqual(scanHints(html,404),[]);assert.deepEqual(scanHints(html,200),['/_next/static/a.js']);
 const rows=['/admin','/api','/docs'].map(path=>({path,status:404,contentType:'text/html',bodySampleSha256:'same',hints:['/_next/static/a.js']}));
 assert.deepEqual(surfaceClusters([...rows,{path:'/timeout',error:'timeout'}]).prefixClusters,[]);
 assert.equal(surfaceClusters(rows.map(r=>({...r,status:200}))).multiBackendNote,undefined);
 const positive=surfaceClusters([{path:'/console',status:200,contentType:'text/html',bodySampleSha256:'a',hints:['/api/user'],cookieNames:['web_session']},{path:'/api/user',status:200,contentType:'application/json',bodySampleSha256:'b',cookieNames:['api_session']}]);
 assert.match(positive.multiBackendNote,/待核实/);assert.doesNotMatch(positive.multiBackendNote,/逐簇.*扫描/);
 const text=renderScan({}, {requested:3,responses:1,hints:0,results:[{path:'/a',status:200,length:null},{path:'/b',error:'timeout'}],scanInput:{supplied:3,invalid:0,duplicates:0,accepted:3,omittedPaths:[]}})[0].text;
 assert.match(text,/失败 1；未调度 1/);assert.match(text,/length=unknown/);assert.doesNotMatch(text,/未执行 0/);
});
test('empty tool identities are malformed rather than unadapted network tools',()=>{
 for(const exec of [{name:'',callId:''},{name:'src_http',callId:''},{name:undefined,callId:'id'}])assert.throws(()=>validateToolIdentity(exec),{code:'SRC_GATE_MALFORMED_TOOL_CALL'});
 assert.doesNotThrow(()=>validateToolIdentity({name:'src_http',callId:'id'}));
});
