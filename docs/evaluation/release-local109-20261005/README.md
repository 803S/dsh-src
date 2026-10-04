# local.109 生产发布 · 2026-10-05

## 已修复的项目问题

- bash/curl/子进程统一受原生出口约束，有界任务审批、Jev建议与人工高危批准分离；详见完成审计。
- 部署清单漏掉根入口与Python代理插件：改为自动收集lib所有JS/Python文件，新增发布测试。
- 部署脚本可能重新启动Laya：删除自动拉起逻辑。
- 模型反复错误调用触发repeat guard时，错误缺少原生error字段导致序列化异常：改走原生异常处理。实际DSH第五次重复返回明确拒绝原因；见native-passed.json。
- Web启动脚本仅nohup，可能随调用进程组清理而退出：改为detached子进程并unref。
- 旧PID文件不再作为kill依据；只停止确认身份的DSH监听进程。
- HTML先就绪、RPC稍后挂载：启动等待真实API成功，而非只认HTTP200。

## 发布与验证

- 用户明确授权生产部署和Git推送。
- 备份：`/Users/lihua-dis/.dsh/backups/src-local109-20261005-010508`。包含两份旧插件、相关宿主插件/桥和一致性数据库备份。不要在发布后产生新数据时直接用旧DB覆盖，必须先核对。
- 生产Web原427会话均空闲后停止；部署web/headless两个profile为0.1.0-local.109。生产无常驻headless进程，不额外拉起。
- `deployment-verified.json`：两份profile共90项运行/配置/启动文件SHA256均与仓库一致；生产真实 `/src-egress-status` 返回success，scope=null，activeWorkerSlots=0。
- 新增一个仅执行只读命令的生产验收会话，未调用模型、未设置目标授权、未发目标请求。当前428会话均空闲。
- Web在调用终端退出后仍存活，PID94837、PPID1；页面HTTP200、session.list API成功；无Laya/mitmdump测试残留。
- 最新原生DSH测试：30次实际工具调用，审批、拒绝、核对、HTTPS、后台/子代理/能力脚本和重复错误均通过；**不是模型30次自主调用**。
- UI类型检查、构建、preset一致性通过；最终回归332项通过、0失败，日志见regression-tests.log。

## 不应误称已经解决的限制

- 历史 `egress-model-20261005/luna-script-passed.json` 是实际Luna自主脚本成功证据。发布前再次运行同模型，模型重复填写不合适的可选权限参数，16步预算耗尽；`luna-rerun-budget.json` 是失败/未完成记录，目标到达数0，不能算通过。模型调用稳定性不是本发布已解决事项；不以放宽权限或抹掉失败记录解决它。
- 上游供应商路由问题按用户要求不处理；没有改生产模型配置。
- 现有Zustand打包import.meta/CJS警告未改变运行结果，不属于本次修复。
- 未适配发送工具仍拒绝使用；宿主/内核/配置是可信边界；不存在“绝对零风险”保证。

Git提交/推送以最终回复的commit及远端核对结果为准。
