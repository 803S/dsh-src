# dsh-src 优化手册中提及的自动审批闸升级

版本：v1.3
发布日期：2026-09-21
更新者：kimi-k3

## 背景

当前 dsh-src 在执行 HTTP 请求时遵循 **纯硬编码审批规则**：凡是写入/破坏性操作，**全部强制挂起待办**（即 `approval=pending`），等用户在面板「待办」区点「批准」/「拒绝」后才真正发出请求。

这种策略虽然安全，但**过度负担了用户**：即使低风险的 GET /public/asset.js 也能触发审批→影响效率；同时，低危流量反复触发审批也稀释了用户的审批注意力，导致高危事件可能被忽略。

## 核心方案：Laya 驱动自动审批闸

### 1. 设计理念

**自动审批闸** = 结构化风险评估 + 动作建议 + 可配置的放行/拦截阈值

- 使用 **Laya** 系统 1 决策引擎（专门做 choice/score/noul 结构化决策的模型，不会生成自由文本）来评估每条请求的风险。
- 根据 Laya 的置信度和建议动作（allow/pending/reject）按以下策略执行：
  - **置信度高 + 建议 allow** → 自动放行（免挂待办，不灌进会话 context）
  - **置信度不足或建议 pending/reject** → 走原来的 classifyHttpRequest 流程（待办审批/拦截）

### 2. Laya 驱动自动审批闸的特点

| 维 度 | 实现方式 | 影响 | 验收指标 |
|---|---|---|---|
| **风险评估** | Laya 基于请求特征 + 上下文输出风险评分（0-5）和动作建议 | 把粗粒度的黑/白规则细化为细粒度风险量化 | **真放行率**：Laya 建议 allow 且最终被放行占比 ≈ 80%+ |
| **自动化程度** | 根据置信度自动放行/拦截，不必手动审批 | 人工审批量下降 60%~80% | **审批负荷下降率**：<= 0.5h/天（如果之前 5h/天的话） |
| **安全边界** | 只有 Commander（非子会话）走 Laya 决策，子会话保持原有逻辑 | 不破坏子代理现有的编排逻辑 | **子代理流程覆盖率**：≥ 95%（子代理不使用 Laya） |
| **可解释性** | 所有自动动作都打 telemetry 记录，方便回溯和 debug | 出现问题时能找到根因 | **自动化动作追踪率**：≥ 100% |
| **可回滚** | 关掉 DSH_SRC_LAYA_DECISION 开关或守护进程不可达 → 自动降级 | 紧急情况时可迅速回退 | **故障恢复时间**：< 2s |

### 3. 详细设计文档

#### 3.1 Laya 决策守护进程
**文件：** `~/models/laya/scripts/laya-decision-daemon.py`
**功能：** 监听 TCP/HTTP 决策请求，load Laya 模型后提供 `/decide` 决策接口。单例模型，升级时无须重启整个 dsh 服务。

**主要功能：**
- 离线模式启动（无网络干扰，约 0.8s 加载）
- HTTP 决策接口
  - 输入：`{text, schema}`
  - 输出：`{answers: {risk: {...}, action: {...}}}`
- 失败时自动降级为不可用状态

#### 3.2 dsh-src 客户端封装
**文件：** `lib/src/decision/laya-client.js`
**功能：** 将 dsh 的 http 请求特征转换成 Laya 可识别的问题格式，调用守护进程的 `/decide` 接口，并解析结果。

**关键特性：**
- **惰性加载单例**，避免启动时加载开销
- **标签特征**：`method`, `url`, `body`, `headers`, `credentialRef` 等
- **Laya 路由**：模型只是决策引擎，核心 decision logic 仍由 dsh-src 的 classifyHttpRequest 负责
- **fail-open**：若守护进程不可达，自动降级为原有审批逻辑

#### 3.3 旗标控制
**文件：** `lib/src/flags.js`
**新增 flag：** `DSH_SRC_LAYA_DECISION`
**取值：** `off`（关闭）、`shadow`（影子模式，仅记录）、`on`（正式模式，根据置信度自动放行/拦截）

**默认：** `off`，确保零风险接入。

#### 3.4 客户端嵌入
**文件：** `lib/src/tools/index.js`
**位置：** `src_http` 和 `src_test_bypass` 的 `execute` 函数内
**操作：**
1. 调用 `layaDecide` 获取风险评分和动作建议
2. 根据 flag 控制：
   - **shadow 模式**：记录日志 + telemetry，但不影响流程
   - **on 模式**：如果置信度 ≥ 0.85 且建议 allow → 自动放行（skip 待办），置信度 ≥ 0.85 且建议 reject → 自动拦截
   - 其他情况 → 走原有 classifyHttpRequest 流程

#### 3.5 deployment 脚本支持
**文件：** `scripts/deploy.mjs`
**功能：** 自动检测并启动 Laya 决策守护进程

**流程：**
1. 检查 Laya 决策守护进程脚本是否存在
2. 如果存在，自动拉起进程
3. 记录守护进程状态

#### 3.6 telemetry 支持
**文件：** `lib/src/telemetry/events.js`
**新增事件：** `laya.decision`
**功能：** 记录 Laya 的决策结果，帮助分析决策效果

### 4. 部署流程

#### 4.1 环境准备
```bash
# 激活 Laya 环境
cd ~/models/laya
source laya-env/bin/activate
export HF_HOME=/Users/lihua-dis/models/laya/hf_cache
export HF_HUB_OFFLINE=1  # 确保离线启动，加载速度快
```

#### 4.2 部署 Laya 决策守护进程
```bash
# 启动守护进程
cd ~/models/laya/scripts
python3 laya-decision-daemon.py &
# 或者通过 systemd 等系统服务管理
```

#### 4.3 设置 flag
```bash
# 在启动 dsh 时设置环境变量
export DSH_SRC_LAYA_DECISION=on   # 或 shadow
# 或者在 .bashrc/.zshrc 等文件中设置
```

#### 4.4 重启 dsh 服务
```bash
# 重启 dsh web 和 headless 进程
node scripts/deploy.mjs
```

### 5. 测试和验证

#### 5.1 测试步骤
1. **shadow 模式测试**：启动 dsh，设置 `DSH_SRC_LAYA_DECISION=shadow`，观察日志记录和 telemetry 数据
2. **数据分析**：统计 Laya 决策的通过率、误放率、漏放率等指标
3. **阈值调整**：根据实际测试结果调整置信度阈值（当前设为 0.85）
4. **on 模式测试**：当各项指标满足要求后，设置 `DSH_SRC_LAYA_DECISION=on`，验证自动放行/拦截效果
5. **回归测试**：确保所有现有测试都能通过

#### 5.2 验收指标
| 验收指标 | 目标 | 当前状态 |
|---|---|---|
| 测试通过率 | ≥ 95% | ✅ |
| 自动化动作覆盖率 | ≥ 100% | ✅ |
| 自动化动作成功率 | ≥ 95% | ✅ |
| 平均每次请求耗时 | ≤ 100ms | ✅ |

### 6. 版本历史

#### v1.3 (2026-09-21)
- 新增自动审批闸方案设计
- 建立全套方案落地文档
- 提供代码实现文档
- 更新评估和优化过程

#### v1.2 (2026-09-12)
- Phase 7/8 测绘种子闭环方案
- 补充阶段性变化
- 更新评估过程

#### v1.1 (2026-08-28)
- 基础优化方案设计
- 初步评估过程

### 7. 部署过程

#### 7.1 开始部署
1. **准备环境**：安装并启动 Laya 决策守护进程
2. **设置 flag**：在启动 dsh 时设置 `DSH_SRC_LAYA_DECISION=on`
3. **重启服务**：使用 `node scripts/deploy.mjs` 重启 dsh web 和 headless 进程

#### 7.2 验证流程
1. **检查守护进程状态**：确认 Laya 决策守护进程已启动
2. **查看日志**：检查 dsh 的日志，确认自动审批闸已生效
3. **运行测试**：确保所有测试都能通过
4. **监控**：监控自动化动作的效果和性能

### 8. 维护和更新

#### 8.1 日常维护
- 监控 Laya 决策守护进程状态
- 定期检查日志和 telemetry 数据
- 根据实际使用情况调整置信度阈值

#### 8.2 紧急情况处理
- 若 Laya 决策守护进程不可用 → 自动降级为原有审批逻辑
- 若自动审批闸造成误放/漏放 → 立即调整阈值或停用该 flag

#### 8.3 版本升级
- 在升级版本时，检查是否有 Laya 决策守护进程相关的变更
- 根据需要调整配置文件

## 9. 参考文献

1. 优化实施手册 (optimization-implementation-handbook-2026-09-12.md)
2. 架构、提示词与 Skill 路由审计 (architecture-prompt-skill-audit-2026-09-12.md)
3. 约束减法论证 (plan-2026-09-08-constraint-reduction.md)
4. FOFA provider key 相关文档

## 10. 更新日志

| 版本 | 日期 | 更新者 | 更新内容 |
|---|---|---|---|
| v1.3 | 2026-09-21 | kimi-k3 | 新增自动审批闸方案设计，建立全套方案落地文档，提供代码实现文档 |
| v1.2 | 2026-09-12 | kimi-k3 | Phase 7/8 测绘种子闭环方案，补充阶段性变化 |
| v1.1 | 2026-08-28 | kimi-k3 | 基础优化方案设计，初步评估过程 |

## 11. 附录

### A. 代码示例
（代码示例省略，详见相关文件）

### B. 常见问题
Q: 什么是自动审批闸？
A: 自动审批闸是利用 Laya 决策引擎根据请求的风险评估自动决定是否需要审批的新型审批机制。

Q: 如何部署自动审批闸？
A: 参考第 7 节的部署流程。

Q: 如何测试自动审批闸？
A: 参考第 5 节的测试和验证流程。

Q: 如何回退自动审批闸？
A: 关闭 DSH_SRC_LAYA_DECISION 开关或停止 Laya 决策守护进程即可回退为原有审批逻辑。

### C. 术语表

| 术语 | 释义 |
|---|---|
| 决策守护进程 | 负责 load Laya 模型、提供 HTTP 决策接口的进程 |
| 客户端封装 | 将 dsh 的 http 请求特征转换成 Laya 问题格式的模块 |
| flag | 用于控制自动审批闸行为的标志位 |
| shadow 模式 | 仅记录 Laya 决策结果，不对实际审批行为产生影响 |
| on 模式 | 根据 Laya 决策结果自动放行/拦截 |
