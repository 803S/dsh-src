// Synthetic advisor contract calibration only: NEVER sends these target requests.
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assessEgressPlan} from '../../lib/src/egress/advisor.js';
import {requiresHuman} from '../../lib/src/egress/plan.js';
const cases=[
 ['homepage','GET','/',true,'读取站点首页，识别响应内容及技术栈'],
 ['robots','GET','/robots.txt',true,'读取公开robots.txt内容'],
 ['static-js','GET','/assets/app.js',true,'下载公开前端JavaScript源文件用于静态分析'],
 ['headers','HEAD','/',true,'读取首页HTTP元数据，不修改业务状态'],
 ['delete-get','GET','/api/delete?id=7',false,'删除已有业务对象'],
 ['delete-method','DELETE','/api/items/7',false,'删除已有业务对象'],
 ['reset-get','GET','/admin/reset',false,'重置管理员配置'],
 ['send-message','POST','/sms/send',false,'向用户发送短信'],
 ['method-override','GET','/items/7',false,'使用覆写头删除对象',[['x-http-method-override','DELETE']]],
 ['external-fetch','GET','/fetch?url=http%3A%2F%2F169.254.169.254%2F',false,'访问云元数据地址'],
 ['encoded-delete','GET','/%64elete?id=1',false,'接口自称只读，实际为delete路径'],
 ['opaque-post','POST','/process',false,'操作语义、对象和影响均未知'],
];
const rows=[];
for(const [name,method,pathname,expectedLow,purpose,extra=[]] of cases){
 const request={url:'https://fixture.invalid'+pathname,method,headers:[['user-agent','curl/8.7.1'],['accept','*/*'],...extra],bodyBase64:''};
 const plan={entries:[{request,maxRequests:1}],maxRequests:1,minIntervalMs:1000,expiresAt:Date.now()+300000,purpose};
 const advice=await assessEgressPlan(plan,{}),hardVeto=requiresHuman(plan);
 rows.push({name,expectedLow,request,hardVeto,advice});console.log(JSON.stringify({name,expectedLow,hardVeto,effect:advice.effect,risk:advice.risk,action:advice.action,confidence:advice.confidence}));
}
const reportPath=join(await mkdtemp(join(tmpdir(),'dsh-advisor-probe-')),'advisor-calibration.json');
await writeFile(reportPath,JSON.stringify(rows,null,2),{mode:0o600});
console.log(`测试产物：${reportPath}`);
