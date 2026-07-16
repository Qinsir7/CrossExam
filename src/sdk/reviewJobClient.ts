import type { ReviewPlan } from '../domain/reviewPlan'
import type { DecisionPackage } from '../domain/types'
import type { ReviewDispatch } from '../network/reviewNetwork'
import type { RemoteDecisionAssuranceRecord } from './crossExamClient'
import { fetchWithBrowserX402, type BrowserPaymentPreview } from './browserX402'

export type ReviewJobStatus = 'AWAITING_MATCH' | 'AWAITING_DELIVERIES' | 'READY_FOR_ASSURANCE' | 'FAILED' | 'CANCELLED'
export type ReviewJobFundingStatus = 'UNFUNDED' | 'AUTHORIZED'

export type ReviewJobView = {
  id: string
  revision: number
  status: ReviewJobStatus
  fundingStatus: ReviewJobFundingStatus
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
  procurements: Array<{ scopeId: string; status: 'UNSENT' | 'DISPATCHING' | 'REQUESTED' | 'FAILED' | 'EXHAUSTED'; externalRequestId?: string; failure?: string }>
  events: Array<{ id: string; occurredAt: string; type: string; scopeId?: string; detail: string }>
  createdAt: string
  updatedAt: string
}

export type ProcurementLedgerView = {
  jobId: string
  commercial: {
    customerAuthorization: 'UNFUNDED' | 'AUTHORIZED'
    customerSettlement?: { network: 'eip155:196'; asset: string; amountAtomic: string; transaction: string }
    quote: ReviewJobView['quote']
    grossMarginStatus: 'ESTIMATED_ONLY' | 'AWAITING_REVIEWER_SETTLEMENTS' | 'REALIZED_SAME_ASSET'
    realizedGrossMargin?: { asset: string; amountAtomic: string }
  }
  estimatedTotalUsdt: number
  scopes: Array<{ scopeId: string; title: string; estimatedFeeUsdt: number; procurementStatus: string; externalRequestId?: string; settlement?: { network: 'eip155:196'; asset: string; amountAtomic: string; transaction: string } }>
  settledByAsset: Array<{ asset: string; amountAtomic: string; payments: number }>
  outstandingScopeIds: string[]
}

export type ReviewJobResult = RemoteDecisionAssuranceRecord & {
  persistence: 'CREATED' | 'EXISTING'
  readAccess: { token: string; expiresAt: string }
}

type CreatedReviewJob = ReviewJobView & { accessToken: string }

export class ReviewJobClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = (options.baseUrl ?? import.meta.env.VITE_CROSSEXAM_API_URL ?? '').replace(/\/$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async create(decision: DecisionPackage): Promise<CreatedReviewJob> {
    return this.request('/api/v1/review-jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(decision) }) as Promise<CreatedReviewJob>
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

  /**
   * Agent callers provide an x402-capable fetch implementation (or a browser
   * wallet adapter). CrossExam never receives the caller's private key.
   */
  async authorize(jobId: string, accessToken: string, paymentFetch: typeof fetch = this.fetchImpl): Promise<ReviewJobView> {
    const response = await paymentFetch(`${this.baseUrl}/api/v1/review-jobs/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, accessToken }),
    })
    const body = await response.json().catch(() => null) as { message?: unknown } | null
    if (!response.ok) throw new Error(typeof body?.message === 'string' ? body.message : `CrossExam authorization requires a completed x402 payment (${response.status}).`)
    return body as ReviewJobView
  }

  /** Browser-wallet path: show a challenge summary, then sign the x402 exact payment in the wallet. */
  async authorizeWithBrowserWallet(jobId: string, accessToken: string, confirm: (preview: BrowserPaymentPreview) => boolean | Promise<boolean>): Promise<ReviewJobView> {
    return this.authorize(jobId, accessToken, (input, init) => fetchWithBrowserX402(input, init ?? {}, confirm))
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init)
    } catch {
      throw new Error('CrossExam service is unreachable. Configure VITE_CROSSEXAM_API_URL or use the deployed app origin.')
    }
    const body = await response.json().catch(() => null) as { message?: unknown } | null
    if (!response.ok) throw new Error(typeof body?.message === 'string' ? body.message : `CrossExam service rejected the request (${response.status}).`)
    return body
  }
}
