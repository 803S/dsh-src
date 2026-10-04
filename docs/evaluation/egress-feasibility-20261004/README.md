# DSH bash 强制出口可行性实证

日期：2026-10-04。目的：先验证轻量接入条件，不实现或部署整套审批网关。

## 结论

当前这台 macOS、DSH rc.8、workspace-write 条件下，可以在 DSH 原生 Seatbelt 配置上叠加网络规则，让真实 bash 工具进程及本次测试中的子进程只能访问指定本地出口，同时保留测试过的本地文件创建、覆盖、删除。

不需要为这个基本条件引入 VM、全局防火墙或系统代理。生产持久化接入尚未完成，试验仅在隔离 DSH 进程中包装 sandbox.confine，未修改宿主依赖或生产配置。

## 两层证据

1. 确定性实验使用安装的 LocalSandboxProvider 生成原生配置：baseline 直连成功；追加 network 约束后直连失败、指定代理读取成功、代理拒绝模拟 DELETE，子 shell/Python/后台进程没有到达目标，本地文件操作成功。
2. 真实 DSH + 当前已配置模型 newapi/hy4：session-357cd02a-f259-4669-9756-b13fcc664311。3 steps、6 次真实 bash 调用，6 次 actual-confine；累计上下文 token 56,061，不是账单价格或独立信息量。
3. 目标服务独立记录只收到 GET /read 一次。代理记录 GET 与 DELETE 各一次，DELETE 在代理返回固定 fixture 拒绝响应，未向目标发送。
4. 此实验的拒绝逻辑是固定合成规则，不是 Jev，也没有人工审批。验证的是“实际流量能否强制到某个出口，出口能否阻止发送”。

网络限制没有在 tools.guard 中按命令文本阻断。guard 只限制本次测试为 bash 且不允许提权；模型实际运行 curl/Python。外部 Codex 沙箱阻止回环端口监听后，经用户批准在其外运行，实际阻断来自实验中的 DSH/Seatbelt 约束，不是 Codex 外层阻断。

## 范围与未验证项

- 当前仅 HTTP、workspace-write、bash 进程树。未验证 TLS 解密、HTTP/2、IPv6、UDP、Unix socket、系统服务代发、控制面密钥隔离、danger-full-access、持久 shell、完整 DSH 子代理、浏览器/Burp/MCP。
- 宿主现有 danger-full-access 路径会绕开 sandbox.confine；本试验不解决该问题，也没有证明提权后仍受控。
- 现有 DSH sandbox.denied 标记主要识别文件错误，curl 的网络拒绝未必表现为 denied=true；后台 wait/curl HTTP403 也可能退出0。验收依据是实际目标日志，而不是工具 isError 或 shell exit。
- 第一次底层实验 Seatbelt 不接受数值 loopback 地址表达，改为 localhost:指定端口后才通过。首次失败未计为通过；无需改系统设置。
- 一次测试中的进程继承成功不等于覆盖全部 OS 逃逸/IPC 路径。不能据此宣称“所有流量绝无旁路”或生产可用。

## 复现

仓库根目录运行，可能需要本机允许回环监听与 sandbox-exec：

```sh
node scripts/egress-feasibility/network-probe.mjs
node scripts/egress-feasibility/dsh-run.mjs --run
```

第二条启动独立 DSH_HOME 的真实会话，使用已有配置模型；有付费调用，固定120秒/8步/12工具调用上限。无 Jev 调用，不触生产目标。脚本在正常退出/异常 finally 路径移除临时 .credentials.yaml；若整个父进程被 SIGKILL，需要人工清理该临时凭据文件。

本目录保存脱敏结果和实际 prompt；完整实验日志路径见 JSON 的 home。生产源码与依赖未改动。

## 对方案的影响

优先选择“复用原生执行 seam 的网络约束 + 成熟代理 + 既有审批系统”，没有证据要求一上来引入重型虚拟化。下一项应单独验证 TLS 可检查性及本地权限模式变化不会解除目标网络约束；未验证的浏览器/MCP 不能算已纳管。
