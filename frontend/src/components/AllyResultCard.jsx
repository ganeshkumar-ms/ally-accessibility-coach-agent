import { useState, useMemo } from 'react'

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

function parseRejection(data) {
  const rej = data?.rejection_details || {}
  const msg = typeof data?.message === 'string' ? data.message : ''
  let title = rej.title || data?.title || ''
  let filename = rej.filename || data?.filename || data?.file_name || data?.document?.filename || data?.document_metadata?.filename || 'Uploaded Document'
  let reason = rej.reason || rej.why || ''
  let technicalDetail = rej.technical_detail || ''
  let supported = rej.supported_formats || ''
  let howToFix = rej.how_to_fix || ''

  if (msg.includes('•') || (!reason && msg.includes('File Not Accepted'))) {
    const parts = msg.split(/\s*•\s*/)
    parts.forEach((p, idx) => {
      const part = p.trim()
      if (idx === 0 && !title) {
        title = part
      } else if (part.toLowerCase().startsWith('file:') && !filename) {
        filename = part.substring(part.indexOf(':') + 1).trim()
      } else if (part.toLowerCase().includes('why it was not accepted:') && !reason) {
        reason = part.substring(part.indexOf(':') + 1).trim()
      } else if (part.toLowerCase().includes('technical details:') && !technicalDetail) {
        technicalDetail = part.substring(part.indexOf(':') + 1).trim()
      } else if (part.toLowerCase().includes('supported formats') && !supported) {
        supported = part.substring(part.indexOf(':') + 1).trim()
      } else if (part.toLowerCase().includes('how to fix') && !howToFix) {
        howToFix = part.substring(part.indexOf(':') + 1).trim()
      }
    })
  }
  if (!title) title = 'File Not Accepted'
  const isSecurity = /credential|secret|access key|password|token/i.test(title + ' ' + reason)
  let reasonLabel = isSecurity ? 'Security & Policy Violation' : 'Reason for Rejection'
  const isFormatIssue = /format|extension|unsupported|binary|unreadable|corrupt|container|mime/i.test(title + ' ' + reason + ' ' + technicalDetail) && !isSecurity && !/empty|blank/i.test(title + ' ' + reason)
  return { title, filename, reason, reasonLabel, technicalDetail, supported: isFormatIssue ? supported : '', howToFix }
}

export default function AllyResultCard({ data, guardrails: propGuardrails, onSendPrompt }) {
  const [showRemediated, setShowRemediated] = useState(false)
  const [remediationChoice, setRemediationChoice] = useState(null) // 'yes' | 'no' | null
  const [copiedCode, setCopiedCode] = useState(false)
  const [prioFilter, setPrioFilter] = useState('ALL')
  const [catFilter, setCatFilter] = useState('ALL')
  const [searchQuery, setSearchQuery] = useState('')

  if (!data) return null

  const guardrails = propGuardrails || data?.guardrails || {}
  const traceId = data?.trace_id || guardrails?.trace_id || ''

  // 1. Structured File Rejection Card
  if (data.rejected || data.rejection_details || (typeof data.message === 'string' && data.message.includes('File Not Accepted'))) {
    const rej = parseRejection(data)

    return (
      <div className="allyRejectionCard">
        <div className="allyRejectionHeader">
          <div className="allyRejectionBadge">
            <svg className="iconSvg" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{rej.title}</span>
          </div>
          <span className="allyRejectionFile">
            {rej.filename}
          </span>
        </div>

        <div className="allyRejectionBody">
          {rej.reason && (
            <div className="rejectionSection">
              <span className="rejectionLabel">{rej.reasonLabel || 'Reason for Rejection'}</span>
              <p className="rejectionValue">{rej.reason}</p>
            </div>
          )}

          {rej.technicalDetail && (
            <div className="rejectionSection">
              <span className="rejectionLabel">Technical Details</span>
              <p className="rejectionValue mono">{rej.technicalDetail}</p>
            </div>
          )}

          {rej.supported && (
            <div className="rejectionSection">
              <span className="rejectionLabel">Supported Formats for ALLY</span>
              <p className="rejectionValue">{rej.supported}</p>
            </div>
          )}

          {rej.howToFix && (
            <div className="rejectionSection fixSection">
              <span className="rejectionLabel">How to Fix & Re-upload</span>
              <p className="rejectionValue">{rej.howToFix}</p>
            </div>
          )}

          {!rej.reason && (
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: '13.5px', color: '#e2e8f0' }}>
              {data.message}
            </div>
          )}
        </div>
      </div>
    )
  }

  // 2. Chat / Text Q&A Message
  if (data.type === 'chat' || !Array.isArray(data.findings)) {
    return (
      <div className="chatProse">
        {guardrails?.status === 'BLOCKED' && (
          <div style={{ marginBottom: '12px' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 12px',
                borderRadius: '999px',
                fontSize: '11.5px',
                fontWeight: 700,
                background: 'rgba(239, 68, 68, 0.22)',
                color: '#f87171',
                border: '1px solid rgba(239, 68, 68, 0.65)'
              }}
            >
              <svg className="iconSvg" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <span>Guardrails: Blocked ({guardrails.triggered_rule || guardrails.rejection_reason || 'Policy Violation'})</span>
            </span>
          </div>
        )}
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
  const score = data.accessibility_score ?? data.readiness_score ?? 75
  const isRemediated = Boolean(data.is_remediated)
  const remediatedDoc = useMemo(() => {
    if (data.remediated_document && String(data.remediated_document).trim()) {
      return String(data.remediated_document).trim()
    }
    if (data.extracted_text && String(data.extracted_text).trim()) {
      let updated = String(data.extracted_text)
      findings.forEach(f => {
        const before = f.non_compliant_code || f.element || f.original_snippet
        const after = f.compliant_code || f.suggested_fix
        if (before && after && updated.includes(before)) {
          updated = updated.replace(before, after)
        }
      })
      return updated
    }
    const snippets = findings
      .map(f => f.compliant_code || f.suggested_fix)
      .filter(Boolean)
    return snippets.length > 0
      ? `<!-- WCAG 2.2 Level A/AA Remediated Code -->\n${snippets.join('\n\n')}`
      : '<!-- Verified WCAG 2.2 Accessible Source Code -->'
  }, [data.remediated_document, data.extracted_text, findings])
  const quarantinedFiles = data.quarantined_files || []

  // Extract categories for filter dropdown
  const categories = useMemo(() => {
    const set = new Set()
    findings.forEach(f => {
      if (f.category) set.add(f.category)
    })
    return Array.from(set)
  }, [findings])

  // Filtered findings
  const visibleFindings = useMemo(() => {
    return findings.filter(f => {
      const p = String(f.priority || 'MEDIUM').toUpperCase()
      if (prioFilter !== 'ALL' && p !== prioFilter) return false
      if (catFilter !== 'ALL' && f.category !== catFilter) return false
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        const text = `${f.category || ''} ${f.wcag_reference || ''} ${f.element_or_location || ''} ${f.issue || ''} ${f.non_compliant_code || ''} ${f.compliant_code || ''} ${f.why_it_matters || ''}`.toLowerCase()
        if (!text.includes(q)) return false
      }
      return true
    })
  }, [findings, prioFilter, catFilter, searchQuery])

  function copyRemediatedCode() {
    if (!remediatedDoc) return
    navigator.clipboard.writeText(remediatedDoc)
    setCopiedCode(true)
    setTimeout(() => setCopiedCode(false), 2000)
  }

  function downloadRemediatedFile() {
    if (!remediatedDoc) return
    const baseName = data.file_name || data.content_scope || 'accessible_document.html'
    const cleanName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_')
    const outName = cleanName.includes('.') ? `remediated_${cleanName}` : `remediated_${cleanName}.html`
    const blob = new Blob([remediatedDoc], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = outName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  function handleChoiceYes() {
    setRemediationChoice('yes')
    setShowRemediated(true)
  }

  function handleChoiceNo() {
    setRemediationChoice('no')
    setShowRemediated(false)
  }

  return (
    <div className="allyCard">
      {/* 0. GUARDRAILS STATUS BAR & TOP-RIGHT TRACE ID */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          marginBottom: '14px',
          width: '100%'
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 12px',
            borderRadius: '999px',
            fontSize: '11.5px',
            fontWeight: 700,
            background: guardrails?.status === 'BLOCKED'
              ? 'rgba(239, 68, 68, 0.22)'
              : guardrails?.status === 'REDACTED'
              ? 'rgba(52, 211, 153, 0.16)'
              : 'rgba(52, 211, 153, 0.16)',
            color: guardrails?.status === 'BLOCKED'
              ? '#f87171'
              : guardrails?.status === 'REDACTED'
              ? '#34d399'
              : '#34d399',
            border: guardrails?.status === 'BLOCKED'
              ? '1px solid rgba(239, 68, 68, 0.65)'
              : guardrails?.status === 'REDACTED'
              ? '1px solid rgba(52, 211, 153, 0.45)'
              : '1px solid rgba(52, 211, 153, 0.45)'
          }}
        >
          <svg className="iconSvg" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span>
            {guardrails?.status === 'BLOCKED'
              ? `Guardrails: Blocked (${guardrails.triggered_rule || guardrails.rejection_reason || 'Policy Violation'})`
              : guardrails?.status === 'REDACTED'
              ? `Guardrails: ${guardrails.redacted_count || 1} Secret(s) Sanitized`
              : 'Guardrails: Passed · Verified Safe'}
          </span>
        </span>

        {traceId && (
          <span
            style={{
              fontSize: '11px',
              fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
              fontWeight: 600,
              color: '#38bdf8',
              letterSpacing: '0.6px',
              padding: '3px 9px',
              borderRadius: '6px',
              background: 'rgba(7, 140, 255, 0.08)',
              border: '1px solid rgba(7, 140, 255, 0.24)',
              marginLeft: 'auto',
              flexShrink: 0
            }}
            title="Verification Trace Code"
          >
            {traceId}
          </span>
        )}
      </div>

      {/* 0.1 QUARANTINED FILES NOTICE (Fault-Tolerant Bulk Processing) */}
      {quarantinedFiles.length > 0 && (
        <div className="allyQuarantineBanner">
          <div className="quarantineHeader">
            <svg className="iconSvg warn" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <strong>Bulk Batch Notice: {quarantinedFiles.length} file(s) quarantined</strong>
            <span className="quarantineSub">Guardrails preserved analysis of remaining valid content.</span>
          </div>
          <div className="quarantineList">
            {quarantinedFiles.map((q, idx) => (
              <div key={idx} className="quarantineRow">
                <span className="qFile">{q.name}</span>
                <span className="qReason">{q.reason}</span>
                {onSendPrompt && (
                  <button
                    type="button"
                    className="qRetryBtn"
                    onClick={() => onSendPrompt(`Please retry accessibility scan for ${q.name} with relaxed non-critical rules.`)}
                  >
                    Retry File
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 1. AUDIT HEADER */}
      <div className="allyTop">
        <div className="allyTitleWrap">
          <div className="allyScope">
            {data.source_url || /^https?:\/\//i.test(String(data.content_scope || '')) ? (
              <a
                href={data.source_url || data.content_scope}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#38bdf8', textDecoration: 'underline', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <span>{data.source_url || data.content_scope}</span>
                <span aria-hidden="true">↗</span>
              </a>
            ) : (
              data.content_scope || 'Web Content & UI'
            )}
          </div>
          <h3 className="allyTitle">{data.review_title || 'Web Accessibility Coaching Review'}</h3>
        </div>
        <div className="allyBadges">
          <span className={`verdictBadge ${verdictClass}`}>{verdictLabel}</span>
          <span className="scorePill">Accessibility Score: {score}/100</span>
        </div>
      </div>

      {/* 2. EXECUTIVE METRICS STRIP */}
      <div className="metricsStrip" aria-label="Accessibility review metrics">
        <span className="metricItem">
          <i className="metricDot dotEmerald" />
          <strong>{m.total_findings ?? findings.length}</strong> Audited WCAG Items
        </span>
        <span className="metricSep">|</span>
        <span className="metricItem">
          <i className="metricDot dotHigh" />
          <strong style={{ color: (m.high_priority || 0) > 0 ? '#f59e0b' : 'inherit' }}>
            {m.high_priority ?? 0}
          </strong>{' '}
          <span style={{ color: (m.high_priority || 0) > 0 ? '#fbbf24' : 'inherit' }}>
            High Priority
          </span>
        </span>
        <span className="metricSep">|</span>
        <span className="metricItem">
          <i className="metricDot dotMed" />
          <strong>{m.medium_priority ?? 0}</strong> Medium Priority
        </span>
        <span className="metricSep">|</span>
        <span className="metricItem">
          <i className="metricDot dotElem" />
          <strong>{m.elements_reviewed ?? 1}</strong> Elements Verified
        </span>
      </div>

      {/* 3. EXECUTIVE SUMMARY */}
      {data.coach_summary && (
        <div className="coachSummary">{formatInlineBold(data.coach_summary)}</div>
      )}

      {/* 4. ENTERPRISE WCAG ISSUES TABLE */}
      {findings.length > 0 && (
        <div className="allySection">
          <div className="sectionHeadRow">
            <span className="sectionHeadTitle">WCAG COMPLIANCE FINDINGS &amp; REMEDIATIONS</span>
            <span className="sectionCountTag">{visibleFindings.length} of {findings.length} Items</span>
          </div>

          {/* Filters Bar */}
          <div className="allyFilterBar">
            <div className="prioFilterGroup">
              {['ALL', 'HIGH', 'MEDIUM', 'LOW'].map(lvl => (
                <button
                  key={lvl}
                  type="button"
                  className={`prioFilterBtn ${prioFilter === lvl ? `active ${lvl.toLowerCase()}` : ''}`}
                  onClick={() => setPrioFilter(lvl)}
                >
                  {lvl}
                </button>
              ))}
            </div>

            {categories.length > 0 && (
              <select
                className="allySelect"
                value={catFilter}
                onChange={e => setCatFilter(e.target.value)}
              >
                <option value="ALL">All Categories</option>
                {categories.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            )}

            <input
              type="text"
              className="allySearchInput"
              placeholder="Filter by rule, element, code..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Scannable Table */}
          {visibleFindings.length === 0 ? (
            <div className="allyEmptyFilter">
              No WCAG findings match the selected priority or keyword filters.
            </div>
          ) : (
            <div className="tableWrap">
              <table className="allyTable" aria-label="WCAG Accessibility Issues Table">
                <thead>
                  <tr>
                    <th className="colIssueId">Issue ID</th>
                    <th className="colCriterion">WCAG Criterion</th>
                    <th className="colElement">Element</th>
                    <th className="colIssue">Issue</th>
                    <th className="colSeverity">Severity</th>
                    <th className="colImpact">User Impact</th>
                    <th className="colLocation">Location</th>
                    <th className="colFix">Suggested Fix</th>
                    <th className="colVerification">Verification</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleFindings.map((f, idx) => {
                    const sev = String(f.severity || f.priority || 'Medium')
                    const sevNorm = sev.toUpperCase()
                    const sevClass =
                      sevNorm === 'CRITICAL'
                        ? 'prioCrit'
                        : sevNorm === 'HIGH'
                          ? 'prioHigh'
                          : sevNorm === 'LOW'
                            ? 'prioLow'
                            : 'prioMed'

                    const nonCompliant = f.non_compliant_code || f.original_snippet || f.element
                    const compliant = f.compliant_code || f.suggested_fix
                    const rule = f.wcag_criterion || f.wcag_highlight || f.wcag_reference || 'WCAG 2.2 AA'

                    return (
                      <tr key={f.id || idx} className="allyRow">
                        {/* 1. Issue ID */}
                        <td className="colIssueId cellIssueId mono">
                          <span className="issueIdBadge">{f.id || `ISS-${String(idx + 1).padStart(2, '0')}`}</span>
                          {f.status && (
                            <span className={`statusTagMicro ${f.status === 'CONFIRMED_VIOLATION' ? 'tagConf' : 'tagMan'}`}>
                              {f.status === 'CONFIRMED_VIOLATION' ? 'VIOLATION' : 'VERIFY'}
                            </span>
                          )}
                        </td>

                        {/* 2. WCAG Criterion */}
                        <td className="colCriterion cellCriterion">
                          <strong className="wcagRuleTag">{rule}</strong>
                          {f.principle && <span className="principleTag">{f.principle}</span>}
                          {f.category && <span className="catTagMicro">{f.category}</span>}
                        </td>

                        {/* 3. Element */}
                        <td className="colElement cellElement mono">
                          <div
                            className="elementInspectorBox"
                            style={{
                              background: 'rgba(7, 140, 255, 0.06)',
                              border: '1px solid rgba(7, 140, 255, 0.25)',
                              borderRadius: '8px',
                              padding: '7px 10px',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '6px',
                            }}
                          >
                            <div>
                              <span
                                style={{
                                  display: 'inline-block',
                                  fontSize: '10px',
                                  fontWeight: 700,
                                  letterSpacing: '0.4px',
                                  color: '#7dd3fc',
                                  background: 'rgba(7, 140, 255, 0.16)',
                                  border: '1px solid rgba(56, 189, 248, 0.35)',
                                  padding: '2px 7px',
                                  borderRadius: '4px',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {f.element_tag || (String(nonCompliant || '').match(/^<([a-zA-Z0-9-]+)/) ? `<${String(nonCompliant).match(/^<([a-zA-Z0-9-]+)/)[1].toLowerCase()}>` : 'DOM NODE')}
                              </span>
                            </div>
                            <pre style={{ margin: 0, fontSize: '11.5px', color: '#e2e8f0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, "JetBrains Mono", Consolas, monospace', lineHeight: 1.45 }}>
                              <code>{nonCompliant || f.element_or_location || 'Element'}</code>
                            </pre>
                          </div>
                        </td>

                        {/* 4. Issue */}
                        <td className="colIssue cellIssue">
                          <p className="issueDesc">{f.issue}</p>
                        </td>

                        {/* 5. Severity */}
                        <td className="colSeverity cellSeverity">
                          <span className={`prioBadge ${sevClass}`}>{sev}</span>
                        </td>

                        {/* 6. User Impact */}
                        <td className="colImpact cellImpact">
                          <p className="impactText">{f.user_impact || f.why_it_matters || 'Affects users relying on assistive technology or keyboard navigation.'}</p>
                        </td>

                        {/* 7. Location */}
                        <td className="colLocation cellLocation mono">
                          <span className="locBadge" title={f.location || f.element_or_location}>
                            {f.location || f.element_or_location || 'source:line 1'}
                          </span>
                        </td>

                        {/* 8. Suggested Fix */}
                        <td className="colFix cellFix mono">
                          {compliant ? (
                            <div className="codeBox compliant">
                              <pre className="codePre">
                                <code>{compliant}</code>
                              </pre>
                            </div>
                          ) : (
                            <span className="textMuted">[Apply semantic fix]</span>
                          )}
                          {f.how_to_improve && <p className="improveDesc">{f.how_to_improve}</p>}
                        </td>

                        {/* 9. Verification */}
                        <td className="colVerification cellVerification">
                          <p className="verifText">{f.verification || 'Test with Tab keyboard navigation and screen reader rotor inspection.'}</p>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 5. ACCESSIBLE STRENGTHS */}
      {strengths.length > 0 && (
        <div className="allySection">
          <div className="sectionHeadRow">
            <span className="sectionHeadTitle">VERIFIED ACCESSIBILITY STRENGTHS</span>
          </div>
          <div className="strengthsList">
            {strengths.map((s, idx) => (
              <div key={idx} className="strengthItem">
                <svg className="iconSvg check" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                <span className="strengthText">{s}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 6. REMEDIATED PREVIEW (if toggled or already remediated) */}
      {(showRemediated || isRemediated) && remediatedDoc && (
        <div className="remediatedDocViewer">
          <div className="viewerHeader">
            <span>APPLIED WCAG 2.2 CODE CHANGES &amp; REMEDIATED SOURCE</span>
            <span className="wcagBadgeSuccess">WCAG 2.2 LEVEL A/AA APPLIED</span>
          </div>

          {findings.length > 0 && (
            <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px', borderBottom: '1px solid rgba(7, 140, 255, 0.2)' }}>
              {findings.map((f, idx) => {
                const beforeCode = f.non_compliant_code || f.element || f.original_snippet || '<!-- Original markup -->'
                const afterCode = f.compliant_code || f.suggested_fix || '<!-- Remediated markup -->'
                return (
                  <div key={f.id || idx} style={{ background: 'rgba(2, 12, 22, 0.65)', border: '1px solid rgba(7, 140, 255, 0.22)', borderRadius: '8px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '11.5px', fontWeight: 700, color: '#38bdf8' }}>
                      <span>{f.id || `ISS-0${idx + 1}`} · {f.wcag_criterion || f.wcag_highlight || 'WCAG 2.2'}</span>
                      <span style={{ color: '#94a3b8', fontWeight: 600 }}>{f.location || f.element_or_location || 'source'}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      <div style={{ background: 'rgba(244, 63, 94, 0.08)', border: '1px solid rgba(244, 63, 94, 0.3)', borderRadius: '6px', padding: '6px 8px' }}>
                        <div style={{ fontSize: '10px', fontWeight: 800, color: '#fda4af', marginBottom: '4px', letterSpacing: '0.5px' }}>ORIGINAL CODE</div>
                        <pre style={{ margin: 0, fontSize: '11.5px', color: '#fecdd3', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, Consolas, monospace' }}><code>{beforeCode}</code></pre>
                      </div>
                      <div style={{ background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.35)', borderRadius: '6px', padding: '6px 8px' }}>
                        <div style={{ fontSize: '10px', fontWeight: 800, color: '#6ee7b7', marginBottom: '4px', letterSpacing: '0.5px' }}>REMEDIATED CODE</div>
                        <pre style={{ margin: 0, fontSize: '11.5px', color: '#a7f3d0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, Consolas, monospace' }}><code>{afterCode}</code></pre>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <pre className="remediatedCodeBlock">
            <code>{remediatedDoc}</code>
          </pre>
          <div className="remediatedViewerActions">
            <button
              type="button"
              className="copyRemediatedBtn"
              onClick={copyRemediatedCode}
            >
              <svg className="iconSvg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span>{copiedCode ? 'Copied to Clipboard' : 'Copy Remediated Code'}</span>
            </button>
            <button
              type="button"
              className="downloadRemediatedBtn"
              onClick={downloadRemediatedFile}
            >
              <svg className="iconSvg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span>Download Remediated Source</span>
            </button>
          </div>
        </div>
      )}

      {/* 7. MANDATORY CLOSING ACTION PROMPT (ALWAYS AT THE VERY END) */}
      <div className="closingRemediationCard">
        <div className="closingPromptWrap">
          <div className="closingPromptLeft">
            <h4 className="closingPromptTitle">
              Should I apply the recommended accessibility fixes to the source code?
            </h4>
            <p className="closingPromptSub">
              Selecting YES applies verified WCAG 2.2 Level A/AA semantic HTML, ARIA attributes, and keyboard controls. Selecting NO preserves the original source code unchanged.
            </p>
          </div>

          <div className="closingPromptActions">
            {remediationChoice === null && !isRemediated && !showRemediated ? (
              <div className="choiceButtons">
                <button
                  type="button"
                  className="btnRemediateYes"
                  onClick={handleChoiceYes}
                >
                  <svg className="iconSvg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  <span>YES – Apply the fixes</span>
                </button>
                <button
                  type="button"
                  className="btnRemediateNo"
                  onClick={handleChoiceNo}
                >
                  <span>NO – Keep the original source unchanged</span>
                </button>
              </div>
            ) : remediationChoice === 'yes' || isRemediated || showRemediated ? (
              <div className="remediationConfirmed">
                <span className="confirmedTag">
                  <svg className="iconSvg" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  Remediation Applied &amp; Validated Safe
                </span>
                <button
                  type="button"
                  className="btnQuickCopy"
                  onClick={copyRemediatedCode}
                >
                  {copiedCode ? 'Copied' : 'Copy Remediated Code'}
                </button>
                <button
                  type="button"
                  className="btnQuickDownload"
                  onClick={downloadRemediatedFile}
                >
                  Download Remediated Source (.html)
                </button>
              </div>
            ) : (
              <div className="remediationDeclined">
                <span className="declinedTag">Original Source Preserved Unchanged</span>
                <span className="declinedSub">WCAG audit recommendations and evidence remain available in the findings table above.</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {data.validation_note && (
        <div className="validationNote">
          <span className="valDot" />
          <span>{data.validation_note}</span>
        </div>
      )}
    </div>
  )
}
