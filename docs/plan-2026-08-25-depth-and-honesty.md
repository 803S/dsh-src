# 下一版主题：测透与诚实（local.22 起）

> 本文档是 2026-08-25 三轮交叉评审的落盘结论，作为执行契约。主题定调：
> 上一版（local.20/21）解决的是「敢挖、会记、能收官」；这一版解决的是
> **「测得深、认得清自己没测哪」**——同一预算下提高命中质量，让遗漏可见。

## 核心判断

1. **瓶颈排序变了**：不是资产面不够宽，而是①登录态/多账号管线锁死了出货量最大的类别（垂直越权/租户隔离）②「以为测到了」比「没测到」更危险③规则补丁有天花板，判断力买不来。
2. **漏报无闸**是质量体系最大的不对称——误报层层设卡，漏报静默无声。
3. **下沉纪律**：方案里凡是仍「写在 prompt（建议）」的部分，继续往 schema/gate/lint 下沉——这是项目自己总结的复盘路径。

## 否决清单（负范围同样是承诺）

❌ 常驻侦查 agent（预算黑洞）❌ storage v7 schema 重写 ❌ 夜间全自动主动测试 ❌ 现成答疑 agent（先在实战里攒够三五条真实问题再说）

## local.22（第一波）—— 提示词 + 课程 + finalize 盲区闸

| 项 | 内容 | 形态 |
|---|---|---|
| 【资产分诊】节 | 信号表（test/uat/staging 前缀、中间件入口、短期证书、双端网关）进指挥官派发节；派发 audit intent 前先排序 | 提示词 |
| 测试环境三分法 | 明确含非生产环境→优先级上调（软目标+生产跳板双重价值）；明确排除→记录跳过；沉默/模糊→被动指纹照做、主动测试建非阻塞待办快速确认 | 提示词（并入【资产分诊】） |
| lessons/token-lifecycle.md | 登出回放、改密后失效、**web token 打 App 网关**、验证码复用；操作顺序警告（登出测试会弄掉用户自己的 Burp 会话）；改密测试建议小号或转 manual-test；认证态低频纪律 + 撞风控停手；test→prod 跳板（战利品清单：源码/.git/sourcemap/调试端点/弱鉴权/staging 抽数 + 最小足迹验证 + 红线：**证明即止，禁止囤积真实用户数据**） | 课程 |
| lessons/csrf.md | 检测套路 + 利用证明需受害者浏览器的部分一律转 manual-test 待办 | 课程 |
| 负结果落盘 | audit 结论为不漏洞时也调 src_record_research 记录（含理由）；去重天然存在（同 intent+category 的 false-positive 覆盖同一条记录） | 提示词 |
| blindSpots **gate** | finalize 新增 `blindSpots` 必填参数（数组，每项 `{dimension, status: covered/uncovered/notApplicable, note?, evidenceId?}`）；服务端校验：①期望维度必须全声明（缺项硬阻断）②covered 必须带可解析的 evidenceId（指向真实 fact/finding/intent/research，硬阻断）③wss 资产存在却标 covered 无证据→硬阻断；与 remainingDirections 切干净：**动作枚举（同类内剩余）vs 类别未碰（结构性盲区）**。**复用 coverage 表存储**（phase=`blind-spot`，免新增表/免迁移） | 代码 |
| 期望维度生成 | 基线集（http-authz-surface / cors-headers / dom-xhr / dict-budget / multi-account-cross-authz，恒适用）∪ 信号派生（wss 资产→websocket；app/mini-program 资产→mobile-api）。**外部能力映射（headless→DOM 等）留待后续接 capsync 注册表，本版不耦合** | 代码 |
| 开场声明并进 policy 步骤 | 【厂商规则】步骤输出时一并声明本目标适用的覆盖维度（基线∪信号）；维度清单随发现可更新（活文档）；finalize 对照最终版 | 提示词 |
| buildReport 渲染盲区 | 报告尾部「## 覆盖维度声明」节列出 blindSpots（dimension/status/note），紧邻「⏸ 等你的事」 | 代码 |
| 可行动盲区→待办 | 盲区可行动（如缺第二账号）→同回合建 src_user_todo（mirror blocked 必建待办铁律） | 提示词 |

## local.23（第二波）—— 多账号矩阵（唯一核心工程项）

| 项 | 内容 | 形态 |
|---|---|---|
| testAccounts 列表 | `infra.testAccount` 单值 → `testAccounts` 列表（向后兼容读单值）；**粘贴式 label 主通道**：每条 `{label, cookie/auth, note?}`，对照 local.10 user:pass/多手机号逗号分隔先例，textarea 先行；observationId 归因降级为兜底 | 代码 |
| 交叉矩阵 persona | audit persona 写明交叉矩阵动作：A 的资源 ID × B 的会话、普通会话 × 管理端端点清单；**双探规则**：IDOR 类需两组不同 id 对确认系统性才提交 | 提示词 |
| 认证态独立预算 | 带认证头请求单独计全局预算（按目标），阈值低于未授权流量一半；触顶→剩余矩阵格转待办（非报错）；401 连发→转「重新登录」待办模板 | 代码 |
| 一致性检查固化 | 解析 preset YAML deny 列表 × 正则提取各 persona 点名的工具名，断言子集关系；纯 js-yaml 解析，挂进 static-check.yml（无私有依赖） | 代码/CI |

## 第三波及以后（依赖链是原则性的）

域笔记（用现有 lessons 机制）→ 笔记积累成基线清单 → 哑脚本 diff 才有可比对象 → 晨报。没有基线，监控是无源之水——这就是为什么它排在后面而不是砍掉。答疑 agent 等真实问题攒够。

## 验收标准（代理指标，非「挖到更多洞」）

1. **续用同一会话**（resume）时，开局 briefing 引用上次已否假设，不再重复钻枯井。（跨会话持久化等第三波域笔记落地后才可验——本版限 resume 场景）
2. 报告尾部出现**具体的**未覆盖清单（写着「WebSocket 面未覆盖」而非「受时间限制」空话）。
3. 配了多账号的目标（第二波后）上，要么产出首个交叉越权 finding，要么给出诚实的 blocked + 待办。
4. manual-test 待办数量上升是健康信号不是退化——**附最低信息门槛防 Goodhart**：复现步骤 + 预期影响 + 证据引用，缺一打回。

## 不在本版范围（明确延后）

- 期望维度从 capsync 能力注册表自动生成（映射表小且手维护可接受，本版用投影信号派生）
- blindSpots 的「声明时间晚于目标」时序校验（goal 无 createdAt 字段，本版只校验证据存在）
- 多账号 UI 多行编辑器（textarea 先行）
- 旧 local.22 候选修复三项（recon deny/委派置 running/completed 降级）保持挂起，不并本批
