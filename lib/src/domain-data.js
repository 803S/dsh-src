// User-owned domain data lifecycle. No model tool and no target network requests.
import { promises as fs, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { artifactsRoot, artifactsHome, engagementDirName } from './artifacts.js';
import { flushDefaultTelemetry, srcTelemetryDir } from './telemetry/events.js';
import { lessonsDataDir } from './lessons.js';

const journalPath = (home) => path.join(home, 'storages', 'src-domain-deletions.json');
export const domainDeletionBusy = new Set();
const deletionCache = new Map();
export function readDomainDeletions(home) {
  try {
    const file = journalPath(home), stat = statSync(file);
    const version = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    if (deletionCache.get(file)?.version === version) return deletionCache.get(file).value;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('域数据删除记录损坏，拒绝继续清理');
    deletionCache.set(file, { version, value });
    return value;
  } catch (error) { if (error.code === 'ENOENT') { deletionCache.delete(journalPath(home)); return {}; } throw error; }
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(temp, file);
}
// Never traverse symlinked parents, including the artifacts root itself.
async function safePath(base, file) {
  const root = path.resolve(base), target = path.resolve(file);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('清理路径越界');
  let current = root;
  for (const part of ['', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`拒绝清理符号链接：${current}`); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  return true;
}
async function cleanFiles(home, plan, store) {
  const ids = new Set(plan.sessionIds);
  const counts = { artifacts: 0, lessons: 0, credentials: 0, snapshots:0, telemetry: 0, approvalLocks: 0 };
  const warnings = [];
  for (const sid of ids) {
    for (const dir of new Set([artifactsRoot(sid, { target: plan.target }), path.join(artifactsHome(), engagementDirName(sid))])) {
      if (!await safePath(artifactsHome(), dir)) continue;
      // Short directory IDs can collide. Delete only directories whose scaffold proves ownership.
      const readme = await fs.readFile(path.join(dir, 'README.md'), 'utf8').catch(() => '');
      if (!readme.split('\n').includes(`- 会话：${sid}`)) { warnings.push(`未删除无法核实归属的产物目录：${dir}`); continue; }
      await fs.rm(dir, { recursive: true }); counts.artifacts++;
    }
  }
  const lessonDir = lessonsDataDir();
  if (await safePath(lessonDir, lessonDir)) {
    for (const name of await fs.readdir(lessonDir)) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(lessonDir, name);
      if (!await safePath(lessonDir, file)) continue;
      const text = await fs.readFile(file, 'utf8');
      const match = /<!-- lesson-meta: (.+?) -->/.exec(text);
      let meta; try { meta = JSON.parse(match?.[1] ?? '{}'); } catch { continue; }
      if (ids.has(meta.sessionId)) { await fs.unlink(file); counts.lessons++; }
    }
  }
  // Credential hashes may be shared: retain anything still referenced by ANY surviving SRC row.
  const remaining = await store.domain();
  const refs = new Set();
  for (const name of plan.tableNames) for (const [, row] of remaining.table(name).entries()) {
    for (const match of JSON.stringify(row).matchAll(/credential:\/\/[a-f0-9]{64}/g)) refs.add(match[0]);
  }
  const vault = path.join(home, 'storages', 'src-credentials');
  if (await safePath(vault, vault)) for (const name of await fs.readdir(vault)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = path.join(vault, name);
    if (!await safePath(vault, file)) continue;
    const row = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!refs.has(row.ref) && (ids.has(row.sessionId) || plan.credentialRefs.includes(row.ref))) { await fs.unlink(file); counts.credentials++; }
  }
  const snapshots=path.join(home,'storages','src-snapshots');
  if(await safePath(snapshots,snapshots))for(const name of await fs.readdir(snapshots)){
    if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
    const file=path.join(snapshots,name);if(!await safePath(snapshots,file))continue;
    const row=JSON.parse(await fs.readFile(file,'utf8'));if(ids.has(row.sessionId)){await fs.unlink(file);counts.snapshots++;}
  }
  const locksFile = path.join(home, 'storages', 'src-approval-locks.json');
  if (await safePath(path.join(home, 'storages'), locksFile)) {
    const locks = JSON.parse(await fs.readFile(locksFile, 'utf8'));
    const keep = locks.filter((lock) => !plan.approvals.some((a) => a.id === lock.id && a.url === lock.url && a.method === lock.method));
    counts.approvalLocks = locks.length - keep.length;
    if (counts.approvalLocks) await atomicJson(locksFile, keep);
  }
  const telDir = srcTelemetryDir();
  if (await safePath(telDir, telDir)) for (const name of await fs.readdir(telDir)) {
    if (!/^src-telemetry-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    const file = path.join(telDir, name);
    if (!await safePath(telDir, file)) continue;
    const lines = (await fs.readFile(file, 'utf8')).split('\n');
    const keep = lines.filter((line) => {
      let row; try { row = JSON.parse(line); } catch { return true; }
      if (ids.has(row.sessionId) || ids.has(row.engagementId)) { counts.telemetry++; return false; }
      return true;
    });
    if (keep.length !== lines.length) {
      const temp = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, keep.join('\n'), { mode: 0o600 }); await fs.rename(temp, file);
    }
  }
  return { counts, warnings };
}

export function registerDomainDataCommands(ctx, store, { homeOf, closeProofServers, resetProjection, rootCtx = ctx }) {
  const catalog = async () => {
    const rows = await store.listDomainCatalog();
    for (const [target, entry] of Object.entries(readDomainDeletions(homeOf()))) {
      if (entry.status !== 'pending') continue;
      const row = rows.find((r) => r.target === target);
      if (row) row.cleanupPending = true;
      else rows.push({ target, sessions: entry.plan.sessionIds.length, notes: 0, assets: 0, findings: 0, research: 0, observations: 0, cleanupPending: true });
    }
    return rows;
  };
  ctx.commands.register({ name: 'src-domains', description: '用户管理：列出全部目标域的 SRC 数据，不调用模型。', input: { hint: '[empty]' }, handler: async () => {
    try { return { kind: 'success', text: JSON.stringify({ domains: await catalog() }) }; }
    catch (error) { return { kind: 'error', text: String(error.message) }; }
  } });
  ctx.commands.register({ name: 'src-delete-domain', description: '用户管理：精确删除目标域的 SRC 数据，需重复域名确认。保留宿主对话历史。', input: { hint: '<target> confirm <target>' }, handler: async (invocation) => {
    const [target, confirm, repeated, extra] = String(invocation.rawInput ?? '').trim().split(/\s+/);
    if (!target || confirm !== 'confirm' || repeated !== target || extra) return { kind: 'error', text: '需确认：/src-delete-domain <target> confirm <target>' };
    const home = homeOf();
    if (domainDeletionBusy.has(home)) return { kind: 'error', text: '已有清理正在进行，请稍后刷新。' };
    domainDeletionBusy.add(home);
    try {
      const agents = rootCtx.get?.('agents');
      if (typeof agents?.list !== 'function') throw new Error('无法检查运行任务，拒绝删除。');
      if (agents.list().some((a) => a.status === 'running')) throw new Error('有任务正在运行，请先停止任务再删除；不会自动中断任务。');
      if (invocation.agent?.session?.header?.parentSession) throw new Error('子代理会话不能管理域数据。');
      const journal = readDomainDeletions(home);
      const prior = journal[target];
      const plan = prior?.status === 'pending' ? prior.plan : await store.planTargetDeletion(target);
      if (!plan.sessionIds.length && !plan.entries.length) throw new Error('未找到该目标的 SRC 数据，请刷新列表。');
      const cutoff = prior?.status === 'pending' ? prior.cutoff : Date.now();
      journal[target] = { status: 'pending', cutoff, plan };
      await atomicJson(journalPath(home), journal);
      for (const sid of plan.sessionIds) await closeProofServers(sid);
      await flushDefaultTelemetry();
      const deleted = await store.deleteTargetData(target, plan);
      const files = await cleanFiles(home, plan, store);
      for (const sid of plan.sessionIds) await resetProjection(sid, target);
      // Projection caches and old log snapshots are masked by the durable cutoff on later reads.
      if (files.warnings.length) return { kind: 'error', text: `数据库已清理，但文件清理未完成（可重试）：${files.warnings.join('；')}` };
      journal[target] = { status: 'completed', cutoff, sessionIds: plan.sessionIds };
      await atomicJson(journalPath(home), journal);
      return { kind: 'success', text: JSON.stringify({ target, deleted, files: files.counts, message: 'SRC 数据已删除。宿主对话历史及备份未删除；已进入旧对话的内容不会被抹除，请新建会话继续。' }) };
    } catch (error) { return { kind: 'error', text: `删除未完成：${error.message}。如已开始清理，可从列表重试。` }; }
    finally { domainDeletionBusy.delete(home); }
  } });
}
