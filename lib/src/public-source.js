// Public research source guard. Reading an advisory is not target traffic and must not
// silently enlarge the authorized target scope. This module performs URL/address checks;
// the caller supplies the actual bounded GET transport.
import { promises as dns } from 'node:dns';
import { BlockList, isIP } from 'node:net';

const DEFAULT_HOSTS = new Set([
  // 官方公告/漏洞库（读公告不是打目标）
  'nvd.nist.gov', 'cve.org', 'www.cve.org', 'security-tracker.debian.org', 'oss-security.openwall.org',
  'www.zerodayinitiative.com', 'security.googleblog.com',
  // 代码与仓库检索（找泄露/配置/版本线索）
  'github.com', 'api.github.com', 'raw.githubusercontent.com', 'grep.app', 'searchcode.com',
  // 资产收集只读源：证书透明度、被动索引、公共 DoH
  'crt.sh', 'api.certspotter.com', 'app.agniops.in', 'api.fofa.info', 'dns.google', 'cloudflare-dns.com',
  // 搜索引擎与历史快照
  'html.duckduckgo.com', 'duckduckgo.com', 'www.google.com', 'www.bing.com', 'cn.bing.com', 'www.baidu.com', 'web.archive.org'
]);
const blockedV4 = new BlockList();
const v4 = (a,b,c,d) => [a,b,c,d].join('.');
for (const [[a,b,c,d], prefix] of [[[0,0,0,0],8],[[10,0,0,0],8],[[100,64,0,0],10],[[127,0,0,0],8],[[169,254,0,0],16],[[172,16,0,0],12],[[192,0,0,0],24],[[192,0,2,0],24],[[192,168,0,0],16],[[198,18,0,0],15],[[198,51,100,0],24],[[203,0,113,0],24],[[224,0,0,0],4],[[240,0,0,0],4]]) blockedV4.addSubnet(v4(a,b,c,d),prefix,'ipv4');
const blockedV6 = new BlockList();
for (const [subnet, prefix] of [['::',128],['::1',128],['::ffff:0:0',96],['64:ff9b:1::',48],['100::',64],['2001:db8::',32],['fc00::',7],['fe80::',10],['ff00::',8]]) blockedV6.addSubnet(subnet,prefix,'ipv6');
function isPrivateIp(value) {const version=isIP(String(value));return version===4?blockedV4.check(String(value),'ipv4'):version===6?blockedV6.check(String(value),'ipv6'):false;}
export function publicSourceHosts() {
  const extra = String(process.env.DSH_SRC_PUBLIC_SOURCE_HOSTS ?? '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  return new Set([...DEFAULT_HOSTS, ...extra]);
}
export async function validatePublicSourceUrl(raw, { hosts = publicSourceHosts(), resolve = dns.lookup } = {}) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new Error('公共资料 URL 无法解析'); }
  if (url.protocol !== 'https:') throw new Error('公共资料只允许 HTTPS GET');
  if (url.username || url.password || url.hash || url.port && url.port !== '443') throw new Error('公共资料 URL 不允许凭据、hash 或非标准端口');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hosts.has(host)) throw new Error(`资料来源未在可信来源清单：${host}；可用 DSH_SRC_PUBLIC_SOURCE_HOSTS 显式添加精确主机`);
  if (host === 'localhost' || host.endsWith('.local') || isPrivateIp(host)) throw new Error('公共资料地址不能指向本机或私有地址');
  let addresses;
  try { addresses = isIP(host) ? [{ address: host }] : await resolve(host, { all: true, verbatim: true }); }
  catch (error) { throw new Error(`公共资料域名解析失败：${error.message}`); }
  if (!addresses.length || addresses.some(row => isPrivateIp(row.address))) throw new Error('公共资料域名解析到了本机/私有地址，拒绝请求');
  return { url: url.href, host };
}
export function boundPublicText(raw, maxChars = 20000) {
  const limit = Math.min(Math.max(Number(maxChars) || 8000, 500), 20000);
  const text = String(raw ?? '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#(?:x27|39);/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  return { text: text.slice(0, limit), truncated: text.length > limit, chars: Math.min(text.length, limit), sourceChars: text.length };
}
