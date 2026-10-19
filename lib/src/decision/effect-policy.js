/* 出口“影响分类(effect) → 能否自动放行 / 需要什么执行材料”的唯一事实来源。
 *
 * 背景（架构问题，2026-10-18 收敛）：这套判据曾被硬编码在 7 个文件 14 处 ——
 *   判定 rubric(jev-client)、计划车道(decision-policy.allowsLowImpact)、单笔车道(http-policy.allowed)、
 *   安全材料(safety-plan.reviewedReadSafety/required)、执行器选择(broker)、同资源待决判定(broker.safeRead)、
 *   审批卡文案(manager)、UI 文案表。
 * 后果有两类，都在 local.144 的 external-probe 上真实发生过：
 *   1) 新增分类漏改消费点 → 漏 reviewedReadSafety 被挡成人工卡；漏 safeRead 被同资源未决审查挡成人工卡；
 *   2) 同一分类在不同车道结论不同，且差异是隐式的（写死两个不同名单，没有说明为什么）。
 * 另外 http-policy 长期写着 'external' 可自动，只因另一处常量把它钉成 high 才未生效 ——
 * 放行名单不得依赖别处常量兜底，必须在本地自证。
 *
 * 规则（由 tests/effect-policy.test.mjs 强制）：
 *   - 任何模块都不得再自建 effect 名单，只能读本表或本表导出的集合/谓词；
 *   - 车道之间确实需要不同的地方，必须以导出的具名集合表达并写明理由，不得就地写数组字面量；
 *   - UI 文案表的键集合必须与本表 EFFECTS 相同（UI 独立打包，无法直接 import，故用测试锁齐）。
 */
export const OBJECT_CLASSES = Object.freeze(['not-applicable', 'new-test-file', 'owned-test-file', 'business-or-unknown']);

/* 列的含义：
 *   label        人话（审批卡与审计记录用；不得夸大也不得掩盖事实，见 external-probe）
 *   impactFree   对目标业务状态无副作用（不含“是否出网”这一维度：外发探测出网但无副作用）
 *   readLike     低风险时无需备份/前置检查/验证材料（执行材料维度，不是授权维度）
 *   lowImpactOn  判定服务能给多低的风险：true=可为 low；false=只能 high；
 *                'risk-graded'=由判定服务给出的 risk 决定；数组=仅这些对象归属可为 low
 *   executor     谁能执行它：scan=有界扫描执行器；write=必须经宿主写执行器/人工
 *   impactDenies 判定服务可否决「无输入只读」的本地豁免（真影响：write/external/destructive）
 *   materialFor  需要哪种执行材料语义（null=不需要）
 */
export const EFFECT_POLICY = Object.freeze({
  read:             { label: '只读取回',                    impactFree: true,  readLike: true,  lowImpactOn: true,                  executor: 'scan',  materialFor: null },
  compute:          { label: '有界计算/校验',               impactFree: true,  readLike: true,  lowImpactOn: true,                  executor: 'scan',  materialFor: null },
  auth:             { label: '单次登录/注册验证',           impactFree: true,  readLike: false, lowImpactOn: true,                  executor: 'write', materialFor: null },
  'external-probe': { label: '有界外发探测：仅让目标回调我方控制的对端，不向真实第三方送达、不写业务数据',
                                                          impactFree: true,  readLike: true,  lowImpactOn: true,                  executor: 'scan',  materialFor: null },
  write:            { label: '写入操作',                    impactFree: false, impactDenies: true, readLike: false, lowImpactOn: ['new-test-file', 'owned-test-file'], executor: 'write', materialFor: ['create', 'replace'] },
  external:         { label: '外发或费用类操作',            impactFree: false, impactDenies: true, readLike: false, lowImpactOn: false,                 executor: 'write', materialFor: ['external'] },
  destructive:      { label: '删除/破坏/不可逆操作',        impactFree: false, impactDenies: true, readLike: false, lowImpactOn: ['owned-test-file'],  executor: 'write', materialFor: ['delete', 'replace'] },
  unknown:          { label: '影响未定的操作',              impactFree: false, readLike: false, lowImpactOn: 'risk-graded',         executor: 'scan',  materialFor: null },
});

export const EFFECTS = Object.freeze(Object.keys(EFFECT_POLICY));

const by = column => Object.freeze(EFFECTS.filter(effect => column(EFFECT_POLICY[effect])));

export const IMPACT_FREE_EFFECTS = by(p => p.impactFree);
export const READ_LIKE_EFFECTS = by(p => p.readLike);
export const WRITE_EXECUTOR_EFFECTS = by(p => p.executor === 'write');
/* 判定侧：本地允许判为 low 的分类（口径是“真实影响”，不是“是否出网”）。 */
export const LOW_IMPACT_CANDIDATE_EFFECTS = by(p => p.lowImpactOn !== false);
/* 需要对象归属才能判低影响的分类；判定服务必须为它们单独回答 objectClass。 */
export const OBJECT_CLASS_SCOPED_EFFECTS = by(p => Array.isArray(p.lowImpactOn));
/* [local.150] 判定服务可以**否决**「无输入只读」本地豁免的分类：真影响（写入/外发/破坏）。
 * 不能写成 !impactFree：unknown 也不是 impactFree，但“判定服务说不清（含调用方没申报用途）”
 * 不构成否决 —— 豁免只处理本地事实（这一发携带不了任何输入），服务没答案不是否定答案。
 * 这是一份 effect 名单，只能在本文件维护；消费点（decision/http-policy、egress/broker、src_http 诊断）引用它。 */
export const IMPACT_DENYING_EFFECTS = by(p => p.impactDenies === true);

/* 单笔车道（一笔冻结请求 + 人工点击）与计划车道可自动外发的分类。
 * 与 IMPACT_FREE_EFFECTS 的差别必须显式写出，不得在车道里就地写数组：
 *  - single 多一个 write：write 能否自动由判定侧的 objectClass 归属决定（无归属的 write 判定侧就是 high），
 *    车道本身不再重复细分 objectClass。
 *  - plan 多一个 unknown：分类未定不等于风险未定；风险已判 low/allow 时仍可放行（消费点自带该守卫）。
 * destructive/external 两个车道都一律要人：不是“不可达所以留着”，是真的要求人工。 */
export const LANE_AUTO_EFFECTS = Object.freeze({
  plan: Object.freeze([...IMPACT_FREE_EFFECTS, 'unknown']),
  single: Object.freeze([...IMPACT_FREE_EFFECTS, 'write']),
});
export const PLAN_LANE_AUTO_EFFECTS = LANE_AUTO_EFFECTS.plan;
export const SINGLE_LANE_AUTO_EFFECTS = LANE_AUTO_EFFECTS.single;

/* 本地辅助读取（判定前置检查、回读校验、待决单的只读执行材料）必须落在这一类：
 * 只读或纯计算 —— 不得出网、不得使用凭据。
 * 因此不含 external-probe（它确实出网）与 auth（它会使用凭据）：
 * 把它们塞进“按只读对待”的分支，会让执行材料/审批记录声称“只读”，从而掩盖事实。 */
export const AUXILIARY_READ_EFFECTS = Object.freeze(['read', 'compute']);

/* 调用方已确认 automatic、且只有一笔请求时，可以按“隐式只读”记账的分类。
 * 比 AUXILIARY_READ_EFFECTS 多一个 unknown：分类未定但风险与服务端动作都已确认低/放行。 */
export const IMPLICIT_READ_EFFECTS = Object.freeze([...AUXILIARY_READ_EFFECTS, 'unknown']);

/* 执行材料（safety plan）语义：这是另一套词汇，不是影响分类。 */
export const SAFETY_EFFECTS = Object.freeze(['read', 'compute', 'replace', 'create', 'delete', 'external']);
export const SAFETY_READ_EFFECTS = Object.freeze(['read', 'compute']);
/* 内部构造的安全计划里“不改目标状态”的材料语义。
 * external-probe 只能由本地构造（模型声明的枚举里没有它），所以放进这里不会放宽模型。 */
export const SAFETY_NON_MUTATING_EFFECTS = Object.freeze(['read', 'compute', 'external-probe']);
export const SAFETY_MATERIAL_STEP_EFFECTS = Object.freeze([...new Set(EFFECTS.flatMap(effect => EFFECT_POLICY[effect].materialFor ?? []))]);
export const SAFETY_BACKUP_EFFECTS = Object.freeze(['replace', 'delete']);

export const riskFloor = (effect, objectClass) => {
  const rule = EFFECT_POLICY[effect]?.lowImpactOn;
  if (rule === true) return 'low';
  if (rule === 'risk-graded') return 'unknown';
  if (Array.isArray(rule) && rule.includes(objectClass)) return 'low';
  return 'high';
};

export const mayBeLowImpact = (effect, objectClass) => riskFloor(effect, objectClass) === 'low';
export const isImpactFree = effect => IMPACT_FREE_EFFECTS.includes(effect);
export const isReadLike = effect => READ_LIKE_EFFECTS.includes(effect);
export const needsWriteExecutor = effect => WRITE_EXECUTOR_EFFECTS.includes(effect);
export const materialEffectsFor = effect => EFFECT_POLICY[effect]?.materialFor ?? null;
export const effectLabel = effect => EFFECT_POLICY[effect]?.label ?? EFFECT_POLICY.unknown.label;

/* 审批卡文案：对象归属比分类更能说明“到底动了什么”，所以归属分支优先。
 * 纯展示层，不产生授权；判定值仍原样保留在卡上供审计。 */
export function describeEffect(review) {
  const effect = review?.effect, objectClass = review?.objectClass;
  if (effect === 'external-probe' || effect === 'auth' || effect === 'read' || effect === 'compute') return effectLabel(effect);
  if (objectClass === 'new-test-file') return '创建新的测试标记，不覆盖既有对象';
  if (objectClass === 'owned-test-file') return effect === 'destructive' ? '清理本次创建、已登记归属的测试文件' : '修改已登记归属且版本匹配的测试文件';
  if (objectClass === 'business-or-unknown') return effect === 'destructive' ? '业务数据删除/破坏' : effect === 'external' ? '外发或费用类操作' : '业务数据写入，或对象归属不明';
  return effectLabel(effect);
}
