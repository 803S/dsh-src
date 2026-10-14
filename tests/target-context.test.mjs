import test from 'node:test';
import assert from 'node:assert/strict';
import {assertKnownTarget,localAddressNotice,renderBrowserNetwork} from '../lib/src/egress/target-context.js';
import {originGranted} from '../lib/src/egress/plan.js';
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
test('范围闸只约束写/影响类：只读不受限，用户排除的域读写都拦',()=>{
 const scope={origins:['https://fixture.test:3000'],domains:[],readOrigins:['https://recorded.test']};
 // [2026-10-13 用户指令] 读取/枚举/探测不因范围被挡（否则新主域资产收集被卡死）。
 for(const url of ['https://another.test/','https://fixture.test:5001/','https://sub.fixture.test/','https://recorded.test/x'])assert.doesNotThrow(()=>assertKnownTarget(scope,url,{method:'GET'}));
 for(const method of ['HEAD','OPTIONS'])assert.doesNotThrow(()=>assertKnownTarget(scope,'https://another.test/',{method}));
 // 写类仍只看人类声明的范围（readOrigins 不授权写）。
 for(const method of ['POST','PUT','PATCH','DELETE'])assert.throws(()=>assertKnownTarget(scope,'https://another.test/write',{method}),{code:'SRC_GATE_OUT_OF_SCOPE'});
 assert.doesNotThrow(()=>assertKnownTarget(scope,'https://fixture.test:3000/write',{method:'POST'}));
 // 越界写类给的是活路：点名「待归属确认」/src_request_asset_confirm，而不是死路。
 try{assertKnownTarget(scope,'https://another.test/write',{method:'POST'});}catch(error){assert.match(error.message,/待归属确认：another\.test/);assert.match(error.message,/src_request_asset_confirm/);assert.match(error.message,/读取、枚举、探测不受此限/);}
 // 用户明确排除的域：读与写都不拦。
 const excluded={...scope,excludedDomains:['another.test']};
 assert.throws(()=>assertKnownTarget(excluded,'https://another.test/read',{method:'GET'}),{code:'SRC_GATE_OUT_OF_SCOPE'});
 assert.throws(()=>assertKnownTarget(excluded,'https://sub.another.test/write',{method:'POST'}),{code:'SRC_GATE_OUT_OF_SCOPE'});
 // 本机环回不受只读放行影响。
 assert.throws(()=>assertKnownTarget(scope,'http://127.0.0.1:5001/',{method:'GET'}),{code:'SRC_GATE_LOCAL_TARGET_NOT_AUTHORIZED'});
});
test('同主机默认 web 端口视为同一授权；非默认端口不放；本机 POC 托管 origin 读放行',async ()=>{
 /* [2026-10-14 现场] 同一主机的 80/443/无端口写法是同一个授权（范围闸语义是「主机归属」）：
  * 现场 agent 被夹 `请求 origin=https://eci-…com`（无端口） vs `当前精确 origins=https://eci-…com:80` 的 OUT_OF_SCOPE
  * 误拦，只能重打裸域名。 */
 const scope={origins:['https://eci.example.test:80'],domains:[]};
 assert.equal(originGranted(scope.origins,'https://eci.example.test'),true);
 assert.equal(originGranted(scope.origins,'https://eci.example.test:443'),true);
 assert.equal(originGranted(scope.origins,'https://eci.example.test:8080'),false);
 assert.doesNotThrow(()=>assertKnownTarget(scope,'https://eci.example.test/write',{method:'POST'}));
 assert.throws(()=>assertKnownTarget(scope,'https://eci.example.test:8443/write',{method:'POST'}),{code:'SRC_GATE_OUT_OF_SCOPE'});
 // 本机 POC 托管 origin（src_serve_proof 回连）：读放行、写也放行，且不进持久化 scope。
 const {registerLocalServe,localServePins,isLocalServeOrigin,unregisterLocalServe}=await import('../lib/src/egress/local-serve.js');
 const serve=registerLocalServe({origin:'http://192.0.2.7:55715',serveId:'serve-1',sessionId:'s',expiresAt:Date.now()+60000});
 assert.equal(isLocalServeOrigin('http://192.0.2.7:55715'),true);
 assert.equal(isLocalServeOrigin('http://192.0.2.7:55716'),false);
 assert.ok(localServePins('http://192.0.2.7:55715'));
 assert.doesNotThrow(()=>assertKnownTarget(scope,'http://192.0.2.7:55715/x',{method:'POST'}));
 assert.throws(()=>assertKnownTarget(scope,'http://192.0.2.7:55716/x',{method:'POST'}),{code:'SRC_GATE_OUT_OF_SCOPE'});
 assert.equal(serve.origin,'http://192.0.2.7:55715');
 // TTL 到点自动失效：过期的托管 origin 不再放行。
 registerLocalServe({origin:'http://192.0.2.7:55717',serveId:'serve-2',sessionId:'s',expiresAt:Date.now()-1});
 assert.equal(isLocalServeOrigin('http://192.0.2.7:55717'),false);
 unregisterLocalServe(serve.serveId);
 assert.equal(isLocalServeOrigin('http://192.0.2.7:55715'),false);
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
