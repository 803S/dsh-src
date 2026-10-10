# 宿主 GenericCommandCard 折叠渲染修复

日期：2026-10-10。对应问题：`global-audit-and-optimization-plan-20261009.md` §2。

## 根因

宿主 `@deepseek-ai/dsh-client-ui-conversation` 的 `GenericCommandCard` 原实现：

- `summary` 直接使用完整 `node.outcome.text`；
- 只有文本含换行时才创建正文；单行巨型 JSON 反而没有独立正文；
- 折叠状态仍把完整文本放进 summary DOM；
- 页面切换时巨大文本节点参与布局和 `scrollHeight` 计算。

因此折叠不是懒加载。原始会话仍只读保留在本地 session 历史，本次没有重写、删除或脱敏历史。

## 补丁

脚本：`scripts/patch-host-command-card.mjs`

- 只接受已知 bundle 文本模式；未知版本拒绝修改；
- 修改前按原 SHA-256 备份到 `$DSH_HOME/backups/command-card/`；
- summary 上限 320 字符；
- 单行/多行结果都可展开；
- 关闭时 `pre` 正文不挂载；只有 `open=true` 才创建正文节点；
- 重复执行幂等；不改宿主 compaction、通用 retry 或 new-api。

当前宿主 bundle：

```text
before: dc48b35b74c71ddfe321d5a8e2604bbbbbc7e5136876740616ef4292b4e61b52
patched: 68843d6bdf58f1e8f03f2f2e8a0b7d484e25a62152f361147bab38abe5ef2d55
backup: /tmp/dsh-command-card-fix-20261010/client.js.before
```

当前运行 bundle 的共享真实路径为：
`/Users/lihua-dis/Library/pnpm/global/v11/1051a-1a01d77de3d-060fb6a9751d8d8c/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`

若宿主包重新安装，执行：

```bash
node scripts/patch-host-command-card.mjs
```

脚本遇到未知 bundle 会拒绝修改，不能把它当成永久兼容 API；宿主升级后应重新做 A/B 和 hash 审查。

## 实测

目标历史：本机已有大历史会话 `session-bda5bad4-7c0b-44bf-a315-0a593aba6565`。

Chrome 1440×1000，旧会话热切换 5 轮：

```text
SRC → 对话：130ms、148ms、147ms、148ms、152ms
主线程长任务：58–73ms
pageerror：0
```

修复后 DOM：

```text
摘要节点：42
摘要最大长度：333（包含折叠提示）
关闭状态正文 pre：0
超过 100,000 字符的 span：0
```

此前同一会话原始实现约 4467–4763ms；浏览器摘要 A/B 约 141–154ms。此次真实 bundle 加载后的复测仍为 130–152ms，达到百毫秒级改善。

## 边界

- 这是宿主展示层兼容补丁，不是项目源码内的正式上游版本；已明确记录 hash、备份和可重复脚本。
- 原始大历史仍保留，展开正文仍可查看；本次没有改变 SQLite/session JSONL 的证据内容。
- 新 `src_state` 仍默认 summary，避免继续生成大 command 结果；两层修复需要同时保留。
- 当前生产真实模型主动会话仍曾被上游 429 阻断；本性能复测是浏览器直接打开已有会话，不依赖模型额度。
