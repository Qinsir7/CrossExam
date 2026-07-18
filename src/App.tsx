import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { runCrossExam } from './domain/crossExam'
import { evaluatePreAction, type PreActionDecision } from './domain/preActionGate'
import type { ActionType, DecisionPackage, ExaminedClaim, ClaimVerdict } from './domain/types'
import type { CrossExaminationPreparationRequest, CrossExaminationPreparationResponse, VerifyAssuranceRecordResponse } from './domain/assuranceContracts'
import { demoDecision, demoFindings, demoReviewers } from './data/demoDecision'
import { ReviewJobClient, type ProcurementLedgerView, type ReviewJobResult, type ReviewJobView } from './sdk/reviewJobClient'
import { displayUsdt0 } from './sdk/browserX402'
import './App.css'

const verdictLabel: Record<ClaimVerdict, string> = {
  SURVIVED: 'Survived',
  REFUTED: 'Refuted',
  UNRESOLVED: 'Unresolved',
}

const reviewSessionKey = 'crossexam.review-session.v1'
const canonicalDemoCandidate = {
  title: 'Review a 10,000 USD Xwawa acquisition',
  intent: 'Acquire Xwawa on X Layer only if the exact route has sufficient liquidity and the token-transfer premise survives independent review.',
  valueAtRiskUsd: '10000',
  tokenRiskTarget: 'token:xlayer:0x095c1a875b985be6e2c86b2cae0b66a3df702e6a',
}

function loadReviewSession(): { job: ReviewJobView; accessToken: string } | null {
  try {
    const raw = window.sessionStorage.getItem(reviewSessionKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { job?: unknown; accessToken?: unknown }
    if (!parsed.job || typeof parsed.job !== 'object' || typeof parsed.accessToken !== 'string' || !parsed.accessToken.startsWith('rjv_')) return null
    const job = parsed.job as ReviewJobView
    if (typeof job.id !== 'string' || !job.id.startsWith('rj_')) return null
    return { job, accessToken: parsed.accessToken }
  } catch {
    return null
  }
}

function Mark({ type }: { type: ClaimVerdict }) {
  if (type === 'SURVIVED') return <span className="mark survived">✓</span>
  if (type === 'REFUTED') return <span className="mark refuted">×</span>
  return <span className="mark unresolved">?</span>
}

function App() {
  const [restoredReviewSession] = useState(loadReviewSession)
  const [runState, setRunState] = useState<'idle' | 'demo-complete' | 'queued'>(restoredReviewSession ? 'queued' : 'idle')
  const [selectedClaim, setSelectedClaim] = useState<ExaminedClaim | null>(null)
  const [briefOpen, setBriefOpen] = useState(false)
  const [activeDecision, setActiveDecision] = useState<DecisionPackage>(restoredReviewSession?.job.decision ?? demoDecision)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftIntent, setDraftIntent] = useState('')
  const [draftRisk, setDraftRisk] = useState('')
  const [draftActionType, setDraftActionType] = useState<ActionType>('TRADE')
  const [draftEvmTransaction, setDraftEvmTransaction] = useState(true)
  const [draftScenario, setDraftScenario] = useState<'Trade' | 'Pay' | 'Approve' | 'Hire agent' | 'Deploy'>('Trade')
  const [draftChainId, setDraftChainId] = useState('196')
  const [draftRecipient, setDraftRecipient] = useState('')
  const [draftCalldata, setDraftCalldata] = useState('0x')
  const [draftValueWei, setDraftValueWei] = useState('0')
  const [draftTokenRiskTarget, setDraftTokenRiskTarget] = useState('')
  const [preparedReview, setPreparedReview] = useState<CrossExaminationPreparationResponse | null>(null)
  const [preparedInput, setPreparedInput] = useState<CrossExaminationPreparationRequest | null>(null)
  const [formErrors, setFormErrors] = useState<string[]>([])
  const [gateDecision, setGateDecision] = useState<PreActionDecision | null>(null)
  const [reviewJob, setReviewJob] = useState<ReviewJobView | null>(restoredReviewSession?.job ?? null)
  const [reviewJobResult, setReviewJobResult] = useState<ReviewJobResult | null>(null)
  const [procurementLedger, setProcurementLedger] = useState<ProcurementLedgerView | null>(null)
  const [reviewJobAccessToken, setReviewJobAccessToken] = useState<string | null>(restoredReviewSession?.accessToken ?? null)
  const [reviewJobError, setReviewJobError] = useState<string | null>(null)
  const [creatingReviewJob, setCreatingReviewJob] = useState(false)
  const [authorizingReviewJob, setAuthorizingReviewJob] = useState(false)
  const [retryingReviewJob, setRetryingReviewJob] = useState(false)
  const [recoveringReviewJob, setRecoveringReviewJob] = useState(false)
  const [sharingReviewRecord, setSharingReviewRecord] = useState(false)
  const [verificationSigner, setVerificationSigner] = useState('')
  const [verifyingReviewRecord, setVerifyingReviewRecord] = useState(false)
  const [recordVerification, setRecordVerification] = useState<VerifyAssuranceRecordResponse | null>(null)
  const claimTriggerRef = useRef<HTMLButtonElement | null>(null)
  const claimCloseRef = useRef<HTMLButtonElement | null>(null)

  const isDemo = activeDecision.id === demoDecision.id
  const ran = runState === 'demo-complete'
  const invalidatePreparation = () => { setPreparedReview(null); setPreparedInput(null) }
  const chooseScenario = (scenario: typeof draftScenario) => {
    setDraftScenario(scenario)
    if (scenario === 'Trade') { setDraftEvmTransaction(true); setDraftActionType('TRADE') }
    if (scenario === 'Pay' || scenario === 'Approve') { setDraftEvmTransaction(true); setDraftActionType('SPEND') }
    if (scenario === 'Deploy') { setDraftEvmTransaction(true); setDraftActionType('DEPLOY') }
    if (scenario === 'Hire agent') { setDraftEvmTransaction(false); setDraftActionType('OTHER') }
    invalidatePreparation()
  }
  const loadCanonicalCandidate = () => {
    setDraftScenario('Trade')
    setDraftEvmTransaction(true)
    setDraftActionType('TRADE')
    setDraftTitle(canonicalDemoCandidate.title)
    setDraftIntent(canonicalDemoCandidate.intent)
    setDraftRisk(canonicalDemoCandidate.valueAtRiskUsd)
    setDraftChainId('196')
    setDraftTokenRiskTarget(canonicalDemoCandidate.tokenRiskTarget)
    // The candidate provides a real asset and review size, but it deliberately
    // never invents a router, recipient, calldata, or executable swap.
    setDraftRecipient('')
    setDraftCalldata('')
    setDraftValueWei('0')
    setFormErrors([])
    invalidatePreparation()
  }
  useEffect(() => {
    if (reviewJob && reviewJobAccessToken) {
      window.sessionStorage.setItem(reviewSessionKey, JSON.stringify({ job: reviewJob, accessToken: reviewJobAccessToken }))
    } else {
      window.sessionStorage.removeItem(reviewSessionKey)
    }
  }, [reviewJob, reviewJobAccessToken])

  useEffect(() => {
    if (!selectedClaim) return
    claimCloseRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setSelectedClaim(null)
        window.requestAnimationFrame(() => claimTriggerRef.current?.focus())
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [selectedClaim])
  useEffect(() => {
    if (!reviewJob || !reviewJobAccessToken || reviewJob.status === 'READY_FOR_ASSURANCE' || reviewJob.status === 'FAILED' || reviewJob.status === 'CANCELLED' || reviewJob.status === 'EXPIRED') return
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

  useEffect(() => {
    if (!reviewJob || !reviewJobAccessToken || reviewJob.fundingStatus !== 'AUTHORIZED') {
      setProcurementLedger(null)
      return
    }
    const client = new ReviewJobClient()
    void client.getLedger(reviewJob.id, reviewJobAccessToken)
      .then(setProcurementLedger)
      .catch((error) => setReviewJobError(error instanceof Error ? error.message : 'Unable to load the procurement ledger.'))
  }, [reviewJob, reviewJobAccessToken])

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

  const displayedGate = gateDecision ?? realGate ?? demoGate
  const decisiveClaim = result.claims.find((claim) => claim.verdict === 'REFUTED')
    ?? result.claims.find((claim) => claim.verdict === 'UNRESOLVED')
  const resultDecision = reviewJobResult?.decision ?? demoDecision
  const resultBinding = resultDecision.actionBinding

  function simpleInput(): CrossExaminationPreparationRequest {
    return {
      simple: {
        title: draftTitle,
        intent: draftIntent,
        valueAtRiskUsd: Number(draftRisk),
        ...(draftEvmTransaction ? {
          ...(draftTokenRiskTarget.trim() ? { tokenRiskTarget: draftTokenRiskTarget.trim() } : {}),
          transaction: {
            actionType: draftActionType,
            chainId: Number(draftChainId),
            to: draftRecipient || undefined,
            data: draftCalldata,
            valueWei: draftValueWei,
          },
        } : {}),
      },
    }
  }

  function validateDraftBeforePreparation(): string[] {
    const errors: string[] = []
    if (!draftTitle.trim()) errors.push('Add a short title for the action under review.')
    if (!draftIntent.trim()) errors.push('Describe what the agent is about to do so CrossExam can compile material claims.')
    if (!Number.isFinite(Number(draftRisk)) || Number(draftRisk) <= 0) errors.push('Value at risk must be a positive USD amount.')
    if (!draftEvmTransaction) return errors

    if (!Number.isInteger(Number(draftChainId)) || Number(draftChainId) !== 196) errors.push('The live pretrade evidence profile currently supports X Layer (chain ID 196) only.')
    if (!/^\d+$/.test(draftValueWei)) errors.push('Native value must be expressed as a whole number of wei.')

    const isDeployment = draftActionType === 'DEPLOY'
    if (!isDeployment && !/^0x[a-fA-F0-9]{40}$/.test(draftRecipient.trim())) errors.push('Add the verified router or recipient address that will receive the exact transaction.')

    if (!/^0x(?:[a-fA-F0-9]{2})*$/.test(draftCalldata.trim())) {
      errors.push('Calldata must be an even-length 0x-prefixed hex string.')
    } else if (isDeployment && draftCalldata.trim() === '0x') {
      errors.push('A deployment review requires non-empty init code.')
    } else if (draftActionType === 'TRADE' && draftCalldata.trim().length < 10) {
      errors.push('A trade review requires the exact router calldata; CrossExam will not sell a review for an empty or placeholder swap.')
    }
    return errors
  }

  async function submitDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const validationErrors = validateDraftBeforePreparation()
    if (validationErrors.length > 0) {
      setFormErrors(validationErrors)
      return
    }
    try {
      const input = simpleInput()
      const prepared = await new ReviewJobClient().prepareCrossExamination(input)
      setActiveDecision(prepared.decision)
      setPreparedInput(input)
      setPreparedReview(prepared)
      setRunState('idle')
      setReviewJob(null)
      setReviewJobResult(null)
      setReviewJobAccessToken(null)
      setReviewJobError(null)
      setFormErrors([])
    } catch (error) {
      setFormErrors([error instanceof Error ? error.message : 'Unable to prepare this action for Cross-Examination.'])
    }
  }

  async function startPreparedReview() {
    if (!preparedInput || !preparedReview?.canStart) return
    setCreatingReviewJob(true)
    setReviewJobError(null)
    try {
      const client = new ReviewJobClient()
      const started = await client.startCrossExamination(preparedInput)
      const job = await client.get(started.jobId, started.accessToken)
      setActiveDecision(job.decision)
      setReviewJob(job)
      setReviewJobAccessToken(started.accessToken)
      setRunState('queued')
    } catch (error) {
      setReviewJobError(error instanceof Error ? error.message : 'CrossExam could not start the durable review.')
    } finally {
      setCreatingReviewJob(false)
    }
  }

  async function authorizeReview() {
    if (!reviewJob || !reviewJobAccessToken) return
    setAuthorizingReviewJob(true)
    setReviewJobError(null)
    try {
      const client = new ReviewJobClient()
      const pending = await client.authorizeWithBrowserWallet(reviewJob.id, reviewJobAccessToken, (preview) => window.confirm(
        `Authorize CrossExam review payment?\n\nAmount: ${displayUsdt0(preview.amountAtomic)} USDT0\nNetwork: X Layer\nRecipient: ${preview.payTo}\n${preview.description ?? ''}\n\nCrossExam will not release external procurement until the facilitator confirms settlement.`,
      ))
      setReviewJob(pending)
      // The service returns 202 before final settlement; poll once now so a
      // fast facilitator confirmation is reflected immediately.
      window.setTimeout(() => { void client.get(reviewJob.id, reviewJobAccessToken).then(setReviewJob).catch(() => undefined) }, 1_500)
    } catch (error) {
      setReviewJobError(error instanceof Error ? error.message : 'Wallet authorization failed.')
    } finally {
      setAuthorizingReviewJob(false)
    }
  }

  async function queueReview() {
    setGateDecision(null)
    if (isDemo) {
      setRunState('demo-complete')
      return
    }
    if (preparedReview?.canStart) return startPreparedReview()
    document.getElementById('check-action')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  async function retryReview() {
    if (!reviewJob || !reviewJobAccessToken) return
    setRetryingReviewJob(true)
    setReviewJobError(null)
    try {
      setReviewJob(await new ReviewJobClient().retry(reviewJob.id, reviewJobAccessToken))
    } catch (error) {
      setReviewJobError(error instanceof Error ? error.message : 'CrossExam could not retry external evidence procurement.')
    } finally {
      setRetryingReviewJob(false)
    }
  }

  async function recoverPaidReview() {
    const transaction = window.prompt('Enter the X Layer transaction hash for your CrossExam payment. Your wallet will sign an access-recovery message; no transaction or payment will be sent.')
    if (!transaction) return
    setRecoveringReviewJob(true)
    setReviewJobError(null)
    try {
      const recovered = await new ReviewJobClient().recoverWithBrowserWallet(transaction.trim())
      const { accessToken, ...job } = recovered
      setActiveDecision(job.decision)
      setReviewJob(job)
      setReviewJobAccessToken(accessToken)
      setReviewJobResult(null)
      setGateDecision(null)
      setRunState('queued')
    } catch (error) {
      setReviewJobError(error instanceof Error ? error.message : 'Paid review access could not be recovered.')
    } finally {
      setRecoveringReviewJob(false)
    }
  }

  function downloadPrivateRecord() {
    if (!reviewJobResult) return
    const href = URL.createObjectURL(new Blob([JSON.stringify(reviewJobResult, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = `${reviewJobResult.recordId}.json`
    anchor.click()
    URL.revokeObjectURL(href)
  }

  async function shareReviewRecord() {
    if (!reviewJobResult) return
    setSharingReviewRecord(true)
    setReviewJobError(null)
    try {
      const share = await new ReviewJobClient().createPublicShare(reviewJobResult.recordId, reviewJobResult.readAccess.token)
      await navigator.clipboard?.writeText(share.url)
      setReviewJobError('A sanitized public share link was copied. It excludes raw evidence, action parameters, payment data, and your private record capability.')
    } catch (error) {
      setReviewJobError(error instanceof Error ? error.message : 'CrossExam could not create a public share link.')
    } finally {
      setSharingReviewRecord(false)
    }
  }

  function closeClaimDetail() {
    setSelectedClaim(null)
    window.requestAnimationFrame(() => claimTriggerRef.current?.focus())
  }

  async function verifyReviewRecord() {
    const binding = reviewJobResult?.decision.actionBinding
    if (!reviewJobResult || !binding) return
    setVerifyingReviewRecord(true)
    setRecordVerification(null)
    try {
      const verified = await new ReviewJobClient().verifyAssuranceRecord({
        record: reviewJobResult,
        expectedServiceSigner: verificationSigner.trim() as `0x${string}`,
        intent: {
          decisionId: reviewJobResult.decision.id,
          valueAtRiskUsd: reviewJobResult.decision.valueAtRiskUsd,
          actionType: binding.actionType,
          target: binding.target,
          parametersHash: binding.parametersHash,
        },
      })
      setRecordVerification(verified)
    } catch (error) {
      setRecordVerification({
        signatureValid: false,
        actionBindingValid: false,
        gate: { status: 'DENY', executable: false, reasons: [error instanceof Error ? error.message : 'Record verification could not complete.'], requiredClaimIds: [] },
      })
    } finally {
      setVerifyingReviewRecord(false)
    }
  }

  const reviewStatusLabel: Record<ReviewJobView['status'], string> = {
    AWAITING_MATCH: 'Awaiting independent reviewer match',
    AWAITING_DELIVERIES: 'Independent review procurement in progress',
    READY_FOR_ASSURANCE: 'All independent deliveries received',
    FAILED: 'Review procurement exhausted its retry budget',
    CANCELLED: 'Review job cancelled',
    EXPIRED: 'Unfunded review quote expired',
  }

  const reviewStages = useMemo(() => {
    if (!reviewJob) return []
    const scopeComplete = (scopeId: string) => {
      const assignment = reviewJob.dispatch.assignments.find((item) => item.scopeId === scopeId)
      const procurement = reviewJob.procurements.find((item) => item.scopeId === scopeId)
      return Boolean(assignment?.delivery || procurement?.evidence)
    }
    const paymentConfirmed = reviewJob.fundingStatus === 'AUTHORIZED'
    const ready = reviewJob.status === 'READY_FOR_ASSURANCE'
    return [
      { label: 'Payment confirmed', complete: paymentConfirmed, pending: !paymentConfirmed, detail: paymentConfirmed ? 'Customer settlement is recorded.' : 'External evidence remains spend-locked.' },
      { label: 'Action bound', complete: true, pending: false, detail: 'The review is bound to its canonical action hash.' },
      { label: 'Liquidity evidence received', complete: scopeComplete('execution-liquidity'), pending: paymentConfirmed && !scopeComplete('execution-liquidity'), detail: 'OKX Onchain OS source output is retained only when received.' },
      { label: 'Contract risk evidence received', complete: scopeComplete('contract-token-risk'), pending: paymentConfirmed && !scopeComplete('contract-token-risk'), detail: 'GoPlus source output is retained only when received.' },
      { label: 'Contradiction analysis complete', complete: ready, pending: paymentConfirmed && !ready, detail: 'All required evidence must be present before analysis completes.' },
      { label: 'Signed verdict issued', complete: Boolean(reviewJobResult), pending: ready && !reviewJobResult, detail: 'A service signature is issued only after the durable result exists.' },
    ]
  }, [reviewJob, reviewJobResult])

  return (
    <main className="app-shell">
      <nav className="topbar">
        <a className="brand" href="#top" aria-label="CrossExam home">
          <span className="brand-mark">×</span>
          <span>CrossExam</span>
        </a>
        <div className="network-status"><span className="live-dot" /> Live on X Layer</div>
        <div className="topbar-actions">
          <a className="developer-link" href="#developers">For developers</a>
          <button className="recover-button" onClick={() => void recoverPaidReview()} disabled={recoveringReviewJob}>{recoveringReviewJob ? 'Signing recovery' : 'Recover paid review'}</button>
          <a className="new-decision-button" href="#check-action" onClick={invalidatePreparation}>Check an action <span>+</span></a>
        </div>
      </nav>

      <section className="hero" id="top">
        <div className="eyebrow"><span /> Adversarial decision assurance</div>
        <h1>Before an agent acts,<br /><em>make the decision survive.</em></h1>
        <p>CrossExam buys independent counter-evidence, challenges material claims, and returns a signed verdict before an agent spends, trades, deploys, publishes, or delegates.</p>
        <form className="hero-composer" id="check-action" onSubmit={submitDecision}>
          <div className="scenario-tabs" aria-label="Action scenario">
            {(['Trade', 'Pay', 'Approve', 'Hire agent', 'Deploy'] as const).map((scenario) => <button key={scenario} type="button" aria-pressed={draftScenario === scenario} className={draftScenario === scenario ? 'selected' : ''} onClick={() => chooseScenario(scenario)}>{scenario}</button>)}
          </div>
          <div className="candidate-prefill">
            <div><span>Canonical live candidate</span><p>Xwawa · 10,000 USD risk screen · X Layer</p></div>
            <button type="button" onClick={loadCanonicalCandidate}>Load candidate</button>
            <small>Loads a real target only. Add a verified router recipient and calldata before CrossExam can bind or sell a review.</small>
          </div>
          <label>What is your agent about to do?<textarea value={draftIntent} onChange={(event) => { setDraftIntent(event.target.value); invalidatePreparation() }} placeholder="Buy this X Layer token only if liquidity and contract risk survive review." rows={2} /></label>
          <div className="hero-composer-grid">
            <label>Action title<input value={draftTitle} onChange={(event) => { setDraftTitle(event.target.value); invalidatePreparation() }} placeholder="Buy a reviewed X Layer token" /></label>
            <label>Value at risk (USD)<input inputMode="decimal" value={draftRisk} onChange={(event) => { setDraftRisk(event.target.value); invalidatePreparation() }} placeholder="5000" /></label>
          </div>
          {draftEvmTransaction && <details className="hero-advanced">
            <summary>Exact X Layer transaction details</summary>
            <p>Required for the live pretrade evidence profile. CrossExam binds these fields before payment.</p>
            <div className="hero-composer-grid">
              <label>Recipient<input value={draftRecipient} onChange={(event) => { setDraftRecipient(event.target.value); invalidatePreparation() }} placeholder="0x…" /></label>
              <label>Token target<input value={draftTokenRiskTarget} onChange={(event) => { setDraftTokenRiskTarget(event.target.value); invalidatePreparation() }} placeholder="token:xlayer:0x…" /></label>
            </div>
            <label>Calldata / init code<textarea value={draftCalldata} onChange={(event) => { setDraftCalldata(event.target.value); invalidatePreparation() }} placeholder="0x…" rows={2} /></label>
            <div className="hero-composer-grid compact">
              <label>Chain ID<input inputMode="numeric" value={draftChainId} onChange={(event) => { setDraftChainId(event.target.value); invalidatePreparation() }} /></label>
              <label>Native value (wei)<input inputMode="numeric" value={draftValueWei} onChange={(event) => { setDraftValueWei(event.target.value); invalidatePreparation() }} /></label>
            </div>
          </details>}
          {formErrors.length > 0 && <div className="hero-form-errors" role="alert">{formErrors.map((error) => <p key={error}>{error}</p>)}</div>}
          {preparedReview && <div className={`hero-prepared ${preparedReview.canStart ? 'ready' : 'limited'}`} aria-live="polite">
            <span><b>{preparedReview.generatedClaims.length}</b> claims prepared</span><span><b>{preparedReview.evidencePlan.flatMap((scope) => scope.sourceIds).length}</b> real sources matched</span><span><b>{preparedReview.quote.priceUsdt} USDT</b> review quote</span>
            {preparedReview.limitations.map((limitation) => <p key={limitation}>{limitation}</p>)}
            {preparedReview.canStart && <button className="hero-primary" type="button" onClick={() => void startPreparedReview()} disabled={creatingReviewJob}>{creatingReviewJob ? 'Starting durable review' : `Continue to ${preparedReview.quote.priceUsdt} USDT authorization`} <span>→</span></button>}
          </div>}
          <button className="hero-primary" type="submit">{preparedReview ? 'Refresh claims and quote' : 'Cross-examine'} <span>→</span></button>
        </form>
        <div className="hero-actions">
          <a className="hero-secondary" href="#workspace">See the live evidence path</a>
          <button className="mobile-recovery" onClick={() => void recoverPaidReview()} disabled={recoveringReviewJob}>{recoveringReviewJob ? 'Signing recovery…' : 'Recover paid review'}</button>
        </div>
        <div className="proof-strip" aria-label="Production capabilities">
          <span><b>Action-agnostic</b> spend · trade · deploy</span>
          <span><b>Evidence market</b> x402 procurement</span>
          <span><b>Enforceable</b> signed verdict</span>
        </div>
      </section>

      <section className="workspace" id="workspace">
        <aside className="decision-card">
          <div className="card-kicker">{isDemo ? 'Sample decision' : 'Live decision'} <span>{activeDecision.id}</span></div>
          <div className="decision-heading">
            <div className="decision-icon">↗</div>
            <div>
              <h2>{activeDecision.title}</h2>
              <p>{isDemo ? 'Illustrative onchain risk case' : reviewJob ? reviewJob.fundingStatus === 'UNFUNDED' ? 'Payment required to procure evidence' : reviewStatusLabel[reviewJob.status] : 'Ready for a real review'}</p>
            </div>
          </div>
          <div className="risk-row">
            <span>Value at risk</span>
            <strong>${activeDecision.valueAtRiskUsd.toLocaleString()}</strong>
          </div>
          <div className="risk-row">
            <span>Material claims</span>
            <strong>{activeDecision.claims.length}</strong>
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
              <span className="card-kicker">First production network · X Layer</span>
              <h2>{ran ? 'Sample verdict ready' : runState === 'queued' ? reviewJob ? reviewStatusLabel[reviewJob.status] : 'Independent review requested' : 'Challenge claims before execution'}</h2>
            </div>
            <span className="round-pill">Production</span>
          </div>

          {isDemo ? <div className="exam-grid">
            <article className="exam-agent coral"><div className="agent-number">01</div><span className="agent-signal">Production evidence</span><h3>OKX<br />Liquidity</h3><p>Tests executable depth and market conditions for the exact asset.</p><div className="agent-footer"><span>Onchain OS</span><span>Authenticated</span></div></article>
            <article className="exam-agent gold"><div className="agent-number">02</div><span className="agent-signal">Independent evidence</span><h3>GoPlus<br />Security</h3><p>Checks token controls, transfer restrictions, and contract risk.</p><div className="agent-footer"><span>X Layer</span><span>Public API</span></div></article>
            <article className="exam-agent blue"><div className="agent-number">03</div><span className="agent-signal">Machine-enforced output</span><h3>Signed<br />Gate</h3><p>Binds the verdict to the reviewed transaction before execution.</p><div className="agent-footer"><span>EIP-191</span><span>Block / permit</span></div></article>
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
              <span className="button-cross">×</span> {creatingReviewJob ? 'Starting durable review' : isDemo ? 'Explore sample verdict' : preparedReview?.canStart ? `Start ${preparedReview.quote.priceUsdt} USDT review` : 'Prepare a live review'} <span className="button-arrow">→</span>
            </button>
          ) : (
            <div className="completed-run">
              <span className="live-dot" /> {ran ? 'Sample verdict loaded · production workflow available above' : reviewJob ? reviewStatusLabel[reviewJob.status] : 'Decision structured · external evidence procurement pending'}
              <button onClick={() => setRunState('idle')}>{ran ? 'Reset demo' : 'Edit package'}</button>
            </div>
          )}
        </section>
      </section>

      {reviewJobError && <section className="service-error" role="alert"><strong>CrossExam needs attention.</strong><span>{reviewJobError}</span></section>}

      <section className="developer-section" id="developers">
        <div><span className="eyebrow"><span /> Developer integration</span><h2>One decision before<br /><em>one irreversible call.</em></h2><p>Request an action-bound verdict, pin CrossExam’s service signer, then let the execution boundary refuse a changed, stale, unresolved, or blocked action.</p><a href="https://api.cross-exam.xyz/.well-known/crossexam.json" target="_blank" rel="noreferrer">Open API discovery →</a></div>
        <pre aria-label="CrossExam integration example"><code>{`const gate = await crossExam.preflightVerified(
  access, exactIntent, trustedCrossExamSigner,
)

if (!gate.executable) {
  throw new Error(gate.reasons.join(' '))
}

await wallet.sendTransaction(tx)`}</code></pre>
      </section>

      <section className={`results ${ran || reviewJobResult ? 'visible' : ''}`} aria-live="polite">
        <div className="results-intro">
          <div>
            <div className="eyebrow"><span /> Decision assurance record</div>
            <h2>A verdict an executor<br /><em>can actually enforce.</em></h2>
          </div>
          <div className="independence">
            <span>Effective independence</span>
            <strong>{result.effectiveIndependence.toFixed(1)} <small>/ 3.0</small></strong>
            <p>Distinct owners, tools, and evidence routes.</p>
          </div>
        </div>

        <section className={`verdict-snapshot ${result.action.toLowerCase()}`} aria-label="Verdict and execution summary">
          <div className="snapshot-verdict"><span>Verdict</span><strong>{result.action}</strong></div>
          <div><span>Protected value</span><strong>${resultDecision.valueAtRiskUsd.toLocaleString()}</strong><small>Exact action remains unbroadcast</small></div>
          <div className="snapshot-reason"><span>{decisiveClaim?.verdict === 'REFUTED' ? 'Strongest contradiction' : 'Material premise'}</span><strong>{decisiveClaim?.id ?? 'No decisive premise'}</strong><p>{decisiveClaim?.evidence ?? 'No record finding is available.'}</p></div>
          <div className={`snapshot-gate ${displayedGate.executable ? 'permit' : 'blocked'}`}><span>Execution gate</span><strong>{displayedGate.status}</strong><p>{displayedGate.reasons[0]}</p></div>
        </section>

        <div className="result-layout">
          <div className="claim-list">
            <div className="claim-list-heading"><span>Claims challenged</span><span>{result.claims.length} examined</span></div>
            {result.claims.map((claim) => (
              <button
                className={`claim-row ${claim.verdict.toLowerCase()} ${selectedClaim?.id === claim.id ? 'selected' : ''}`}
                key={claim.id}
                onClick={(event) => { claimTriggerRef.current = event.currentTarget; setSelectedClaim(claim) }}
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
              <div className="guard-heading"><span>Execution guard</span><small>{reviewJobResult?.attributionStatus ?? 'NETWORK VERIFIED'}</small></div>
              <p>Bound to {resultBinding?.actionType.toLowerCase()} · {resultBinding?.target}</p>
              <div className={`gate-outcome ${displayedGate.executable ? 'permit' : 'blocked'}`}>
                <strong>{displayedGate.status}</strong>
                <span>{displayedGate.reasons[0]}</span>
                {displayedGate.requiredClaimIds.length > 0 && <small>Remediate {displayedGate.requiredClaimIds.join(' · ')}</small>}
              </div>
              <button className="guard-button" onClick={() => setGateDecision(realGate ?? demoGate)}>Re-run exact gate check <span>→</span></button>
            </div>
            {reviewJobResult && <div className="record-proof"><span>Signed assurance record</span><p>{reviewJobResult.recordId}</p><small>{reviewJobResult.attributionStatus} · {reviewJobResult.persistence} · access expires {new Date(reviewJobResult.readAccess.expiresAt).toLocaleString()}</small></div>}
            {reviewJobResult && <div className="record-actions"><button onClick={downloadPrivateRecord}>Download private JSON</button><button onClick={() => void shareReviewRecord()} disabled={sharingReviewRecord}>{sharingReviewRecord ? 'Creating safe link…' : 'Create safe share link'}</button></div>}
            {reviewJobResult?.decision.actionBinding && <div className="record-verification">
              <label>Trusted CrossExam signer<input value={verificationSigner} onChange={(event) => { setVerificationSigner(event.target.value); setRecordVerification(null) }} placeholder="0x… pin from your deployment config" autoComplete="off" spellCheck="false" /></label>
              <p>Paste the issuer you independently pinned from deployment configuration or a verified manifest. Do not take it from this record.</p>
              <a href="https://api.cross-exam.xyz/.well-known/crossexam.json" target="_blank" rel="noreferrer">Open issuer manifest →</a>
              <button onClick={() => void verifyReviewRecord()} disabled={verifyingReviewRecord || !/^0x[a-fA-F0-9]{40}$/.test(verificationSigner.trim())}>{verifyingReviewRecord ? 'Verifying signed record…' : 'Verify signed record'}</button>
              {recordVerification && <output className={recordVerification.signatureValid && recordVerification.actionBindingValid && recordVerification.gate.executable ? 'verified' : 'rejected'} aria-live="polite"><strong>{recordVerification.signatureValid ? 'Issuer signature valid' : 'Issuer signature rejected'}</strong><span>{recordVerification.actionBindingValid ? 'Exact action binding matches.' : 'Exact action binding does not match.'} {recordVerification.gate.reasons[0] ?? recordVerification.gate.status}</span></output>}
            </div>}
          </aside>
        </div>
      </section>

      {runState === 'queued' && reviewJob && (
        <section className="queued-panel" aria-live="polite">
          <span className="queued-icon">{reviewJob.status === 'READY_FOR_ASSURANCE' ? '✓' : '×'}</span>
          <div>
            <span className="card-kicker">Review lifecycle · {reviewStatusLabel[reviewJob.status]}</span>
            <h2>{reviewJob.status === 'READY_FOR_ASSURANCE' ? 'Evidence received. Assurance issued.' : 'CrossExam will not invent a verdict.'}</h2>
            <p>{reviewJob.fundingStatus === 'UNFUNDED' ? 'Evidence procurement is spend-locked until payment settles.' : reviewJob.status === 'READY_FOR_ASSURANCE' ? 'External responses are retained, content-addressed, and bound to the signed record.' : 'The worker is acquiring evidence from matched production sources.'}</p>
          </div>
          <div className="queued-meta"><span>{reviewJob.quote.authorizationPriceUsdt} USDT review</span><span>{reviewJob.plan.estimatedTotalUsdt} USDT evidence cap</span><span>{reviewJob.fundingStatus}</span></div>
          {reviewJob.fundingStatus === 'UNFUNDED' && <button className="run-button" onClick={() => void authorizeReview()} disabled={authorizingReviewJob}>
            <span className="button-cross">×</span> {authorizingReviewJob ? 'Waiting for wallet approval' : `Authorize ${reviewJob.quote.authorizationPriceUsdt} USDT review`} <span className="button-arrow">→</span>
          </button>}
          {reviewJob.status === 'FAILED' && reviewJob.fundingStatus === 'AUTHORIZED' && <button className="run-button" onClick={() => void retryReview()} disabled={retryingReviewJob}>
            <span className="button-cross">×</span> {retryingReviewJob ? 'Rebinding evidence sources' : 'Retry without another payment'} <span className="button-arrow">→</span>
          </button>}
          <ol className="review-stage-list" aria-label="Live review progress">
            {reviewStages.map((stage) => <li className={stage.complete ? 'complete' : stage.pending ? 'pending' : 'waiting'} key={stage.label}>
              <span aria-hidden="true">{stage.complete ? '✓' : stage.pending ? '·' : '—'}</span><div><strong>{stage.label}</strong><small>{stage.detail}</small></div>
            </li>)}
          </ol>
          <details className="audit-details">
            <summary>View evidence provenance and economics</summary>
            <div className="review-plan-list">
              {reviewJob.plan.scopes.map((scope) => {
                const assignment = reviewJob.dispatch.assignments.find((item) => item.scopeId === scope.id)
                const procurement = reviewJob.procurements.find((item) => item.scopeId === scope.id)
                return <div key={scope.id}>
                  <span>{scope.title}</span>
                  <small>{assignment?.status === 'AWAITING_MATCH' ? 'Awaiting independent match' : `${assignment?.reviewer?.displayName ?? 'Matched reviewer'} · ${procurement?.status ?? 'UNSENT'}`} · {scope.estimatedFeeUsdt} USDT</small>
                  {assignment?.delivery?.provenance && <details className="evidence-proof">
                    <summary>Verified provenance</summary>
                    <p>{assignment.delivery.provenance.kind.replaceAll('_', ' ')} · {new Date(assignment.delivery.provenance.observedAt).toLocaleString()}</p>
                    <code>request {assignment.delivery.provenance.requestHash}</code>
                    <code>response {assignment.delivery.provenance.responseHash}</code>
                    {assignment.delivery.findings.map((finding) => <p key={`${scope.id}-${finding.claimId}`}><b>{finding.verdict}</b> {finding.evidence}</p>)}
                  </details>}
                </div>
              })}
            </div>
            {procurementLedger && <div className="economics-ledger">
              <div><span>Customer revenue</span><strong>{procurementLedger.commercial.customerSettlement ? `${(Number(procurementLedger.commercial.customerSettlement.amountAtomic) / 1_000_000).toFixed(2)} USDT0` : 'Pending'}</strong></div>
              <div><span>External settled cost</span><strong>{procurementLedger.settledByAsset.length === 0 ? '0.00 USDT0' : procurementLedger.settledByAsset.map((item) => `${(Number(item.amountAtomic) / 1_000_000).toFixed(2)} USDT0`).join(' + ')}</strong></div>
              <div><span>Realized gross margin</span><strong>{procurementLedger.commercial.realizedGrossMargin ? `${(Number(procurementLedger.commercial.realizedGrossMargin.amountAtomic) / 1_000_000).toFixed(2)} USDT0` : procurementLedger.commercial.grossMarginStatus.replaceAll('_', ' ')}</strong></div>
              <div><span>Evidence cost basis</span><strong>{procurementLedger.scopes.map((scope) => scope.costBasis === 'INCLUDED_API_QUOTA' ? 'Included quota' : scope.costBasis === 'SETTLED_X402' ? 'x402 settled' : 'Pending').join(' · ')}</strong></div>
            </div>}
          </details>
        </section>
      )}

      {selectedClaim && (
        <div className="detail-backdrop" onClick={closeClaimDetail} role="presentation">
          <aside className="detail-panel" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="claim-detail-title">
            <button className="close-button" ref={claimCloseRef} onClick={closeClaimDetail} aria-label="Close detail">×</button>
            <span className={`detail-label ${selectedClaim.verdict.toLowerCase()}`}>{verdictLabel[selectedClaim.verdict]}</span>
            <small>{selectedClaim.id} · challenged by {selectedClaim.challenger}</small>
            <h2 id="claim-detail-title">{selectedClaim.text}</h2>
            <div className="evidence-block"><span>Evidence finding</span><p>{selectedClaim.evidence}</p></div>
            <div className="reversal-block"><span>Reversal condition</span><p>Provide a current, independently verifiable data point that addresses this contradiction.</p></div>
          </aside>
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
