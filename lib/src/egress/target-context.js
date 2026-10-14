// Target-derived addresses are evidence, never authority. No DNS or URL rewriting here.
import {gateError,READ_METHODS,originGranted} from './plan.js';
import {withinDomain} from './user-scope.js';
import {isLocalServeOrigin} from './local-serve.js';
export function isLoopbackHost(host) {
 const value=host.toLowerCase().replace(/\.$/,'');
 return value==='localhost'||value.endsWith('.localhost')||value==='[::1]'||/^127\./.test(value)||/^\[::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(value);
}
/* 范围闸只管写/影响类请求。读取、枚举、探测不因范围被挡（否则一整个新主域的资产收集
 * 会被卡死，见 2026-10-13 审计：SRC_GATE_OUT_OF_SCOPE ×27、子会话空转 13 分钟）。
 * 不确定归属时不靠猜：写成「待归属确认」交用户，或用 src_request_asset_confirm 确认整域。
 * 用户明确排除（excludedDomains）的域对读和写都一律不碰。 */
export function assertKnownTarget(scope,value,{method,allowUnscopedLoopback=false}={}) {
 let url;try{url=new URL(value);}catch{throw gateError('INVALID_URL');}
 if(!['http:','https:'].includes(url.protocol))throw gateError('INVALID_URL');
 // 我们自己的 POC 托管 origin（src_serve_proof）：它不是外部目标，读写都不受范围约束。
 if(isLocalServeOrigin(url.origin))return;
 const origins=scope?.origins??[],domains=scope?.domains??[];
 // An explicit loopback fixture remains possible. Web-page localhost can never use a domain grant.
 if(isLoopbackHost(url.hostname)&&!origins.includes(url.origin)&&!(allowUnscopedLoopback&&!origins.length&&!domains.length))throw Object.assign(gateError('LOCAL_TARGET_NOT_AUTHORIZED'),{message:'SRC_GATE_LOCAL_TARGET_NOT_AUTHORIZED：未发送。页面中的 localhost/127.0.0.1 指向工具所在机器，不是用户给出的远程域名；不访问本机、不替换域名或端口。继续原授权目标，必要时报告页面配置问题。'});
 // 人类明确说「不属于/排除」的域：读与写都不碰，不接受模型再解释。
 if((scope?.excludedDomains??[]).some(d=>withinDomain(url.hostname,d)))throw Object.assign(gateError('OUT_OF_SCOPE'),{message:`SRC_GATE_OUT_OF_SCOPE：${url.hostname} 已被用户明确排除，未发送。不得重试、不得换通道；归属判断若变了，只能由用户自己改范围。`});
 if(!origins.length&&!domains.length)return; // 没有人类声明范围（readOrigins 只是自动记录的只读通道）→ 走既有范围确认/本地放行流程。
 if(READ_METHODS.has(String(method??'').toUpperCase()))return; // 只读放行：影响闸（Jev/人工审批）仍是唯一闸门。
 if(!originGranted(origins,url.origin)&&!domains.some(d=>withinDomain(url.hostname,d)))throw Object.assign(gateError('OUT_OF_SCOPE'),{message:`SRC_GATE_OUT_OF_SCOPE：写/影响类请求不在授权范围，未发送。请求 origin=${url.origin}；当前精确 origins=${origins.join(', ')||'无'}；当前授权域=${domains.join(', ')||'无'}（域内子域/任意端口自动放行；同一主机的 80/443/无端口写法视为同一授权）。读取、枚举、探测不受此限，请继续做不用发送到的收集；不确定归属就写「待归属确认：${url.hostname}（依据）」交父会话，或用 src_request_asset_confirm 请用户点一次确认（确认=整个注册域含全部子域授权），也可让用户直接在对话里写下该域名或 *.域名。不要换浏览器/curl 重试，不要反复试同域其他 host。`});
}
export function localAddressNotice(text) {
 return /(?:https?:\/\/)(?:localhost\b|127(?:\.\d+){3}|\[::1\])/i.test(String(text))
 ? '【地址上下文】正文中的 localhost/127.0.0.1 是页面配置或证据，不是新增测试目标；在浏览器执行时指向浏览器所在机器。不得据此访问本机、把它替换成目标域名的其他端口，或断言目标后端可达。只继续用户授权的 origin。' : '';
}
export function renderBrowserNetwork(records) {
 if(!records.length)return '';
 const denied=records.filter(r=>r.kind==='denied');
 if(!denied.length)return '';
 const grouped=new Map();for(const r of denied){const key=`${r.origin} ${r.code}`;grouped.set(key,(grouped.get(key)??0)+1);}
 return `【宿主网关记录：本次浏览器操作窗口】${denied.length} 次请求在本地被阻断，未发往所列目标；浏览器显示的合成403不能证明目标服务可达。\n${[...grouped].slice(0,12).map(([key,n])=>`${key} ×${n}`).join('\n')}\n这是操作期间的网络记录，可能含页面自动加载；不代表其他已获准请求均未发送。不要换通道绕行、重复导航或把页面地址当授权。`;
}
