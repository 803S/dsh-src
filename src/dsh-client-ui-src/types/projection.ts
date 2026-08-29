/**
 * Type declarations of the `src` session projection, mirroring the wire
 * schema in lib/src.js (srcProjectionSchema). Client code imports these
 * through `@lihua_dis/dsh-src/src/client-types` — type-only, erased at build.
 */

export type SrcSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type SrcFactKind = 'port' | 'service' | 'vuln' | 'finding' | 'http' | 'info'
export type SrcAssetType =
  | 'root-domain' | 'subdomain' | 'ip' | 'service' | 'app' | 'endpoint'
  | 'mini-program' | 'client' | 'firmware' | 'ai-surface' | 'threat-intel'
export type SrcEdgeKind = 'spawns' | 'yields' | 'derived_from' | 'proves' | 'parent'
export type SrcIntentStatus = 'planned' | 'running' | 'completed' | 'blocked' | 'failed'

export interface SrcProjectionGoal {
  readonly id: string
  readonly target: string
  readonly objective: string
  readonly authorization: string
}

export type SrcProjectionNode =
  | {
    readonly id: string
    readonly kind: 'intent'
    readonly title: string
    readonly detail: string
    readonly status: SrcIntentStatus
    readonly createdAt: number
  }
  | {
    readonly id: string
    readonly kind: 'fact'
    readonly factKind: SrcFactKind
    readonly intentId: string
    readonly target: string
    readonly detail: string
    readonly confidence: number
    readonly createdAt: number
  }
  | {
    readonly id: string
    readonly kind: 'finding'
    readonly intentId: string
    readonly title: string
    readonly severity: SrcSeverity
    readonly description: string
    readonly steps: readonly string[]
    readonly impact: string
    readonly affectedScope: string
    readonly remediation: string
    readonly pocEvidence: readonly string[]
    readonly entryPoint: string
    readonly discoveryPath: string
    readonly rawRequest: string
    readonly rawResponse: string
    readonly victimImpact: string
    /** [local.26] attack preconditions (利用前提). */
    readonly attackPrerequisites: string
    /** [local.26] ids of facts/observations/research showing actual loss. */
    readonly concreteLossEvidence: readonly string[]
    readonly affectedAssetId: string | undefined
    readonly createdAt: number
    /** [local.26] finding lifecycle: 'active' (default) or 'rejected' (user-pushed-back). */
    readonly status: 'active' | 'rejected'
    /** [local.26] reject reason text when status === 'rejected'; '' otherwise. */
    readonly rejectReason: string
    /** [local.26] epoch ms when rejected; 0 when active. */
    readonly rejectedAt: number
    /** [local.26] optional narrative attack chain (发现→利用前提→利用过程→实际损失→受害者). */
    readonly attackChain: string
    /** [local.26] vulnerability/intel category for the report template (e.g. 登录认证漏洞). */
    readonly vulnType: string
    /** [local.27] ready-to-run PoC script, rendered as a fenced code block (indent preserved). */
    readonly pocScript: string
  }

export interface SrcProjectionAsset {
  readonly id: string
  readonly type: SrcAssetType
  readonly value: string
  readonly meta: string
  readonly source: string
  readonly method: 'passive' | 'low-impact' | 'authorized-active' | 'user-confirmed'
  readonly confidence: number
  readonly status: 'candidate' | 'confirmed' | 'excluded'
}

export interface SrcProjectionCheckpoint {
  readonly id: string
  readonly intentId: string
  readonly childSessionId: string
  readonly stage: 'progress' | 'completed' | 'blocked' | 'failed'
  readonly summary: string
  readonly decision: string
  readonly facts: number
  readonly assets: number
  readonly findings: number
  readonly batchKey: string
  readonly createdAt: number
}

export interface SrcProjectionObservation {
  readonly id: string
  readonly intentId: string
  readonly assetId: string | undefined
  readonly method: string
  readonly path: string
  readonly httpStatus: number
  readonly protectionSignal: boolean
  readonly wafBypassed: boolean
  readonly source: string
  readonly decision: string
  readonly respHeaders: string
  readonly respBodySnippet: string
  readonly createdAt: number
}

export interface SrcProjectionUserTodo {
  readonly id: string
  readonly intentId: string | undefined
  readonly kind: string
  readonly title: string
  readonly detail: string
  readonly status: 'pending' | 'done' | 'abandoned'
  readonly note: string
  readonly createdAt: number
}

/** [local.31] One high-risk HTTP request hung up pending human approval (async queue). */
export interface SrcProjectionPendingApproval {
  readonly id: string
  readonly intentId: string | undefined
  readonly method: string
  readonly url: string
  readonly path: string
  readonly headers: string
  readonly body: string
  readonly category: string
  readonly reason: string
  readonly justification: string
  readonly status: 'pending' | 'approved' | 'rejected'
  readonly note: string
  readonly responseStatus: number
  readonly createdAt: number
}

export interface SrcProjectionEdge {
  readonly id: string
  readonly kind: 'spawns' | 'yields' | 'derived_from' | 'proves' | 'parent'
  readonly sourceId: string
  readonly targetId: string
}

/** [local.32] One coverage row as carried by the wire projection (mirrors srcProjectionSchema). */
export interface SrcProjectionCoverageRow {
  readonly id: string
  readonly assetId: string | undefined
  readonly phase: string
  readonly category: string
  readonly status: 'planned' | 'running' | 'completed' | 'blocked' | 'not-applicable'
  readonly evidence: readonly string[]
  readonly limitation: string
  readonly updatedAt: number
}

/** [local.32] One research row as carried by the wire projection (mirrors srcProjectionSchema). */
export interface SrcProjectionResearchRow {
  readonly id: string
  readonly intentId: string
  readonly category: string
  readonly hypothesis: string
  readonly preconditions: readonly string[]
  readonly status: 'hypothesis' | 'testing' | 'reproduced' | 'verified' | 'false-positive' | 'blocked'
  readonly stopReason: string
  readonly evidence: readonly string[]
  readonly findingId: string | undefined
  readonly updatedAt: number
}

/** [local.33] One domain note as carried by the snapshot wire projection (mirrors srcProjectionSchema). */
export interface SrcProjectionDomainNote {
  readonly id: string
  readonly category: string
  readonly title: string
  readonly content: string
  readonly sourceSessionId: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** The standing src state shown by the Web view tab. */
export interface SrcProjection {
  readonly goal: SrcProjectionGoal | null
  readonly nodes: readonly SrcProjectionNode[]
  readonly assets: readonly SrcProjectionAsset[]
  readonly coverage: ReadonlyArray<SrcProjectionCoverageRow>
  readonly research: ReadonlyArray<SrcProjectionResearchRow>
  readonly checkpoints: readonly SrcProjectionCheckpoint[]
  readonly observations: readonly SrcProjectionObservation[]
  readonly userTodos: readonly SrcProjectionUserTodo[]
  readonly pendingApprovals: readonly SrcProjectionPendingApproval[]
  /** [local.33] 会话级认证预算（src_test_bypass 认证请求计数，src_auth_budget 合成事件推送）；头部统计格渲染。 */
  readonly authBudget?: { readonly used: number; readonly limit: number }
  /** [local.33] 目标域笔记快照（跨会话；src_add_goal / src_record_domain_note 时整表推送），explore 侧栏只读列表。 */
  readonly domainNotes?: readonly SrcProjectionDomainNote[]
  readonly infra: Readonly<Record<string, string>>
  readonly edges: readonly SrcProjectionEdge[]
  readonly apiDiscovery: {
    readonly total: number
    readonly schemas: number
    readonly graphql: number
    readonly hints: number
    readonly untouched: number
  } | undefined
  /** Derived counters (lib/src.js projection). */
  readonly counts: {
    readonly intents: number
    readonly facts: number
    readonly findings: number
    readonly assets: number
    readonly coverage: number
    readonly research: number
    readonly checkpoints: number
    readonly observations: number
    readonly userTodos: number
    readonly pendingApprovals: number
  } | undefined
  /** [UI-source note] not part of the wire schema; the timeline tolerates its absence (`src.findings ?? []`). */
  readonly findings?: readonly SrcProjectionNode[]
}
