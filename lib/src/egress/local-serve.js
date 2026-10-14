// 本机 POC 托管（src_serve_proof）活跃 origin 注册表。
//
// 为什么需要它：src_serve_proof 把本机局域网 IP 当受控 VPS 用（返回
// http://<LAN-IP>:<port>/poc.html）。当浏览器/目标页面回连这个 URL 时，它经过我们
// 自己的出口闸，而闸有两处把它们当外部目标拒绝：
//   ① pinOrigin 只接受公网地址 → 私网 LAN IP 直接 NON_PUBLIC_TARGET（浏览器合成 403）；
//   ② 范围闸要求 origin 在人类声明的范围里 → LAN IP 不在其中。
// 但它并不是外部目标：它是本进程刚起、载荷已由人类一次性批准、TTL 到点自动关闭的
// 我们自己的监听器。
//
// 边界（刻意收窄）：
//   * 只按精确 origin 命中（scheme+host+port 全等），不做网段/通配；
//   * 只在 TTL 内有效，且该 origin 永不写入持久化 scope（避免私网 pin 破坏
//     validateStoredScope 的「公网才可 pin」不变量）；
//   * 不授权任何其他主机、端口或路径。
const active = new Map();

function sweep() {
  const now = Date.now();
  for (const [origin, entry] of active) if (entry.expiresAt <= now) active.delete(origin);
}

export function registerLocalServe({ origin, serveId, sessionId, expiresAt }) {
  sweep();
  const key = String(origin);
  const entry = { origin: key, serveId: String(serveId), sessionId: String(sessionId ?? ''), expiresAt: Number(expiresAt) || Date.now() };
  active.set(key, entry);
  return entry;
}

export function unregisterLocalServe(serveId) {
  for (const [origin, entry] of [...active]) if (entry.serveId === String(serveId)) active.delete(origin);
}

export function isLocalServeOrigin(origin) {
  sweep();
  return active.has(String(origin));
}

export function localServePins(origin) {
  sweep();
  const entry = active.get(String(origin));
  if (entry === undefined) return undefined;
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
  return [{ address: host, family: host.includes(':') ? 6 : 4 }];
}

export function localServeOrigins() {
  sweep();
  return [...active.keys()];
}
