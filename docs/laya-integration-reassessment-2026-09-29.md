# Laya 接入重新定界（2026-09-29）

状态：历史梳理快照（基线7bf6c95），不是完成声明；后续改动及已验证范围见 [实施记录](implementation-2026-09-29-laya-repair.md)。本地输入保留真实语义、不默认脱敏；永久遥测另行控制。

## 真实收益证据

session-412ebd38：risk53（fallback11）、delegate2（全部fallback）、skill53（fallback21、46skip、2reminded）；3read均无recommendationId、0next-action/0outcome。这只能证明现有接入没有证明正收益，不能证明Laya模型不适合。两次子任务确实spawn且各恢复一次，但子模型一直401，不是委派函数被删除。主模型deepseek-v4-flash，子模型仍sensenova-6.8-flash；模型选择/恢复接入需单独核对，重复唤醒不修复无效凭证。

## 断点及修复合同

### A. 等待与错误
- 500/800ms人为截断，5秒熔断又跳过下一次决策；daemon脚本用单线程TCPServer，共享队列等待可能被误算模型慢。不能直接改成多线程并发访问MLX模型。
- 已在工作区移除熔断、默认120000ms惰性env；尚未部署。120秒是预算不是实际耗时保证。
- 应记录排队/服务端推理/总耗时、timeout/network/http/schema/cancel错误类型；客户端取消不等于服务端取消，不能宣称省掉推理成本。

### B. 风险评估：有调用，没有足够语义输入和消费
- buildLayaPrompt只提供URL、认证存在、body长度/是否JSON/敏感词等；不提供脱敏请求语义、任务目的及证据依据。JSON-RPC id是请求关联号还是业务对象ID无法被理解。
- 提示里请求率硬写0；未观测的数据应unknown。
- action是allow/pending/reject，调用方只存字符串，执行仍只看verdict.require；普通放行响应不展示风险建议。因此不能把allowed-auto算作Laya自动审批，也不能说它减少了人工审批。
- risk probabilities在拼字符串后丢失；高confidence是选项置信而非评估正确率。
- classifier新增routeText把任意body中的query/schema等字串当只读凭据，是不可靠的执行依据；不得继续扩大名单。
- 目标合同：不可越过的scope/人工授权由代码守住；风险语义由Laya基于脱敏结构化事实判断；明确哪些决策可由既有执行策略消费、哪些必须人工。缺证据≠只读。保留风险职责，不假设一个allow足以绕过所有边界。

### C. 分工：建议冒充已执行
- 客户端pending fallback又被tools/index.js fallbackAction按步骤/隔离强制替成delegate/self（rules-fallback）；只移除客户端熔断不解决这一点。
- src_add_intent把建议直接写delegationMode；实际没有spawn也可能delegate，实际spawn也可能self。finalize再读该字段豁免checkpoint，形成错误闭环。
- shadow仍返回/落建议，缺严格只观测语义；reason多为代码特征描述，并非模型生成理由。
- src_update_intent新增delegationMode只改store，projection fold没接该字段；未证明实际执行方式一致。
- 目标合同：decision(建议)、execution(实际)、outcome(结果)分离。失败=未取得Laya决策，不推导self/delegate；实际spawn/父方接管/child checkpoint各自留证，建议不能解除收尾判据。任务实质变化时重新评估，不是每个HTTP都评估。不新增第二套调度器。

### D. Skill：候选与读取链缺陷
- 模块级recallKnowledgeCandidates访问nodePath/fsPromises，但变量只在createRegisterSrcTools局部解构，外部函数不可见；ReferenceError被catch吞后退到lesson，所谓安装知识库全召回不成立。
- cache仅按相对文件名，不按安装根/版本，且空读永久缓存。
- 新stopTerms删除api/model/两字中文，属于再补过滤规则，不能替代任务语义召回。
- Laya排序输入没有当前intent正文/justification/response证据，lastSkillUsed固定null；只看请求路径和候选标题，候选错则重排无从救。
- 已读/已提醒判断放在Laya调用后：不重复提醒不等于不重复推理。
- 读取路径与route别名虽补映射，isRead仍主要看skillId；推荐前已经读取的文档不能可靠消除后续重复推荐。
- next-action在dispatch前记，可能把另一篇阅读或被repeat guard拒绝的调用算执行；evidence outcome仅消费HTTP证据，不证明采用了Skill。
- 目标合同：以真实文档身份+版本建候选，用当前任务语义召回，多源合并，先排除确已消费的同版本文档，再让Laya排序；只发真实可读指针。观测read/action/evidence区分时间关联与因果采纳。不能把skip低当收益差（合理skip有价值）。

### E. Browser
- 保留外部browser-index、dsh执行与范围/审批边界；本会话没有browser调用，不能评价收益，更不能宣称接管普通planning。

## 修复顺序

1. 等待预算/错误分类/排队观测，不用熔断代替判断。
2. 移除rules-fallback对分工的替代；建议与实际执行状态分离，修shadow及projection。
3. 修Skill真实文档加载及语义输入、文档身份/去重与观测，停止端点补丁。
4. 风险输入与消费合同（一般可逆只读语义 vs 真实副作用/权限边界），不以body字串直接放行。
5. 在无网络fixture验证：延迟响应、畸形响应、任务变化、child失败再恢复、同文档重复读取、审批队列、并发会话隔离。
6. 部署前只读确认真实session运行状态，一次备份/一次部署；不改历史、不因端口HTTP200认定完整health，/healthz返回SPA HTML不算API健康证明。

## 验收

不能用全量测试绿替代闭环证据：必须提供各职责的输入、原始合法选择、模型可见输出、实际执行/未执行、结果归因；保留无Laya对照，统计无效人工审批、真实恢复成功率、Skill读取采纳、重复调用、证据产出，不以调用次数/allow rate为准确率。
