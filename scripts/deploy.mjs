#!/usr/bin/env node
/**
 * dsh-src 部署脚本：lib/src.js + package.json → 各 profile 的插件目录，md5 终验。
 *
 * 为什么是多副本：dsh profile 是自包含 pnpm workspace，profile 的 package.json 里
 * `@lihua_dis/dsh-src: file:<repo>` 会在 pnpm install 时被【复制】进该 profile 的
 * node_modules，进程运行时只加载自己 node_modules 里的那份。所以每个要用 dsh-src
 * 的 profile 都有一份副本，这是 dsh 隔离设计的正常成本，不是垃圾文件。
 *
 * 活目标（2026-08-31 实测确认）：
 *   - ~/.dsh/profiles/web/node_modules/@lihua_dis/dsh-src      ← web 进程加载
 *   - ~/.dsh/profiles/headless/node_modules/@lihua_dis/dsh-src ← headless 进程加载
 *
 * 【不要再部署】全局 dsh 包（pnpm global 目录下的 @deepseek-ai/dsh/lib/src.js）：
 *   早期安装方式曾把 dsh-src rsync 进 dsh 主包目录（该目录 package.json 因此被覆盖成
 *   dsh-src 的）。2026-08-31 证实是死代码：bin.js/plugin chunk 等全部 lib/*.js 零引用
 *   src.js，web 行为验证也只认 profile 副本。该文件留着无害，升级 dsh 时自然恢复。
 *
 * 用法：node scripts/deploy.mjs [额外目标目录 ...]
 * 部署后需重启对应 dsh 进程（web / headless）才生效。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
/* [local.48] scripts/caps-sync.mjs 一并部署：src_add_capability 动态 import 它的纯函数，
 * 且接线时 spawn 的是【部署副本】里的这份脚本。 */
const files = ["lib/src.js", "lib/src/state.js", "lib/src/context.js", "lib/src/protocol.js", "lib/src/playbooks.js", "lib/src/reporting.js", "lib/src/security.js", "lib/src/lessons.js", "lib/src/store.js", "lib/src/mutations.js", "lib/src/credentials.js", "lib/src/tools/index.js", "package.json", "scripts/caps-sync.mjs"];
const targets = [
  join(homedir(), ".dsh/profiles/web/node_modules/@lihua_dis/dsh-src"),
  join(homedir(), ".dsh/profiles/headless/node_modules/@lihua_dis/dsh-src"),
  ...process.argv.slice(2),
];

const md5 = (p) => createHash("md5").update(readFileSync(p)).digest("hex");
let failed = false;

/* [local.55] dsh-home 资产：仓库转私有后收编的插件源头，单向 repo → ~/.dsh。
 * 注意 capabilities.yaml 不在此列：它是运行时入口（src_add_capability 会追加写入），
 * 只收编备份进 git，不做部署覆盖（避免回滚运行时新增的能力条目）。 */
const dshHomeAssets = [
  { src: "plugins/dsh-session-history", dest: join(homedir(), ".dsh/plugins/dsh-session-history") },
  { src: "plugins/dsh-headless-src", dest: join(homedir(), ".dsh/profiles/headless/plugins/dsh-headless-src") },
];
const ASSET_EXCLUDE = new Set([".git", ".venv", "node_modules", "__pycache__", ".DS_Store"]);
function collectFiles(dir, base = dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ASSET_EXCLUDE.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectFiles(p, base));
    else if (ent.isFile()) out.push({ abs: p, rel: relative(base, p) });
  }
  return out;
}
console.log("─── dsh-home 资产（repo → ~/.dsh）───");
for (const a of dshHomeAssets) {
  if (!existsSync(a.src)) { console.error(`✗ 源不存在: ${a.src}`); failed = true; continue; }
  if (!existsSync(a.dest)) { console.error(`✗ 目标不存在（先手动创建或首次 rsync）: ${a.dest}`); failed = true; continue; }
  const list = collectFiles(a.src);
  let mismatch = false;
  for (const f of list) {
    const destination = join(a.dest, f.rel);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(f.abs, destination);
    if (md5(f.abs) !== md5(destination)) mismatch = true;
  }
  const ok = list.length > 0 && !mismatch;
  console.log(`${ok ? "✓" : "✗"} ${a.src} → ${a.dest}（${list.length} 文件${mismatch ? "，md5 不一致" : ""}）`);
  if (!ok) failed = true;
}

for (const t of targets) {
  if (!existsSync(join(t, "lib"))) {
    console.error(`✗ 目标不存在或缺 lib/（跳过）: ${t}`);
    failed = true;
    continue;
  }
  for (const f of files) {
    const destination = join(t, f);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repo, f), destination);
  }
  console.log(`✓ 已同步 → ${t}`);
}

console.log("─── md5 终验（repo 与各目标必须一致）───");
for (const f of files) {
  const hashes = new Set([md5(join(repo, f))]);
  for (const t of targets) {
    const p = join(t, f);
    if (existsSync(p)) hashes.add(md5(p));
  }
  const ok = hashes.size === 1;
  console.log(`${ok ? "✓" : "✗"} ${f}: ${[...hashes].map((h) => h.slice(0, 8)).join(" vs ")}`);
  if (!ok) failed = true;
}

if (failed) process.exit(1);
console.log("完成。记得重启 dsh web / headless 进程使新代码生效。");
