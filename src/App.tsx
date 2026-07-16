import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { runCrossExam } from './domain/crossExam'
import { createDecisionPackage } from './domain/decisionPackage'
import { createActionBinding } from './domain/actionBinding'
import { evaluatePreAction, type PreActionDecision } from './domain/preActionGate'
import type { ActionType, DecisionPackage, ExaminedClaim, ClaimVerdict } from './domain/types'
import { demoDecision, demoFindings, demoReviewers } from './data/demoDecision'
import { ReviewJobClient, type ReviewJobResult, type ReviewJobView } from './sdk/reviewJobClient'
import './App.css'

const verdictLabel: Record<ClaimVerdict, string> = {
  SURVIVED: 'Survived',
  REFUTED: 'Refuted',
  UNRESOLVED: 'Unresolved',
}

function Mark({ type }: { type: ClaimVerdict }) {
  if (type === 'SURVIVED') return <span className="mark survived">✓</span>
  if (type === 'REFUTED') return <span className="mark refuted">×</span>
  return <span className="mark unresolved">?</span>
}

function App() {
  const [runState, setRunState] = useState<'idle' | 'demo-complete' | 'queued'>('idle')
  const [selectedClaim, setSelectedClaim] = useState<ExaminedClaim | null>(null)
  const [briefOpen, setBriefOpen] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [activeDecision, setActiveDecision] = useState<DecisionPackage>(demoDecision)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftRisk, setDraftRisk] = useState('')
  const [draftClaims, setDraftClaims] = useState('')
  const [draftActionType, setDraftActionType] = useState<ActionType>('OTHER')
  const [draftTarget, setDraftTarget] = useState('')
  const [draftParameters, setDraftParameters] = useState('')
  const [formErrors, setFormErrors] = useState<string[]>([])
  const [gateDecision, setGateDecision] = useState<PreActionDecision | null>(null)
  const [reviewJob, setReviewJob] = useState<ReviewJobView | null>(null)
  const [reviewJobResult, setReviewJobResult] = useState<ReviewJobResult | null>(null)
  const [reviewJobAccessToken, setReviewJobAccessToken] = useState<string | null>(null)
  const [reviewJobError, setReviewJobError] = useState<string | null>(null)
  const [creatingReviewJob, setCreatingReviewJob] = useState(false)

  const isDemo = activeDecision.id === demoDecision.id
  const ran = runState === 'demo-complete'
  useEffect(() => {
    if (!reviewJob || !reviewJobAccessToken || reviewJob.status === 'READY_FOR_ASSURANCE' || reviewJob.status === 'CANCELLED') return
    const client = new ReviewJobClient()
    const refresh = async () => {
      try {
        setReviewJob(await client.get(reviewJob.id, reviewJobAccessToken))
        setReviewJobError(null)
      } catch (error) {
        setReviewJobError(error instanceof Error ? error.message : 'Unable to refresh the review job.')
      }
    }
    const timer = window.setInterval(() => { void refresh() }, 12_000)
    return () => window.clearInterval(timer)
  }, [reviewJob?.id, reviewJob?.status, reviewJobAccessToken])

  useEffect(() => {
    if (!reviewJob || reviewJob.status !== 'READY_FOR_ASSURANCE' || !reviewJobAccessToken || reviewJobResult) return
    const client = new ReviewJobClient()
    void client.getResult(reviewJob.id, reviewJobAccessToken)
      .then((record) => {
        setReviewJobResult(record)
        setSelectedClaim(record.result.claims[0] ?? null)
        setReviewJobError(null)
      })
      .catch((error) => setReviewJobError(error instanceof Error ? error.message : 'Unable to issue the completed assurance record.'))
  }, [reviewJob, reviewJobAccessToken, reviewJobResult])

  const demoResult = useMemo(
    () => runCrossExam(demoDecision, demoReviewers, demoFindings),
    [],
  )

  const result = reviewJobResult?.result ?? demoResult

  const counts = useMemo(
    () => ({
      survived: result.claims.filter((claim) => claim.verdict === 'SURVIVED').length,
      refuted: result.claims.filter((claim) => claim.verdict === 'REFUTED').length,
      unresolved: result.claims.filter((claim) => claim.verdict === 'UNRESOLVED').length,
    }),
    [result.claims],
  )

  const demoGate = useMemo(() => evaluatePreAction({
    recordId: 'dar_demo_assurance_record',
    issuedAt: new Date().toISOString(),
    decisionId: demoDecision.id,
    valueAtRiskUsd: demoDecision.valueAtRiskUsd,
    attributionStatus: 'NETWORK_VERIFIED',
    result: demoResult,
    actionBinding: demoDecision.actionBinding,
  }, {
    decisionId: demoDecision.id,
    valueAtRiskUsd: demoDecision.valueAtRiskUsd,
    actionType: demoDecision.actionBinding!.actionType,
    target: demoDecision.actionBinding!.target,
    parametersHash: demoDecision.actionBinding!.parametersHash,
  }), [demoResult])

  const realGate = useMemo(() => {
    const record = reviewJobResult
    const binding = record?.decision.actionBinding
    if (!record || !binding) return null
    return evaluatePreAction({
      recordId: record.recordId,
      issuedAt: record.issuedAt,
      decisionId: record.decision.id,
      valueAtRiskUsd: record.decision.valueAtRiskUsd,
      attributionStatus: record.attributionStatus,
      result: record.result,
      actionBinding: binding,
    }, {
      decisionId: record.decision.id,
      valueAtRiskUsd: record.decision.valueAtRiskUsd,
      actionType: binding.actionType,
      target: binding.target,
      parametersHash: binding.parametersHash,
    })
  }, [reviewJobResult])

  async function submitDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    let actionBinding
    try {
      actionBinding = await createActionBinding(draftActionType, draftTarget, draftParameters)
    } catch (error) {
      setFormErrors([error instanceof Error ? error.message : 'Unable to create an action binding.'])
      return
    }
    const created = createDecisionPackage({
      title: draftTitle,
      valueAtRiskUsd: Number(draftRisk),
      claimsText: draftClaims,
      actionBinding,
    })

    if (created.ok === false) {
      setFormErrors(created.errors)
      return
    }

    setActiveDecision(created.value)
    setRunState('idle')
    setReviewJob(null)
    setReviewJobResult(null)
    setReviewJobAccessToken(null)
    setReviewJobError(null)
    setFormErrors([])
    setComposerOpen(false)
  }

  async function queueReview() {
    setGateDecision(null)
    if (isDemo) {
      setRunState('demo-complete')
      return
    }
    setCreatingReviewJob(true)
    setReviewJobError(null)
    try {
      const created = await new ReviewJobClient().create(activeDecision)
      const { accessToken, ...job } = created
      setReviewJob(job)
      setReviewJobAccessToken(accessToken)
      setRunState('queued')
    } catch (error) {
      setReviewJobError(error instanceof Error ? error.message : 'CrossExam could not create the review job.')
    } finally {
      setCreatingReviewJob(false)
    }
  }

  const reviewStatusLabel: Record<ReviewJobView['status'], string> = {
    AWAITING_MATCH: 'Awaiting independent reviewer match',
    AWAITING_DELIVERIES: 'Independent review procurement in progress',
    READY_FOR_ASSURANCE: 'All independent deliveries received',
    CANCELLED: 'Review job cancelled',
  }

  return (
    <main className="app-shell">
      <nav className="topbar">
        <a className="brand" href="#top" aria-label="CrossExam home">
          <span className="brand-mark">×</span>
          <span>CrossExam</span>
        </a>
        <div className="nav-links" aria-label="Primary navigation">
          <a className="active" href="#workspace">Workspace</a>
          <a href="#protocol">Protocol</a>
          <a href="#network">Network</a>
        </div>
        <button className="new-decision-button" onClick={() => setComposerOpen(true)}>New decision <span>+</span></button>
      </nav>

      <section className="hero" id="top">
        <div className="eyebrow"><span /> Adversarial decision assurance</div>
        <h1>Before an agent acts,<br /><em>make it survive a cross-examination.</em></h1>
        <p>CrossExam procures independent counter-evidence before a consequential decision becomes an irreversible action.</p>
      </section>

      <section className="workspace" id="workspace">
        <aside className="decision-card">
          <div className="card-kicker">Decision package <span>{activeDecision.id}</span></div>
          <div className="decision-heading">
            <div className="decision-icon">↗</div>
            <div>
              <h2>{activeDecision.title}</h2>
              <p>{isDemo ? 'Agent-originated onchain recommendation' : reviewJob ? reviewJob.fundingStatus === 'UNFUNDED' ? 'x402 procurement authorization required' : reviewStatusLabel[reviewJob.status] : 'Decision package not yet submitted to CrossExam'}</p>
            </div>
          </div>
          <div className="risk-row">
            <span>Value at risk</span>
            <strong>${activeDecision.valueAtRiskUsd.toLocaleString()}</strong>
          </div>
          <div className="risk-row">
            <span>{reviewJob ? 'Review job' : 'Action window'}</span>
            <strong>{isDemo ? '18 min' : reviewJob ? reviewJob.id.slice(0, 14) : `${activeDecision.claims.length} claims`}</strong>
          </div>
          <div className="source-row">
            <span className="source-avatar">A</span>
            <div><span>Origin</span><strong>{isDemo ? 'Atlas Research' : 'Local Decision Package'}</strong></div>
          </div>
          <button className="ghost-button" onClick={() => setBriefOpen(!briefOpen)}>
            {briefOpen ? 'Hide decision brief' : 'Inspect decision brief'} <span>→</span>
          </button>
          {briefOpen && (
            <div className="brief-panel">
              <p>{isDemo ? 'Buy the asset after a purported catalyst, citing deep liquidity, transfer safety, and accelerating market attention.' : 'This package is structured for independent review. Claims have not yet been verified or scored.'}</p>
              <div><span>Review claims</span> {activeDecision.claims.length} material assertions</div>
            </div>
          )}
        </aside>

        <section className={`exam-stage ${ran ? 'ran' : ''}`} aria-label="Cross-examination workspace">
          <div className="stage-topline">
            <div>
              <span className="card-kicker">Cross-examination</span>
              <h2>{ran ? 'Evidence under pressure' : runState === 'queued' ? reviewJob ? reviewStatusLabel[reviewJob.status] : 'Independent review requested' : 'Ready to challenge the decision'}</h2>
            </div>
            <span className="round-pill">Round 01</span>
          </div>

          {isDemo ? <div className="exam-grid">
            <article className="exam-agent coral"><div className="agent-number">01</div><span className="agent-signal">Independent scope</span><h3>Liquidity<br />Scout</h3><p>Reconstructs executable depth and tests the price-impact premise.</p><div className="agent-footer"><span>Onchain</span><span>0.18 USDT</span></div></article>
            <article className="exam-agent gold"><div className="agent-number">02</div><span className="agent-signal">Independent scope</span><h3>Contract<br />Examiner</h3><p>Challenges privileged paths, proxy changes, and transfer controls.</p><div className="agent-footer"><span>Static analysis</span><span>0.22 USDT</span></div></article>
            <article className="exam-agent blue"><div className="agent-number">03</div><span className="agent-signal">Independent scope</span><h3>Evidence<br />Desk</h3><p>Validates primary sources, timing claims, and causal assumptions.</p><div className="agent-footer"><span>Open web</span><span>0.12 USDT</span></div></article>
          </div> : reviewJob ? <div className="exam-grid">
            {reviewJob.plan.scopes.map((scope, index) => {
              const assignment = reviewJob.dispatch.assignments.find((item) => item.scopeId === scope.id)
              return <article className={`exam-agent ${['coral', 'gold', 'blue'][index % 3]}`} key={scope.id}>
                <div className="agent-number">{String(index + 1).padStart(2, '0')}</div>
                <span className="agent-signal">{assignment?.status === 'AWAITING_MATCH' ? 'Awaiting independent match' : 'Registry matched'}</span>
                <h3>{scope.title}</h3>
                <p>{scope.objective}</p>
                <div className="agent-footer"><span>{scope.requiredCapability}</span><span>{scope.estimatedFeeUsdt} USDT estimate</span></div>
              </article>
            })}
          </div> : <div className="scope-placeholder">
            <span>Review scopes are generated server-side</span>
            <p>Submit the Decision Package to see matched reviewers, attributable pricing, and procurement state. CrossExam does not display invented reviewers for live work.</p>
          </div>}

          {runState === 'idle' ? (
            <button className="run-button" onClick={() => void queueReview()} disabled={creatingReviewJob}>
              <span className="button-cross">×</span> {creatingReviewJob ? 'Creating real review job' : isDemo ? 'Run CrossExam' : 'Queue CrossExam'} <span className="button-arrow">→</span>
            </button>
          ) : (
            <div className="completed-run">
              <span className="live-dot" /> {ran ? 'Cross-examination complete · 3 independent scopes · 00:19' : 'Decision structured · external evidence procurement pending'}
              <button onClick={() => setRunState('idle')}>{ran ? 'Reset demo' : 'Edit package'}</button>
            </div>
          )}
        </section>
      </section>

      {reviewJobError && <section className="service-error" role="alert"><strong>CrossExam did not queue this decision.</strong><span>{reviewJobError}</span></section>}

      <section className={`results ${ran || reviewJobResult ? 'visible' : ''}`} aria-live="polite">
        <div className="results-intro">
          <div>
            <div className="eyebrow"><span /> Decision assurance record</div>
            <h2>Consensus is not the point.<br /><em>Surviving evidence is.</em></h2>
          </div>
          <div className="independence">
            <span>Effective independence</span>
            <strong>{result.effectiveIndependence.toFixed(1)} <small>/ 3.0</small></strong>
            <p>Distinct owners, tools, and evidence routes.</p>
          </div>
        </div>

        <div className="result-layout">
          <div className="claim-list">
            <div className="claim-list-heading"><span>Claims challenged</span><span>{result.claims.length} examined</span></div>
            {result.claims.map((claim) => (
              <button
                className={`claim-row ${claim.verdict.toLowerCase()} ${selectedClaim?.id === claim.id ? 'selected' : ''}`}
                key={claim.id}
                onClick={() => setSelectedClaim(claim)}
              >
                <Mark type={claim.verdict} />
                <span className="claim-text"><small>{claim.id}</small>{claim.text}</span>
                <span className="claim-status">{verdictLabel[claim.verdict]} <span>→</span></span>
              </button>
            ))}
          </div>

          <aside className="action-card">
            <span className="card-kicker">Recommended action</span>
            <div className="action-verdict">{result.action}</div>
            <p>{result.materialRefutations > 0 ? `${result.materialRefutations} material premise${result.materialRefutations === 1 ? ' was' : 's were'} refuted. Do not execute until the recorded reversal conditions are satisfied or the risk is explicitly accepted.` : 'No material premise was refuted, but unresolved claims and the configured execution policy still apply.'}</p>
            {isDemo && <div className="score-bars">
              <div><span>Claim integrity</span><i><b style={{ width: '46%' }} /></i><strong>46</strong></div>
              <div><span>Evidence resilience</span><i><b style={{ width: '59%' }} /></i><strong>59</strong></div>
              <div><span>Action readiness</span><i><b style={{ width: '31%' }} /></i><strong>31</strong></div>
            </div>}
            <div className="action-summary">
              <span><b>{result.materialRefutations}</b> refuted</span>
              <span><b>{counts.unresolved}</b> unresolved</span>
              <span><b>{counts.survived}</b> survived</span>
            </div>
            {result.reversalConditions.length > 0 && (
              <div className="reversal-list">
                <span>To reverse this action</span>
                {result.reversalConditions.map((condition) => <p key={condition.claimId}><b>{condition.claimId}</b>{condition.requirement}</p>)}
              </div>
            )}
            <div className="execution-guard">
              <div className="guard-heading"><span>Execution guard</span><small>NETWORK VERIFIED</small></div>
              <p>Bound to {(reviewJobResult?.decision.actionBinding ?? demoDecision.actionBinding)?.actionType.toLowerCase()} · {(reviewJobResult?.decision.actionBinding ?? demoDecision.actionBinding)?.target}</p>
              {gateDecision ? (
                <div className={`gate-outcome ${gateDecision.executable ? 'permit' : 'blocked'}`}>
                  <strong>{gateDecision.status}</strong>
                  <span>{gateDecision.reasons[0]}</span>
                  {gateDecision.requiredClaimIds.length > 0 && <small>Remediate {gateDecision.requiredClaimIds.join(' · ')}</small>}
                </div>
              ) : (
                <button className="guard-button" onClick={() => setGateDecision(realGate ?? demoGate)}>Attempt guarded execution <span>→</span></button>
              )}
            </div>
            {reviewJobResult && <div className="record-proof"><span>Signed assurance record</span><p>{reviewJobResult.recordId}</p><small>{reviewJobResult.persistence} · access expires {new Date(reviewJobResult.readAccess.expiresAt).toLocaleString()}</small></div>}
          </aside>
        </div>
      </section>

      {runState === 'queued' && reviewJob && (
        <section className="queued-panel" aria-live="polite">
          <span className="queued-icon">×</span>
          <div>
            <span className="card-kicker">Review request staged</span>
            <h2>CrossExam will not invent a verdict.</h2>
            <p>Job {reviewJob.id} is persisted by CrossExam. {reviewJob.fundingStatus === 'UNFUNDED' ? 'It is intentionally spend-locked until its owner completes the paid x402 authorization route.' : 'It will only advance on a server-recorded external procurement and an attributable signed delivery.'} No reviewer or conclusion is synthesized in the browser.</p>
          </div>
          <div className="queued-meta"><span>{activeDecision.claims.length} claims</span><span>{reviewJob.plan.estimatedTotalUsdt} USDT estimate</span><span>{reviewJob.fundingStatus}</span><span>rev {reviewJob.revision}</span></div>
          <div className="review-plan-list">
            {reviewJob.plan.scopes.map((scope) => {
              const assignment = reviewJob.dispatch.assignments.find((item) => item.scopeId === scope.id)
              const procurement = reviewJob.procurements.find((item) => item.scopeId === scope.id)
              return <div key={scope.id}><span>{scope.title}</span><small>{assignment?.status === 'AWAITING_MATCH' ? 'Awaiting independent match' : `${assignment?.reviewer?.displayName ?? 'Matched reviewer'} · ${procurement?.status ?? 'UNSENT'}`} · {scope.estimatedFeeUsdt} USDT</small></div>
            })}
          </div>
        </section>
      )}

      {selectedClaim && (
        <div className="detail-backdrop" onClick={() => setSelectedClaim(null)} role="presentation">
          <aside className="detail-panel" onClick={(event) => event.stopPropagation()}>
            <button className="close-button" onClick={() => setSelectedClaim(null)} aria-label="Close detail">×</button>
            <span className={`detail-label ${selectedClaim.verdict.toLowerCase()}`}>{verdictLabel[selectedClaim.verdict]}</span>
            <small>{selectedClaim.id} · challenged by {selectedClaim.challenger}</small>
            <h2>{selectedClaim.text}</h2>
            <div className="evidence-block"><span>Evidence finding</span><p>{selectedClaim.evidence}</p></div>
            <div className="reversal-block"><span>Reversal condition</span><p>Provide a current, independently verifiable data point that addresses this contradiction.</p></div>
          </aside>
        </div>
      )}

      {composerOpen && (
        <div className="detail-backdrop composer-backdrop" onClick={() => setComposerOpen(false)} role="presentation">
          <form className="composer-panel" onSubmit={submitDecision} onClick={(event) => event.stopPropagation()}>
            <button type="button" className="close-button" onClick={() => setComposerOpen(false)} aria-label="Close composer">×</button>
            <span className="card-kicker">Decision package</span>
            <h2>Create a reviewable action.</h2>
            <p className="composer-intro">CrossExam only challenges claims you explicitly submit. It will never fill unknown facts with confident prose.</p>
            <label>Proposed action<input autoFocus value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} placeholder="e.g. Approve a $5,000 vendor contract" /></label>
            <label>Value at risk (USD)<input inputMode="decimal" value={draftRisk} onChange={(event) => setDraftRisk(event.target.value)} placeholder="5000" /></label>
            <label>Execution type<select value={draftActionType} onChange={(event) => setDraftActionType(event.target.value as ActionType)}><option value="SPEND">Spend</option><option value="TRADE">Trade</option><option value="DEPLOY">Deploy</option><option value="PUBLISH">Publish</option><option value="OTHER">Other</option></select></label>
            <label>Execution target<input value={draftTarget} onChange={(event) => setDraftTarget(event.target.value)} placeholder="e.g. xlayer:0x... or vendor:acme" /></label>
            <label>Action parameters<textarea value={draftParameters} onChange={(event) => setDraftParameters(event.target.value)} placeholder="Raw transaction parameters, contract payload, or canonical action JSON" rows={3} /></label>
            <label>Claims that must be true<textarea value={draftClaims} onChange={(event) => setDraftClaims(event.target.value)} placeholder={'One material claim per line\nThe vendor has a valid SOC 2 report.\nCustomer data remains in the EU.'} rows={6} /></label>
            {formErrors.length > 0 && <div className="form-errors">{formErrors.map((error) => <p key={error}>{error}</p>)}</div>}
            <button className="run-button" type="submit"><span className="button-cross">×</span> Structure Decision Package <span className="button-arrow">→</span></button>
          </form>
        </div>
      )}

      <footer id="protocol">
        <span>CrossExam / Decision assurance protocol</span>
        <span>Evidence over consensus</span>
      </footer>
    </main>
  )
}

export default App
