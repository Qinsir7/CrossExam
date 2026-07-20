import { useMemo, useRef, useState, type DragEvent } from 'react'
import type { AdversarialReviewResult, AuthoritativeSourceCheck, AuthoritativeSourceCheckStatus, ReviewPreflight, ReviewProfile } from './domain/generalReview'
import type { PaidAdversarialReviewResponse } from './domain/assuranceContracts'
import { ReviewJobClient } from './sdk/reviewJobClient'
import { displayUsdt0 } from './sdk/browserX402'
import './AppV2.css'

type Stage = 'INPUT' | 'REVIEW' | 'RESULT'

const profiles: Array<{
  id: ReviewProfile
  label: string
  title: string
  hint: string
  preview: string
  placeholder: string
}> = [
  {
    id: 'LEGAL', label: 'Legal', title: 'Document or contract',
    hint: 'Optional: include the opposing document or case background. A single document is enough to start.',
    preview: 'Searches public official sources for cited law and cases, then argues the strongest opposing case. Anything not confirmed stays unresolved.',
    placeholder: 'Paste a pleading, response, appeal, legal opinion, or contract draft…',
  },
  {
    id: 'MONEY', label: 'Money', title: 'Investment or trade',
    hint: 'Write why you want to make the move. CrossExam attacks your reasoning, not just the asset.',
    preview: 'Tests the thesis claim by claim. A contract address can be routed to live onchain evidence.',
    placeholder: 'Paste the thesis, asset or contract address, amount, and what you expect to happen…',
  },
  {
    id: 'PLAN', label: 'Plan', title: 'Plan or proposal',
    hint: 'The closer to final, the more useful the attack. Goals and hard constraints improve blind-spot detection.',
    preview: 'Attacks assumptions, dependencies and failure modes; cited facts are verified only when a real source is available.',
    placeholder: 'Paste a product proposal, business plan, technical architecture, or anything you are about to do…',
  },
  {
    id: 'GENERAL', label: 'Anything', title: 'Any consequential decision',
    hint: 'Anything can be reviewed. Unsupported domains are clearly marked as argument-only, never falsely verified.',
    preview: 'Maps the argument, finds hidden premises, and tells you exactly which conclusions still need evidence.',
    placeholder: 'Paste the decision, reasoning, document, or recommendation you want challenged…',
  },
]

function profileCopy(profile: ReviewProfile) {
  return profiles.find((item) => item.id === profile) ?? profiles[3]
}

const sourceStatusCopy: Record<AuthoritativeSourceCheckStatus, { label: string; tone: 'confirmed' | 'warning' | 'unknown' }> = {
  CURRENT_LAW_CONFIRMED: { label: 'Current status confirmed', tone: 'confirmed' },
  REPEALED_OR_SUPERSEDED: { label: 'Repeal signal found', tone: 'warning' },
  OFFICIAL_SOURCE_FOUND_STATUS_UNCLEAR: { label: 'Official source · status unclear', tone: 'unknown' },
  CASE_PUBLIC_SOURCE_CONFIRMED: { label: 'Case found in official source', tone: 'confirmed' },
  AUTHORITATIVE_SOURCE_LOCATED: { label: 'Authoritative source located', tone: 'confirmed' },
  NOT_CONFIRMED_IN_PUBLIC_SOURCES: { label: 'Not confirmed in public sources', tone: 'unknown' },
  SEARCH_UNAVAILABLE: { label: 'Source check unavailable', tone: 'unknown' },
}

function sourceCheckTitle(check: AuthoritativeSourceCheck) {
  return check.subject === 'LAW' ? 'Law status' : check.subject === 'CASE' ? 'Case citation' : 'Primary source'
}

function escapeXml(value: string) {
  return value.replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character] ?? character)
}

function wrapText(value: string, limit = 64) {
  const words = value.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!current) current = word
    else if (`${current} ${word}`.length <= limit) current += ` ${word}`
    else { lines.push(current); current = word }
  }
  if (current) lines.push(current)
  return lines.slice(0, 4)
}

function createVerdictSvg(preflight: ReviewPreflight, analysis: AdversarialReviewResult, recordId: string) {
  const lines = wrapText(analysis.strongestAttack)
  const verdict = analysis.verdict === 'SURVIVED' ? 'SURVIVED.' : analysis.verdict === 'REFUTED' ? 'REFUTED.' : 'UNRESOLVED.'
  const textLines = lines.map((line, index) => `<text x="72" y="${310 + index * 34}" fill="#f4efe8" font-family="Arial" font-size="24">${escapeXml(line)}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#111619"/><circle cx="1080" cy="80" r="240" fill="#e85d43" opacity=".12"/>
  <text x="72" y="76" fill="#f4efe8" font-family="Arial" font-size="24" font-weight="700">CrossExam</text>
  <text x="72" y="142" fill="#e9a35f" font-family="Arial" font-size="18" letter-spacing="3">SIGNED ADVERSARIAL VERDICT</text>
  <text x="72" y="230" fill="#f4efe8" font-family="Arial" font-size="72" font-weight="700">${verdict}</text>
  ${textLines}
  <text x="72" y="510" fill="#9ba5a4" font-family="Arial" font-size="20">${preflight.claimCount} claims · ${escapeXml(preflight.inferredDocumentType)} · ${escapeXml(recordId)}</text>
  <text x="72" y="570" fill="#e9a35f" font-family="Arial" font-size="22">Before you act, make it survive.</text>
  </svg>`
}

function DeveloperPage() {
  return <main className="developer-page">
    <a className="wordmark" href="/">CrossExam<span>×</span></a>
    <section>
      <p className="overline">For agents</p>
      <h1>Before your agent acts,<br /><em>make it survive.</em></h1>
        <p>One adversarial-review primitive for agents and people: structured inputs, explicit evidence boundaries, signed records, and standard OKX x402 payment on X Layer.</p>
      <pre><code>{`const verdict = await crossExam.preflightTransaction(tx, {
  intent: "Buy only if the thesis survives",
  valueAtRiskUsd: 5000,
})

if (!verdict.canExecute) throw new Error(verdict.reason)
await wallet.sendTransaction(tx)`}</code></pre>
      <div className="developer-actions"><a href="https://api.cross-exam.xyz/.well-known/crossexam.json">Service manifest</a><a href="https://github.com/Qinsir7/CrossExam">GitHub</a></div>
    </section>
  </main>
}

export default function AppV2() {
  const [stage, setStage] = useState<Stage>('INPUT')
  const [profile, setProfile] = useState<ReviewProfile>('GENERAL')
  const [text, setText] = useState('')
  const [filename, setFilename] = useState<string | undefined>()
  const [preflight, setPreflight] = useState<ReviewPreflight | null>(null)
  const [paidReview, setPaidReview] = useState<PaidAdversarialReviewResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [paidState, setPaidState] = useState<'IDLE' | 'WALLET' | 'ANALYZING'>('IDLE')
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [shareFeedback, setShareFeedback] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const idempotencyKey = useRef(`web-review-${crypto.randomUUID()}`)
  const copy = profileCopy(profile)

  const sourceRequired = useMemo(() => preflight?.claims.filter((claim) => claim.verificationRoute === 'SOURCE_REQUIRED') ?? [], [preflight])
  const toolReady = useMemo(() => preflight?.claims.filter((claim) => claim.verificationRoute === 'TOOL_READY') ?? [], [preflight])
  const attackOnly = useMemo(() => preflight?.claims.filter((claim) => claim.verificationRoute === 'ARGUMENT_ONLY') ?? [], [preflight])
  const runPaidReview = async () => {
    if (!preflight?.paidReview?.available) return
    setError(null)
    setPaidState('WALLET')
    try {
      const result = await new ReviewJobClient().runPaidReviewWithBrowserWallet(
        { text, profile: preflight.profile, ...(filename ? { filename } : {}) },
        idempotencyKey.current,
        preflight.paidReview.priceUsd,
        async (preview) => {
          const approved = window.confirm(`Authorize ${displayUsdt0(preview.amountAtomic)} USDT0 on X Layer for one full CrossExam review?\n\nRecipient: ${preview.payTo}\n\nYour wallet will show the final authorization before signing.`)
          if (approved) setPaidState('ANALYZING')
          return approved
        },
      )
      setPaidReview(result)
      setStage('RESULT')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The paid review could not be completed.')
    } finally {
      setPaidState('IDLE')
    }
  }

  const runPreflight = async (material = text, name = filename, nextStage = false) => {
    setBusy(true)
    setError(null)
    try {
      const result = await new ReviewJobClient().preflightReview({ text: material, ...(profile === 'GENERAL' ? {} : { profile }), ...(name ? { filename: name } : {}) })
      setPreflight(result)
      setProfile(result.profile)
      if (nextStage) setStage('REVIEW')
      return result
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'CrossExam could not read this material.')
      return null
    } finally {
      setBusy(false)
    }
  }

  const handleFile = async (file?: File) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const extracted = await new ReviewJobClient().extractFile(file)
      setText(extracted.text)
      setFilename(extracted.filename)
      const result = await new ReviewJobClient().preflightReview({ text: extracted.text, ...(profile === 'GENERAL' ? {} : { profile }), filename: extracted.filename })
      setPreflight(result)
      setProfile(result.profile)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'CrossExam could not read this file.')
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    void handleFile(event.dataTransfer.files[0])
  }

  const reset = () => {
    setStage('INPUT')
    setText('')
    setFilename(undefined)
    setPreflight(null)
    setPaidReview(null)
    idempotencyKey.current = `web-review-${crypto.randomUUID()}`
    setError(null)
    setShareFeedback(null)
  }

  const downloadCard = () => {
    if (!preflight || !paidReview) return
    const blob = new Blob([createVerdictSvg(preflight, paidReview.analysis, paidReview.record.recordId)], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `crossexam-${preflight.profile.toLowerCase()}-verdict.svg`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const share = async () => {
    if (!preflight || !paidReview) return
    const summary = `CrossExam: ${paidReview.analysis.verdict} — ${paidReview.analysis.strongestAttack}`
    try {
      if (navigator.share) await navigator.share({ title: 'CrossExam verdict', text: summary, url: window.location.origin })
      else await navigator.clipboard.writeText(summary)
      setShareFeedback(navigator.share ? 'Share sheet opened.' : 'Verdict copied.')
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setShareFeedback('Sharing is unavailable in this browser.')
    }
  }

  if (window.location.pathname.startsWith('/developers')) return <DeveloperPage />

  return <div className={`product-shell stage-${stage.toLowerCase()}`}>
    <header className="product-header">
      <button className="wordmark" type="button" onClick={reset}>CrossExam<span>×</span></button>
      <nav><a href="/developers">API</a>{stage !== 'INPUT' && <button type="button" onClick={reset}>New review</button>}</nav>
    </header>

    {stage === 'INPUT' && <main className="input-screen">
      <section className="intro-copy">
        <p className="overline">Cross-examine before committing</p>
        <h1>Before you act,<br /><em>make it survive.</em></h1>
        <p>Paste the thing you are about to rely on. Get one clear verdict, the strongest attack, and the evidence still missing.</p>
      </section>

      <section className="intake-card" aria-label="Start a CrossExam review">
        <div className="profile-tabs" role="tablist" aria-label="Review type">
          {profiles.map((item) => <button key={item.id} role="tab" aria-selected={profile === item.id} className={profile === item.id ? 'active' : ''} type="button" onClick={() => { setProfile(item.id); setPreflight(null) }}>{item.label}</button>)}
        </div>
        <div className={`drop-surface ${dragging ? 'dragging' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={drop}>
          <div className="input-heading"><span>{copy.title}</span>{filename && <button type="button" onClick={() => { setFilename(undefined); setText(''); setPreflight(null) }}>Remove {filename}</button>}</div>
          <textarea value={text} onChange={(event) => { setText(event.target.value); setFilename(undefined); setPreflight(null); setError(null) }} placeholder={copy.placeholder} aria-label="Material to cross-examine" rows={11} />
          <div className="upload-row">
            <input id="cross-exam-file" ref={fileInput} aria-label="Upload TXT, Markdown, DOCX, or PDF" disabled={busy} type="file" accept=".txt,.md,.markdown,.docx,.pdf,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => void handleFile(event.target.files?.[0])} />
            <label htmlFor="cross-exam-file" aria-disabled={busy}><span>＋</span> Upload TXT, MD, DOCX, or PDF</label>
            <small>{text.length.toLocaleString()} / 200,000</small>
          </div>
        </div>

        {preflight && <div className="preflight-echo" aria-live="polite"><span>Understood</span><strong>{preflight.inferredDocumentType}</strong><b>{preflight.claimCount} claims</b><b>{preflight.verifiableClaimCount} potentially verifiable</b></div>}
        {error && <p className="intake-error" role="alert">{error}</p>}
        <div className="intake-note"><p>{copy.hint}</p><span>{copy.preview}</span></div>
        <button className="survive-button" type="button" disabled={busy || text.trim().length < 20} onClick={() => void runPreflight(text, filename, true)}>{busy ? 'Reading your material…' : 'Make it survive'}<span>↗</span></button>
        <p className="privacy-note">Files are extracted in memory and are not stored during preflight.</p>
      </section>
    </main>}

    {stage === 'REVIEW' && preflight && <main className="review-screen">
      <section className="review-heading">
        <p className="overline">Cross-examination map</p>
        <h1>{preflight.claimCount} claims.<br /><em>Every premise exposed.</em></h1>
        <p>{preflight.inferredDocumentType} · {preflight.verifiableClaimCount} claims can be routed to evidence checks.</p>
      </section>
      <section className="process-card" aria-live="polite" aria-busy={paidState === 'ANALYZING'}>
        <div className={`process-summary ${paidState === 'ANALYZING' ? 'running' : ''}`}><span className="process-pulse">{paidState === 'ANALYZING' ? '×' : '✓'}</span><div><strong>{paidState === 'ANALYZING' ? 'Cross-examination in progress' : 'Material understood'}</strong><p>{paidState === 'ANALYZING' ? (preflight.paidReview?.authoritySearchAvailable ? 'Attacking every claim and checking eligible citations against public official sources.' : 'Attacking every claim and preserving every unsupported fact as unresolved.') : 'Claims, hidden premises, and verification routes are mapped.'}</p></div></div>
        <ol className="claim-process">
          {preflight.claims.map((claim) => <li key={claim.id}>
            <span className={`route-dot ${claim.verificationRoute.toLowerCase()}`} aria-hidden="true" />
            <div><small>{claim.id} · {claim.kind.replaceAll('_', ' ')}</small><p>{claim.text}</p><strong>{claim.reviewTask}</strong></div>
            <b>{paidState === 'ANALYZING' ? (claim.verificationRoute === 'SOURCE_REQUIRED' ? 'Checking source…' : claim.verificationRoute === 'TOOL_READY' ? 'Checking tool…' : 'Attacking…') : claim.verificationRoute === 'TOOL_READY' ? 'Tool ready' : claim.verificationRoute === 'SOURCE_REQUIRED' ? 'Source queued' : 'Attack mapped'}</b>
          </li>)}
        </ol>
        <div className="truth-line"><span>{toolReady.length} tool checks</span><span>{sourceRequired.length} source checks</span><span>{attackOnly.length} logic attacks</span>{preflight.paidReview?.authoritySearchAvailable && <span className="truth-ready">Official-source search ready</span>}</div>
        {error && <p className="intake-error review-error" role="alert">{error}</p>}
        <button className="survive-button compact" type="button" disabled={!preflight.paidReview?.available || paidState !== 'IDLE'} onClick={() => void runPaidReview()}>
          {paidState === 'WALLET' ? 'Waiting for wallet…' : paidState === 'ANALYZING' ? 'Cross-examining every claim…' : preflight.paidReview?.available ? `Run full cross-examination · ${preflight.paidReview.priceUsd} USDT0` : 'Full review temporarily unavailable'}<span>→</span>
        </button>
        <p className="paid-note">Paid review sends the material to DeepSeek and eligible citation excerpts to Tavily when source search is enabled. The signed result is stored.</p>
      </section>
    </main>}

    {stage === 'RESULT' && preflight && paidReview && <main className="result-screen">
      <section className="verdict-card">
        <div className="verdict-top"><p>Signed adversarial verdict</p><span>{preflight.profile}</span></div>
        <div className={`verdict-word verdict-${paidReview.analysis.verdict.toLowerCase()}`}>{paidReview.analysis.verdict}<span>.</span></div>
        <p className="verdict-lede">{paidReview.analysis.headline}</p>

        <div className="verdict-focus">
          <small>Strongest attack</small>
          <h2>{paidReview.analysis.strongestAttack}</h2>
          <p>{paidReview.analysis.verdict === 'SURVIVED' ? 'The reasoning survived this adversarial pass; factual claims still carry the verification status shown below.' : 'Fix this before relying on the decision.'}</p>
        </div>

        <div className="result-grid">
          <section><h3>What can break</h3>{paidReview.analysis.claims.slice(0, 4).map((claim) => <div className="finding" key={claim.claimId}><span>{claim.claimId}</span><div><b>{claim.verdict}</b><p>{claim.strongestAttack}</p></div></div>)}</section>
          <section><h3>What would resolve it</h3>{paidReview.analysis.nextActions.slice(0, 4).map((action, index) => <div className="finding resolve" key={`${index}-${action}`}><span>＋</span><p>{action}</p></div>)}</section>
        </div>

        {(paidReview.analysis.sourceChecks?.length ?? 0) > 0 && <section className="source-ledger" aria-label="Source verification results">
          <div className="source-ledger-heading"><div><span>Evidence checks</span><h3>What the public record can — and cannot — confirm</h3></div><b>{paidReview.analysis.sourceChecks!.filter((check) => Boolean(check.source)).length}/{paidReview.analysis.sourceChecks!.length} sources located</b></div>
          <div className="source-checks">{paidReview.analysis.sourceChecks!.map((check) => {
            const status = sourceStatusCopy[check.status]
            return <article className={`source-check source-${status.tone}`} key={`${check.claimId}-${check.requestHash}`}>
              <div><small>{check.claimId} · {sourceCheckTitle(check)}</small><strong>{status.label}</strong></div>
              <p>{check.statement}</p>
              {check.source ? <a href={check.source.url} target="_blank" rel="noreferrer">Open {check.source.authorityDomain} source ↗</a> : <span>No source link was accepted</span>}
            </article>
          })}</div>
        </section>}
        <div className="honesty-block"><strong>Truth boundary</strong><p>{paidReview.analysis.claims.filter((claim) => claim.verificationStatus === 'REQUIRES_EXTERNAL_SOURCE' || claim.verificationStatus === 'TOOL_CHECK_REQUIRED').length} claim(s) remain unverified. A source link confirms only the status written above; it does not prove legal applicability, interpretation, or the whole decision.</p></div>
        <div className="result-actions"><button type="button" onClick={downloadCard}>Download card</button><button type="button" onClick={() => void share()}>Share verdict</button>{preflight.profile === 'MONEY' && preflight.detected.contractAddresses.length > 0 && <a href="/check/transaction">Run live onchain checks</a>}<button className="primary" type="button" onClick={reset}>Review another</button></div>
        {shareFeedback && <p className="share-feedback" aria-live="polite">{shareFeedback}</p>}
        <p className="result-boundary">Record {paidReview.record.recordId} · {paidReview.record.attributionStatus} · signed by {paidReview.record.serviceAttestation.signer.slice(0, 10)}… · {paidReview.analysis.provenance.model}</p>
      </section>
    </main>}

    <footer className="product-footer"><span>CrossExam</span><span>Evidence, not confidence.</span></footer>
  </div>
}
