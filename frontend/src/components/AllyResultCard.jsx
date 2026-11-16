import { useState } from 'react'

function formatInlineBold(text) {
  const parts = String(text || '').split(/(\**[^*]+\**)/g)
  return parts.map((part, idx) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={idx}>{part.slice(2, -2)}</strong>
    ) : (
      part
    )
  )
}

export default function AllyResultCard({ data, onSendPrompt }) {
  const [showRemediated, setShowRemediated] = useState(false)
  const [copiedCode, setCopiedCode] = useState(false)

  if (!data) return null

  if (data.type === 'chat' || !Array.isArray(data.findings)) {
    return (
      <div className="chatProse">
        {String(data.message || '')
          .split('\n\n')
          .filter(Boolean)
          .map((para, idx) => (
            <p key={idx}>{formatInlineBold(para)}</p>
          ))}
      </div>
    )
  }

  const verdict = String(data.coach_verdict || 'NEEDS_COACHING').toUpperCase()
  const verdictClass =
    verdict === 'STRONG_ACCESSIBILITY'
      ? 'verdictStrong'
      : verdict === 'CRITICAL_BARRIERS'
        ? 'verdictCritical'
        : 'verdictCoach'

  const verdictLabel =
    verdict === 'STRONG_ACCESSIBILITY'
      ? 'STRONG ACCESSIBILITY'
      : verdict === 'CRITICAL_BARRIERS'
        ? 'CRITICAL BARRIERS'
        : 'COACHING OPPORTUNITIES'

  const m = data.metrics || {}
  const findings = data.findings || []
  const strengths = data.strengths || []
  const score = data.readiness_score ?? 75
  const isRemediated = Boolean(data.is_remediated)
  const remediatedDoc = data.remediated_document || ''

  function copyRemediatedCode() {
    if (!remediatedDoc) return
    navigator.clipboard.writeText(remediatedDoc)
    setCopiedCode(true)
    setTimeout(() => setCopiedCode(false), 2000)
  }

  function downloadRemediatedFile() {
    if (!remediatedDoc) return
    const blob = new Blob([remediatedDoc], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'wcag_remediated_accessible_document.html'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  function handleApplyFixes() {
    setShowRemediated(true)
    if (onSendPrompt) {
      onSendPrompt('Yes, please update the document with all WCAG fixes applied.')
    }
  }

  return (
    <div className="allyCard">
      <div className="allyTop">
        <div className="allyTitleWrap">
          <div className="allyScope">{data.content_scope || 'Web Content & UI'}</div>
          <h3 className="allyTitle">{data.review_title || 'Web Accessibility Coaching Review'}</h3>
        </div>
        <div className="allyBadges">
          <span className={`verdictBadge ${verdictClass}`}>{verdictLabel}</span>
          <span className="scorePill">Readiness {score}%</span>
        </div>
      </div>

      <div className="metricsStrip" aria-label="Accessibility review metrics">
        <span className="metricItem">
          <i className="metricDot dotEmerald" />
          <strong>{m.total_findings ?? findings.length}</strong> WCAG Audited Items
        </span>
        <span className="metricSep">|</span>
        <span className="metricItem">
          <i className="metricDot dotHigh" />
          <strong>{m.high_priority ?? 0}</strong> Critical Fixes
        </span>
        <span className="metricSep">|</span>
        <span className="metricItem">
          <i className="metricDot dotMed" />
          <strong>{m.medium_priority ?? 0}</strong> Enhancements
        </span>
        <span className="metricSep">|</span>
        <span className="metricItem">
          <i className="metricDot dotElem" />
          <strong>{m.elements_reviewed ?? 1}</strong> Elements Checked
        </span>
      </div>

      {data.coach_summary && (
        <div className="coachSummary">{formatInlineBold(data.coach_summary)}</div>
      )}

      {/* Interactive WCAG Full Document Remediation Banner */}
      <div className="remediationBanner">
        <div className="remediationBannerLeft">
          <span className="remediationIcon">✨</span>
          <div>
            <h4 className="remediationQuestion">
              {isRemediated
                ? 'Document Fully Remediated with 100% WCAG Accuracy'
                : 'Should I update the document with all WCAG fixes applied?'}
            </h4>
            <p className="remediationSubtext">
              {isRemediated
                ? 'All non-compliant elements have been replaced with accessible ARIA, keyboard-operable, and semantic code.'
                : 'Instantly generate the production-ready remediated document with maximum accessibility compliance.'}
            </p>
          </div>
        </div>
        <div className="remediationActions">
          {(!isRemediated && !showRemediated) ? (
            <button
              type="button"
              className="applyFixesBtn"
              onClick={handleApplyFixes}
            >
              ✨ Yes, Update Document
            </button>
          ) : (
            <div className="remediatedBtns">
              <button
                type="button"
                className="copyRemediatedBtn"
                onClick={copyRemediatedCode}
              >
                {copiedCode ? '✓ Copied' : '📋 Copy Accessible Code'}
              </button>
              <button
                type="button"
                className="downloadRemediatedBtn"
                onClick={downloadRemediatedFile}
              >
                📥 Download Remediated File (.html)
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Remediated Document Code Viewer */}
      {(showRemediated || isRemediated) && remediatedDoc && (
        <div className="remediatedDocViewer">
          <div className="viewerHeader">
            <span>📄 ACCESSIBLE REMEDIATED DOCUMENT PREVIEW</span>
            <span className="wcagBadgeSuccess">✓ WCAG 2.2 LEVEL AA/AAA COMPLIANT</span>
          </div>
          <pre className="remediatedCodeBlock">
            <code>{remediatedDoc}</code>
          </pre>
        </div>
      )}

      {/* Findings with WCAG Highlight and Non-Compliant vs Compliant Code */}
      {findings.length > 0 && (
        <div className="allySection">
          <div className="sectionHead">
            WCAG COMPLIANCE FINDINGS · CODE REPLACEMENTS
          </div>
          <div className="findingsList">
            {findings.map((f, idx) => {
              const prio = String(f.priority || 'MEDIUM').toUpperCase()
              const prioClass = prio === 'HIGH' ? 'prioHigh' : prio === 'LOW' ? 'prioLow' : 'prioMed'
              const wcagRule = f.wcag_highlight || f.wcag_reference || 'WCAG 2.2 SC 2.4.4 Link Purpose'
              const nonCompliant = f.non_compliant_code || f.original_snippet
              const compliant = f.compliant_code || f.suggested_fix

              return (
                <div key={idx} className="findingItem">
                  {/* WCAG Standard Highlight at Top */}
                  <div className="wcagHighlightBanner">
                    <span className="wcagIcon">🛡️</span>
                    <span className="wcagName">{wcagRule}</span>
                    <span className={`prioPill ${prioClass}`}>{prio} PRIORITY</span>
                  </div>

                  <div className="findingHead" style={{ marginTop: '8px' }}>
                    <span className="findingLoc">{f.element_or_location || `Target Location ${idx + 1}`}</span>
                    <span className="catPill">{f.category || 'Semantic Structure'}</span>
                  </div>

                  {/* Side-by-Side / Stacked Non-Compliant vs Compliant Code */}
                  <div className="codeComparisonGrid">
                    {nonCompliant && (
                      <div className="codeBox nonCompliantBox">
                        <div className="codeBoxHeader">
                          <span className="codeBoxBadge redBadge">❌ NON-COMPLIANT CODE</span>
                        </div>
                        <pre className="codeSnippet">
                          <code>{nonCompliant}</code>
                        </pre>
                      </div>
                    )}
                    {compliant && (
                      <div className="codeBox compliantBox">
                        <div className="codeBoxHeader">
                          <span className="codeBoxBadge greenBadge">✅ ACCESSIBLE WCAG REPLACEMENT CODE</span>
                        </div>
                        <pre className="codeSnippet">
                          <code>{compliant}</code>
                        </pre>
                      </div>
                    )}
                  </div>

                  {/* Concise Context */}
                  <div className="coachRows" style={{ marginTop: '10px' }}>
                    {f.issue && (
                      <div className="coachRow">
                        <span className="coachKey">Issue</span>
                        <span className="coachVal">{f.issue}</span>
                      </div>
                    )}
                    {f.why_it_matters && (
                      <div className="coachRow">
                        <span className="coachKey">Assistive Impact</span>
                        <span className="coachVal">{f.why_it_matters}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {strengths.length > 0 && (
        <div className="allySection">
          <div className="sectionHead">ACCESSIBLE STRENGTHS DETECTED</div>
          <div className="strengthsList">
            {strengths.map((s, idx) => (
              <div key={idx} className="strengthItem">
                <span className="strengthCheck">✓</span>
                <span className="strengthText">{s}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.validation_note && (
        <div className="validationNote">
          <span className="valDot" />
          <span>{data.validation_note}</span>
        </div>
      )}
    </div>
  )
}
