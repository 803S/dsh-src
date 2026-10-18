/* [local.145] 影响分类判据表的一致性锁。
 *
 * 这一组测试存在的唯一目的：让“哪些 effect 能自动放行 / 需要什么材料”不能再靠散落的数组字面量维护。
 * 背景：该判据曾被硬编码在 7 文件 14 处，导致 local.144 的 external-probe 漏改两处消费点
 * （reviewedReadSafety → 被挡人工；broker.safeRead → 被同资源未决审查挡成人工卡），
 * 且 http-policy 里长期写着 'external' 可自动、只因别处常量把它钉成 high 才未生效。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  EFFECT_POLICY, EFFECTS, IMPACT_FREE_EFFECTS, READ_LIKE_EFFECTS, WRITE_EXECUTOR_EFFECTS,
  LOW_IMPACT_CANDIDATE_EFFECTS, OBJECT_CLASS_SCOPED_EFFECTS, LANE_AUTO_EFFECTS,
  PLAN_LANE_AUTO_EFFECTS, SINGLE_LANE_AUTO_EFFECTS, AUXILIARY_READ_EFFECTS,
  SAFETY_EFFECTS, SAFETY_READ_EFFECTS, SAFETY_NON_MUTATING_EFFECTS,
  SAFETY_MATERIAL_STEP_EFFECTS, SAFETY_BACKUP_EFFECTS, OBJECT_CLASSES, IMPLICIT_READ_EFFECTS,
  riskFloor, mayBeLowImpact, describeEffect, materialEffectsFor,
} from '../lib/src/decision/effect-policy.js';
import { httpDecisionPolicy } from '../lib/src/decision/http-policy.js';
import { allowsLowImpact, reviewSummary } from '../lib/src/egress/decision-policy.js';
import { reviewedReadSafety, assertReviewedSafety } from '../lib/src/egress/safety-plan.js';

const ROOT = new URL('..', import.meta.url).pathname;
const LOW = { fallback: false, mode: 'on', action: 'allow', risk: 'low', confidence: 0.9 };
const advice = (effect, extra = {}) => ({ ...LOW, effect, objectClass: 'not-applicable', ...extra });
/* 必须用“本地不确定只读”的报文，才能让车道走到判定分支：
 * 一条干净的裸 GET 会被 readClearRequest 直接视为确定性只读，不经过分类判据。
 * callback 是本地可疑语义词（SUSPICIOUS_WORDS），正好也是探测类请求的真实形状。 */
const judged = { method: 'GET', url: 'https://t.example/fetch?callback=http://probe.example/cb', headers: [] };

test('[local.145] 判据表是完整的：每个分类都定义了文案与四个维度', () => {
  assert.deepEqual([...EFFECTS].sort(), ['auth', 'compute', 'destructive', 'external', 'external-probe', 'read', 'unknown', 'write'].sort());
  for (const effect of EFFECTS) {
    const policy = EFFECT_POLICY[effect];
    assert.equal(typeof policy.label, 'string', effect);
    assert.ok(policy.label.trim().length > 0, effect);
    for (const column of ['impactFree', 'readLike', 'executor']) assert.ok(column in policy, `${effect}.${column}`);
    assert.ok(policy.lowImpactOn !== undefined, `${effect}.lowImpactOn`);
    assert.ok(policy.materialFor === null || Array.isArray(policy.materialFor), `${effect}.materialFor`);
    assert.ok(['scan', 'write'].includes(policy.executor), effect);
    // 材料语义只能落在材料词汇表内。
    for (const material of policy.materialFor ?? []) assert.ok(SAFETY_EFFECTS.includes(material), `${effect} → ${material}`);
    for (const objectClass of Array.isArray(policy.lowImpactOn) ? policy.lowImpactOn : []) assert.ok(OBJECT_CLASSES.includes(objectClass), `${effect} → ${objectClass}`);
  }
});

test('[local.145] 派生集合就是收敛前那 14 处硬编码的值（收敛未改变判据）', () => {
  assert.deepEqual([...IMPACT_FREE_EFFECTS], ['read', 'compute', 'auth', 'external-probe']);
  assert.deepEqual([...READ_LIKE_EFFECTS], ['read', 'compute', 'external-probe']);
  assert.deepEqual([...WRITE_EXECUTOR_EFFECTS], ['auth', 'write', 'external', 'destructive']);
  assert.deepEqual([...OBJECT_CLASS_SCOPED_EFFECTS], ['write', 'destructive']);
  assert.deepEqual([...SINGLE_LANE_AUTO_EFFECTS], ['read', 'compute', 'auth', 'external-probe', 'write']);
  assert.deepEqual([...PLAN_LANE_AUTO_EFFECTS], ['read', 'compute', 'auth', 'external-probe', 'unknown']);
  assert.deepEqual([...AUXILIARY_READ_EFFECTS], ['read', 'compute']);
  assert.deepEqual([...SAFETY_EFFECTS], ['read', 'compute', 'replace', 'create', 'delete', 'external']);
  assert.deepEqual([...SAFETY_READ_EFFECTS], ['read', 'compute']);
  assert.deepEqual([...SAFETY_NON_MUTATING_EFFECTS], ['read', 'compute', 'external-probe']);
  assert.deepEqual([...IMPLICIT_READ_EFFECTS], ['read', 'compute', 'unknown']);
  assert.deepEqual([...SAFETY_MATERIAL_STEP_EFFECTS].sort(), ['create', 'delete', 'external', 'replace']);
  assert.deepEqual([...SAFETY_BACKUP_EFFECTS], ['replace', 'delete']);
  assert.deepEqual([...LOW_IMPACT_CANDIDATE_EFFECTS], ['read', 'compute', 'auth', 'external-probe', 'write', 'destructive', 'unknown']);
});

test('[local.145] riskFloor 与收敛前的判定服务表达式逐一等价（含 destructive 只在 owned 可低）', () => {
  // oracle = 收敛前 lib/src/decision/jev-client.js 的 lowImpact 表达式
  const oracle = (effect, objectClass) => {
    const lowImpact = ['read', 'compute', 'auth', 'external-probe'].includes(effect)
      || effect === 'write' && objectClass === 'new-test-file'
      || ['write', 'destructive'].includes(effect) && objectClass === 'owned-test-file';
    return lowImpact ? 'low' : effect === 'unknown' ? 'unknown' : 'high';
  };
  for (const effect of EFFECTS) {
    for (const objectClass of [...OBJECT_CLASSES, undefined]) {
      assert.equal(riskFloor(effect, objectClass), oracle(effect, objectClass), `${effect}/${objectClass}`);
    }
  }
  // 三个关键结论必须显式成立，避免以后被人“顺手放宽”。
  assert.equal(mayBeLowImpact('destructive', 'new-test-file'), false);
  assert.equal(mayBeLowImpact('external', 'owned-test-file'), false);
  assert.equal(mayBeLowImpact('external-probe', 'not-applicable'), true);
});

test('[local.145] 两条车道对同一分类给出同一结论（差异只在表里显式声明的那两处）', () => {
  const plan = effect => ({ maxRequests: 1, entries: [{ request: { method: 'GET', url: 'https://t.example/x', headers: [] }, maxRequests: 1 }] });
  for (const effect of EFFECTS) {
    const single = httpDecisionPolicy(null, advice(effect), 'on', { method: 'GET', url: 'https://t.example/x', path: '/x' });
    const planAuto = allowsLowImpact(advice(effect), plan(effect), []);
    assert.equal(single.require === false, SINGLE_LANE_AUTO_EFFECTS.includes(effect), `单笔车道 ${effect}`);
    assert.equal(planAuto, PLAN_LANE_AUTO_EFFECTS.includes(effect), `计划车道 ${effect}`);
    const safety = reviewedReadSafety(judged, advice(effect));
    assert.equal(safety !== null, READ_LIKE_EFFECTS.includes(effect), `执行材料车道 ${effect}`);
  }
  // 边界：destructive / external 在任何车道都不自动，且不是靠别处常量兜底。
  for (const effect of ['destructive', 'external']) {
    assert.equal(SINGLE_LANE_AUTO_EFFECTS.includes(effect), false, effect);
    assert.equal(PLAN_LANE_AUTO_EFFECTS.includes(effect), false, effect);
    assert.equal(READ_LIKE_EFFECTS.includes(effect), false, effect);
    assert.equal(mayBeLowImpact(effect, 'owned-test-file'), effect === 'destructive', effect);
  }
  // write 在单笔车道可自动、在计划车道需额外对象归属守卫：差异是显式的，两边都能自证。
  assert.equal(SINGLE_LANE_AUTO_EFFECTS.includes('write'), true);
  assert.equal(PLAN_LANE_AUTO_EFFECTS.includes('write'), false);
  assert.equal(allowsLowImpact(advice('write', { objectClass: 'owned-test-file' }), plan('write'), [{ digest: 'd', maxRequests: 1 }]), true);
});

test('[local.145] 材料要求由表推导：有材料要求的分类，挑错材料必被拒', () => {
  const caught = fn => { try { fn(); return null; } catch (error) { return String(error?.code ?? error).replace(/^SRC_GATE_/, ''); } };
  const run = (effect, safetyEffect) => {
    const safety = { effect: safetyEffect, object: 'https://t.example/x', recovery: 'r' };
    if (['create', 'replace', 'delete', 'external'].includes(safetyEffect)) { safety.precondition = {}; safety.verification = {}; }
    if (['replace', 'delete'].includes(safetyEffect)) safety.backupRef = 'b';
    if (safetyEffect === 'external') safety.irreversibleAcknowledgement = 'external-effect-cannot-be-automatically-undone';
    return caught(() => assertReviewedSafety({ method: 'GET', url: 'https://t.example/x', headers: [] }, safety, { effect }));
  };
  for (const effect of EFFECTS) {
    const material = materialEffectsFor(effect);
    for (const safetyEffect of SAFETY_EFFECTS) {
      // 无材料要求的分类（read/compute/external-probe/auth/unknown）不由材料语义约束；
      // 有材料要求的分类，材料必须落在表里列出的那几种。
      const expected = material && !material.includes(safetyEffect) ? 'SAFETY_EFFECT_CONTRADICTION' : null;
      assert.equal(run(effect, safetyEffect), expected, `${effect}+${safetyEffect}`);
    }
  }
  // 三个有材料要求的分类的边界，逐项钉住。
  assert.deepEqual(materialEffectsFor('write'), ['create', 'replace']);
  assert.deepEqual(materialEffectsFor('destructive'), ['delete', 'replace']);
  assert.deepEqual(materialEffectsFor('external'), ['external']);
  assert.equal(run('write', 'delete'), 'SAFETY_EFFECT_CONTRADICTION');
  assert.equal(run('destructive', 'create'), 'SAFETY_EFFECT_CONTRADICTION');
  assert.equal(run('external', 'replace'), 'SAFETY_EFFECT_CONTRADICTION');
  // 写类安全材料少了前置/回读/备份仍然被拒（不能因为收敛而放松材料检查）。
  const bare = code => caught(() => assertReviewedSafety({ method: 'GET', url: 'https://t.example/x', headers: [] }, { effect: 'create', object: 'x', recovery: 'r' }, { effect: code }));
  assert.equal(bare('write'), 'SAFETY_PLAN_REQUIRED');
  assert.equal(caught(() => assertReviewedSafety({ method: 'GET', url: 'https://t.example/x', headers: [] }, null, { effect: 'write' })), 'SAFETY_PLAN_REQUIRED');
});

test('[local.145] local.144 漏改的两个消费点已被表覆盖', () => {
  // 1) reviewedReadSafety 若不认 external-probe，低风险探测会被 SAFETY_PLAN_REQUIRED 挡成人工卡。
  assert.ok(READ_LIKE_EFFECTS.includes('external-probe'));
  // 2) broker 的同资源未决审查若不算 external-probe，低风险探测会被别人的卡挡成人工卡。
  assert.ok(PLAN_LANE_AUTO_EFFECTS.includes('external-probe'));
  // 3) 但它绝不能混进“按只读对待”的本地辅助读取分支，否则执行材料会声称“只读”。
  assert.equal(AUXILIARY_READ_EFFECTS.includes('external-probe'), false);
  assert.equal(AUXILIARY_READ_EFFECTS.includes('auth'), false);
});

test('[local.145] 判定记录与文案不得掩盖事实：外发探测不得被说成只读', () => {
  const label = describeEffect({ effect: 'external-probe', objectClass: 'not-applicable' });
  assert.ok(label.includes('回调'), label);
  assert.ok(!label.includes('只读'), label);
  // 记录侧同样不得折叠或美化（reviewSummary 必须原样保留分类）。
  const summary = reviewSummary(advice('external-probe'));
  assert.equal(summary.effect, 'external-probe');
  for (const effect of EFFECTS) assert.equal(reviewSummary(advice(effect)).effect, effect, effect);
  // 安全材料的恢复文案必须如实说明会出网。
  const safety = reviewedReadSafety(judged, advice('external-probe'));
  assert.ok(safety.recovery.includes('回调'), safety.recovery);
  assert.ok(!safety.recovery.includes('只读单笔请求'), safety.recovery);
  // 只读/计算仍按只读描述（不能因为上面收紧而让普通只读卡片变模糊）。
  assert.ok(reviewedReadSafety(judged, advice('read')).recovery.includes('只读'));
});

test('[local.145] UI 文案表与判据表对齐（UI 独立打包，故用跨包断言锁死）', () => {
  const source = readFileSync(join(ROOT, 'src/dsh-client-ui-src/src/client/approval-explanation.ts'), 'utf8');
  const literal = (marker, open = '{', close = '}') => {
    const start = source.indexOf(marker);
    assert.ok(start > 0, `未找到 ${marker}`);
    const from = source.indexOf(open, start + marker.length - 1);
    const to = source.indexOf(close, from);
    const text = source.slice(from, to + 1);
    return JSON.parse(text.replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":').replace(/'/g, '"'));
  };
  // ① 高风险文案表的键必须是真实分类（无幽灵键），且覆盖全部“有影响”的分类。
  const labels = literal('const effect: Record<string,string>=');
  for (const key of Object.keys(labels)) assert.ok(EFFECTS.includes(key), `UI 幽灵分类 ${key}`);
  assert.ok(Object.values(labels).every(value => typeof value === 'string' && value.trim().length > 0));
  const mustExplain = EFFECTS.filter(effect => !EFFECT_POLICY[effect].impactFree && effect !== 'unknown');
  for (const effect of mustExplain) assert.ok(Object.hasOwn(labels, effect), `UI 缺少有影响分类的文案：${effect}（新增分类时必须同步 UI）`);
  // ② 缺材料判定的映射必须与表一致（UI 自己又写了一份 required）。
  assert.deepEqual(literal('const required:Record<string,string[]>='),
    Object.fromEntries(EFFECTS.filter(effect => materialEffectsFor(effect)).map(effect => [effect, materialEffectsFor(effect)])));
  // ③ UI 的探测说明同样不得说成只读。
  const probeText = source.slice(source.indexOf("if (assessment.effect === 'external-probe')"));
  const probeLine = probeText.slice(0, probeText.indexOf('\n  }'));
  assert.ok(probeLine.includes('回调'), probeLine);
  assert.ok(!probeLine.includes('只读'), probeLine);
});

test('[local.145] 判据表不得在别处重新长出来：lib/src 下禁止 effect 名单字面量', () => {
  const files = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.js')) files.push(full);
    }
  };
  walk(join(ROOT, 'lib/src'));
  assert.ok(files.length > 100, `扫描面过小，可能路径写错：${files.length}`);
  const EFFECT_LITERAL = /['"](read|compute|auth|write|external|external-probe|destructive|unknown|not-applicable)['"]/g;
  /* 允许显式豁免：宿主工具名列表（如 ['read','write','edit',...]）也叫 read/write，
   * 但那不是影响分类。豁免必须写在当行，写清楚“为什么不是影响分类”。 */
  const ALLOW = 'effect-policy-lint-allow';
  const offenders = [];
  const flags = [];
  for (const file of files) {
    if (file.endsWith('/decision/effect-policy.js')) continue;
    const relative = file.slice(ROOT.length);
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (line.includes(ALLOW)) { flags.push(`${relative}:${index + 1}`); return; }
      const at = `${relative}:${index + 1}  ${line.trim().slice(0, 110)}`;
      // ① 方括号名单里出现 ≥2 个分类字面量 —— 这就是一份硬编码名单。
      for (const bracket of line.matchAll(/\[[^\]]*\]/g)) {
        const distinct = new Set([...bracket[0].matchAll(EFFECT_LITERAL)].map(m => m[1]));
        if (distinct.size >= 2) offenders.push(`${at}\n     ← ${bracket[0].slice(0, 120)}`);
      }
      // ② 凭空出现的 .includes('分类')：名单被挪成单元素了。
      for (const call of line.matchAll(/\.(?:has|includes)\(\s*['"](external-probe|external|destructive|auth|not-applicable)['"]/g)) {
        offenders.push(`${at}\n     ← ${call[0]}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `判据表被重新硬编码，请改为从 decision/effect-policy.js 取集合：\n${offenders.join('\n')}`);
  assert.ok(flags.length >= 4, `宿主工具名豁免不应消失（${flags.length} 处）：它们是给别人看的解释，不是开关`);
});
