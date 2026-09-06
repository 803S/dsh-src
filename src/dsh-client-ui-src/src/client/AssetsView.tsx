/**
 * AssetsView: the 资产 sub-tab of the SRC view, with a 列表/图 mode toggle.
 * List mode groups assets by type (root domain → … → threat-intel) and shows
 * each parent link, source/method/confidence provenance, and candidate /
 * excluded status inline; graph mode renders the parent-child asset tree
 * with @xyflow/react (positions from the pure `layoutAssets` helper).
 * [SRC] 5 new asset types (mini-program / client / firmware / ai-surface /
 * threat-intel), AI-flavored rows get a 🤖 accent, and list rows show
 * 来源/方式/置信 provenance. [UI-source rebuild] restored from local.21 bundle.
 */

import { useMemo, useState } from 'react'
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  ReactFlow,
  type EdgeProps,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { SrcAssetType, SrcProjection } from '../../types/projection'
import type { PropsLocale } from '../../types/slots'
import { ASSET_NODE_SIZE, layoutAssets, type AssetGraphNode } from './graph.ts'
import { GraphDetailDrawer } from './GraphDetailDrawer.tsx'
import type { SrcKey } from './locales.ts'
import css from './AssetsView.module.css'

/** Asset type label keys, in display order. */
const ASSET_TYPES = [
  'root-domain',
  'subdomain',
  'ip',
  'service',
  'app',
  'endpoint',
  'mini-program',
  'client',
  'firmware',
  'ai-surface',
  'threat-intel',
] as const satisfies readonly SrcAssetType[]

/** Asset type badge label keys. */
const TYPE_LABELS: Record<SrcAssetType, SrcKey> = {
  'root-domain': 'asset.type.root-domain',
  'subdomain': 'asset.type.subdomain',
  'ip': 'asset.type.ip',
  'service': 'asset.type.service',
  'app': 'asset.type.app',
  'endpoint': 'asset.type.endpoint',
  'mini-program': 'asset.type.mini-program',
  'client': 'asset.type.client',
  'firmware': 'asset.type.firmware',
  'ai-surface': 'asset.type.ai-surface',
  'threat-intel': 'asset.type.threat-intel',
}

/** The two view modes of the assets tab. */
type AssetMode = 'list' | 'graph'

/** [local.60] Per-asset coverage badge keys: explicit per-asset coverage row > fact evidence > untouched. */
type CoverageKey = 'tested' | 'blocked' | 'notApplicable' | 'testing' | 'assessed' | 'untouched'

const COVERAGE_LABELS: Record<CoverageKey, string> = {
  tested: '已测',
  blocked: '受阻',
  notApplicable: '不适用',
  testing: '测试中',
  assessed: '已评估',
  untouched: '未触达',
}

const COVERAGE_CLASSES: Record<CoverageKey, string> = {
  tested: css.covTested,
  blocked: css.covBlocked,
  notApplicable: css.covNa,
  testing: css.covTesting,
  assessed: css.covAssessed,
  untouched: css.covUntouched,
}

const COVERAGE_ORDER: readonly CoverageKey[] = ['tested', 'blocked', 'notApplicable', 'testing', 'assessed', 'untouched']

function coverageBadgeOfStatus(status: string): CoverageKey {
  if (status === 'completed') return 'tested'
  if (status === 'blocked') return 'blocked'
  if (status === 'not-applicable') return 'notApplicable'
  return 'testing' // planned / running
}

/** Hostname of an asset value ("https://a.b/c" | "a.b" | "1.2.3.4:80"); '' when not host-shaped. */
function hostOfAssetValue(value: string): string {
  const raw = value.trim()
  if (raw === '') return ''
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** [local.60] Per-asset coverage map: explicit per-asset coverage row（assetId）wins；否则 fact 节点提
 *  及该 host 记「已评估」（侦察阶段评估过但无显式覆盖结论）；都没有即「未触达」。此前 coverage
 *  全是 phase×category 级、assetId 全程为空，用户看 159 资产墙无法区分「测过」和「没碰过」。 */
function coverageBadges(src: SrcProjection): Map<string, CoverageKey> {
  const explicit = new Map<string, CoverageKey>()
  for (const row of src.coverage) {
    if (row.assetId === undefined || row.assetId === '') continue
    explicit.set(row.assetId, coverageBadgeOfStatus(row.status))
  }
  const facts = src.nodes.filter(node => node.kind === 'fact')
  const badges = new Map<string, CoverageKey>()
  for (const asset of src.assets) {
    const fromCoverage = explicit.get(asset.id)
    if (fromCoverage !== undefined) {
      badges.set(asset.id, fromCoverage)
      continue
    }
    const host = hostOfAssetValue(asset.value)
    badges.set(asset.id, host !== '' && facts.some(fact => fact.target.toLowerCase().includes(host)) ? 'assessed' : 'untouched')
  }
  return badges
}

/** One asset row in list mode (with the parent value and provenance resolved). */
interface AssetRow {
  readonly id: string
  readonly type: SrcAssetType
  readonly value: string
  readonly meta: string
  readonly source: string
  readonly method: string
  readonly confidence: number
  readonly status: string
  readonly parentValue: string
}

/** Resolve the parent value and provenance of every asset from the parent edges. */
function rowsOf(projection: SrcProjection): AssetRow[] {
  return projection.assets.map((asset) => {
    const parentEdge = projection.edges.find(edge => edge.kind === 'parent' && edge.targetId === asset.id)
    const parent = parentEdge === undefined
      ? undefined
      : projection.assets.find(candidate => candidate.id === parentEdge.sourceId)
    return {
      id: asset.id,
      type: asset.type,
      value: asset.value,
      meta: asset.meta,
      source: asset.source ?? '',
      method: asset.method ?? '',
      confidence: typeof asset.confidence === 'number' ? Math.round(asset.confidence * 100) : -1,
      status: asset.status ?? 'confirmed',
      parentValue: parent?.value ?? '',
    }
  })
}

/** Group asset rows by type in display order. */
function groupByType(rows: readonly AssetRow[]): Array<{ type: SrcAssetType; rows: AssetRow[] }> {
  return ASSET_TYPES
    .map(type => ({ type, rows: rows.filter(row => row.type === type) }))
    .filter(group => group.rows.length > 0)
}

/** List mode: sections per asset type with inline parent links. */
function AssetList({ src, t }: AssetsViewProps) {
  const rows = useMemo(() => rowsOf(src), [src])
  const badges = useMemo(() => coverageBadges(src), [src])
  const counts = useMemo(() => {
    const acc: Record<CoverageKey, number> = { tested: 0, blocked: 0, notApplicable: 0, testing: 0, assessed: 0, untouched: 0 }
    for (const row of rows) {
      const key = badges.get(row.id) ?? 'untouched'
      acc[key] += 1
    }
    return acc
  }, [rows, badges])
  const groups = groupByType(rows)
  return (
    <div className={css.list} data-testid="src-assets-list">
      <p className={css.coverageSummary} data-testid="src-assets-coverage-summary">
        {COVERAGE_ORDER.map(key => (
          <span key={key} className={`${css.coverageSummaryItem} ${COVERAGE_CLASSES[key]}`}>
            {COVERAGE_LABELS[key]} {counts[key]}
          </span>
        ))}
      </p>
      {groups.map(group => (
        <section key={group.type} className={css.group} data-testid="src-asset-group">
          <h4 className={css.groupTitle}>{t(TYPE_LABELS[group.type])}</h4>
          <ul className={css.rows}>
            {group.rows.map(row => (
              <li key={row.id} className={css.row} data-testid="src-asset-row">
                <span
                  className={css.rowValue}
                  style={row.type === 'ai-surface' || row.type === 'threat-intel' ? { color: '#c60', fontWeight: 600 } : undefined}
                >
                  {row.type === 'ai-surface' || row.type === 'threat-intel' ? '🤖 ' : ''}
                  {row.value}
                  {row.status === 'candidate' ? ' （待确认）' : row.status === 'excluded' ? ' （已排除）' : ''}
                </span>
                {row.meta !== '' && <span className={css.rowMeta}>（{row.meta}）</span>}
                {(() => {
                  const key = badges.get(row.id) ?? 'untouched'
                  return (
                    <span
                      className={`${css.coverageBadge} ${COVERAGE_CLASSES[key]}`}
                      data-testid="src-asset-coverage"
                      title={key === 'assessed' ? '侦察阶段评估过（有事实提及），尚无显式覆盖结论' : key === 'untouched' ? '没有覆盖记录，也没有事实提及' : '来自 src_record_coverage 的单资产结论'}
                    >
                      {COVERAGE_LABELS[key]}
                    </span>
                  )
                })()}
                {(row.source !== '' && row.source !== 'unknown' || row.method !== '' && row.method !== 'passive' || row.confidence >= 0) && (
                  <span className={css.rowParent}>
                    {row.source !== '' && row.source !== 'unknown' ? `来源:${row.source}` : ''}
                    {row.source !== '' && row.source !== 'unknown' && row.method !== '' && row.method !== 'passive' ? ' · ' : ''}
                    {row.method !== '' && row.method !== 'passive' ? `方式:${row.method}` : ''}
                    {row.confidence >= 0 ? `${row.source !== '' && row.source !== 'unknown' || row.method !== '' && row.method !== 'passive' ? ' · ' : ''}置信 ${row.confidence}%` : ''}
                  </span>
                )}
                {row.parentValue !== '' && <span className={css.rowParent}>← {row.parentValue}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** The React Flow node payload of one placed asset (type alias: the node data must satisfy Record<string, unknown>). */
type FlowNodeData = { readonly asset: AssetGraphNode }

/** One custom flow node: an asset-type badge over the value, with source/target handles. */
function AssetFlowNode({ data, t }: NodeProps & { t: PropsLocale['t'] }) {
  const asset = (data as FlowNodeData).asset
  return (
    <div className={css.node} data-type={asset.type} data-testid="explore-node-asset">
      <Handle type="target" position={Position.Left} className={css.handle} />
      <span className={css.nodeBadge}>{t(TYPE_LABELS[asset.type])}</span>
      <span className={css.nodeValue} title={asset.value}>{asset.value}</span>
      {asset.meta !== '' && <span className={css.nodeMeta} title={asset.meta}>{asset.meta}</span>}
      <Handle type="source" position={Position.Right} className={css.handle} />
    </div>
  )
}

/** One custom edge: a bezier curve with a visible 隶属 pill at its midpoint. */
export function AssetEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetPosition, targetX, targetY })
  return (
    <>
      <BaseEdge id={id} path={path} />
      {label !== undefined && (
        <EdgeLabelRenderer>
          <div className={css.edgeLabel} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

/** Graph mode: the parent-child asset tree. */
function AssetGraph({ src, t }: AssetsViewProps) {
  const { nodes, edges } = useMemo(() => layoutAssets(src), [src])
  const [selectedAsset, setSelectedAsset] = useState<AssetGraphNode | null>(null)
  const flowNodes = useMemo<FlowNode<FlowNodeData, 'src'>[]>(() =>
    nodes.map(node => ({
      id: node.id,
      type: 'src',
      position: { x: node.x, y: node.y },
      data: { asset: node },
      style: ASSET_NODE_SIZE,
    })), [nodes])
  const flowEdges = useMemo<FlowEdge[]>(() =>
    edges.map(edge => ({
      id: edge.id,
      type: 'src',
      source: edge.sourceId,
      target: edge.targetId,
      label: t('edge.parent'),
    })), [edges, t])
  const nodeTypes = useMemo<NodeTypes>(() => ({
    src: (props: NodeProps) => <AssetFlowNode {...props} t={t} />,
  }), [t])
  return (
    <div className={css.graph} data-testid="src-assets-graph">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={{ src: AssetEdge }}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, flowNode) => { setSelectedAsset((flowNode.data as FlowNodeData).asset) }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
      {selectedAsset !== null && (
        <GraphDetailDrawer
          title={selectedAsset.value}
          fields={[
            { label: '资产类型', value: t(TYPE_LABELS[selectedAsset.type]) },
            { label: '资产值', value: selectedAsset.value },
            { label: '元数据', value: selectedAsset.meta },
          ]}
          onClose={() => { setSelectedAsset(null) }}
        />
      )}
    </div>
  )
}

/** Full props of the assets sub-tab. */
export interface AssetsViewProps {
  readonly src: SrcProjection
  readonly t: PropsLocale['t']
}

export function AssetsView({ src, t }: AssetsViewProps) {
  const [mode, setMode] = useState<AssetMode>('list')
  if (src.assets.length === 0) {
    return <p className={css.empty} data-testid="src-assets-empty">{t('assets.empty')}</p>
  }
  return (
    <div className={css.root} data-testid="src-assets">
      <div className={css.modeBar}>
        {(['list', 'graph'] as const).map(modeKey => (
          <button
            key={modeKey}
            type="button"
            className={css.modeButton}
            aria-pressed={mode === modeKey}
            data-testid={`src-assets-mode-${modeKey}`}
            onClick={() => { setMode(modeKey) }}
          >
            {t(modeKey === 'list' ? 'assets.mode.list' : 'assets.mode.graph')}
          </button>
        ))}
      </div>
      {mode === 'list' ? <AssetList src={src} t={t} /> : <AssetGraph src={src} t={t} />}
    </div>
  )
}
