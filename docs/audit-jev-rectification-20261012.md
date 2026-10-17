# 整改验收复核：Jev 审批仍有阻断问题

日期：2026-10-12。只读源码/部署核对、离线合成复现；没有修改运行代码、部署、重启、调用真实Jev或目标请求。唯一新增文件为本审计报告。

## 1. 验收结论

**不通过。不能宣布Jev审批已整改完成。**

复核基线HEAD `2d871fe`，其前包括 `9ad85bb` / `7f655ca` / `dc8fc27`。package和两部署副本仍标local.128。

新增公共资料工具、approval-ID读取、操作上下文、待办直接持久化有价值，但若干关键路径只“新增了字段/调用”，没有验证生产执行链。现有缺陷不是Jev准确率问题。

本轮实际回归：npm test **595项，594通过、1失败**；UI类型检查通过。未跑实时模型评测，不给Jev准确率结论。

证据：`/private/tmp/dsh-approval-audit-20261012/`。隔离fixture使用临时DSH_HOME和mock fetch/模拟执行器，未发实际网络请求。临时node_modules链接仅用于fixture模块解析，未修改仓库依赖。

## 2. P0：冻结HTTP正文丢失、headers形状退化

位置：
- `lib/src/egress/advisor.js`
- `lib/src/decision/operation-context.js:operationContextToJev`

冻结请求结构为 `{method,url,headers:[pairs],bodyBase64}`。

新转换器使用`context.request.body`，没有解码`bodyBase64`，因此正文为undefined；headers未转换成此前约定的对象。

离线结果：POST `/render`含JSON正文，经assessEgressPlan后`hasBody=false`、`body=null`、command为空。read/delete两种不同正文生成相同operation digest。

已有测试 `tests/egress-onboarding.test.mjs:105` 已报错：原`headers.accept === '*/*'`现在是undefined。不是只改测试期待数组即可，必须检查真实Jev wire input的正文和语义。

进一步实际链路验证（`wire-repro.mjs` / `wire-report.json`）：隔离manager使用默认broker/advisor/jev-client，捕获最终HTTP payload；原POST正文完整到达模拟directFetch，但Jev payload中`request.body`不存在，headers不是约定对象，command为空。mock Jev返回compute/allow后该请求可执行且没有审批。这证明送审数据确实在真实接线层丢失；模拟返回不能当作真实Jev误判或准确率证据。未访问真实Jev/靶场。

影响：Jev可能看不到决定危害的实际参数，不能可靠自动放行；操作digest不能作为安全身份。原broker的请求HMAC另行完整绑定，未因此证明已出现批准替换绕过。

修复要求：
1. 建立单一规范请求投影：headers对象，原bodyBase64显式按类型解码；二进制/附件有类型感知表示，不能丢或假装为空。
2. 保持reviewBody已有无损语义、重复键和有界检查。
3. 操作hash覆盖所声称绑定的原始参数/正文/headers/文件版本；诊断hash不能冒充授权hash。
4. 测试捕获最终发给mock Jev的payload，断言正文首尾、危险参数、headers值都在，不仅断言上层对象字段存在。

## 3. P0：Jev low/allow 的bash在前置钩子被拒绝

位置：`lib/src.js:tools/pre-execute`约2218行。

当前代码：当Jev允许、scopeTarget=true且`!currentEgressExecution()`时返回deny。

但该ALS在`tools/execute`阶段才进入，pre-execute阶段通常没有它。检查ALS存在不等于验证原任务是否有已审核计划。

真实ToolRuntime合成夹具复现：

```
命令：curl -d x=1 http://fixture.test/search
mock Jev：compute / low / allow
Jev调用次数：1
执行器次数：0
结果：Error: Jev判定为低影响候选，但该bash命令尚未绑定精确出口计划…
```

bash回注到Jev的operationId为空；本地telemetry构造的ID没有传给jevDecide。

下游task-tool又只接受GET/HEAD/OPTIONS，不能解决要求POST先提交计划的问题。

修复要求：
1. 别用pre阶段ALS判授权；操作评估与实际任务绑定使用显式operation/task状态。
2. 允许低影响命令通过统一决定和已核对scope进入原执行器；动态实际请求仍校验原决定的范围/内容/预算，不使用无限许可。
3. 检查已提交计划之后该命令也能通过pre阶段，不再次卡住。
4. 补low POST实际到达合成站点并将响应返回原调用的正例；不可只用unknown→人工→fake shell执行次数测试。

## 4. P0：新增入口Jev调用的返回结果被丢弃

位置：
- `lib/src/egress/browser-adapter.js:38-47`
- `lib/src/egress/burp-request.js:106-115`
- `lib/src/egress/file-tools.js:49-59`

代码形式为`try { await jevDecide(...) } catch {}`，没有消费结果。

operationContext保留arguments，但operationContextToJev没有输出它们，taskSpec也不保留原始工具参数。浏览器evaluate代码、文件write的content因此没有进入审核。

合成浏览器适配器复现：mock Jev返回destructive/high/pending，但原工具仍执行1次；payload不包含浏览器脚本，scopeChecked=false。

重要边界：这**不证明下游HTTP出口已经绕过**，因为真实HTTP还会经过broker。它证明这一新增入口评估无控制作用，只增加调用费用/等待，Burp可能随后再次评估。

修复要求：
1. 不继续各适配器追加独立Jev调用；使用同一operation评估/判定消费点。
2. 需要保留的入口评估必须携完整参数并明确消费allow/pending/error。
3. 原生文件只读不应因一个不参与执行决定的远程调用平白等待最多120秒。
4. 补各入口high/unknown/失败不会悄悄执行、low正常执行的测试，并保留实际网络scope检查。

## 5. P1：操作上下文仍未全链路传递

- advisor重建tool为egress_http/egress_scan，未读取入口command、理由及已有op context。
- manager代理claim仍只传taskId/deferAssessment/signal，丢上层工具上下文。
- 同一call在bash/browser/egress使用不同ID或无ID；无callId时Date.now也不是稳定ID。
- scan-plan的taskSpec只保留plan，未消费新增的operation字段。
- `scopeChecked=Boolean(scopeOrigin||goalTarget)`把“存在目标文字”误表达成“已验证授权”；broker检查仍存在，但该通用helper不应制造这种可信结论。

修复要求：显式传同一operationId和上下文；scopeChecked只接受可信范围验证结果；不靠session最近调用猜归属，不复用其他会话许可。最终payload覆盖command/args/cwd/intent/理由/正文，输入与决定关联可查。

## 6. P1：两个新增工具被生产入口目录拒绝

`src_read_public_source`与`src_account_assist`已注册，但没有进入`host-integration.js`的SRC_TOOLS目录。

离线调用实际tools/execute钩子，两者均得到`SRC_GATE_UNADAPTED_TOOL`，在工具实现前停止。

公共资料还有下一层问题：实现使用makeHttpFetch→targetTransport→manager.fetch；public-lookup不承认新资料工具，因此即使补目录，NVD仍可能进目标scope检查。当前测试只验证URL函数/版本比较，未覆盖此链。

修复要求：完整纳入工具可用性和只读资料transport，不能通过扩大测试目标scope绕过；DNS验证结果固定到实际连接，正文接收有界，而非接收全部后仅截输出。账号协助须过真实工具钩子和更新行为测试。

## 7. P1：审批仍可重复创建待办

位置：`tools/index.js:592`。

`new RegExp("\b" + row.id + "\b")`在JS字符串中这里实际使用的是退格字符，不是regex单词边界（源码应注意反斜杠层级）。

真实工具实现合成复现：已有pending approval-1，再调用src_user_todo(title='批准 approval-1')仍创建userTodo-1。

仅修转义也不够：只查title漏detail，仅以是否含ID又会误伤真实账号协助背景。应按具体目的/关联操作区分审批决定与账号输入。

修复要求：同operation的审批决定不复制todo；账号协助可独立存在。补approval-1/approval-10精确匹配、detail重复、真正账号需求正例。

## 8. P1：待办持久化失败却返回成功

位置：`lib/src.js:src-todo`约1893-1907行。

新增直接持久化路径有try/catch空吞；不存在ID/存储失败仍followup“状态已持久化”并返回success。followup未await，也未报告投递失败。

合成命令复现：`userTodo-999 done`返回success，store中0条todo，消息却称已写入。

账号协助更新还会用默认标题/detail覆盖原内容；targetUrl新建仍可省，不能称完整URL已经强制可用。

修复要求：持久化失败返回error，不投递虚假完成；写入成功但通知失败分别报告，重投不重复改状态；完成/放弃有具体不同续接，账户完成后实际验证输入有效。只更新状态时保留原标题和入口说明。

## 9. 部署一致性未通过

本机Web/headless与当前源码比较：

- bash-guard.js、jev-client.js一致。
- src.js、operation-context.js、advisor.js、manager.js、browser-adapter.js、tools/index.js不同或缺失。

因此“源码已改”不等于“运行中的审批已生效”；不能仅凭都叫local.128判断。Jev全局enabled/riskMode仍为on，本轮读取设置未输出key。

修复后从一个干净提交构建同一tgz验证/部署，展示commit/hash。不要现在直接覆盖生产以掩盖半更新。

## 10. 最小验收清单（不新建系统）

实施顺序：

1. 修请求投影丢正文/headers，最终payload正负例。
2. 修bash low后必deny及入口重复评估：单一操作决定，真实原执行器返回结果。
3. 原参数/operationId全链路与拒绝/未知决定实际消费。
4. 新工具生产目录与公共资料实际transport。
5. 待办去重/失败诚实处理。
6. 一次完整回归、同包部署、隔离宿主E2E，再限定数量真实Jev矩阵。

必须通过场景：
- low GET、low POST计算、nuclei版本查询正常执行；无人工重复单。
- 正文仅改变read/delete意图时送审内容明确不同，不靠路径猜。
- high/unknown进入唯一人工审批；批准原文执行，拒绝不绕行。
- 同操作通过src_http/curl/browser/Burp输入/结论一致；判断结果没有被忽略。
- 改脚本/目标/账号/预算不能使用旧决定；跨会话隔离。
- 资料读取不扩大目标授权；新工具真实可调用。
- 完成/放弃状态写入与消息投递结果真实，旧审批证据可读，禁止重复要求用户贴包。
- 部署文件与验收提交一致。

这些离线复现本身证明当前问题存在，不是修复验收。报告不要求用户继续为内部流程增加审批或待办，不用放宽全部出口代替正确接线。
