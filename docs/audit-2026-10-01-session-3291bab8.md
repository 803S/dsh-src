# local.107 当前会话审查与修复（2026-10-01）

会话session-3291bab8-6005-4b3a-aeba-2b2eff6435d6，主模型/四子模型请求路由newapi/deepseek-v4-flash。只读检查时419会话均idle，不代表SRC任务completed；4 intents仍running。

## 证据
- 23审批全部pending、全部Jev risk=low/verdict=pending/fallback=false，21 GET/HEAD/OPTIONS，2 POST /login；不是免费服务宕机引发。
- 5次src_http把goal-1当intentId，1次src_add_asset method=manual与store枚举冲突（工具描述却宣称自由文本），1次child src_test_credential发包后写入child store时报无goal。
- 四子session各1次、父session3次终止：400要求reasoning_text/content[].thinking。日志保存reasoning_content；父responseModel曾为MiniMax-M2.7/deepseek-flash/未报告，同一逻辑路由可能多后端。没有原始上游HTTP发送记录，不能断言确切在哪层丢字段；本轮不改宿主通用retry/模型服务或伪造reasoning。
- child.started=4、child.request-error=4、child.ended=0：subagent/end是continuable residency结束，不是每次turn结束；原单测只手工发end，未覆盖真实错误后仍驻留的子代理。
- Jev最小匿名对照（不请求目标）：同一GET+普通授权文本，原verdict问题pending；补可信executionPolicy声明已校验scope/低风险自动批准后allow。必须正式接入此前遗漏的授权前提，不忽略pending、不改allow条件、不加路径特例。

## 修复范围
- 请求本地校验scope后向Jev明确executionPolicy，区分应用未鉴权测试与用户授权；低风险自动允许是既定策略，高风险/不明继续人工。
- src_test_credential证据/研究/覆盖/凭据写入engagement，同步parent投影；不重复目标请求，不增额度。
- src_http错误提供已有intentID或省略参数指引；asset method schema与store统一，不把manual猜成授权主动操作。
- 以子代理实际turn-end/error更新未来生命周期；src_state对已驻留失败会话提供只读运行状态诊断，不能把idle视为成功。
- 真实工具mock回归与少量Jev匿名请求对照；不跑主模型、不清理历史数据、不自批23条审批、不重放真实目标。

## 结果与边界
- 授权前提加入模型state.executionPolicy，低风险允许仍需Jev明确low+allow+已知effect，不忽略pending；code范围校验仍先于决策，不增端点白名单。
- 模拟事故语义、匿名化目标的10个Jev用例全部符合预期：GET首页/健康检查、OPTIONS、HEAD、匿名只读、单次无效登录放行；删除/未知POST/真实批量邮件/未通过scope不放行。仅请求Jev，未访问真实目标；测试输出docs/evaluation/local107/authorization-check.json。
- 263/263全量回归通过，新增parent/child凭据测试证据回写、method枚举、无效intent指引、continuable turn/end错误接线与只读失败诊断。类型/预设检查通过。
- 上游协议进一步取证：new-api容器channel #3的400日志中request_id与dsh会话完全匹配（如5d28a05c、fcf7ad11、fd671e3c）；离线调用当前pi-ai convertMessages证明reasoning_content签名按reasoning_content回传，不会凭空变成reasoning_text或content[].thinking。不能证明网关具体哪个转换环节有错，但故障确在chat模型链、不是Jev决策服务。后续需检查该channel映射/思考格式透传与同一路由混模型，禁止用SRC假字段/无限retry解决。
- 已有23条审批与历史intent不改写、不删除、不自动批准；修复只作用后续请求。新src_state可从child最新turn读取失败原因，既有records仍如实保留。

状态：已部署local.107（代码e072164）。备份/tmp/dsh-before-local107-20261001-055424；双profile部署哈希通过；Web PID20572，API部署前后419会话idle、management HTTP200。Jev配置与已有审批不变。未启动付费主模型、未重放目标、未修复或改动new-api channel #3。

原始session解码临时文件/tmp/audit-jev-*.json权限0600，仅本机排查，不提交凭据或原始上下文。
