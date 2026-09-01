// dsh-src playbook routing derived from the local clown-src expert knowledge base.
// This module only returns bounded pointers and checks; it never reads files or performs network work.

const BASE_DOCS = Object.freeze([
	"skills/skill/知识库/打穿短表.md",
	"rules/dig-scope-workflow.md",
	"rules/src-value-hunting.md"
]);

const ROUTES = Object.freeze([
	{
		key: "recon",
		terms: ["侦察", "测绘", "资产", "子域", "端口", "指纹", "recon", "subdomain", "asset"],
		docs: ["skills/skill/知识库/recon-methodology.md"],
		checks: ["先清洗、去重、确认存活并记录资产来源", "当前种子剩余活面处理完前不切换新种子", "页面/JS/响应中的业务 host、path、id 进入资产或接口清单"]
	},
	{
		key: "js-reverse",
		terms: ["js", "javascript", "前端", "混淆", "签名", "webpack", "source map", "接口发现", "逆向"],
		docs: ["skills/skill/知识库/js-reverse-guide.md"],
		checks: ["从页面和 bundle 提取完整接口、参数、签名盐和隐藏路由", "回包中的 id、token、下载地址和内部 host 回填清单", "同一参数在 query/body/header/path 的行为做基线差分"]
	},
	{
		key: "authorization",
		terms: ["越权", "idor", "bola", "bfla", "权限", "租户", "对象", "换 id", "授权", "authorization"],
		docs: ["skills/skill/知识库/idor-test.md"],
		checks: ["先建立对象图和本账号基线，再换回包或列表中的真实 id", "区分本职可读与跨用户/跨租户敏感正文", "有写入口只改可恢复的测试对象，并保留前后差分证据"]
	},
	{
		key: "authentication",
		terms: ["登录", "认证", "接管", "重置", "改密", "改绑", "验证码", "oauth", "jwt", "sso", "token"],
		docs: [
		"skills/skill/知识库/authbypass-test.md",
		"skills/skill/知识库/oauth-jwt-test.md"
	],
		checks: ["先确认真正发会话/token 的接口，不在登录壳上空转", "重置、换票、改绑场景明确身份绑定和对照条件", "不登出或吊销用户会话，凭据命中必须验证真实身份或业务数据"]
	},
	{
		key: "injection",
		terms: ["注入", "sql", "nosql", "ldap", "xpath", "ssti", "搜索", "筛选", "过滤", "injection"],
		docs: ["skills/skill/知识库/injection-test.md"],
		checks: ["只在有业务差分面的参数上做基线、变体、响应差分", "按栈选择探针并尝试 query/body/header/path 位置差异", "total、主体和敏感正文出现跨权差异才进入 finding 评估"]
	},
	{
		key: "ssrf",
		terms: ["ssrf", "回源", "webhook", "fetch", "proxy", "预览", "导入", "url 请求", "ssrf"],
		docs: ["skills/skill/知识库/ssrf-test.md"],
		checks: ["枚举所有 URL、回调、预览、导入和代理参数", "先做受控回环/外带对照，再验证内网或云元数据差分", "只记录最小必要响应和 OOB 证据，不扩大扫描范围"]
	},
	{
		key: "xss",
		terms: ["xss", "跨站脚本", "反射型", "存储型", "stored xss", "富文本", "评论", "html", "postmessage"],
		docs: ["skills/skill/知识库/xss-test.md"],
		checks: ["区分反射、存储和 DOM sink，记录输入到输出的完整链路", "用无害金丝雀确认解析上下文和受害者交互", "仅配置缺陷或无法证明受害影响时记 research，不提交 finding"]
},
	{
		key: "csrf",
		terms: ["csrf", "跨站请求伪造", "跨站写", "无 csrf", "token 校验"],
		docs: ["skills/skill/知识库/csrf-test.md"],
		checks: ["只对真实状态变更接口验证 token、Cookie 和来源校验", "先确认跨用户影响或可利用的敏感操作，不把只害自己的结果当漏洞", "不注销、不吊销用户会话，保存最小可复核请求证据"]
},
	{
		key: "cache-and-redirect",
		terms: ["缓存投毒", "缓存欺骗", "cache poisoning", "cache deception", "开放重定向", "open redirect", "重定向"],
		docs: ["skills/skill/知识库/cache-poisoning-test.md", "skills/skill/知识库/open-redirect-test.md"],
		checks: ["区分静态缓存命中与敏感业务正文泄露，做未登录/登录态对照", "重定向必须验证真实外部跳转或令牌泄露链，不以 Location 反射单独定性", "记录缓存键、方法和前后响应差异，避免扩大缓存污染范围"]
},
	{
		key: "execution-and-deserialization",
		terms: ["rce", "命令执行", "代码执行", "模板执行", "反序列化", "deserialization", "jndi", "表达式执行", "危险上传"],
		docs: ["skills/skill/知识库/deserialization-test.md", "skills/skill/知识库/jndi-injection-test.md", "skills/skill/知识库/el-injection-test.md"],
		checks: ["先确认输入可控、执行 sink 和过滤边界，再做最小无害验证", "只使用受控标记或无害命令证明执行，不做破坏性操作或外传", "执行链未闭合时记 research/blocked，不把错误页或版本信息当 RCE"]
},
	{
		key: "xxe-and-file-read",
		terms: ["xxe", "xml 外部实体", "实体解析", "路径穿越", "lfi", "文件读取", "任意文件"],
		docs: ["skills/skill/知识库/xxe-test.md", "skills/skill/知识库/path-traversal-lfi-test.md"],
		checks: ["确认 XML/文件参数进入解析或文件访问 sink，再使用最小受控文件对照", "路径、编码和规范化差异要有基线，禁止读取不必要的敏感文件", "必须证明真实文件正文或外带影响，单纯报错/路径存在不提交 finding"]
},
	{
		key: "prototype-and-type",
		terms: ["原型污染", "prototype pollution", "constructor.prototype", "__proto__", "类型杂耍", "type juggling"],
		docs: ["skills/skill/知识库/prototype-pollution-test.md", "skills/skill/知识库/type-juggling-test.md"],
		checks: ["先证明污染或类型差异跨请求/跨组件生效，再追踪模板、权限或业务 sink", "区分前端展示变化与服务端安全影响", "没有稳定权限扩大、数据越权或执行结果时记 false-positive"]
},
	{
		key: "waf-and-parser",
		terms: ["waf", "防火墙拦截", "过滤绕过", "编码绕过", "解析差异", "parser discrepancy", "规则绕过"],
		docs: ["skills/skill/知识库/waf-bypass.md", "skills/skill/知识库/http-smuggling-test.md"],
		checks: ["先保留原始基线和拦截证据，再有限尝试编码、位置、方法和解析差异", "绕过本身不是漏洞，必须继续证明越权、注入、敏感数据或执行影响", "低速、有界、无批量爆破；持续 403/429 时记录 blocked 并换方向"]
},
	{
		key: "information-and-supply-chain",
		terms: ["信息泄露", "敏感信息", "密钥泄露", "配置泄露", "源码泄露", "供应链", "依赖混淆", "insecure scm", "git 泄露"],
		docs: ["skills/skill/知识库/info-leak-test.md", "skills/skill/知识库/insecure-scm-test.md", "skills/skill/知识库/dependency-confusion-test.md"],
		checks: ["区分公开信息、指纹和可利用敏感数据，记录来源与权限边界", "凭据或密钥必须经过生产有效性和身份/数据影响验证", "源码、配置或依赖线索未形成真实危害时记 fact/research，不提交 finding"]
},
	{
		key: "file-and-storage",
		terms: ["文件上传", "上传", "下载", "对象存储", "bucket", "sts", "证件", "file upload", "storage"],
		docs: ["skills/skill/知识库/file-upload-test.md", "skills/skill/知识库/path-traversal-lfi-test.md"],
		checks: ["上传/下载先关联业务对象和归属，再检查路径、签名和权限边界", "对象存储的 key、租户、bucket 和签名参数做跨对象对照", "能传能下不是终点，继续验证他人正文或可执行/回源链"]
	},
	{
		key: "business-logic",
		terms: ["业务", "逻辑", "支付", "优惠券", "积分", "订单", "流程", "竞态", "race", "状态机"],
		docs: ["skills/skill/知识库/logic-test.md", "skills/skill/知识库/race-condition-test.md"],
		checks: ["画出业务状态机和角色边界，检查跳步、重放、金额和归属参数", "涉及并发时只做小规模、可恢复的验证", "确认业务状态或受害者数据真实变化后再评估等级"]
},
	{
		key: "api-and-protocol",
		terms: ["graphql", "websocket", "api 网关", "网关", "websocket", "协议", "swagger", "openapi"],
		docs: ["skills/skill/知识库/api-gateway-test.md", "skills/skill/知识库/graphql-test.md", "skills/skill/知识库/websocket-test.md"],
		checks: ["从 schema、operation、gateway route 或握手参数建立接口清单", "逐项验证认证、对象归属、字段级权限和方法差异", "协议错误或头反射本身不当作漏洞，必须落真实影响证据"]
}
]);

function normalize(text) {
	return String(text ?? "").toLowerCase().replace(/[\s\-_./]+/g, "");
}

export function routePlaybook(title, detail = "") {
	const input = normalize(`${title} ${detail}`);
	const matched = ROUTES.filter((route) => route.terms.some((term) => input.includes(normalize(term))));
	const routes = matched.length > 0 ? matched : [ROUTES[0]];
	const docs = [...new Set([...BASE_DOCS, ...routes.flatMap((route) => route.docs)])];
	const checks = [...new Set(routes.flatMap((route) => route.checks))];
	return {
		keys: routes.map((route) => route.key),
		docs,
		checks,
		matchedBy: routes.flatMap((route) => route.terms.filter((term) => input.includes(normalize(term)))).slice(0, 12)
	};
}

export const PLAYBOOK_ROUTE_KEYS = Object.freeze(ROUTES.map((route) => route.key));
