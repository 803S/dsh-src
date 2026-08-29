/**
 * ExploreView: the 探索链路 sub-tab of the SRC view. Renders the
 * exploration chain (goal → intent → fact → derived intent → finding) as an
 * interactive graph with @xyflow/react; positions come from the pure
 * `layoutExploration` helper, nodes carry kind badges and connection handles,
 * and a custom edge renders a visible relationship pill on every chain edge
 * (意图链 / 产出 / 推导自 / 证实). [SRC] the detail drawer additionally shows
 * target / confidence / impact / remediation / POC evidence for finding and
 * fact nodes. [UI-source rebuild] restored from the local.21 bundle.
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
import type { SrcProjection, SrcEdgeKind, SrcSeverity } from '../../types/projection'
import type { PropsLocale } from '../../types/slots'
import { EXPLORE_NODE_SIZE, layoutExploration, type ExploreGraphNode } from './graph.ts'
import { GraphDetailDrawer } from './GraphDetailDrawer.tsx'
import type { SrcKey } from './locales.ts'
import css from './ExploreView.module.css'

/** Kind badge label keys per node kind. */
const KIND_LABELS: Record<ExploreGraphNode['kind'], SrcKey> = {
  goal: 'kind.goal',
  intent: 'kind.intent',
  fact: 'kind.fact',
  finding: 'kind.finding',
}

/** Relationship label keys per chain edge kind (parent edges never reach this view). */
const EDGE_LABELS: Record<SrcEdgeKind, SrcKey> = {
  spawns: 'edge.spawns',
  yields: 'edge.yields',
  derived_from: 'edge.derived_from',
  proves: 'edge.proves',
  parent: 'edge.parent',
}

/** Severity badge label keys. */
const SEVERITY_LABELS: Record<SrcSeverity, SrcKey> = {
  critical: 'severity.critical',
  high: 'severity.high',
  medium: 'severity.medium',
  low: 'severity.low',
  info: 'severity.info',
}

/** The React Flow node payload of one placed chain node (type alias: the node data must satisfy Record<string, unknown>). */
type FlowNodeData = { readonly node: ExploreGraphNode }

/** One custom flow node: a kind badge over the title and detail line, with source/target handles. */
function ChainNode({ data, t }: NodeProps & { t: PropsLocale['t'] }) {
  const node = (data as FlowNodeData).node
  return (
    <div className={css.node} data-kind={node.kind} data-severity={node.severity} data-testid={`explore-node-${node.kind}`}>
      <Handle type="target" position={Position.Left} className={css.handle} />
      <span className={css.badge}>{t(KIND_LABELS[node.kind])}</span>
      <span className={css.title} title={node.title}>{node.title}</span>
      {node.detail !== '' && <span className={css.detail} title={node.detail}>{node.detail}</span>}
      {node.severity !== undefined && (
        <span className={css.severity} data-severity={node.severity}>{t(SEVERITY_LABELS[node.severity])}</span>
      )}
      <Handle type="source" position={Position.Right} className={css.handle} />
    </div>
  )
}

/** One custom edge: a bezier curve with a visible relationship pill at its midpoint. */
export function ChainEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label }: EdgeProps) {
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

/** Full props of the explore sub-tab. */
export interface ExploreViewProps {
  readonly src: SrcProjection
  readonly t: PropsLocale['t']
}

/** [local.33] 域笔记分类徽标文案（分类枚举与 src_record_domain_note 一致）。 */
const NOTE_CATEGORY_LABELS: Record<string, string> = {
  fingerprint: '域指纹',
  pitfall: '坑位',
  'falsified-summary': '已否假设',
  baseline: '基线',
  misc: '其他',
}

export function ExploreView({ src, t }: ExploreViewProps) {
  const { nodes, edges } = useMemo(() => layoutExploration(src), [src])
  const [selectedNode, setSelectedNode] = useState<ExploreGraphNode | null>(null)
  /* [local.33] 域笔记侧栏：跨会话只读（src_add_goal / src_record_domain_note 快照推送）；默认展开，可收起。 */
  const notes = src.domainNotes ?? []
  const [notesOpen, setNotesOpen] = useState(true)
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null)
  const flowNodes = useMemo<FlowNode<FlowNodeData, 'src'>[]>(() =>
    nodes.map(node => ({
      id: node.id,
      type: 'src',
      position: { x: node.x, y: node.y },
      data: { node },
      style: EXPLORE_NODE_SIZE,
    })), [nodes])
  const flowEdges = useMemo<FlowEdge[]>(() =>
    edges.map(edge => ({
      id: edge.id,
      type: 'src',
      source: edge.sourceId,
      target: edge.targetId,
      label: t(EDGE_LABELS[edge.kind]),
    })), [edges, t])
  // The locale seat rides into the custom nodes through a render-scoped type
  // map (React Flow re-renders nodes when the map identity changes).
  const nodeTypes = useMemo<NodeTypes>(() => ({
    src: (props: NodeProps) => <ChainNode {...props} t={t} />,
  }), [t])
  return (
    <div className={css.graph} data-testid="src-explore">
      {nodes.length <= 1 ? (
        <p className={css.empty} data-testid="src-explore-empty">{t('explore.empty')}</p>
      ) : (
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={{ src: ChainEdge }}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, flowNode) => { setSelectedNode((flowNode.data as FlowNodeData).node) }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      )}
      {selectedNode !== null && (
        <GraphDetailDrawer
          title={selectedNode.title}
          fields={[
            { label: '类型', value: t(KIND_LABELS[selectedNode.kind]) },
            { label: '说明', value: selectedNode.detail },
            ...(selectedNode.target !== undefined && selectedNode.target !== '' ? [{ label: '目标', value: selectedNode.target }] : []),
            ...(typeof selectedNode.confidence === 'number' ? [{ label: '置信度', value: `${Math.round(selectedNode.confidence * 100)}%` }] : []),
            ...(selectedNode.severity === undefined ? [] : [{ label: '风险等级', value: t(SEVERITY_LABELS[selectedNode.severity]) }]),
            ...(selectedNode.impact !== undefined && selectedNode.impact !== '' ? [{ label: '危害', value: selectedNode.impact }] : []),
            ...(selectedNode.remediation !== undefined && selectedNode.remediation !== '' ? [{ label: '修复建议', value: selectedNode.remediation }] : []),
            ...((selectedNode.pocEvidence ?? []).length > 0 ? [{ label: 'POC 证据', value: (selectedNode.pocEvidence ?? []).join('\n---\n') }] : []),
          ]}
          onClose={() => { setSelectedNode(null) }}
        />
      )}
      {/* [local.33] 域笔记侧栏：只读折叠列表，绝对定位在图右上角，不干扰图布局。 */}
      <aside className={`${css.notesPanel}${notesOpen ? '' : ` ${css.notesPanelClosed}`}`} data-testid="src-domain-notes">
        <button type="button" className={css.notesHeader} onClick={() => { setNotesOpen(!notesOpen) }}>
          <span>{`📚 域笔记${notes.length > 0 ? ` · ${notes.length}` : ''}`}</span>
          <span className={css.notesToggle} aria-hidden>{notesOpen ? '▾' : '▸'}</span>
        </button>
        {notesOpen && (
          <div className={css.notesList}>
            {notes.length === 0 ? (
              <p className={css.notesEmpty}>本目标暂无域笔记——agent 沉淀（src_record_domain_note）后跨会话可见，开局也会自动带出。</p>
            ) : notes.map((note) => (
              <div key={note.id} className={css.noteItem}>
                <button type="button" className={css.noteTitle} onClick={() => { setExpandedNoteId(expandedNoteId === note.id ? null : note.id) }}>
                  <span className={css.noteCategory}>{NOTE_CATEGORY_LABELS[note.category] ?? note.category}</span>
                  {note.title}
                </button>
                {expandedNoteId === note.id && note.content !== '' && <p className={css.noteContent}>{note.content}</p>}
                <p className={css.noteMeta}>
                  {`来自会话 ${note.sourceSessionId === '' ? '—' : note.sourceSessionId.length > 14 ? `${note.sourceSessionId.slice(0, 14)}…` : note.sourceSessionId} · ${note.updatedAt > 0 ? new Date(note.updatedAt).toISOString().slice(0, 10) : '—'}`}
                </p>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  )
}
