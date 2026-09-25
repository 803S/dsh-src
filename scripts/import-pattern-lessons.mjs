#!/usr/bin/env node
/* Phase 8: 将「打穿短表」一次性转换为安全的 distilled pattern lessons。
 * 默认 dry-run；加 --write 才写入 DSH_SRC_LESSONS_DIR。不会把源表原文复制进经验库。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const source = process.env.DSH_SRC_SHORT_TABLE ?? "/Users/lihua-dis/Downloads/clown-src-6k-skill/skills/skill/知识库/打穿短表.md";
const outDir = process.env.DSH_SRC_LESSONS_DIR ?? path.join(os.homedir(), ".dsh", "storages", "src-lessons");
const write = process.argv.includes("--write");
const redact = (value) => String(value ?? "")
  .replace(/https?:\/\/[^\s|）)]+/gi, "某目标地址")
  .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, "目标域")
  .replace(/(?:^|[\s|])\/(?:[a-z0-9._-]+\/)*[a-z0-9._-]+/gi, " 目标路径")
  .replace(/\b(?:[A-Za-z0-9_-]{24,}|(?:sk|ak|jwt|token|secret|password|key)[=:：][^\s|，。；;]+)/gi, "<敏感值>")
  .replace(/\s+/g, " ").trim();
const slug = (text) => `pattern-${crypto.createHash("sha1").update(text).digest("hex").slice(0, 12)}`;
const features = (text) => {
  const map = { api: /接口|API|endpoint|网关/i, auth: /登录|认证|会话|权限|越权/i, credential: /凭证|token|密钥|secret|签名/i, upload: /上传|文件|对象存储|下载/i, browser: /浏览器|前端|页面|JS|DOM/i, mobile: /小程序|安卓|Android|App/i, cors: /跨域|Origin|CORS/i, business: /订单|金额|促销|业务|流程/i };
  return Object.entries(map).filter(([, re]) => re.test(text)).map(([key]) => key);
};
const lines = (await fs.readFile(source, "utf8")).split("\n");
const rows = lines.filter((line) => /^\|/.test(line) && !/^\|[- ]+\|/.test(line) && !line.includes("认什么 |"));
const seen = new Set();
const lessons = [];
for (const row of rows) {
  const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
  if (cells.length !== 4) continue;
  const [recognize, attack, success, falsePoint] = cells.map(redact);
  const key = recognize.toLowerCase();
  if (!recognize || seen.has(key)) continue;
  seen.add(key);
  const meta = { kind: "pattern", vulnType: "短表形态 pattern", featureKeys: features(`${recognize} ${attack} ${success}`), source: "打穿短表（安全转换）", createdAt: Date.now() };
  const text = [`# ${recognize.slice(0, 80)}`, "", "## 认什么", recognize, "", "## 打哪", attack, "", "## 出什么算成", success, "", "## 假点", falsePoint, "", `<!-- lesson-meta: ${JSON.stringify(meta)} -->`, ""].join("\n");
  lessons.push({ file: `${slug(recognize)}.md`, text });
}
console.log(`pattern seed rows=${rows.length}, unique=${lessons.length}, output=${outDir}, mode=${write ? "write" : "dry-run"}`);
if (!write) {
  for (const lesson of lessons.slice(0, 5)) console.log(`- ${lesson.file}`);
  process.exit(0);
}
await fs.mkdir(outDir, { recursive: true });
for (const lesson of lessons) {
  const target = path.join(outDir, lesson.file);
  try { await fs.access(target); continue; } catch {}
  await fs.writeFile(target, lesson.text, "utf8");
}
console.log(`wrote ${lessons.length} safe pattern lessons (existing files preserved)`);
