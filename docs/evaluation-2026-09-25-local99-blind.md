# local.99 生效与首轮真实模型盲测

日期：2026-09-25。结论：**版本已生效；评测入口已建，模型盲测尚未完成，不能判断产出改善。**

## 安全生效

通过只读 `/api/session.list` 的 `result.ok=true` 读取413个会话，running=0；停止前再次核验，确认监听者仍为PID37320。原参数 `dsh web`、原profile、未新增feature flags，重启为PID43172。`127.0.0.1:3080` HTTP200，启动日志 `/tmp/dsh-web-local99.log`，PID文件 `/tmp/dsh-web-local99.pid`。没有中断已知活跃任务，没有修改真实目标记录。

## 评测实现

- `tests/blind-range.mjs`：独立进程内本地fixture，固定seed生成入口路径。首页公开业务导航与访问政策，不把答案预告给模型；含HR私有数据错误匿名返回、正常公开门店、HTTP200但业务拒绝、缺管理员账号、未获批准的删除。
- `scripts/blind-eval-plugin.mjs`：真实宿主agent/preset/tools与会话日志；host monotonic tools.guard限制工具白名单和精确本地origin。禁shell/fs/MCP/外部侦察/审批重放，不能读取fixture源码、运行器或模型凭据。保留正常角色工具deny，不预填finding。
- `scripts/run-blind-eval.mjs`：全新临时DSH_HOME/profile/工作目录/存储；固定已配置模型，旧版从git archive 21e0358提取，新版复制当前代码。显式全局宿主路径（可用DSH_EVAL_AI_ROOT覆盖），不修改生产profile。凭据仅复制所选provider的一个managed key，0600，结束删除。
- 防提前退出：指挥官yield后等待子代理及回注，所有agent连续空闲3秒才退出；步骤/工具/累计usage与wall-clock预算；取消、flush、进程组外层超时兜底。
- 评分区分：网络观察、候选finding、持久证据、证据指针与verification记录；不把路径匹配当有效漏洞/独立验证证明；budget/error标记not-evaluated。

约束：这是受限工具环境的诊断评测，不代表完整生产工具面的性能。guard拦截的工具仍可能出现在catalog中，可能造成额外摩擦；同平台不同动态端口并非字节相同prompt。模型ID是配置的路由别名，未验证中转的上游实际模型身份。maxSteps是agent规划步，不是包含所有重试的供应商请求次数；token预算按已返回usage统计，当前在途请求可超出，缺usage不代表没有费用。最长300秒硬预算，当前单条输出maxTokens1800（子代理继承行为仍需单独验证）。

## 实际运行（顺序执行，没有无限重试）

|版本/模型|预算|实际结果|解释|
|---|---|---|---|
|local99 / kimi-k3|150s /20步|2步开始、1次工具、0 HTTP|只完成建goal，耗尽时间|
|local98 / kimi-k3|150s /20步|5步开始、4次工具、1 HTTP|首页200只有状态行，无正文；随后试图补observation，intentId错误|
|local99 / kimi-k3 诊断重跑|300s /24步|3步开始、2次工具、0 HTTP|建goal后约199秒才完成建intent；不是可比的A/B收益样本|
|local99 / deepseek-v4.1-flash|180s /24步|首步等待，0工具/0完整消息|时间预算终止，未进入验证|
|local98 / deepseek-v4.1-flash|180s /24步|首步等待，0工具/0完整消息|同样未进入验证|

每组最多60工具调用、累计100万usage tokens（包含cache-read，不是价格）。总返回usage约213,188 tokens，未知在途请求计费不在此统计。所有组删除请求=0，真实外部目标请求=0；唯一fixture请求为旧版kimi首页读取。没有finding/独立复核产出，不把这些0当作漏检率。

原始材料目录（临时目录可能被系统清理，重要复盘应自行归档）：
- kimi新版150s：`/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-blind-eval-sj5Q68`
- kimi旧版150s：`/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-blind-eval-e4JGm2`
- kimi新版300s：`/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-blind-eval-iFL8sz`
- flash新版：`/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-blind-eval-rgJ7PG`
- flash旧版：`/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-blind-eval-54mVw5`

每目录包含 metadata/trace/requests/score/completion/runner.log 与实际session持久日志。执行前还发现运行器依赖定位错误、git archive stdout缓冲上限两个准备阶段问题，已修，未混算模型评测。所有临时凭据已清理。

## 自动化验收

`npm test` **227/227** 通过（新增fixture、隔离guard、超时评分3项），日志 `/tmp/dsh-blind-tests.log`。preset consistency、语法检查、git diff --check通过。生产会话仍413个，盲测未写入生产会话库；已核对临时凭据零残留。评测脚本必须显式 `--run` 才调用模型。

## 下一步（按证据而非继续堆功能）

1. 先诊断现有模型路由的实际请求耗时/错误/重试；不要因这轮超时断言SRC逻辑一定错误，也不能声称只是模型问题（大catalog和prompt影响尚未做消融）。
2. 路由稳定后，用同模型、同预算至少3个配对seed重跑，得到完整轨迹；目前不切生产默认模型、不继续无限烧额度。
3. 然后做finding/报告语义收敛：暂停不等于验证完成，阴性不进有效漏洞，verified应有独立执行者与证据来源。再做survey消费与终态证据。
4. 本轮新测评代码不自动部署/不自动调用模型。`npm test`仅跑本地确定性测试。

## 手动复现命令

```bash
# 仅展示用法，不调用模型
npm run eval:blind
# 显式付费模型调用，每次独立隔离，不改生产配置
node scripts/run-blind-eval.mjs --run --model=kimi-k3 --seconds=180 --steps=24
node scripts/run-blind-eval.mjs --run --baseline --model=kimi-k3 --seconds=180 --steps=24
```
