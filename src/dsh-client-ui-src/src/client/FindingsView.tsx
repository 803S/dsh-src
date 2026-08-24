/**
 * FindingsView: the 漏洞 sub-tab of the SRC view. Lists every vulnerability
 * finding of the engagement — severity badge, title, description, impact,
 * victim impact, discovery path, entry point, scope, remediation, raw
 * request/response POC, evidence list, reproducible steps, and the affected
 * asset when linked. [UI-source rebuild] restored from the local.21 bundle.
 */

import type { SrcProjection, SrcProjectionNode, SrcSeverity } from '../../types/projection'
import type { PropsLocale } from '../../types/slots'
import type { SrcKey } from './locales.ts'
import css from './FindingsView.module.css'

/** Severity badge label keys. */
const SEVERITY_LABELS: Record<SrcSeverity, SrcKey> = {
  critical: 'severity.critical',
  high: 'severity.high',
  medium: 'severity.medium',
  low: 'severity.low',
  info: 'severity.info',
}

/** Narrow the projection nodes to findings. */
function findingsOf(projection: SrcProjection): Array<SrcProjectionNode & { kind: 'finding' }> {
  return projection.nodes.filter((node): node is SrcProjectionNode & { kind: 'finding' } => node.kind === 'finding')
}

/** Full props of the findings sub-tab. */
export interface FindingsViewProps {
  readonly src: SrcProjection
  readonly t: PropsLocale['t']
}

export function FindingsView({ src, t }: FindingsViewProps) {
  const findings = findingsOf(src)
  if (findings.length === 0) {
    return <p className={css.empty} data-testid="src-findings-empty">{t('findings.empty')}</p>
  }
  return (
    <ul className={css.list} data-testid="src-findings">
      {findings.map((finding) => {
        const asset = finding.affectedAssetId === undefined
          ? undefined
          : src.assets.find(candidate => candidate.id === finding.affectedAssetId)
        return (
          <li key={finding.id} className={css.finding} data-testid="src-finding">
            <header className={css.header}>
              <span className={css.severity} data-severity={finding.severity}>{t(SEVERITY_LABELS[finding.severity])}</span>
              <h4 className={css.title}>{finding.title}</h4>
              <span className={css.id}>{finding.id}</span>
            </header>
            {finding.description !== '' && <p className={css.description}>{finding.description}</p>}
            <p className={css.description}>{t('finding.impact')}: {finding.impact}</p>
            {(finding.victimImpact ?? '') !== '' && <p className={css.description}>{t('finding.victimImpact')}: {finding.victimImpact}</p>}
            {finding.discoveryPath !== '' && <p className={css.description}>{t('finding.discoveryPath')}: {finding.discoveryPath}</p>}
            {finding.entryPoint !== '' && <p className={css.description}>{t('finding.entryPoint')}: {finding.entryPoint}</p>}
            <p className={css.description}>{t('finding.scope')}: {finding.affectedScope}</p>
            <p className={css.description}>{t('finding.remediation')}: {finding.remediation}</p>
            {(finding.rawRequest !== '' || finding.rawResponse !== '') && (
              <div className={css.stepsBlock}>
                {finding.rawRequest !== '' && (
                  <>
                    <span className={css.stepsLabel}>{t('finding.rawRequest')}</span>
                    <pre className={css.steps} style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{finding.rawRequest}</pre>
                  </>
                )}
                {finding.rawResponse !== '' && (
                  <>
                    <span className={css.stepsLabel}>{t('finding.rawResponse')}</span>
                    <pre className={css.steps} style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{finding.rawResponse}</pre>
                  </>
                )}
              </div>
            )}
            <div className={css.stepsBlock}>
              <span className={css.stepsLabel}>{t('finding.evidence')}</span>
              <ol className={css.steps}>
                {(finding.pocEvidence ?? []).map((evidence, index) => <li key={index}>{evidence}</li>)}
              </ol>
            </div>
            <div className={css.stepsBlock}>
              <span className={css.stepsLabel}>{t('finding.steps')}</span>
              <ol className={css.steps}>
                {finding.steps.map((step, index) => <li key={index}>{step}</li>)}
              </ol>
            </div>
            {asset !== undefined && (
              <p className={css.asset}>{t('finding.affected')}: [{asset.type}] {asset.value}</p>
            )}
          </li>
        )
      })}
    </ul>
  )
}
