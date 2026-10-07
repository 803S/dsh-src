# local.120：恢复覆盖状态异常导致的会话加载失败

## 原因

最新会话的 `src_record_coverage` 未带 manifest，写入 `endpointStatuses["/render"]="vulnerable"`。旧写入路径未执行覆盖记录 schema 校验，读取的严格 schema 则只接受 tested/skipped/blocked/not-applicable。于是 `session.history` 和 `src-authoritative-state` 同时失败，整份会话无法加载。浏览器和真实 RPC 均已复现，不是文件丢失，也不是供应商错误。

## 修复

- 无论是否带 manifest，覆盖行写入前均使用现有 schema 校验；非法状态、非字符串值不能落库或发布成功事件。工具层不再静默过滤非法值。
- 旧行在读取时兼容：无效状态显示为 blocked，原值保留在限制说明，不计为已测试；不更改数据库原行、会话日志、漏洞或审批。
- 同时覆盖权威状态、旧工具事件、提交事件、覆盖提交事件及已缓存投影，不靠清缓存或删数据掩盖问题。
- 不新增依赖、表或后台服务，不放宽合法状态枚举，也不把 vulnerable 自动当成 tested。

## 验证

- 最新会话3106条原始日志离线完整回放，通过投影 schema，保留两条 finding。
- 新增回归：无 manifest 的非法覆盖拒绝写入；历史坏行可连续加载且原行不变；合法状态可纠正原行；三种历史事件与缓存投影均可读取。
- local.119 中间部署恢复了历史回放，但实际冷启动仍被存储schema拦住；没有算作完整恢复，也未发布正式Release。local.120将兼容补到DomainFacility开库解析入口，写入仍严格校验，并补真实SQLite关闭重开测试及提交日志对账。
- 541/541全量回归通过，发布预检及实际部署前再次通过；新测试使用真实SQLite后端和DSH DomainFacility关闭、重开两轮，确认磁盘原文不变，提交对账正常。
- 生产数据库副本整体冷启动通过：原会话11条覆盖、2条漏洞、3条审批可读。
- 北京时间2026-10-07 15:04完成local.120 Web/headless部署并重启，Web PID 7602；两份114个运行时文件与源码一致，424个会话保留，生产配置未改动。备份：`~/.dsh/backups/src-local120-20261007-150319`。
- **直接打开原会话** `session-4c0d5566-3034-4fb0-a6c9-eefed5a8539f`：`session.history` RPC成功，浏览器进入对话及SRC面板均成功，无页面错误。原始 coverage-2 行与部署前逐字节一致；不是用新会话代替验收。
- 功能提交 `72c5fa7`、标签 `v0.1.0-local.120` 已推送；[正式发行版](https://github.com/803S/dsh-src/releases/tag/v0.1.0-local.120)及安装包独立下载校验完成。local.119保留为中间修复记录，未发布正式Release。
- 无新增依赖、表或服务；安装包比local.118仅增加928字节。测试及交付凭据在 `~/.local/share/dsh-src/releases/0.1.0-local.120/`；原有 `artifacts/` 未修改。
