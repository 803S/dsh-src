#!/usr/bin/env node
/**
 * 对 @deepseek-ai/dsh-client-ui-conversation 的 GenericCommandCard 做最小展示补丁。
 *
 * 目的：折叠摘要只保留有界文本；正文只有用户展开时才挂载。原始 session/event 不修改。
 * 这是宿主 UI 兼容补丁，不改 compaction/retry/new-api。未知 bundle 版本默认拒绝修改，防止
 * 静默把错误文本写进宿主包。每次修改前将原文件保存到 DSH_HOME/backups/command-card。
 */
import { copyFile, mkdir, readFile, rename, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const candidates = [
  process.env.DSH_CONVERSATION_CLIENT_BUNDLE,
  path.join(home, 'profiles/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'),
  path.join(os.homedir(), 'Library/pnpm/global/v11/1051a-1a01d77de3d-060fb6a9751d8d8c/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js')
].filter(Boolean);
const marker = 'const summaryDisplay = typeof summary === "string" && summary.length > 320';
const old = `\t\t\tconst summary = node.outcome === null ? runningSummary ?? t("command.running") : text ?? (node.outcome.kind === "error" ? t("command.failed") : t("command.done"));
\t\t\tconst title = node.name ?? t("command.title");
\t\t\tconst state = stateOf(node.outcome);
\t\t\tconst body = text !== void 0 && text.includes("\\n") ? text : null;
\t\t\tconst open = expanded && body !== null;`;
const replacement = `\t\t\tconst summary = node.outcome === null ? runningSummary ?? t("command.running") : text ?? (node.outcome.kind === "error" ? t("command.failed") : t("command.done"));
\t\t\tconst summaryDisplay = typeof summary === "string" && summary.length > 320 ? \`${'${summary.slice(0, 320)}'}…（已折叠，点击查看全文）\` : summary;
\t\t\tconst title = node.name ?? t("command.title");
\t\t\tconst state = stateOf(node.outcome);
\t\t\tconst body = text !== void 0 ? text : null;
\t\t\tconst open = expanded && body !== null;`;

async function sha(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }
async function findBundle() {
  for (const candidate of candidates) {
    try { const real = await realpath(candidate); if ((await stat(real)).isFile()) return real; } catch {}
  }
  throw new Error(`找不到宿主 conversation client bundle；候选：${candidates.join(', ')}`);
}
const file = await findBundle();
let source = await readFile(file, 'utf8');
if (source.includes(marker)) { console.log(JSON.stringify({ status: 'already-patched', file, sha256: await sha(file) })); process.exit(0); }
if (!source.includes(old)) throw new Error('宿主 bundle 版本/文本不匹配，拒绝修改；请重新审查 GenericCommandCard 后更新脚本');
const before = await sha(file);
const backupDir = path.join(home, 'backups/command-card');
await mkdir(backupDir, { recursive: true, mode: 0o700 });
const backup = path.join(backupDir, `client.js.${before}.before`);
try { await stat(backup); } catch { await copyFile(file, backup); }
source = source.replace(old, replacement).replace('children: summary\n\t\t\t\t\t\t\t})] }),', 'children: summaryDisplay\n\t\t\t\t\t\t\t})] }),');
const oldBody = `\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("pre", {
\t\t\t\t\t\t\tclassName: GenericCommandCard_module_css_default.body,
\t\t\t\t\t\t\t"data-error": state === "error" || void 0,
\t\t\t\t\t\t\tchildren: body
\t\t\t\t\t\t})`;
const newBody = `\t\t\t\t\t\tchildren: open ? (0, react_jsx_runtime.jsx)("pre", {
\t\t\t\t\t\t\tclassName: GenericCommandCard_module_css_default.body,
\t\t\t\t\t\t\t"data-error": state === "error" || void 0,
\t\t\t\t\t\t\tchildren: body
\t\t\t\t\t\t}) : null`;
if (!source.includes(oldBody)) throw new Error('正文渲染片段未找到，拒绝写入');
source = source.replace(oldBody, newBody);
const temp = `${file}.tmp-${process.pid}`;
await writeFile(temp, source, { mode: 0o600, flag: 'wx' });
await rename(temp, file);
console.log(JSON.stringify({ status: 'patched', file, before, backup, after: await sha(file) }));
