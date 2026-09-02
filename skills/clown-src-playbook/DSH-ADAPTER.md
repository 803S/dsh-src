# clown-src 专家知识库：dsh-src 适配说明

## 定位

本目录是 SRC 黑盒研究方法论和专题知识库的本地只读副本。它用于增强 dsh-src 的目标选择、接口建模、类型矩阵、差分验证、攻击链升阶和报告证据判断，不替代 dsh-src 的服务端约束。

本适配层只服务 dsh，不使用原项目中的 Grok 身份覆盖、Windows 配置、桌面任务目录、Playwright 双槽启动器或朋友移交提示词。

## dsh 工具映射

| 专家方法 | dsh-src 记录/工具 |
|---|---|
| 目标和授权边界 | `src_add_goal`、`src_set_goal_target`、`src_add_asset` |
| 被动资产与接口发现 | `src_collect_passive`、`src_collect_dorks`、`src_record_observation` |
| 一个测试假设 | `src_add_intent`、`src_record_research` |
| 子代理执行 | `src_recon`、`src_audit`、`src_verify` |
| 子代理结构化交付 | `src_submit` |
| 资产归属确认 | `src_request_asset_confirm` |
| 请求/响应证据 | `src_record_observation`、`src_add_fact` |
| 真实流量 | Burp MCP、`src_import_traffic` |
| 厂商规则 | `src_fetch_policy` |
| 经验沉淀 | `src_record_lesson`、`src_record_domain_note` |
| 最终报告 | `src_finalize_engagement`、`src_report` |
| 用户阻塞事项 | `src_user_todo` |

## 使用协议

1. 先用 `src_state` 判断当前 goal、资产、intent、待办和已覆盖面。
2. 进入目标后先建立短接口/资产清单，再按现场选择专题文件；不要无条件通读全部知识库。
3. 读到一个专题后，把它转成 dsh 的 `src_add_intent`、`src_record_research` 和可验证的停止条件。
4. 任何外部产出都要经过 `src_record_observation` 或 `src_add_fact` 固化；没有证据指针不能提交 finding。
5. 子代理必须使用真实父 intent，并通过 `src_submit` 提交 facts/assets/findings/checkpoint；失败时提交 blocked/failed 状态，不要静默结束。
6. 最终 finding 仍必须满足 dsh-src 的 `victimImpact`、`attackPrerequisites`、`concreteLossEvidence`、`rawRequest` 等服务端门禁。
7. CORS 遵循现有 dsh-src 规则：不挖、不作为 finding。
8. 任何外部能力脚本都必须通过 `src_run_capability`，等待面板人工审批；本知识库当前不注册脚本，只有文档读取。

## 选读路由

- 总体起手：`skills/skill/知识库/打穿短表.md`
- 范围、种子和深挖节奏：`rules/dig-scope-workflow.md`
- 价值排序和类型矩阵：`rules/src-value-hunting.md`
- 经验迭代：`rules/hunt-iter.md`
- 报告准入：`rules/vuln-report-format.md`、`skills/skill/知识库/README.md`
- JS/签名/前端接口：`skills/skill/知识库/js-reverse-guide.md`
- 越权/对象图：`skills/skill/知识库/idor-test.md`
- 认证/换票/接管：`skills/skill/知识库/authbypass-test.md`、`oauth-jwt-test.md`
- 注入：`skills/skill/知识库/injection-test.md`
- SSRF：`skills/skill/知识库/ssrf-test.md`
- XSS：`skills/skill/知识库/xss-test.md`
- 上传和对象存储：`skills/skill/知识库/file-upload-test.md`
- 业务逻辑与竞态：`skills/skill/知识库/logic-test.md`、`race-condition-test.md`
- AI/对话工具真实执行：`skills/skill/知识库/agent-tool-exec-test.md`

## 统一本地配置

用户只维护 `$DSH_HOME/capabilities.yaml` 这一份本地配置。能力声明、代理和 FOFA 运行配置都放在该文件的 `settings:` / `capabilities:` 中；profile patch、`capabilities/index.json`、能力安装目录和 MCP 启动环境都是自动生成物，不需要手改。

FOFA 的账号和 Key 可以直接写在 `settings:` 的 `fofaEmail`、`fofaKey`、`fofaEmailBackup`、`fofaKeyBackup`、`fofaEmailBackup2`、`fofaKeyBackup2` 字段中。该文件只保存在本机，权限应为 `600`，不得提交或上传。FOFA 启动器只从这份文件读取凭据，不读取散落的 `.env` 或 PowerShell 配置。

FOFA 测绘仍必须遵守当前 dsh-src 的授权资产边界、单种子闭环、限流和证据记录规则；Key 可用不等于可以扩大目标范围。

