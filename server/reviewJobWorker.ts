import type { ReviewJobStore } from './reviewJobStore'
import type { PaidEvidenceProvenance, ReviewDelivery } from '../src/network/reviewNetwork'
import { blindTaskForProcurement, markProcurementDispatching, markProcurementFailed, markProcurementRequested, recordPaidEvidenceDelivery, type ReviewJob } from './reviewJob'
import type { ReviewerRegistry } from './reviewerRegistry'

export type ExternalReviewProvider = {
  requestReview(input: { jobId: string; scopeId: string; reviewerId: string; idempotencyKey: string; task: ReturnType<typeof blindTaskForProcurement> }): Promise<{
    externalRequestId: string
    payment?: ReviewJob['procurements'][number]['payment']
    evidence?: { delivery: ReviewDelivery; provenance: PaidEvidenceProvenance; responseBody: string }
  }>
}

/**
 * Outgoing procurement is a recoverable worker operation, not a browser
 * promise. The stable per-scope idempotency key is passed to the external ASP
 * so retry after a process crash cannot authorize duplicate work or spend.
 */
export type ReviewJobWorkerOptions = {
  maxAttempts?: number
  retryBaseMs?: number
  dispatchTimeoutMs?: number
  now?: () => Date
  registry?: ReviewerRegistry
}

export class ReviewJobWorker {
  private readonly store: ReviewJobStore
  private readonly provider: ExternalReviewProvider
  private readonly options: Required<ReviewJobWorkerOptions>

  constructor(store: ReviewJobStore, provider: ExternalReviewProvider, options: ReviewJobWorkerOptions = {}) {
    this.store = store
    this.provider = provider
    this.options = {
      maxAttempts: options.maxAttempts ?? 5,
      retryBaseMs: options.retryBaseMs ?? 30_000,
      dispatchTimeoutMs: options.dispatchTimeoutMs ?? 300_000,
      now: options.now ?? (() => new Date()),
      registry: options.registry ?? {},
    }
    if (!Number.isInteger(this.options.maxAttempts) || this.options.maxAttempts < 1) throw new Error('Worker maxAttempts must be a positive integer.')
    if (!Number.isInteger(this.options.retryBaseMs) || this.options.retryBaseMs < 1) throw new Error('Worker retryBaseMs must be positive.')
    if (!Number.isInteger(this.options.dispatchTimeoutMs) || this.options.dispatchTimeoutMs < 1) throw new Error('Worker dispatchTimeoutMs must be positive.')
  }

  private now() {
    return this.options.now().toISOString()
  }

  private retryDelay(attempts: number) {
    return Math.min(this.options.retryBaseMs * 2 ** Math.max(0, attempts - 1), 3_600_000)
  }

  private async recoverStaleDispatch(job: ReviewJob, scopeId: string, now: string) {
    const procurement = job.procurements.find((item) => item.scopeId === scopeId)
    if (!procurement || procurement.status !== 'DISPATCHING' || !procurement.lastAttemptAt) return false
    const elapsed = new Date(now).getTime() - new Date(procurement.lastAttemptAt).getTime()
    if (!Number.isFinite(elapsed) || elapsed < this.options.dispatchTimeoutMs) return false
    const recovered = markProcurementFailed(job, scopeId, 'Dispatch lease expired before the external reviewer acknowledged the request; retrying with the same idempotency key.', {
      now,
      maxAttempts: this.options.maxAttempts,
      retryAfterMs: this.retryDelay(procurement.attempts),
    })
    await this.store.updateJob(recovered, job.revision)
    return true
  }

  async runOnce(): Promise<{ claimed: number; requested: number; failed: number; recovered: number }> {
    let claimed = 0
    let requested = 0
    let failed = 0
    let recovered = 0
    for (const current of await this.store.listActiveJobs()) {
      if (current.fundingStatus !== 'AUTHORIZED') continue
      const runAt = this.now()
      for (const procurement of current.procurements.filter((item) => item.status === 'DISPATCHING')) {
        try {
          if (await this.recoverStaleDispatch(current, procurement.scopeId, runAt)) recovered += 1
        } catch {
          // A concurrent worker may already have recovered the same lease.
        }
      }
      const afterRecovery = await this.store.findJob(current.id)
      if (!afterRecovery || afterRecovery.status !== 'AWAITING_DELIVERIES') continue
      for (const procurement of afterRecovery.procurements.filter((item) => (item.status === 'UNSENT' || item.status === 'FAILED') && (!item.nextAttemptAt || item.nextAttemptAt <= runAt))) {
        const latest = await this.store.findJob(current.id)
        if (!latest || latest.status !== 'AWAITING_DELIVERIES' || latest.fundingStatus !== 'AUTHORIZED') continue
        const assignment = latest.dispatch.assignments.find((item) => item.scopeId === procurement.scopeId)
        if (!assignment?.reviewer) continue
        let claimedJob: ReviewJob
        try {
          claimedJob = markProcurementDispatching(latest, procurement.scopeId, this.now())
          await this.store.updateJob(claimedJob, latest.revision)
          claimed += 1
        } catch {
          continue
        }
        try {
          const response = await this.provider.requestReview({
            jobId: claimedJob.id,
            scopeId: procurement.scopeId,
            reviewerId: assignment.reviewer.id,
            idempotencyKey: claimedJob.procurements.find((item) => item.scopeId === procurement.scopeId)!.idempotencyKey,
            task: blindTaskForProcurement(claimedJob, procurement.scopeId),
          })
          const requestedJob = markProcurementRequested(claimedJob, procurement.scopeId, response.externalRequestId, response.payment)
          await this.store.updateJob(requestedJob, claimedJob.revision)
          requested += 1
          if (response.evidence) {
            const evidenceJob = recordPaidEvidenceDelivery(
              requestedJob,
              procurement.scopeId,
              response.evidence.delivery,
              response.evidence.provenance,
              response.evidence.responseBody,
              this.options.registry,
              this.now(),
            )
            await this.store.updateJob(evidenceJob, requestedJob.revision)
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'External reviewer procurement failed.'
          try {
            const claimed = claimedJob.procurements.find((item) => item.scopeId === procurement.scopeId)!
            const failedJob = markProcurementFailed(claimedJob, procurement.scopeId, reason, {
              now: this.now(),
              maxAttempts: this.options.maxAttempts,
              retryAfterMs: this.retryDelay(claimed.attempts),
            })
            await this.store.updateJob(failedJob, claimedJob.revision)
            failed += 1
          } catch {
            // A concurrent recovery may already have persisted this attempt.
          }
        }
      }
    }
    return { claimed, requested, failed, recovered }
  }
}
