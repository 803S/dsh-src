import test from 'node:test';
import assert from 'node:assert/strict';
import { httpDecisionPolicy } from '../lib/src/decision/http-policy.js';
import { classifyHttpRequest } from '../lib/src/security.js';
const readRule={require:false,category:'放行',reason:'read'};
const genericPost={require:true,category:'未授权删改',reason:'POST unknown'};
const context={method:'OPTIONS',path:'/api/user',rule:readRule};
const low={fallback:false,action:'allow',risk:'low',effect:'read'};

test('actual DELETE and conflicting PUT/PATCH cannot inherit read-only authorization', () => {
 for (const method of ['DELETE', 'PUT', 'PATCH']) {
  const decision = httpDecisionPolicy(genericPost, low, 'on', {method, path:'/'});
  assert.equal(decision.require, true);
  assert.match(decision.reason, /可能/);
  assert.match(decision.reason, /恢复/);
  assert.match(decision.reason, /未发出/);
 }
 for (const effect of ['read','compute','write','auth','external']) {
  assert.equal(httpDecisionPolicy(readRule, {...low, effect}, 'on', {method:'DELETE',path:'/'}).require,true);
 }
 assert.equal(httpDecisionPolicy(readRule, low, 'on', {method:'GET',path:'/'}).require,false);
 assert.equal(httpDecisionPolicy(genericPost, {...low,effect:'compute'}, 'on', {method:'POST',path:'/'}).require,false);
});
test('Jev execution contract: low impact allows generic POST; errors/high/unknown/contradiction require human even for GET',()=>{
 assert.equal(httpDecisionPolicy(genericPost,low,'on',context).authority,'jev-low-risk');
 assert.match(httpDecisionPolicy(readRule,{...low,action:'pending'},'on',context).reason,/OPTIONS \/api\/user/);
 assert.match(httpDecisionPolicy(readRule,{...low,action:'pending'},'on',context).reason,/risk=low/);
 assert.match(httpDecisionPolicy(readRule,{...low,fallback:true,errorType:'timeout'},'on',context).reason,/Jev服务失败.*timeout/);
 for(const patch of [{risk:'high'},{risk:'unknown'},{action:'pending'},{effect:'unknown'},{effect:'destructive'},{fallback:true,errorType:'http-503'}]) {
  assert.equal(httpDecisionPolicy(readRule,{...low,...patch},'on').require,true);
  assert.equal(httpDecisionPolicy(genericPost,{...low,...patch},'on').require,true);
 }
 assert.equal(httpDecisionPolicy(readRule,undefined,'on').require,true);
 // 本地确定危害：显式 hardBoundary 才终审（旧版按 category 名猜，已删除）。
 assert.equal(httpDecisionPolicy({...genericPost,hardBoundary:true,category:'破坏性写入'},low,'on').require,true);
 assert.equal(httpDecisionPolicy({...genericPost,hardBoundary:true,category:'破坏性写入'},low,'on').authority,'hard-boundary');
 assert.match(httpDecisionPolicy({...genericPost,hardBoundary:true,reason:'path 含强删改语义词'},low,'on').reason,/判定服务无权覆盖/);
 // 本地明确只读：直接放行，不调用也不等待判定服务。
 assert.equal(httpDecisionPolicy({...readRule,verdict:'read-clear',reason:'读方法无语义词'},undefined,'on').require,false);
 assert.equal(httpDecisionPolicy({...readRule,verdict:'read-clear'},undefined,'on').authority,'hard-rules');
 assert.match(httpDecisionPolicy({...readRule,verdict:'read-clear'},undefined,'on').reason,/未调用判定服务/);
 for(const mode of ['off','shadow']) {assert.equal(httpDecisionPolicy(readRule,undefined,mode).require,false);assert.equal(httpDecisionPolicy(genericPost,low,mode).require,true);}
});
/* [local.138] 端到端：真实分类结果 → 判定服务未启用（legacy 分支）时的策略。
   过去带签名的存储桶写入落到 classifier 最后一条写方法分支（require:false），legacy 分支直接 {...rule} 返回，
   于是「没有 Jev 结论」的 PUT 被自动外发。 */
test('[local.138] 判定服务未启用时，写类无本地豁免的请求（含存储桶写入/覆盖）不再自动外发',()=>{
 const bucketPut=classifyHttpRequest({method:'PUT',path:'/assets/report.txt',headers:{authorization:'AWS4-HMAC-SHA256 Credential=x'},body:'marker'});
 const bucketGet=classifyHttpRequest({method:'GET',path:'/assets/report.txt',headers:{}});
 assert.equal(bucketPut.require,true,'分类层：写类无本地豁免');
 for(const mode of ['off','shadow']){
  const write=httpDecisionPolicy(bucketPut,undefined,mode,{method:'PUT',path:'/assets/report.txt'});
  assert.equal(write.require,true,`${mode}: 桶写入必须挂人工`);
  assert.equal(write.authority,'legacy-rules');
  assert.match(write.reason,/本地规则要求人工审批（判定服务未启用）/);
  const read=httpDecisionPolicy(bucketGet,undefined,mode,{method:'GET',path:'/assets/report.txt'});
  assert.equal(read.require,false,`${mode}: 只读仍本地放行`);
 }
 // 判定服务启用时行为不变：写类仍由 Jev 判定，低风险 allow 可自动外发；
 // 不给本地规则“写类一律挂起”的权力，避免把 Jev 已判定的低风险写入也压成人工。
 assert.equal(httpDecisionPolicy(bucketPut,{...low,effect:'write'},'on',{method:'PUT',path:'/assets/report.txt'}).authority,'jev-low-risk');
 assert.equal(httpDecisionPolicy(bucketPut,{...low,effect:'write'},'on',{method:'PUT',path:'/assets/report.txt'}).require,false);
});

/* [local.150 用户拍板 2026-10-19] 「无输入只读」（无正文/无查询串/无资源 id/无强删改词/无影响类语义词）
 * 不再挂人工卡：判定服务说不清（unknown/pending/服务失败，包括调用方没申报用途）不是用户的事 ——
 * 发出去、记账、把「未申报用途」记为调用方缺陷。判定服务仍然能否决（reject / high / write|external|destructive）。 */
test('[local.150] 无输入只读不挂人工卡；带输入、影响类语义词或判定服务否决仍挂人工',()=>{
 const rule={require:true,category:'只读疑义',reason:'GET /extra/create：读方法命中可疑语义词（create）'};
 const ctx={method:'GET',path:'/extra/create',url:'https://fixture.invalid/extra/create',rule,impactFree:{impactFree:true,reason:'GET /extra/create：读方法 + 无正文 + 无查询串 + 无资源 id —— 与浏览器加载表单页逐字节相同'}};
 for(const patch of [{risk:'unknown'},{action:'pending'},{effect:'unknown'},{fallback:true,errorType:'timeout'}]){
  const decision=httpDecisionPolicy(rule,{...low,...patch},'on',ctx);
  assert.equal(decision.require,false,JSON.stringify(patch));
  assert.equal(decision.authority,'read-suspicion-auto',JSON.stringify(patch));
  assert.match(decision.reason,/不改变本地事实/);
  assert.match(decision.reason,/未申报用途|调用方/);
 }
 // 注意 effect=write + risk=low + allow 在单笔车道本来就自动（旧规则，先于本分支）；
 // 这里锁的是「判定服务说这是真影响」的那种形态：拒绝/高风险/说不清但点名 write|external|destructive。
 for(const patch of [{action:'reject'},{risk:'high'},{action:'pending',effect:'write'},{action:'pending',effect:'external'},{action:'pending',effect:'destructive'}]){
  const decision=httpDecisionPolicy(rule,{...low,...patch},'on',ctx);
  assert.equal(decision.require,true,JSON.stringify(patch));
  assert.notEqual(decision.authority,'read-suspicion-auto',JSON.stringify(patch));
 }
 // 不是「无输入」只读（带查询串/正文/资源 id）→ 不豁免，仍然挂人工卡。
 for(const reason of ['带查询串（?id=1）','带请求正文','路径含资源 id']){
  assert.equal(httpDecisionPolicy(rule,{...low,effect:'unknown'},'on',{...ctx,impactFree:{impactFree:false,reason}}).require,true,reason);
 }
 // 本地硬边界先于本分支返回，判定服务与豁免都不能覆盖。
 const hard=httpDecisionPolicy({...rule,hardBoundary:true,category:'破坏性写入'},low,'on',ctx);
 assert.equal(hard.require,true);assert.equal(hard.authority,'hard-boundary');
});
