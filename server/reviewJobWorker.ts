import type { ReviewJobStore } from './reviewJobStore'
import { blindTaskForProcurement, markProcurementDispatching, markProcurementFailed, markProcurementRequested, type ReviewJob } from './reviewJob'

export type ExternalReviewProvider = {
  requestReview(input: { jobId: string; scopeId: string; reviewerId: string; idempotencyKey: string; task: ReturnType<typeof blindTaskForProcurement> }): Promise<{ externalRequestId: string; payment?: ReviewJob['procurements'][number]['payment'] }>
}

/**
 * Outgoing procurement is a recoverable worker operation, not a browser
 * promise. The stable per-scope idempotency key is passed to the external ASP
 * so retry after a process crash cannot authorize duplicate work or spend.
 */
export class ReviewJobWorker {
  private readonly store: ReviewJobStore
  private readonly provider: ExternalReviewProvider

  constructor(store: ReviewJobStore, provider: ExternalReviewProvider) {
    this.store = store
    this.provider = provider
  }

  async runOnce(): Promise<{ claimed: number; requested: number; failed: number }> {
    let claimed = 0
    let requested = 0
    let failed = 0
    for (const current of await this.store.listActiveJobs()) {
      for (const procurement of current.procurements.filter((item) => item.status === 'UNSENT' || item.status === 'FAILED')) {
        const latest = await this.store.findJob(current.id)
        if (!latest || latest.status !== 'AWAITING_DELIVERIES') continue
        const assignment = latest.dispatch.assignments.find((item) => item.scopeId === procurement.scopeId)
        if (!assignment?.reviewer) continue
        let claimedJob: ReviewJob
        try {
          claimedJob = markProcurementDispatching(latest, procurement.scopeId)
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
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'External reviewer procurement failed.'
          try {
            const failedJob = markProcurementFailed(claimedJob, procurement.scopeId, reason)
            await this.store.updateJob(failedJob, claimedJob.revision)
            failed += 1
          } catch {
            // A concurrent recovery may already have persisted this attempt.
          }
        }
      }
    }
    return { claimed, requested, failed }
  }
}
