import type { ReviewPlan } from '../domain/reviewPlan'
import type { DecisionPackage } from '../domain/types'
import type { ReviewDispatch } from '../network/reviewNetwork'
import type { RemoteDecisionAssuranceRecord } from './crossExamClient'

export type ReviewJobStatus = 'AWAITING_MATCH' | 'AWAITING_DELIVERIES' | 'READY_FOR_ASSURANCE' | 'CANCELLED'
export type ReviewJobFundingStatus = 'UNFUNDED' | 'AUTHORIZED'

export type ReviewJobView = {
  id: string
  revision: number
  status: ReviewJobStatus
  fundingStatus: ReviewJobFundingStatus
  decision: DecisionPackage
  plan: ReviewPlan
  dispatch: ReviewDispatch
  procurements: Array<{ scopeId: string; status: 'UNSENT' | 'DISPATCHING' | 'REQUESTED' | 'FAILED'; externalRequestId?: string; failure?: string }>
  events: Array<{ id: string; occurredAt: string; type: string; scopeId?: string; detail: string }>
  createdAt: string
  updatedAt: string
}

export type ProcurementLedgerView = {
  jobId: string
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
