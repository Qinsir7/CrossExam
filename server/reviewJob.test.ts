import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it } from 'vitest'
import type { DecisionPackage } from '../src/domain/types'
import type { ReviewDelivery } from '../src/network/reviewNetwork'
import { deliveryPayloadHash } from './deliveryAttestation'
import { evidenceArtifactHash } from './evidenceIntegrity'
import { authorizeReviewJobFunding, canAccessReviewJob, createReviewJob, createReviewJobWithAccess, recordReviewDelivery, reviewJobForOwner } from './reviewJob'
import { FileReviewJobStore } from './reviewJobStore'
import { ReviewJobWorker } from './reviewJobWorker'
import type { ReviewerRegistry } from './reviewerRegistry'
import { buildProcurementLedger } from './procurementLedger'

const directories: string[] = []
const accounts = [
  privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123'),
  privateKeyToAccount('0x1123456789012345678901234567890123456789012345678901234567890123'),
  privateKeyToAccount('0x2123456789012345678901234567890123456789012345678901234567890123'),
]
const registry: ReviewerRegistry = {
  source: { id: 'source', displayName: 'Source', ownerId: 'owner-a', modelFamily: 'retrieval', evidenceRoutes: ['primary'], capabilities: ['source verification'], wallet: accounts[0].address, status: 'ACTIVE' },
  challenger: { id: 'challenger', displayName: 'Challenge', ownerId: 'owner-b', modelFamily: 'reasoning', evidenceRoutes: ['counterexample'], capabilities: ['adversarial research'], wallet: accounts[1].address, status: 'ACTIVE' },
  specialist: { id: 'specialist', displayName: 'Risk', ownerId: 'owner-c', modelFamily: 'analysis', evidenceRoutes: ['onchain'], capabilities: ['domain specialist'], wallet: accounts[2].address, status: 'ACTIVE' },
}
const decision: DecisionPackage = {
  id: 'DP-JOB', title: 'Review a material decision', valueAtRiskUsd: 10_000,
  claims: [{ id: 'C-1', statement: 'A decision-critical premise is true.', materiality: 0.9 }],
}

async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'crossexam-jobs-'))
  directories.push(directory)
  const result = new FileReviewJobStore(directory)
  await result.checkHealth()
  return result
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ReviewJob lifecycle', () => {
  it('returns a one-time owner capability while persisting only its hash', () => {
    const created = createReviewJobWithAccess(decision, registry, '2026-07-15T00:00:00.000Z')
    expect(canAccessReviewJob(created.job, created.accessToken)).toBe(true)
    expect(canAccessReviewJob(created.job, 'rjv_not-the-issued-capability-000000000000000000')).toBe(false)
    expect(reviewJobForOwner(created.job)).not.toHaveProperty('accessTokenHash')
  })

  it('durably stages independent procurements and sends blind tasks with stable idempotency keys', async () => {
    const jobStore = await store()
    const job = createReviewJob(decision, registry, '2026-07-15T00:00:00.000Z', 'rj_11111111-1111-4111-8111-111111111111')
    await jobStore.createJob(job)
    const requests: Array<{ scopeId: string; idempotencyKey: string; withheld: string[] }> = []
    const worker = new ReviewJobWorker(jobStore, {
      async requestReview(input) {
        requests.push({ scopeId: input.scopeId, idempotencyKey: input.idempotencyKey, withheld: input.task.withheldContext })
        return { externalRequestId: `external-${input.scopeId}`, payment: { network: 'eip155:196', asset: '0x5555555555555555555555555555555555555555', amountAtomic: '120000', transaction: `0x${'1'.repeat(64)}` } }
      },
    })

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 0, requested: 0, failed: 0, recovered: 0 })
    const authorized = authorizeReviewJobFunding(job, '2026-07-15T00:00:01.000Z')
    await jobStore.updateJob(authorized, job.revision)
    await expect(worker.runOnce()).resolves.toEqual({ claimed: 3, requested: 3, failed: 0, recovered: 0 })
    const persisted = await jobStore.findJob(job.id)
    expect(persisted?.procurements.map((procurement) => procurement.status)).toEqual(['REQUESTED', 'REQUESTED', 'REQUESTED'])
    expect(requests).toHaveLength(3)
    expect(requests.every((request) => request.idempotencyKey.startsWith(`${job.id}:`))).toBe(true)
    expect(requests.every((request) => request.withheld.includes('aggregate_verdict'))).toBe(true)
  })

  it('terminates a job once an external procurement exhausts its bounded attempt budget', async () => {
    const jobStore = await store()
    const job = createReviewJob(decision, registry, '2026-07-15T00:00:00.000Z', 'rj_33333333-3333-4333-8333-333333333333')
    await jobStore.createJob(job)
    const authorized = authorizeReviewJobFunding(job, '2026-07-15T00:00:01.000Z')
    await jobStore.updateJob(authorized, job.revision)
    let now = new Date('2026-07-15T00:00:02.000Z')
    const worker = new ReviewJobWorker(jobStore, {
      async requestReview() { throw new Error('transient vendor outage') },
    }, { maxAttempts: 1, retryBaseMs: 1_000, dispatchTimeoutMs: 1_000, now: () => now })

    await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 1, failed: 1 })
    const failed = await jobStore.findJob(job.id)
    expect(failed?.status).toBe('FAILED')
    expect(failed?.procurements.filter((procurement) => procurement.status === 'EXHAUSTED')).toHaveLength(1)
    expect(failed?.procurements.find((procurement) => procurement.status === 'EXHAUSTED')).toMatchObject({ attempts: 1 })
    expect((await jobStore.listActiveJobs())).toHaveLength(0)
  })

  it('accepts only signed delivery after a recorded external request and becomes ready only when every scope returns', async () => {
    const jobStore = await store()
    let job = createReviewJob(decision, registry, '2026-07-15T00:00:00.000Z', 'rj_22222222-2222-4222-8222-222222222222')
    await jobStore.createJob(job)
    const authorized = authorizeReviewJobFunding(job, '2026-07-15T00:00:01.000Z')
    await jobStore.updateJob(authorized, job.revision)
    job = authorized
    const worker = new ReviewJobWorker(jobStore, { async requestReview(input) { return { externalRequestId: `external-${input.scopeId}`, payment: { network: 'eip155:196', asset: '0x5555555555555555555555555555555555555555', amountAtomic: '120000', transaction: `0x${'1'.repeat(64)}` } } } })
    await worker.runOnce()
    job = (await jobStore.findJob(job.id))!

    for (const [index, assignment] of job.dispatch.assignments.entries()) {
      const reviewerId = assignment.reviewer!.id
      const artifact = { id: `E-${reviewerId}`, kind: 'PRIMARY_SOURCE' as const, locator: `https://example.com/${reviewerId}`, observedAt: '2026-07-15T00:01:00.000Z', excerpt: 'Traceable primary evidence.' }
      const delivery: ReviewDelivery = {
        reviewerId,
        deliveredAt: '2026-07-15T00:02:00.000Z',
        artifacts: [{ ...artifact, contentHash: evidenceArtifactHash(artifact) }],
        findings: [{ claimId: 'C-1', reviewerId, verdict: index === 1 ? 'CONTRADICTS' : 'SUPPORTS', confidence: 0.9, materiality: 0.9, evidence: 'The cited artifact supports the stated review conclusion.', evidenceArtifactIds: [artifact.id] }],
      }
      const payloadHash = deliveryPayloadHash({ dispatchId: job.dispatch.id, decisionId: job.decision.id, scopeId: assignment.scopeId, delivery })
      const signed = { ...delivery, attestation: { scheme: 'EIP191' as const, payloadHash, signature: await accounts[index].signMessage({ message: { raw: payloadHash } }) } }
      const updated = await recordReviewDelivery(job, assignment.scopeId, signed, registry, `2026-07-15T00:0${index + 3}:00.000Z`)
      await jobStore.updateJob(updated, job.revision)
      job = updated
    }

    expect(job.status).toBe('READY_FOR_ASSURANCE')
    expect(job.events.at(-1)?.type).toBe('JOB_READY_FOR_ASSURANCE')
    expect(buildProcurementLedger(job)).toMatchObject({ settledByAsset: [{ asset: '0x5555555555555555555555555555555555555555', amountAtomic: '360000', payments: 3 }] })
  })
})
