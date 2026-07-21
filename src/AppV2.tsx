import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
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

const productUrl = 'https://www.cross-exam.xyz'
const apiUrl = 'https://api.cross-exam.xyz'
const githubUrl = 'https://github.com/Qinsir7/CrossExam'

function Wordmark({ button = false, onClick }: { button?: boolean; onClick?: () => void }) {
  const content = <>CrossExam<span>×</span></>
  return button
    ? <button className="wordmark" type="button" onClick={onClick}>{content}</button>
    : <a className="wordmark" href="/" aria-label="CrossExam home">{content}</a>
}

function SiteHeader({ stage, onReset }: { stage?: Stage; onReset?: () => void }) {
  return <header className="product-header">
    <Wordmark button={Boolean(onReset)} onClick={onReset} />
    <nav aria-label="Primary navigation">
      {stage === 'INPUT' && <>
        <a className="nav-wide" href="/#product">Product</a>
        <a className="nav-wide" href="/#use-cases">Use cases</a>
        <a className="nav-wide" href="/#pricing">Pricing</a>
      </>}
      <a href="/developers">Developers</a>
      {stage && stage !== 'INPUT'
        ? <button className="nav-cta" type="button" onClick={onReset}>New review</button>
        : <a className="nav-cta" href="/#review">Start a review</a>}
    </nav>
  </header>
}

function SiteFooter() {
  return <footer className="site-footer">
    <div className="footer-brand"><Wordmark /><p>Adversarial review before consequential action.</p></div>
    <div className="footer-links">
      <div><strong>Product</strong><a href="/#review">Start a review</a><a href="/#use-cases">Use cases</a><a href="/#pricing">Pricing</a></div>
      <div><strong>Developers</strong><a href="/developers">Documentation</a><a href={`${apiUrl}/.well-known/crossexam.json`}>Service manifest</a><a href={githubUrl}>GitHub</a></div>
      <div><strong>Trust</strong><a href={`${apiUrl}/health`}>API health</a><a href="/developers#security">Security boundary</a><a href="/developers#verification">Verify records</a></div>
    </div>
    <div className="footer-bottom"><span>© 2026 CrossExam</span><span>Evidence, not confidence.</span></div>
  </footer>
}

function MarketingSections({ selectProfile }: { selectProfile: (profile: ReviewProfile) => void }) {
  const choose = (nextProfile: ReviewProfile) => {
    selectProfile(nextProfile)
    document.getElementById('review')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return <div className="marketing-sections">
    <section className="trust-strip" aria-label="Product facts">
      <span><b>01</b> Free claim preflight</span>
      <span><b>02</b> Official-source checks where available</span>
      <span><b>03</b> Signed verdict records</span>
      <span><b>04</b> x402 on X Layer</span>
    </section>

    <section className="marketing-section product-story" id="product">
      <div className="section-intro"><p className="overline">What CrossExam does</p><h2>Your proposal gets a hostile reading<br />before reality gives it one.</h2><p>CrossExam turns a document or decision into material claims, attacks each premise, verifies bounded facts with real sources, and returns one clear verdict. Missing evidence stays missing.</p></div>
      <div className="steps-grid" id="how-it-works">
        <article><span>01</span><h3>Decompose</h3><p>Extract the claims, dependencies, citations, numbers, and hidden assumptions that the decision relies on.</p></article>
        <article><span>02</span><h3>Attack & verify</h3><p>Build the strongest opposing case. Route checkable facts to available tools and authoritative public sources.</p></article>
        <article><span>03</span><h3>Decide</h3><p>Get a signed verdict with the strongest attack, unresolved premises, and exactly what would change the result.</p></article>
      </div>
    </section>

    <section className="marketing-section" id="use-cases">
      <div className="section-heading"><div><p className="overline">Deep review profiles</p><h2>One engine. Four ways in.</h2></div><p>Start with whatever you have. CrossExam asks for missing material in the verdict instead of blocking the review.</p></div>
      <div className="use-case-grid">
        <button type="button" onClick={() => choose('LEGAL')}><span>Legal</span><h3>Documents & contracts</h3><p>Challenge pleadings, appeals, opinions, and contract drafts. Check exact cited authorities against public official sources where available.</p><b>Review a document →</b></button>
        <button type="button" onClick={() => choose('MONEY')}><span>Money</span><h3>Investments & trades</h3><p>Attack the reason for a move. When a supported X Layer contract is present, continue into live onchain evidence.</p><b>Test a thesis →</b></button>
        <button type="button" onClick={() => choose('PLAN')}><span>Plan</span><h3>Plans & proposals</h3><p>Expose brittle assumptions, missing dependencies, incentives, timing risks, and reversal conditions before execution.</p><b>Stress-test a plan →</b></button>
        <button type="button" onClick={() => choose('GENERAL')}><span>Anything</span><h3>Consequential decisions</h3><p>Use the same adversarial structure on any material. Unsupported facts remain clearly marked as argument-only.</p><b>Start from anything →</b></button>
      </div>
    </section>

    <section className="marketing-section capability-section">
      <div className="section-heading"><div><p className="overline">Built for people and agents</p><h2>One assurance layer,<br />at every decision boundary.</h2></div><p>The browser product, paid API, signed record, and execution gate use the same truth boundary.</p></div>
      <div className="capability-grid">
        <article><div className="capability-icon">T</div><h3>Universal review</h3><p>Paste text or upload TXT, Markdown, DOCX, or text-based PDF. Watch the claim map, then buy the full adversarial pass.</p><a href="/#review">Open the reviewer →</a></article>
        <article><div className="capability-icon">↯</div><h3>Transaction preflight</h3><p>Bind a supported exact X Layer trade to live liquidity and token-risk evidence. Ambiguity fails closed.</p><a href="/check/transaction">Review an onchain action →</a></article>
        <article><div className="capability-icon">{'{ }'}</div><h3>Agent API</h3><p>Call the same capability over HTTP. Standard x402 challenges let agents pay per review without subscriptions or API keys.</p><a href="/developers">Read the quickstart →</a></article>
        <article><div className="capability-icon">✓</div><h3>Signed records</h3><p>Verify the service signature, exact action binding, freshness, and execution gate before an agent or wallet acts.</p><a href="/developers#verification">See verification →</a></article>
      </div>
    </section>

    <section className="marketing-section pricing-section" id="pricing">
      <div className="section-heading"><div><p className="overline">Simple usage pricing</p><h2>Pay for the challenge,<br />not another dashboard.</h2></div><p>No account or subscription is required for the public flow. Paid requests use USDT0 on X Layer through x402.</p></div>
      <div className="pricing-grid">
        <article><span>Understand</span><div><strong>Free</strong></div><p>File extraction, document detection, claim map, verification routes, and a bounded review preview.</p><a href="/#review">Run a preflight</a></article>
        <article className="featured"><span>Cross-examine</span><div><strong>0.20</strong><small>USDT0 / review</small></div><p>Full model-based adversarial review, eligible official-source checks, signed verdict, export, and share.</p><a href="/#review">Make it survive</a></article>
        <article><span>Protect an action</span><div><strong>0.02</strong><small>USDT0 / check</small></div><p>Transaction Preflight or Agent endpoint check with an action-bound signed result. Supported scopes only.</p><a href="/developers#endpoints">View paid endpoints</a></article>
      </div>
    </section>

    <section className="marketing-section truth-section">
      <div><p className="overline">The promise is bounded</p><h2>CrossExam shows what survived.<br />It does not pretend uncertainty disappeared.</h2></div>
      <div className="truth-points"><p><span>Verified</span> means a named source or deterministic tool supports the exact stated fact.</p><p><span>Unresolved</span> means the available material cannot establish a material premise.</p><p><span>Signed</span> means the record is attributable to CrossExam—not that every claim is true.</p><p><span>Review</span> is an adversarial evidence layer, not a substitute for licensed legal, financial, or security advice.</p></div>
    </section>

    <section className="marketing-cta">
      <p className="overline">The cost of being wrong is usually larger</p>
      <h2>Put the decision on the stand.</h2>
      <a href="/#review">Make it survive <span>↗</span></a>
    </section>
  </div>
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }
  return <div className="code-block">
    <div><span>{label}</span><button type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button></div>
    <pre><code>{code}</code></pre>
  </div>
}

function DeveloperPage() {
  useEffect(() => {
    document.title = 'CrossExam Developers — API, x402 and signed verdicts'
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]')
    if (description) description.content = 'Integrate CrossExam adversarial review, x402 payment, signed assurance records, and fail-closed action verification.'
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
    if (canonical) canonical.href = `${productUrl}/developers`
  }, [])

  const preflightCurl = `curl -X POST ${apiUrl}/api/v1/reviews/preflight \\
  -H 'Content-Type: application/json' \\
  -d '{
    "profile": "PLAN",
    "text": "We should ship this migration on Friday because rollback is straightforward and demand is proven."
  }'`
  const paidFetch = `const response = await fetch("${apiUrl}/api/v1/reviews", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Idempotency-Key": crypto.randomUUID(),
  },
  body: JSON.stringify({ profile: "PLAN", text: proposal }),
})

// Unpaid requests return 402 + PAYMENT-REQUIRED.
// Your x402 client signs, pays on X Layer, and retries this request.
if (response.status === 402) handleX402Challenge(response)
const { analysis, record } = await response.json()`
  const verifyCurl = `curl -X POST ${apiUrl}/api/v1/assurance/verify \\
  -H 'Content-Type: application/json' \\
  -d '{
    "record": { "...": "complete signed record" },
    "expectedServiceSigner": "0x independently-pinned signer",
    "intent": { "...": "exact action intent" }
  }'`

  return <div className="docs-page">
    <SiteHeader />
    <main className="docs-layout">
      <aside className="docs-sidebar" aria-label="Developer documentation">
        <p>Documentation</p>
        <a href="#quickstart">Quickstart</a>
        <a href="#endpoints">Endpoints</a>
        <a href="#payments">x402 payment</a>
        <a href="#verification">Verification</a>
        <a href="#security">Security & privacy</a>
        <span />
        <a href={`${apiUrl}/.well-known/crossexam.json`}>Service manifest ↗</a>
        <a href={`${githubUrl}/blob/main/docs/API.md`}>Full API contract ↗</a>
        <a href={githubUrl}>GitHub ↗</a>
      </aside>

      <div className="docs-content">
        <section className="docs-hero">
          <p className="overline">CrossExam for agents</p>
          <h1>Before your agent acts,<br /><em>make it survive.</em></h1>
          <p>CrossExam is a paid decision-assurance API. It decomposes consequential inputs, attacks material premises, preserves evidence boundaries, and returns signed verdicts an agent can verify before execution.</p>
          <div className="docs-hero-actions"><a className="primary" href="#quickstart">Run the quickstart</a><a href={`${apiUrl}/.well-known/crossexam.json`}>Open manifest</a></div>
          <div className="api-origin"><span>Production API</span><code>{apiUrl}</code><b>Production</b></div>
        </section>

        <section className="docs-section" id="quickstart">
          <div className="docs-section-heading"><span>01</span><div><p className="overline">Quickstart</p><h2>Map a decision for free.</h2></div></div>
          <p>Start with the free preflight. It infers the review profile, extracts material claims, and tells you what can be checked—without creating a record or charging a wallet.</p>
          <CodeBlock label="Shell" code={preflightCurl} />
          <div className="response-preview"><span>Returns</span><code>profile</code><code>claims[]</code><code>verificationRoute</code><code>limitations[]</code><code>paidReview</code></div>
          <h3>Run the full paid review</h3>
          <p>Send the same material to the paid route. The first call returns the standard x402 challenge. An x402-capable client authorizes the quoted USDT0 amount on X Layer and retries the identical request.</p>
          <CodeBlock label="JavaScript · payment handoff" code={paidFetch} />
          <div className="callout"><strong>Never send a private key to CrossExam.</strong><p>The buyer signs through its own wallet or agent payment client. CrossExam receives the x402 payment proof, not the buyer's signing key.</p></div>
        </section>

        <section className="docs-section" id="endpoints">
          <div className="docs-section-heading"><span>02</span><div><p className="overline">Endpoint reference</p><h2>Use the narrowest service that fits.</h2></div></div>
          <p>CrossExam refuses known-unsupported paid scopes before payment. Use Universal Review for documents and reasoning; use Transaction Preflight only for its explicitly supported exact X Layer trade scope.</p>
          <div className="endpoint-table" role="table" aria-label="CrossExam endpoints">
            <div className="endpoint-row heading" role="row"><span>Method & path</span><span>Purpose</span><span>Price</span></div>
            <div className="endpoint-row" role="row"><code><b>POST</b> /api/v1/reviews/preflight</code><span>Claim map and review preview</span><strong>Free</strong></div>
            <div className="endpoint-row" role="row"><code><b>POST</b> /api/v1/reviews</code><span>Universal adversarial review</span><strong>0.20 USDT0</strong></div>
            <div className="endpoint-row" role="row"><code><b>POST</b> /api/v1/preflight/transaction</code><span>Exact supported X Layer trade preflight</span><strong>0.02 USDT0</strong></div>
            <div className="endpoint-row" role="row"><code><b>POST</b> /api/v1/preflight/asp</code><span>Passive ASP endpoint purchase check</span><strong>0.02 USDT0</strong></div>
            <div className="endpoint-row" role="row"><code><b>POST</b> /api/v1/assurance/verify</code><span>Signature, binding, freshness, and gate</span><strong>Free</strong></div>
            <div className="endpoint-row" role="row"><code><b>GET · POST</b> /api/v1/assurance/aggregate</code><span>Registered A2MCP assurance service</span><strong>0.02 USDT0</strong></div>
          </div>
          <p className="docs-detail">Every paid POST should carry a stable <code>Idempotency-Key</code> of 32–200 URL-safe characters. Reuse it only for an exact retry. A completed replay returns the persisted result without a second purchase; the same key with changed input is rejected.</p>
        </section>

        <section className="docs-section" id="payments">
          <div className="docs-section-heading"><span>03</span><div><p className="overline">x402 payment</p><h2>Payment is the authorization layer.</h2></div></div>
          <div className="payment-flow">
            <article><span>1</span><div><h3>Request</h3><p>Call a paid endpoint without a payment signature.</p></div><code>HTTP 402</code></article>
            <article><span>2</span><div><h3>Authorize</h3><p>Read <code>PAYMENT-REQUIRED</code>, verify asset, chain, amount, and recipient, then sign locally.</p></div><code>eip155:196</code></article>
            <article><span>3</span><div><h3>Retry</h3><p>Repeat the identical request with the signed x402 payment header.</p></div><code>exact</code></article>
            <article><span>4</span><div><h3>Receive</h3><p>Get the analysis and service-attested record only after settlement verification.</p></div><code>signed record</code></article>
          </div>
          <div className="callout warning"><strong>Inspect every challenge before signing.</strong><p>The current production rail is USDT0 on X Layer (<code>eip155:196</code>). A client should reject any unexpected network, asset, amount, or recipient.</p></div>
        </section>

        <section className="docs-section" id="verification">
          <div className="docs-section-heading"><span>04</span><div><p className="overline">Verification</p><h2>Trust the record only after you verify it.</h2></div></div>
          <p>Verification is free and stateless. Pin the expected CrossExam service signer independently, provide the complete signed record, and bind it to the exact intended action. Never use the signer declared by an untrusted record as its own trust anchor.</p>
          <CodeBlock label="Shell · free verifier" code={verifyCurl} />
          <div className="verify-grid"><article><span>01</span><h3>Service signature</h3><p>EIP-191 attestation matches the complete canonical record.</p></article><article><span>02</span><h3>Exact action</h3><p>Target, parameters, chain, and value-at-risk match what was reviewed.</p></article><article><span>03</span><h3>Execution gate</h3><p>Contradictions, unresolved material premises, and stale evidence fail closed.</p></article></div>
        </section>

        <section className="docs-section" id="security">
          <div className="docs-section-heading"><span>05</span><div><p className="overline">Security & privacy</p><h2>Know the boundary before integrating.</h2></div></div>
          <div className="security-list">
            <article><h3>Input handling</h3><p>Free file preflight extracts supported files in memory and does not persist the original upload. A paid universal review sends submitted material to DeepSeek; bounded eligible citation text can be sent to Tavily when source search is enabled.</p></article>
            <article><h3>Evidence semantics</h3><p>A located source supports only the exact status stated in the result. Missing, stale, ambiguous, or inapplicable evidence remains unresolved and cannot become a favorable signal.</p></article>
            <article><h3>Private records</h3><p>Paid records are private by default and accessed through time-limited bearer capabilities. Public share links expose a sanitized allowlist, never raw action parameters, payments, wallet addresses, or access tokens.</p></article>
            <article><h3>Scope limits</h3><p>CrossExam is an adversarial assurance layer—not legal advice, investment advice, or a comprehensive smart-contract audit. Read each endpoint's explicit coverage before paying.</p></article>
          </div>
          <div className="docs-links"><a href={`${githubUrl}/blob/main/docs/API.md`}>Read the complete API contract ↗</a><a href={`${githubUrl}/blob/main/docs/DEPLOYMENT.md`}>Deployment and operations ↗</a><a href={`${apiUrl}/.well-known/crossexam.json`}>Machine-readable discovery ↗</a></div>
        </section>
      </div>
    </main>
    <SiteFooter />
  </div>
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
    <SiteHeader stage={stage} onReset={reset} />

    {stage === 'INPUT' && <main className="landing-main">
      <section className="input-screen" id="review">
        <section className="intro-copy">
          <p className="overline">Adversarial review before commitment</p>
          <h1>Before you act,<br /><em>make it survive.</em></h1>
          <p>Put a decision, document, thesis, or plan on the stand. CrossExam finds the strongest case against it—and shows what the evidence can actually prove.</p>
          <div className="hero-proof"><span><b>Free</b> preflight</span><span><b>0.20 USDT0</b> full review</span><span><b>No account</b> required</span></div>
        </section>

        <section className="intake-card" aria-label="Start a CrossExam review">
          <div className="intake-label"><span>New review</span><b>Free preflight</b></div>
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
      </section>
      <MarketingSections selectProfile={(nextProfile) => { setProfile(nextProfile); setPreflight(null) }} />
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

    {stage === 'INPUT' ? <SiteFooter /> : <footer className="product-footer"><span>CrossExam</span><span>Evidence, not confidence.</span></footer>}
  </div>
}
