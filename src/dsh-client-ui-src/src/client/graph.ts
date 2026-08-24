/**
 * Pure graph-layout helpers for the pentest view tabs: layered positions for
 * the exploration chain (goal → intents → facts → derived intents → findings)
 * and for the asset tree (parent → children). Pure functions of the standing
 * projection — fully unit-testable, no React Flow involvement.
 */

import type {
  SrcProjection,
  SrcProjectionEdge,
  SrcProjectionNode,
  SrcSeverity,
  SrcAssetType,
} from '../../types/projection'

/** Node kinds drawn in the exploration graph. */
export type ExploreNodeKind = 'goal' | 'intent' | 'fact' | 'finding'

/** One placed exploration node (position in graph units). */
export interface ExploreGraphNode {
  readonly id: string
  readonly kind: ExploreNodeKind
  readonly title: string
  readonly detail: string
  readonly severity: SrcSeverity | undefined
  readonly x: number
  readonly y: number
  // [SRC] finding/fact 详情透传（上游 pentest 无）：
  readonly target?: string
  readonly confidence?: number
  readonly impact?: string
  readonly remediation?: string
  readonly pocEvidence?: readonly string[]
}

/** One placed asset node (position in graph units). */
export interface AssetGraphNode {
  readonly id: string
  readonly type: SrcAssetType
  readonly value: string
  readonly meta: string
  readonly x: number
  readonly y: number
}

/** Fixed graph-card dimensions; layout spacing must leave room around them. */
export const EXPLORE_NODE_SIZE = { width: 236, height: 120 } as const
export const ASSET_NODE_SIZE = { width: 220, height: 100 } as const

/** The chain edge kinds (parent edges belong to the asset graph only). */
const CHAIN_EDGE_KINDS: ReadonlySet<string> = new Set(['spawns', 'yields', 'derived_from', 'proves'])

/** Assign every reachable id a BFS depth from the roots; others hang below. */
function depthsOf(roots: readonly string[], edges: readonly SrcProjectionEdge[]): Map<string, number> {
  const depth = new Map<string, number>()
  // BFS over the edge list; `for..of` visits entries pushed while iterating,
  // so the queue grows in place without indexed access.
  const queue: Array<{ id: string; level: number }> = []
  for (const root of roots) {
    depth.set(root, 0)
    queue.push({ id: root, level: 0 })
  }
  for (const { id, level } of queue) {
    for (const edge of edges) {
      if (edge.sourceId !== id || depth.has(edge.targetId)) continue
      depth.set(edge.targetId, level + 1)
      queue.push({ id: edge.targetId, level: level + 1 })
    }
  }
  return depth
}

/** Stack items into columns by depth, assigning x/y positions. */
function stackByDepth<T extends { readonly id: string }>(
  items: readonly T[],
  depth: ReadonlyMap<string, number>,
  columnGap: number,
  rowGap: number,
): Array<T & { readonly x: number; readonly y: number }> {
  const maxDepth = Math.max(0, ...depth.values())
  const rows = new Map<number, T[]>()
  for (const item of items) {
    const level = depth.get(item.id) ?? maxDepth + 1
    const row = rows.get(level) ?? []
    row.push(item)
    rows.set(level, row)
  }
  const placed: Array<T & { readonly x: number; readonly y: number }> = []
  for (const [level, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    for (const [index, item] of row.entries()) {
      placed.push({ ...item, x: level * columnGap, y: index * rowGap })
    }
  }
  return placed
}

/** The display title of one folded node. */
function titleOf(node: SrcProjectionNode): string {
  switch (node.kind) {
    case 'intent': return node.title
    case 'fact': return node.detail
    case 'finding': return node.title
  }
}

/** The display detail line of one folded node. */
function detailOf(node: SrcProjectionNode): string {
  switch (node.kind) {
    case 'intent': return node.detail
    case 'fact': {
      const target = node.target === '' ? '' : `${node.target} `
      return `${target}[${node.factKind}] · ${node.confidence}`
    }
    case 'finding': return node.description
  }
}

/**
 * Layered layout of the exploration chain: the goal at column 0, every node
 * one column per hop along its chain edges; nodes unreachable from the goal
 * hang in the last column. Parent edges are excluded.
 * @param projection - the standing pentest projection.
 * @returns the placed nodes and their chain edges.
 */
export function layoutExploration(projection: SrcProjection): {
  nodes: ExploreGraphNode[]
  edges: SrcProjectionEdge[]
} {
  const edges = projection.edges.filter(edge => CHAIN_EDGE_KINDS.has(edge.kind))
  const goalId = projection.goal === null ? 'goal-1' : projection.goal.id
  const depth = depthsOf([goalId], edges)
  const goal: ExploreGraphNode = {
    id: goalId,
    kind: 'goal',
    title: projection.goal === null ? '' : projection.goal.target,
    detail: projection.goal === null ? '' : projection.goal.objective,
    severity: undefined,
    x: 0,
    y: 0,
  }
  const chain: Array<ExploreGraphNode & { readonly x: number; readonly y: number }> = stackByDepth(
    [goal, ...projection.nodes.map(node => ({
      id: node.id,
      kind: node.kind,
      title: titleOf(node),
      detail: detailOf(node),
      severity: node.kind === 'finding' ? node.severity : undefined,
      // [SRC] finding/fact 详情字段透传给 GraphDetailDrawer（上游 pentest 无此段）；
      // 各字段按节点 kind 可选，缺失即为 undefined，与 bundle 行为一致。
      target: 'target' in node ? node.target : undefined,
      confidence: 'confidence' in node ? node.confidence : undefined,
      impact: 'impact' in node ? node.impact : undefined,
      remediation: 'remediation' in node ? node.remediation : undefined,
      pocEvidence: 'pocEvidence' in node ? node.pocEvidence : undefined,
    }))],
    depth,
    320,
    152,
  )
  return { nodes: chain, edges }
}

/**
 * Layered layout of the asset graph: roots (assets without a parent edge) at
 * column 0, children one column deeper per parent hop.
 * @param projection - the standing pentest projection.
 * @returns the placed asset nodes and their parent edges.
 */
export function layoutAssets(projection: SrcProjection): {
  nodes: AssetGraphNode[]
  edges: SrcProjectionEdge[]
} {
  const edges = projection.edges.filter(edge => edge.kind === 'parent')
  const children = new Set(edges.map(edge => edge.targetId))
  const roots = projection.assets.filter(asset => !children.has(asset.id)).map(asset => asset.id)
  const depth = depthsOf(roots, edges)
  const nodes = stackByDepth(projection.assets, depth, 292, 132)
  return { nodes, edges }
}
