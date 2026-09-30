# local.106：Jev迁移表与验收合同

状态：代码、配置、双profile部署及验证完成。基线local.105/b5aed67；实现分支feat/jev-service。主工作区的既有合并冲突保持原样，不部署其他实验分支。

## 用户最终确认
Jev替代Laya的判断后端。授权范围内的低风险HTTP外发可由Jev自动放行；高风险、不确定、超时、服务错误和非法输出挂人工。Skill保留直接选名称/文档，分工保留delegate/self建议，Browser已有候选选择也迁移。

## 迁移表（唯一范围）
|入口|输入与输出|消费/执行|失败与权限|
|---|---|---|---|
|src_http风险闸|请求语义、实际身份存在性、任务目的、授权文本；effect/risk/verdict三个离散判断|risk=low且verdict=allow且输出有效，授权范围已过，才发出；其余pending。保留规则明确的破坏性/越权保护，不能只靠allow绕过|on下错误/不确定包括GET也pending；pending原单必须由用户解决，后续判断不能自动重放。off/shadow保持既有规则，shadow不改变执行|
|src_add_intent分工|实际任务/目标/预期证据→delegate/self/pending|on展示与留存；主模型派发/接管，实际执行仍由host/checkpoint记录|服务失败明确交主模型，不伪造已委派；shadow只遥测|
|src_http Skill|真实文档候选和片段→名称/读取入口或skip|主模型读取采用，调用前去重；失败不阻断业务，disabled不调用|不自动运行能力脚本；RUN仍人工审批|
|已有browser-index adapter|明确目标、当前snapshot、代码候选→index或none|改用Jev；保留原MCP executor/scope/stale/权限；none/失败不点击|只迁移现有候选接口。宿主普通MCP planning没有稳定snapshot改写seam，不伪称已经全面接管普通浏览器|
|response-classify/tool-advisory/next-action|只有旧兼容客户端，无生产调用|不复活新规划决策；标注未启用|不擅删分工/风险，不新增高阶规划器|

## 全局配置
基础设施→决策服务：SystemOne完整URL/模型/API key/timeout/启用及四职责on-shadow-off。DSH_HOME/settings/src-decision.json，目录0700、文件0600。key保存命令recordInput=false、查询仅hasKey；换origin必须新key/明确清除。保存后下一调用生效，缓存按配置身份隔离；服务宕机不自动换供应商/回退Laya，无短时熔断。远程去除业务凭据，不把认证头完整值送供应商。

## 验证结果
- 261/261完整回归通过（/tmp/jev106-release-tests.log），另类型/预设/语法/diff检查通过。UI bundle构建成功，已有rolldown define/import.meta警告保留，不为本轮升级依赖。
- 主/子真实ToolRuntime：低风险POST执行，高风险/未知/故障即使GET也pending；待审原单不能被重判放行；shadow不影响原规则。四职责使用同一配置，Browser none/shadow不点击，stale/scope guards保留。
- 真实CommandRuntime保存配置验证：command/run只含commandId/name/source，未含API key；command/done仅返回hasKey。重定向拒绝、供应商origin变更强制新key、配置/key/model变更缓存失效。
- 真实主模型prompt只跑一轮：session-2e2c5b7c-f9f0-4778-910f-bfd9084003cd，4规划步/6工具/126517累计tokens，未触预算上限。四个场景均调用；计算POST低风险allow但effect=unknown被保守挂起，首轮验收未通过。根因是操作类别缺少纯计算，不是加端点白名单可解决。
- 补通用compute类别后，用上述主模型产生的原始四请求（只改隔离靶场origin）经真实ToolRuntime+Jev重放，低风险POST和GET实际到达；DELETE和不明POST均pending；通过。没有重复付费主模型会话。这是“prompt发现问题+修复后的工具链复验”，不冒称修复后完整重跑了主模型。
- 原始证据：docs/evaluation/local106/{prompt-score,prompt-http,replay}.json；模型源版本在结果内，Jev1.13.0。其他职责复用此前固定样本通过记录+本轮接线单测，不冒称新的生产准确率验证。

## 当前迁移边界
- 自动审批范围是src_http的主/子请求，不接管Burp/bash/MCP的宿主通用安全策略；这类工具仍受既有授权纪律，不能绕行pending。
- Jev只替代部分低风险HTTP人工批准；RUN脚本、资产归属确认及规则明确破坏性/越权仍人工。固定置信度数值不是正确率，不靠熵阈值批准。
- Browser已迁移existing candidate seam，不伪称已获得宿主普通planning接管接口。旧localdecide进程不终止，但新启动脚本不再自动启动它。
- 兼容字段layaAdvice、遥测laya.decision和旧环境默认名保留以免改坏历史；payload明确provider/model，生产调用已无layaDecide别名。
- 配置或服务故障一律挂人工（风险on）；用户明确关闭risk/启用shadow才回原规则。服务不会被短时熔断或自动换站。

## 发布记录
- 代码提交b9c49ed；版本0.1.0-local.106，分支feat/jev-service（基线local.105，不合入Laya实验代码）。
- 备份/tmp/dsh-before-local106-20261001-002800：双包、插件、桥文件和SQLite一致性备份；若要回滚自动审批，先停用全局决策服务，恢复旧包后启动。不要把旧DB覆盖后续业务记录。
- 双profile部署哈希检查通过；Web PID15971 /tmp/dsh-web-latest.log，API session.list部署前后415会话均idle。未中断进行中的任务，未改目标finding/审批历史。
- 全局配置已写入用户提供的SystemOne endpoint，jev-latest，timeout120000，risk/skill/delegate/browser均on。key不进入仓库。
- Chrome面板验收：基础设施decision-settings出现；endpoint/model读回正确；4模式均on；password值为空；pageerror=[]。测试已保存连接返回jev-1.13.0，2858ms，合成read分类成功。未运行真实目标请求。
- 原3166/8791模型进程没有强制终止，但SRC四条生产决策入口均不再调用它们。
- 源码工作区将在收尾时移入Software/dsh-src-jev以避免临时目录丢失；原Software/dsh-src的远端合并冲突仍保留，未擅选ours/theirs。

## 验收表
- [x] 低风险POST即使旧泛写规则挂起，也可由Jev放行；高风险和语义不明不执行。
- [x] 401/429/503/超时/非法结构/矛盾回答→人工；取消不发包；已pending不自动放行。
- [x] scope越界、明确破坏性/越权、RUN、资产归属确认仍不能被模型批准。
- [x] 分工、Skill名称/读取、Browser none/stale/候选之外分别走真实工具接线。
- [x] 主/子HTTP风险策略一致；Jev服务不可用不伪造任务完成。
- [x] 配置热切换/禁用/职责模式；key不写command/run输入、不回显、不转发到重定向。
- [x] 类型/语法/全量回归/打包；双profile备份与哈希核对；空闲才重启。
- [x] 隔离合成靶场prompt（首轮发现缺陷，修正后复用原请求工具链复验，详见上方记录）：低风险POST、低风险GET、高风险DELETE、不明POST；检查服务端计数/审批/证据/主模型总结。供应商失败另用离线mock。不触真实目标。

真实prompt只一轮，预设120秒/8步/10工具/160000累计token预算；未覆盖算未通过，不反复开会话。生产配置切换需通过上述验收，不能把单测绿当准确率保证。
