import type { ReviewPlan } from '../domain/reviewPlan'
import type { DecisionPackage } from '../domain/types'
import type { ReviewDispatch } from '../network/reviewNetwork'
import type { CrossExaminationPreparationRequest, CrossExaminationPreparationResponse, CrossExaminationResponse, DocumentExtractionResponse, GenericReviewPreflightRequest, GenericReviewPreflightResponse, TransactionQuoteRequest, TransactionQuoteResponse, VerifyAssuranceRecordRequest, VerifyAssuranceRecordResponse } from '../domain/assuranceContracts'
import type { RemoteDecisionAssuranceRecord } from './crossExamClient'
import { fetchWithBrowserX402, signReviewAccessRecovery, type BrowserPaymentPreview } from './browserX402'

export type ReviewJobStatus = 'AWAITING_MATCH' | 'AWAITING_DELIVERIES' | 'READY_FOR_ASSURANCE' | 'FAILED' | 'CANCELLED' | 'EXPIRED'
export type ReviewJobFundingStatus = 'UNFUNDED' | 'AUTHORIZED'

export type ReviewJobView = {
  id: string
  revision: number
  status: ReviewJobStatus
  fundingStatus: ReviewJobFundingStatus
  customerPayment?: { network: 'eip155:196'; asset: string; amountAtomic: string; transaction: string; payer?: `0x${string}` }
  decision: DecisionPackage
  plan: ReviewPlan
  quote: {
    currency: 'USDT'
    authorizationPriceUsdt: number
    estimatedExternalCostUsdt: number
    minimumGrossMarginFraction: number
    minimumAuthorizationPriceUsdt: number
    estimatedGrossMarginUsdt: number
    estimatedGrossMarginFraction: number
    economicallyAuthorized: boolean
  }
  dispatch: ReviewDispatch
  procurements: Array<{
    scopeId: string
    status: 'UNSENT' | 'DISPATCHING' | 'REQUESTED' | 'FAILED' | 'EXHAUSTED'
    externalRequestId?: string
    failure?: string
    payment?: { network: 'eip155:196'; asset: string; amountAtomic: string; transaction: string }
    includedQuota?: { sourceId: string; authentication: 'OKX_HMAC_SHA256' | 'PUBLIC_HTTPS' }
    evidence?: { observedAt: string; requestHash: `0x${string}`; responseHash: `0x${string}`; responseBody: string }
  }>
  events: Array<{ id: string; occurredAt: string; type: string; scopeId?: string; detail: string }>
  createdAt: string
  updatedAt: string
}

export type ProcurementLedgerView = {
  jobId: string
  commercial: {
    customerAuthorization: 'UNFUNDED' | 'AUTHORIZED'
    customerSettlement?: { network: 'eip155:196'; asset: string; amountAtomic: string; transaction: string; payer?: `0x${string}` }
    quote: ReviewJobView['quote']
    grossMarginStatus: 'ESTIMATED_ONLY' | 'AWAITING_REVIEWER_SETTLEMENTS' | 'REALIZED_SAME_ASSET'
    realizedGrossMargin?: { asset: string; amountAtomic: string }
  }
  estimatedTotalUsdt: number
  scopes: Array<{
    scopeId: string
    title: string
    estimatedFeeUsdt: number
    procurementStatus: string
    externalRequestId?: string
    settlement?: { network: 'eip155:196'; asset: string; amountAtomic: string; transaction: string }
    costBasis?: 'SETTLED_X402' | 'INCLUDED_API_QUOTA'
  }>
  settledByAsset: Array<{ asset: string; amountAtomic: string; payments: number }>
  outstandingScopeIds: string[]
}

export type ReviewJobResult = RemoteDecisionAssuranceRecord & {
  persistence: 'CREATED' | 'EXISTING'
  readAccess: { token: string; expiresAt: string }
}

export type CreatedReviewJob = ReviewJobView & { accessToken: string }

function settlementTransaction(response: Response) {
  const encoded = response.headers.get('payment-response')
  if (!encoded) return undefined
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const decoded = JSON.parse(globalThis.atob(padded)) as { transaction?: unknown }
    return typeof decoded.transaction === 'string' && /^0x[0-9a-fA-F]{64}$/.test(decoded.transaction)
      ? decoded.transaction
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The public product is intentionally split between www.cross-exam.xyz and
 * api.cross-exam.xyz. Keep a deploy-safe fallback so a missing Vercel build
 * variable cannot make the browser accidentally call its own static origin.
 */
export function resolveCrossExamApiUrl(configuredUrl?: string, browserOrigin?: string) {
  if (browserOrigin) {
    try {
      const origin = new URL(browserOrigin)
      const host = origin.hostname.toLowerCase()
      // The public web app reaches the API through Vercel's same-origin
      // rewrite. This eliminates browser CORS/extension interference while
      // Vercel forwards the request to the canonical API over HTTPS.
      if (host === 'cross-exam.xyz' || host === 'www.cross-exam.xyz' || host.endsWith('.vercel.app')) return `${origin.origin}/review-service`
    } catch {
      // A configured URL below can still support unusual local environments.
    }
  }
  const configured = configuredUrl?.trim().replace(/\/$/, '')
  if (configured) return configured
  if (!browserOrigin) return ''
  try {
    const origin = new URL(browserOrigin)
    return origin.origin
  } catch {
    return ''
  }
}

export class ReviewJobClient {
  private readonly baseUrl: string
  private readonly usesPublicProxy: boolean
  private readonly fetchImpl: typeof fetch

  constructor(options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = resolveCrossExamApiUrl(
      options.baseUrl ?? import.meta.env.VITE_CROSSEXAM_API_URL,
      typeof window === 'undefined' ? undefined : window.location.origin,
    )
    this.usesPublicProxy = this.baseUrl.endsWith('/review-service')
    // Never store the browser's native fetch as an unbound method. Calling a
    // detached Window.fetch through `this.fetchImpl(...)` gives it the client
    // instance as `this` and Chromium rejects it with "Illegal invocation".
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  private endpoint(path: string) {
    return `${this.baseUrl}${this.usesPublicProxy ? path.replace(/^\/api/, '') : path}`
  }

  async create(decision: DecisionPackage): Promise<CreatedReviewJob> {
    return this.request('/api/v1/review-jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(decision) }) as Promise<CreatedReviewJob>
  }

  /** Compile a review without creating a job, charging x402, or spending a provider budget. */
  async prepareCrossExamination(input: CrossExaminationPreparationRequest): Promise<CrossExaminationPreparationResponse> {
    return this.request('/api/v1/cross-examinations/prepare', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    }) as Promise<CrossExaminationPreparationResponse>
  }

  /** Construct an exact X Layer swap transaction from an authenticated OKX DEX quote. No wallet approval, signature, or broadcast occurs. */
  async quoteTransaction(input: TransactionQuoteRequest): Promise<TransactionQuoteResponse> {
    return this.request('/api/v1/transactions/quote', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    }) as Promise<TransactionQuoteResponse>
  }

  /** Read a bounded local document on the server without storing the original upload. */
  async extractFile(file: File): Promise<DocumentExtractionResponse> {
    const contentType = file.type || (file.name.toLowerCase().endsWith('.md') ? 'text/markdown' : 'application/octet-stream')
    return this.request(`/api/v1/intake/files?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'content-type': contentType }, body: file,
    }) as Promise<DocumentExtractionResponse>
  }

  /** Decompose material into candidate claims without charging or issuing a verdict. */
  async preflightReview(input: GenericReviewPreflightRequest): Promise<GenericReviewPreflightResponse> {
    return this.request('/api/v1/reviews/preflight', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    }) as Promise<GenericReviewPreflightResponse>
  }

  /** Start a fulfillable durable review; authorization remains an explicit x402 step. */
  async startCrossExamination(input: CrossExaminationPreparationRequest): Promise<CrossExaminationResponse> {
    return this.request('/api/v1/cross-examinations', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    }) as Promise<CrossExaminationResponse>
  }

  /** Stateless verification against a caller-pinned service issuer and exact intended action. */
  async verifyAssuranceRecord(input: VerifyAssuranceRecordRequest): Promise<VerifyAssuranceRecordResponse> {
    return this.request('/api/v1/assurance/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    }) as Promise<VerifyAssuranceRecordResponse>
  }

  async recoverWithBrowserWallet(transaction: string): Promise<CreatedReviewJob> {
    const proof = await signReviewAccessRecovery(transaction)
    return this.request('/api/v1/review-jobs/recover-access', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proof),
    }) as Promise<CreatedReviewJob>
  }

  async get(jobId: string, accessToken: string): Promise<ReviewJobView> {
    return this.request(`/api/v1/review-jobs/${encodeURIComponent(jobId)}`, { headers: { authorization: `Bearer ${accessToken}` } }) as Promise<ReviewJobView>
  }

  async getLedger(jobId: string, accessToken: string): Promise<ProcurementLedgerView> {
    return this.request(`/api/v1/review-jobs/${encodeURIComponent(jobId)}/ledger`, { headers: { authorization: `Bearer ${accessToken}` } }) as Promise<ProcurementLedgerView>
  }

  async getResult(jobId: string, accessToken: string): Promise<ReviewJobResult> {
    return this.request(`/api/v1/review-jobs/${encodeURIComponent(jobId)}/result`, { headers: { authorization: `Bearer ${accessToken}` } }) as Promise<ReviewJobResult>
  }

  async createPublicShare(recordId: string, readAccessToken: string): Promise<{ token: string; url: string }> {
    return this.request(`/api/v1/assurance/records/${encodeURIComponent(recordId)}/share`, {
      method: 'POST', headers: { authorization: `Bearer ${readAccessToken}` },
    }) as Promise<{ token: string; url: string }>
  }

  async retry(jobId: string, accessToken: string): Promise<ReviewJobView> {
    return this.request(`/api/v1/review-jobs/${encodeURIComponent(jobId)}/retry`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    }) as Promise<ReviewJobView>
  }

  /**
   * Agent callers provide an x402-capable fetch implementation (or a browser
   * wallet adapter). CrossExam never receives the caller's private key.
   */
  async authorize(jobId: string, accessToken: string, paymentFetch: typeof fetch = this.fetchImpl): Promise<ReviewJobView> {
    const response = await paymentFetch(this.endpoint('/api/v1/review-jobs/authorize'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, accessToken }),
    })
    const body = await response.json().catch(() => null) as { message?: unknown } | null
    const transaction = settlementTransaction(response)
    if (transaction) {
      try {
        return await this.reconcileFunding(jobId, accessToken, transaction)
      } catch (error) {
        // If the paid response itself succeeded, keep polling the owner view;
        // the server-side hook may still be finishing its durable write.
        if (!response.ok) throw error
      }
    }
    if (!response.ok) throw new Error(typeof body?.message === 'string' ? body.message : `CrossExam authorization requires a completed x402 payment (${response.status}).`)
    return body as ReviewJobView
  }

  async reconcileFunding(jobId: string, accessToken: string, transaction: string): Promise<ReviewJobView> {
    return this.request(`/api/v1/review-jobs/${encodeURIComponent(jobId)}/reconcile-funding`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ transaction }),
    }) as Promise<ReviewJobView>
  }

  /** Browser-wallet path: show a challenge summary, then sign the x402 exact payment in the wallet. */
  async authorizeWithBrowserWallet(jobId: string, accessToken: string, confirm: (preview: BrowserPaymentPreview) => boolean | Promise<boolean>): Promise<ReviewJobView> {
    const job = await this.get(jobId, accessToken)
    if (job.fundingStatus !== 'UNFUNDED') throw new Error('This review job is already funded and cannot accept another payment.')
    const expectedAmountAtomic = BigInt(Math.round(job.quote.authorizationPriceUsdt * 1_000_000)).toString()
    return this.authorize(jobId, accessToken, (input, init) => fetchWithBrowserX402(input, init ?? {}, confirm, expectedAmountAtomic))
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint(path), init)
    } catch (error) {
      const cause = error instanceof Error && error.message ? error.message : 'unknown browser network error'
      throw new Error(`CrossExam request did not leave the browser (${cause}). Request: ${this.endpoint(path)}`)
    }
    const body = await response.json().catch(() => null) as { message?: unknown } | null
    if (!response.ok) throw new Error(typeof body?.message === 'string' ? body.message : `CrossExam service rejected the request (${response.status}).`)
    return body
  }
}
