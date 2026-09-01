# dsh-src 后续迭代总路线：资产、出洞、UI 与外部能力

> 本文是总索引。外部能力的专项实现规范见 [`plan-capabilities-next.md`](./plan-capabilities-next.md)。当前仓库事实以源码、`docs/CAPABILITIES.md`、`docs/DEVELOPMENT.md` 为准；本文不替代现有安全红线。

## 1. 目标与判断

完整实现不会保证一定出洞，但会提高有效资产覆盖、研究命中率、证据质量和长任务稳定性。评价不得使用“新增工具数量”，而应记录：

- 存活且可归因资产比例；
- endpoint hint → candidate → confirmed 转化率；
- 高优先级攻击面的覆盖率；
- research → reproduced → verified 转化率；
- verified finding 独立复核通过率；
- 重复研究、误报、审批误操作；
- 长会话 projection 加载时间和内存；
- 外部能力超时、重连、失败后任务继续率。

不能为了指标放宽授权、批量遍历对象、默认执行写请求、自动批准 skill 或让外部输出直接成为 finding。

## 2. 版本顺序

```text
local.50a  lib/src.js 纯拆包
local.50b  store + synthetic event + projection 统一 mutation API
local.51a  资产 canonicalization/provenance/lifecycle
local.51b  CT/DNS/HTML/JS/source map/manifest 有界被动收集
local.51c  资产合并、归属分诊、可恢复 crawl frontier
local.52a  EndpointSurface 攻击面模型
local.52b  自动研究骨架和证据要求
local.52c  priority frontier 与 src_state
local.55a  UI 组件拆分，不改变行为
local.55b  Overview/当前行动
local.53a  测试对象提取
local.53b  多账号 × 对象 × endpoint × channel 矩阵
local.53c  响应语义分类
local.53d  baseline/variant 证据闭环
local.55c  资产/漏洞详情体验
local.55d  响应式、无障碍、性能
local.54a  Burp 请求序列与业务 workflow
local.54b  Web/App/小程序/旧 API 多渠道比较
local.56   脱敏、增量 projection、性能、Map 生命周期
local.57a–57g 外部能力专项，见 plan-capabilities-next.md
local.58   frontier 驱动的能力推荐与证据回灌
```

## 3. 资产与出洞设计

资产必须表达：值、canonical key、归属/授权依据、存活状态、生命周期、来源 provenance、优先级、关联 endpoint/observation/research。CRT、dork、历史 DNS 只能产生 candidate/historical；excluded 永远不能授权；Burp 真实访问证明访问事实，不单独证明组织归属。

EndpointSurface 至少包含：host/path/method、channel、认证边界、auth profiles、对象参数、租户参数、敏感动作标签、响应类别、workflow、来源、priority、coverage 状态。对象参数包括 `userId/orderId/fileId/tenantId/shareId` 等；敏感动作包括上传、下载、导出、改密、绑定、审批、退款、回调等。

自动研究只生成假设，不直接建 finding：

```text
对象参数 → IDOR/BOLA/跨账号/租户隔离
上传 → 授权/类型/公开访问/内容处理
下载导出 → 范围/对象授权/token 生命周期
callback/url/fetch → SSRF/重定向/回调授权
验证码/reset/bind → 重放/绑定/限速/状态迁移
```

多账号测试只使用测试账号自有对象和少量对照格：A 自有、B 访问 A、A 访问 B、普通账号访问一项管理接口、匿名访问一项需登录接口。单次差异不足以建 finding；必须有归属证据、敏感响应和最小复现包。

响应不能只按 `status < 400` 判断，至少分类为：unauthorized、forbidden、login-page、empty-success、business-error、object-not-found、object-owned-by-self、object-owned-by-other、sensitive-success、rate-limited、challenge。

## 4. UI 总体规范

当前 `SrcView.tsx` 同时承担 tab、header、时间线、待办、审批、基础设施和命令回传，先拆组件再改视觉：

```text
SrcView
SrcHeader / OverviewView
TimelineView
AssetSurfaceView
FindingListView / FindingDetail
TodoListView / ApprovalListView
InfraView
CommandRelay
Card/Badge/Button/EmptyState/PreBlock
```

默认首屏必须回答：目标和授权是什么、下一步做什么、是否有用户事项、已有何种真实风险证据。若暂不新增 Overview tab，就在 explore 顶部加入 Overview。

视觉采取克制的 Vercel/shadcn 风格：radius 8/12/16，减少全局玻璃和阴影；红色仅漏洞/高危/错误，橙色待处理/防护，灰色历史/排除；状态不能只靠颜色。资产页优先列表和分组，图只做关系探索；漏洞页用概览卡片+详情抽屉；待处理页分“用户待办/高危 HTTP 审批/资产归属确认/历史”；时间线保留双栏但增加资产、意图、时间筛选和 500 条以上分页/窗口化。

必须支持键盘、可见 focus、aria-live、WCAG AA、375px/768px/1440px、pre 不撑破页面、reduced motion、重复点击和成功/失败/loading 状态。UI 不得直写 store，命令仍经过现有 relay。

## 5. 统一施工纪律

每次实现只能有一个主题，先写失败测试，再实现最小纯函数，然后接 domain/store、tool/command、projection/TS、UI。每个字段都检查：Zod、TS、fold、output schema、UI、fixture、报告和 legacy migration。网络测试只用本地 mock；不动用户模型配置、CPA 和真实厂商资产。

交付前：

```text
npm test
npm run ui-src:typecheck       # 有 UI 改动
npm run ui-src:build           # 有 UI 改动
npm pack + 解包加载
检查 deploy.mjs files 清单
双 profile md5 与双地址 200
```

中文 commit message，回滚必须是 `git revert` 后重新运行 `deploy.mjs`，不能只回滚源码。

## 6. 明确不做

暂不做全网端口扫描、默认目录爆破、大规模 ID 遍历、自动注册账号、自动生成真实违规 AI 内容、未经复核的自动提交、无限爬行、重量级 UI 框架和把权限声明冒充真实 sandbox。

## 7. 相关文档

- `docs/DEVELOPMENT.md`：当前工程红线和历史事实；
- `docs/CAPABILITIES.md`：当前外部能力 v2 用户规范；
- `docs/plan-capabilities-next.md`：基于实际源码的 Burp、mcp、skill、lesson、proof、宿主能力专项规划及 local.57a–58 单次实施规范。
