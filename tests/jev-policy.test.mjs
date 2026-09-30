import test from 'node:test';
import assert from 'node:assert/strict';
import { httpDecisionPolicy } from '../lib/src/decision/http-policy.js';
const readRule={require:false,category:'放行',reason:'read'};
const genericPost={require:true,category:'未授权删改',reason:'POST unknown'};
const low={fallback:false,action:'allow',risk:'low',effect:'read'};
test('Jev execution contract: low impact allows generic POST; errors/high/unknown/contradiction require human even for GET',()=>{
 assert.equal(httpDecisionPolicy(genericPost,low,'on').authority,'jev-low-risk');
 for(const patch of [{risk:'high'},{risk:'unknown'},{action:'pending'},{effect:'unknown'},{effect:'destructive'},{fallback:true,errorType:'http-503'}]) {
  assert.equal(httpDecisionPolicy(readRule,{...low,...patch},'on').require,true);
  assert.equal(httpDecisionPolicy(genericPost,{...low,...patch},'on').require,true);
 }
 assert.equal(httpDecisionPolicy(readRule,undefined,'on').require,true);
 assert.equal(httpDecisionPolicy({...genericPost,category:'破坏性写入'},low,'on').require,true);
 assert.equal(httpDecisionPolicy({...genericPost,category:'越权删改'},low,'on').require,true);
 for(const mode of ['off','shadow']) {assert.equal(httpDecisionPolicy(readRule,undefined,mode).require,false);assert.equal(httpDecisionPolicy(genericPost,low,mode).require,true);}
});
