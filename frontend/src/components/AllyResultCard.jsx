function formatInlineBold(text) {
  const parts = String(text || '').split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, idx) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={idx}>{part.slice(2, -2)}</strong>
    ) : (
      part
    )
  )
}

export default function AllyResultCard({ data }) {
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
          <strong>{m.total_findings ?? findings.length}</strong> Coaching Items
        </span>
        <span className="metricSep">|</span>
        <span className="metricItem">
          <i className="metricDot dotHigh" />
          <strong>{m.high_priority ?? 0}</strong> High Priority
        </span>
        <span className="metricSep">|</span>
        <span className="metricItem">
          <i className="metricDot dotMed" />
          <strong>{m.medium_priority ?? 0}</strong> Medium Priority
        </span>
        <span className="metricSep">|</span>
        <span className="metricItem">
          <i className="metricDot dotElem" />
          <strong>{m.elements_reviewed ?? 1}</strong> Elements Reviewed
        </span>
      </div>

      {data.coach_summary && (
        <div className="coachSummary">{formatInlineBold(data.coach_summary)}</div>
      )}

      {findings.length > 0 && (
        <div className="allySection">
          <div className="sectionHead">ACCESSIBILITY COACHING · ISSUE -&gt; WHY IT MATTERS -&gt; HOW TO IMPROVE</div>
          <div className="findingsList">
            {findings.map((f, idx) => {
              const prio = String(f.priority || 'MEDIUM').toUpperCase()
              const prioClass = prio === 'HIGH' ? 'prioHigh' : prio === 'LOW' ? 'prioLow' : 'prioMed'
              return (
                <div key={idx} className="findingItem">
                  <div className="findingHead">
                    <span className="findingLoc">{f.element_or_location || `Finding ${idx + 1}`}</span>
                    <div className="findingPills">
                      <span className="catPill">{f.category || 'Usability'}</span>
                      <span className={`prioPill ${prioClass}`}>{prio}</span>
                    </div>
                  </div>

                  {(f.original_snippet || f.suggested_fix) && (
                    <div className="fixPair">
                      {f.original_snippet && (
                        <div className="fixBox fixOrig">
                          <span className="fixTag">ORIGINAL</span>
                          <code>{f.original_snippet}</code>
                        </div>
                      )}
                      {f.suggested_fix && (
                        <div className="fixBox fixBetter">
                          <span className="fixTag">SUGGESTED WORDING / FIX</span>
                          <code>{f.suggested_fix}</code>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="coachRows">
                    <div className="coachRow">
                      <span className="coachKey">Issue</span>
                      <span className="coachVal">{f.issue}</span>
                    </div>
                    <div className="coachRow">
                      <span className="coachKey">Why it matters</span>
                      <span className="coachVal">{f.why_it_matters}</span>
                    </div>
                    <div className="coachRow">
                      <span className="coachKey">How to improve</span>
                      <span className="coachVal improveVal">{f.how_to_improve}</span>
                    </div>
                  </div>

                  {f.wcag_reference && (
                    <div className="wcagRef">{f.wcag_reference}</div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {strengths.length > 0 && (
        <div className="allySection">
          <div className="sectionHead">WHAT IS WORKING WELL</div>
          <ul className="strengthList">
            {strengths.map((st, idx) => (
              <li key={idx}>{st}</li>
            ))}
          </ul>
        </div>
      )}

      {data.validation_note && (
        <div className="validationNote">{data.validation_note}</div>
      )}
    </div>
  )
}

