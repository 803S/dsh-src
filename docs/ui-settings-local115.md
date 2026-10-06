# local.115：Jev 设置、主题可读性与域删除交互

## 本轮范围

仅修改前端及构建产物；不修改审批/网络执行后端、数据库结构或供应商配置。

- Jev 设置分为连接、职责、保存与测试结果区；四项职责仍采用 on/shadow/off。
- 密钥不回填，输入为空保留原 key，勾选清除才清除；新 key 可显隐。更换 origin 时不把旧 key 自动重发，继续接受服务端校验。
- 测试已保存配置时保留草稿；错误不清空输入；保存及测试各自有明确反馈。
- 「查看报告」使用 #405bd9 底/#fff 字，不再错误组合会随主题反转的 brand-primary 和固定白字。
- 域管理拆为 `DomainDataView`，确认用 top-layer `<dialog>`，无需手输目标；点击确认才向服务端传 `/src-delete-domain <target> confirm <target>`，服务端接口保持原状。
- 删除失败留在弹窗；成功但刷新失败不谎称删除失败；双击不重复提交。运行中禁止删除、精确范围/共享凭据保留仍是后端责任。

## 验证

- `npm run ui-src:typecheck` 与 `npm run ui-src:build` 已通过。
- `npm run ui-src:test` 已通过：真实 UI bundle、宿主浅/深主题、390px 窄屏、四项职责保存、密钥保留/更换/清除、测试不覆盖草稿、保存/连接失败、删除取消/Esc/焦点循环、免输入、失败/重试/双击、报告跳转。
- 按钮两主题实测对比度 5.6506558715:1。截图和 results.json 在 `/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-ui-settings-gpqWAI`，不随安装包发布。
- 首轮浏览器测试发现 Chrome Tab 焦点可离开初始按钮，已增加显式首尾焦点循环，复跑通过。
- 以上 UI 命令为合成适配器，不等同于真实 Jev 服务准确率或生产数据删除验收；没有删除任何生产域数据。

## 交付状态

- 发布前全量回归 516/516 通过；两个 profile 已同步 121 个核心文件和 12 份内置经验，部署脚本哈希终验通过。
- Web 已优雅重启（PID 54522）；重启前后 424 个会话均 idle（备份检查时为 423，期间新增会话，不执行任何删除）。备份与部署日志：`/private/tmp/dsh-ui115-delivery.rmmxZ4`。
- 实际 DSH Web（含 Open Sea Skin）深色主题验收通过：Jev 页加载、已有 key 不回填、报告按钮 #405bd9 底/#fff 字、域数据弹窗打开/取消、无输入域名框、零 pageerror。未点击真实保存/连接测试/删除。`live-ui.json` 与服务端 bundle 哈希在上述日志目录。
- Git 与 Release 待本次提交后发布；尚未将“本机部署”混同于“发行版已发布”。

## 前轮 Git 判断纠正

前轮“后端未提交内容可能丢失”的判断错误：发布前 git status 已只剩 UI 变更；异步审批等文件已在 local.111–113 提交中。`22d3d16..4bed8bd` 没有后端差异，无需恢复不可达旧对象。前轮临时 worktree 已移除，后续仍从唯一主目录 `/Users/lihua-dis/Software/dsh-src` 的 main 开发及部署。
