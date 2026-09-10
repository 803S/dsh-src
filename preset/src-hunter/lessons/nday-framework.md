# 框架与 nDay（指纹命中后的定向打法）

## 触发场景
- 识别出开源框架/知名组件指纹（VAppServer、VSB 站群、致远 OA、Sea.js、常见 CMS 等）。

## 打法
1. 立即创建框架研究 intent：①查公开 CVE/历史漏洞（NVD/CNNVD/GitHub advisory/exploit-db，用 web 搜索）匹配版本范围，把「框架+版本+已知漏洞」落 research（category: nday）；②开源框架直接拉源码（GitHub/Gitee）做定向白盒审计（category: framework-audit），针对目标定制点（如特定 jsp/DWR 接口族）找注入/越权/反序列化。
2. nDay 验证做最小化 PoC 确认（不利用、不深入），命中即 high+ finding。
3. 与厂商规则对照：厂商明确不收的 nDay 类型（如纯版本号泄露）如实降级为 research 记录，不硬凑 finding。

<!-- lesson-meta: {"sessionId": "builtin", "vulnType": "框架指纹与 nDay", "hook": "指纹命中先查公开 CVE/补丁对比再打；有源码/白盒线索优先对照已知漏洞模式", "createdAt": 1788720000000, "triggers": {"keywords": ["指纹", "CVE", "nDay", "框架", "CMS", "版本号", "白盒"]}} -->
