import { x402Client } from '@okxweb3/x402-core/client'
import { x402HTTPClient } from '@okxweb3/x402-core/http'
import type { PaymentRequired, PaymentRequirements } from '@okxweb3/x402-core/types'
import { ExactEvmScheme, toClientEvmSigner } from '@okxweb3/x402-evm'
import { privateKeyToAccount } from 'viem/accounts'
import { keccak256, stringToHex, type Hex } from 'viem'
import type { ExternalReviewProvider } from './reviewJobWorker'
import type { ReviewerRegistry } from './reviewerRegistry'
import { evidenceArtifactHash } from './evidenceIntegrity'
import type { RegisteredReviewer } from './reviewerRegistry'

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export type X402ReviewProviderOptions = {
  registry: ReviewerRegistry
  signingKey: Hex
  maxPerScopeAtomic: bigint
  allowedAssets: string[]
  callbackBaseUrl: string
  fetchImpl?: FetchLike
}

function allowedRequirement(requirement: PaymentRequirements, options: X402ReviewProviderOptions) {
  return requirement.scheme === 'exact'
    && requirement.network === 'eip155:196'
    && /^0x[a-fA-F0-9]{40}$/.test(requirement.payTo)
    && options.allowedAssets.includes(requirement.asset.toLowerCase())
    && /^[1-9][0-9]*$/.test(requirement.amount)
    && BigInt(requirement.amount) <= options.maxPerScopeAtomic
}

function selectAllowedRequirements(payment: PaymentRequired, options: X402ReviewProviderOptions, reviewer: RegisteredReviewer) {
  const allowed = payment.accepts.filter((requirement) => allowedRequirement(requirement, options))
  if (!allowed.length) {
    throw new Error('External reviewer payment requirements violate the X Layer procurement spend policy.')
  }
  if (reviewer.procurementProtocol !== 'PAID_EVIDENCE_V1') return allowed
  const recipient = reviewer.paymentRecipient?.toLowerCase()
  const bound = recipient ? allowed.filter((requirement) => requirement.payTo.toLowerCase() === recipient) : []
  if (!bound.length) {
    throw new Error('Paid evidence source payment recipient does not match its server-owned registry binding.')
  }
  return bound
}

function callbackUrl(baseUrl: string, jobId: string, scopeId: string) {
  const normalized = baseUrl.replace(/\/$/, '')
  if (!/^https:\/\/.+/.test(normalized)) throw new Error('Procurement callbacks require a public HTTPS CROSSEXAM_PUBLIC_URL.')
  return `${normalized}/api/v1/review-jobs/${encodeURIComponent(jobId)}/deliveries/${encodeURIComponent(scopeId)}`
}

function boundedResponse(text: string) {
  if (!text.trim()) throw new Error('Paid evidence source returned an empty response.')
  if (Buffer.byteLength(text, 'utf8') > 65_536) throw new Error('Paid evidence source response exceeds the 64 KiB retention limit.')
  try {
    JSON.parse(text)
  } catch {
    throw new Error('Paid evidence source must return a JSON response for the OPAQUE_JSON_V1 adapter.')
  }
  return text
}

type EvidenceRequest = { url: string; method: 'GET' | 'POST'; body?: string }

function evidenceRequest(reviewer: RegisteredReviewer, input: Parameters<ExternalReviewProvider['requestReview']>[0]): EvidenceRequest {
  if (reviewer.responseAdapter === 'OPAQUE_JSON_V1') {
    return { url: reviewer.procurementEndpoint!, method: 'POST', body: JSON.stringify(reviewer.evidenceRequestBody ?? {}) }
  }
  if (reviewer.responseAdapter === 'CERTIK_TOKEN_SCAN_V1') {
    const target = input.task.reviewEvidenceContext?.tokenRiskTarget ?? input.task.actionBinding?.target ?? ''
    const matched = /^(?:token|contract):([a-z0-9_-]+):(0x[a-fA-F0-9]{40})$/.exec(target)
    if (!matched) throw new Error('CertiK Token Scan requires actionBinding.target formatted as token:<chain>:0x<contract-address>.')
    const url = new URL(reviewer.procurementEndpoint!)
    url.searchParams.set('chain', matched[1])
    url.searchParams.set('address', matched[2])
    return { url: url.toString(), method: 'GET' }
  }
  throw new Error('External evidence source has no approved response adapter.')
}

function certikFindings(input: Parameters<ExternalReviewProvider['requestReview']>[0], reviewer: RegisteredReviewer, response: Record<string, unknown>, artifactId: string) {
  const summary = response.summary && typeof response.summary === 'object' ? response.summary as Record<string, unknown> : {}
  const score = typeof summary.score === 'number' ? summary.score : Number(summary.score)
  const alertCount = typeof summary.alert_count === 'number' ? summary.alert_count : Number(summary.alert_count)
  const alertLevel = typeof summary.highest_alert_level === 'string' ? summary.highest_alert_level.toUpperCase() : ''
  const contradiction = alertLevel === 'CRITICAL' || alertLevel === 'MAJOR' || (Number.isFinite(score) && score < 50)
  const support = !contradiction && Number.isFinite(score) && score >= 70 && Number.isFinite(alertCount) && alertCount === 0
  const verdict = contradiction ? 'CONTRADICTS' as const : support ? 'SUPPORTS' as const : 'INSUFFICIENT_EVIDENCE' as const
  const explanation = Number.isFinite(score)
    ? `CertiK Token Scan reported score ${score}${Number.isFinite(alertCount) ? `, ${alertCount} alert(s)` : ''}${alertLevel ? `, highest alert ${alertLevel}` : ''}.`
    : 'CertiK Token Scan returned no normalized score, so the source cannot resolve this claim.'
  return input.task.claims.map((claim) => ({
    claimId: claim.id,
    reviewerId: reviewer.id,
    verdict,
    confidence: contradiction ? 0.9 : support ? 0.75 : 1,
    materiality: claim.materiality,
    evidence: explanation,
    evidenceArtifactIds: [artifactId],
  }))
}

/**
 * Real buyer-side x402 adapter. It first asks the external ASP for a job,
 * then signs only an `exact` X Layer requirement that passes the configured
 * asset allowlist and atomic per-scope cap. It never falls back to an unpaid
 * request, broadens the price cap, or follows redirects to an unreviewed URL.
 */
export class X402ReviewProvider implements ExternalReviewProvider {
  private readonly options: X402ReviewProviderOptions
  private readonly http: x402HTTPClient
  private readonly fetchImpl: FetchLike

  constructor(options: X402ReviewProviderOptions) {
    if (options.maxPerScopeAtomic <= 0n || !options.allowedAssets.length) throw new Error('X402 procurement requires an explicit positive spend policy.')
    this.options = { ...options, allowedAssets: options.allowedAssets.map((asset) => asset.toLowerCase()) }
    const account = privateKeyToAccount(options.signingKey)
    const core = x402Client.fromConfig({
      schemes: [{ network: 'eip155:196', client: new ExactEvmScheme(toClientEvmSigner(account)) }],
      policies: [(_version, requirements) => requirements.filter((requirement) => allowedRequirement(requirement, this.options))],
    })
    this.http = new x402HTTPClient(core)
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async requestReview(input: Parameters<ExternalReviewProvider['requestReview']>[0]): Promise<Awaited<ReturnType<ExternalReviewProvider['requestReview']>>>
  {
    const reviewer = this.options.registry[input.reviewerId]
    if (!reviewer?.procurementEndpoint || !/^https:\/\/.+/.test(reviewer.procurementEndpoint)
      || (reviewer.procurementProtocol !== 'CROSSEXAM_SIGNED_CALLBACK_V1' && reviewer.procurementProtocol !== 'PAID_EVIDENCE_V1')) {
      throw new Error('Matched source has no approved external procurement endpoint.')
    }
    const externalRequest = reviewer.procurementProtocol === 'PAID_EVIDENCE_V1'
      ? evidenceRequest(reviewer, input)
      : JSON.stringify({
        schemaVersion: '0.1',
        jobId: input.jobId,
        scopeId: input.scopeId,
        task: input.task,
        callback: { url: callbackUrl(this.options.callbackBaseUrl, input.jobId, input.scopeId), attestation: 'EIP191 delivery required' },
      })
    const request = typeof externalRequest === 'string'
      ? { url: reviewer.procurementEndpoint, method: 'POST' as const, body: externalRequest }
      : externalRequest
    const headers = { ...(request.body ? { 'content-type': 'application/json' } : {}), 'idempotency-key': input.idempotencyKey }
    const initial = await this.fetchImpl(request.url, { method: request.method, headers, ...(request.body ? { body: request.body } : {}), redirect: 'error' })
    if (initial.status !== 402) {
      throw new Error(`External reviewer must return x402 Payment Required before accepting work (received ${initial.status}).`)
    }
    const required = this.http.getPaymentRequiredResponse((name) => initial.headers.get(name))
    const allowed = selectAllowedRequirements(required, this.options, reviewer)
    const payment = await this.http.createPaymentPayload({ ...required, accepts: allowed })
    const paid = await this.fetchImpl(request.url, {
      method: request.method,
      headers: { ...headers, ...this.http.encodePaymentSignatureHeader(payment) },
      ...(request.body ? { body: request.body } : {}),
      redirect: 'error',
    })
    if (!paid.ok) throw new Error(`External reviewer rejected the paid procurement request (${paid.status}).`)
    const settlement = this.http.getPaymentSettleResponse((name) => paid.headers.get(name))
    if (!settlement.success || settlement.network !== 'eip155:196' || !settlement.transaction?.trim()) {
      throw new Error('External reviewer response lacks a successful X Layer payment settlement confirmation.')
    }
    const accepted = payment.accepted
    const amountAtomic = settlement.amount ?? accepted.amount
    if (!/^[1-9][0-9]*$/.test(amountAtomic) || BigInt(amountAtomic) > this.options.maxPerScopeAtomic) {
      throw new Error('Settlement amount violates the approved procurement spend policy.')
    }
    const recordedPayment = {
        network: 'eip155:196',
        asset: accepted.asset.toLowerCase(),
        amountAtomic,
        transaction: settlement.transaction,
    } as const
    if (reviewer.procurementProtocol === 'PAID_EVIDENCE_V1') {
      const responseBody = boundedResponse(await paid.text())
      const observedAt = new Date().toISOString()
      const requestHash = keccak256(stringToHex(JSON.stringify({ method: request.method, url: request.url, ...(request.body ? { body: request.body } : {}) })))
      const responseHash = keccak256(stringToHex(responseBody))
      const artifact = {
        id: `paid-response-${input.scopeId}`,
        kind: 'TOOL_OUTPUT' as const,
        locator: request.url,
        observedAt,
        excerpt: responseBody,
      }
      const delivery = {
        reviewerId: reviewer.id,
        deliveredAt: observedAt,
        artifacts: [{ ...artifact, contentHash: evidenceArtifactHash(artifact) }],
        findings: reviewer.responseAdapter === 'CERTIK_TOKEN_SCAN_V1'
          ? certikFindings(input, reviewer, JSON.parse(responseBody) as Record<string, unknown>, artifact.id)
          : input.task.claims.map((claim) => ({
            claimId: claim.id,
            reviewerId: reviewer.id,
            verdict: 'INSUFFICIENT_EVIDENCE' as const,
            confidence: 1,
            materiality: claim.materiality,
            evidence: `CrossExam retained the paid ${reviewer.displayName} response, but its OPAQUE_JSON_V1 adapter does not infer a provider verdict. The action remains unresolved until a source-specific deterministic adapter or signed reviewer delivery is available.`,
            evidenceArtifactIds: [artifact.id],
          })),
        provenance: {
          kind: 'X402_PAID_EVIDENCE_V1' as const,
          sourceId: reviewer.id,
          endpoint: reviewer.procurementEndpoint,
          observedAt,
          requestHash,
          responseHash,
          payment: recordedPayment,
        },
      }
      return {
        externalRequestId: `evidence-${responseHash.slice(2, 18)}`,
        payment: recordedPayment,
        evidence: { delivery, provenance: delivery.provenance, responseBody },
      }
    }
    const response = await paid.json() as { requestId?: unknown }
    if (typeof response.requestId !== 'string' || !response.requestId.trim()) {
      throw new Error('External reviewer accepted payment without returning a stable requestId.')
    }
    return { externalRequestId: response.requestId, payment: recordedPayment }
  }
}
