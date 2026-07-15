import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReviewPlan, type ReviewPlan } from '../src/domain/reviewPlan'
import type { DecisionPackage } from '../src/domain/types'
import { acceptReviewDelivery, stageReviewPlan, type ReviewDispatch } from '../src/network/reviewNetwork'
import { createBlindReviewTask, type BlindReviewTask } from '../src/network/reviewTask'
import { verifyDeliveryAttestation, type SignedReviewDelivery } from './deliveryAttestation'
import { normalizeReviewJobDispatch, reviewerWalletRegistry, type ReviewerRegistry } from './reviewerRegistry'

export type ReviewJobStatus = 'AWAITING_MATCH' | 'AWAITING_DELIVERIES' | 'READY_FOR_ASSURANCE' | 'CANCELLED'
export type ReviewJobFundingStatus = 'UNFUNDED' | 'AUTHORIZED'
export type ProcurementStatus = 'UNSENT' | 'DISPATCHING' | 'REQUESTED' | 'FAILED'

export type ReviewProcurement = {
  scopeId: string
  status: ProcurementStatus
  idempotencyKey: string
  externalRequestId?: string
  lastAttemptAt?: string
  failure?: string
  payment?: { network: 'eip155:196'; asset: string; amountAtomic: string; transaction: string }
}

export type ReviewJobEvent = {
  id: string
  occurredAt: string
  type: 'JOB_CREATED' | 'JOB_FUNDING_AUTHORIZED' | 'REVIEW_REQUEST_DISPATCHING' | 'REVIEW_REQUESTED' | 'REVIEW_REQUEST_FAILED' | 'REVIEW_DELIVERED' | 'JOB_READY_FOR_ASSURANCE' | 'JOB_CANCELLED'
  scopeId?: string
  detail: string
}

export type ReviewJob = {
  schemaVersion: '0.1'
  id: string
  revision: number
  status: ReviewJobStatus
  fundingStatus: ReviewJobFundingStatus
  decision: DecisionPackage
  plan: ReviewPlan
  dispatch: ReviewDispatch
  procurements: ReviewProcurement[]
  events: ReviewJobEvent[]
  createdAt: string
  updatedAt: string
  /** SHA-256 only; the raw bearer capability is returned once at creation. */
  accessTokenHash: string
}

export type CreatedReviewJob = { job: ReviewJob; accessToken: string }

function event(type: ReviewJobEvent['type'], detail: string, occurredAt: string, scopeId?: string): ReviewJobEvent {
  return { id: `rje_${randomUUID()}`, occurredAt, type, ...(scopeId ? { scopeId } : {}), detail }
}

function jobStatus(dispatch: ReviewDispatch): ReviewJobStatus {
  if (dispatch.assignments.some((assignment) => assignment.status === 'AWAITING_MATCH')) return 'AWAITING_MATCH'
  return dispatch.status === 'DELIVERED' ? 'READY_FOR_ASSURANCE' : 'AWAITING_DELIVERIES'
}

function assertDecision(decision: DecisionPackage) {
  if (!/^DP-[A-Za-z0-9_-]{1,120}$/.test(decision.id)
    || !decision.title?.trim()
    || !Number.isFinite(decision.valueAtRiskUsd) || decision.valueAtRiskUsd <= 0
    || !Array.isArray(decision.claims) || decision.claims.length === 0 || decision.claims.length > 64
    || new Set(decision.claims.map((claim) => claim.id)).size !== decision.claims.length
    || decision.claims.some((claim) => !claim.id.trim() || !claim.statement.trim() || !Number.isFinite(claim.materiality) || claim.materiality < 0 || claim.materiality > 1)) {
    throw new Error('Review job requires a valid, bounded Decision Package.')
  }
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function createReviewJob(decision: DecisionPackage, registry: ReviewerRegistry, now = new Date().toISOString(), id = `rj_${randomUUID()}`, accessToken = `rjv_${randomBytes(32).toString('base64url')}`): ReviewJob {
  assertDecision(decision)
  const plan = createReviewPlan(decision)
  const activeReviewers = Object.values(registry).filter((reviewer) => reviewer.status === 'ACTIVE')
  const dispatch = stageReviewPlan(plan, activeReviewers)
  const status = jobStatus(dispatch)
  return {
    schemaVersion: '0.1',
    id,
    revision: 0,
    status,
    fundingStatus: 'UNFUNDED',
    decision,
    plan,
    dispatch,
    procurements: dispatch.assignments.filter((assignment) => assignment.reviewer).map((assignment) => ({
      scopeId: assignment.scopeId,
      status: 'UNSENT',
      idempotencyKey: `${id}:${assignment.scopeId}`,
    })),
    events: [event('JOB_CREATED', status === 'AWAITING_MATCH' ? 'Created; compatible independent reviewers are still required.' : 'Created with independent reviewers matched from the server registry.', now)],
    createdAt: now,
    updatedAt: now,
    accessTokenHash: tokenHash(accessToken),
  }
}

export function createReviewJobWithAccess(decision: DecisionPackage, registry: ReviewerRegistry, now = new Date().toISOString()): CreatedReviewJob {
  const accessToken = `rjv_${randomBytes(32).toString('base64url')}`
  return { job: createReviewJob(decision, registry, now, `rj_${randomUUID()}`, accessToken), accessToken }
}

export function canAccessReviewJob(job: ReviewJob, accessToken: string): boolean {
  if (!/^rjv_[A-Za-z0-9_-]{32,}$/.test(accessToken)) return false
  const expected = Buffer.from(job.accessTokenHash, 'hex')
  const actual = Buffer.from(tokenHash(accessToken), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function reviewJobForOwner(job: ReviewJob) {
  const { accessTokenHash: _accessTokenHash, ...ownerView } = job
  return ownerView
}

export function blindTaskForProcurement(job: ReviewJob, scopeId: string): BlindReviewTask {
  if (!job.procurements.some((procurement) => procurement.scopeId === scopeId)) {
    throw new Error('Review job has no matched procurement for this scope.')
  }
  return createBlindReviewTask(job.decision, job.plan, scopeId)
}

function revise(job: ReviewJob, now: string, patch: Partial<Pick<ReviewJob, 'status' | 'fundingStatus' | 'dispatch' | 'procurements'>>, nextEvent: ReviewJobEvent): ReviewJob {
  return { ...job, ...patch, revision: job.revision + 1, updatedAt: now, events: [...job.events, nextEvent] }
}

/** A paid x402 authorization is required before the buyer worker may spend. */
export function authorizeReviewJobFunding(job: ReviewJob, now = new Date().toISOString()): ReviewJob {
  if (job.status === 'CANCELLED') throw new Error('A cancelled review job cannot be funded.')
  if (job.fundingStatus === 'AUTHORIZED') return job
  return revise(job, now, { fundingStatus: 'AUTHORIZED' }, event('JOB_FUNDING_AUTHORIZED', 'x402 buyer authorization received; external procurement may now spend within the configured policy.', now))
}

export function markProcurementDispatching(job: ReviewJob, scopeId: string, now = new Date().toISOString()): ReviewJob {
  if (job.status !== 'AWAITING_DELIVERIES') throw new Error('Only matched jobs can dispatch reviewer procurement.')
  const procurement = job.procurements.find((item) => item.scopeId === scopeId)
  if (!procurement || procurement.status === 'REQUESTED') throw new Error('Review scope is not available for procurement dispatch.')
  const procurements = job.procurements.map((item) => item.scopeId === scopeId
    ? { ...item, status: 'DISPATCHING' as const, lastAttemptAt: now, failure: undefined }
    : item)
  return revise(job, now, { procurements }, event('REVIEW_REQUEST_DISPATCHING', 'External reviewer procurement is being dispatched with its stable idempotency key.', now, scopeId))
}

export function markProcurementRequested(job: ReviewJob, scopeId: string, externalRequestId: string, payment?: ReviewProcurement['payment'], now = new Date().toISOString()): ReviewJob {
  if (!externalRequestId.trim()) throw new Error('External review request must return a stable identifier.')
  if (!payment?.transaction || !/^0x[0-9a-fA-F]+$/.test(payment.transaction) || !/^[1-9][0-9]*$/.test(payment.amountAtomic)) {
    throw new Error('External review procurement requires a successful, recorded x402 settlement.')
  }
  const procurement = job.procurements.find((item) => item.scopeId === scopeId)
  if (!procurement || procurement.status !== 'DISPATCHING') throw new Error('Review scope was not claimed for procurement dispatch.')
  const procurements = job.procurements.map((item) => item.scopeId === scopeId
    ? { ...item, status: 'REQUESTED' as const, externalRequestId, ...(payment ? { payment } : {}), lastAttemptAt: now }
    : item)
  return revise(job, now, { procurements }, event('REVIEW_REQUESTED', `External reviewer accepted request ${externalRequestId}.`, now, scopeId))
}

export function markProcurementFailed(job: ReviewJob, scopeId: string, reason: string, now = new Date().toISOString()): ReviewJob {
  const procurement = job.procurements.find((item) => item.scopeId === scopeId)
  if (!procurement || procurement.status !== 'DISPATCHING') throw new Error('Review scope was not claimed for procurement dispatch.')
  const procurements = job.procurements.map((item) => item.scopeId === scopeId
    ? { ...item, status: 'FAILED' as const, failure: reason.slice(0, 500), lastAttemptAt: now }
    : item)
  return revise(job, now, { procurements }, event('REVIEW_REQUEST_FAILED', reason.slice(0, 500), now, scopeId))
}

export async function recordReviewDelivery(job: ReviewJob, scopeId: string, delivery: SignedReviewDelivery, registry: ReviewerRegistry, now = new Date().toISOString()): Promise<ReviewJob> {
  if (job.status !== 'AWAITING_DELIVERIES') throw new Error('This review job is not accepting deliveries.')
  const procurement = job.procurements.find((item) => item.scopeId === scopeId)
  if (!procurement || procurement.status !== 'REQUESTED') throw new Error('A review delivery is accepted only after its external procurement is recorded.')
  await verifyDeliveryAttestation({
    dispatchId: job.dispatch.id,
    decisionId: job.decision.id,
    scopeId,
    delivery,
    reviewerWallets: reviewerWalletRegistry(registry),
  })
  const dispatch = acceptReviewDelivery(job.plan, job.dispatch, scopeId, delivery)
  // Also force the signed review's effective identity back through the
  // server-owned registry before its status is persisted.
  const normalized = normalizeReviewJobDispatch(job.decision, dispatch, registry)
  const status = jobStatus(normalized)
  const delivered = revise(job, now, { dispatch: normalized, status }, event('REVIEW_DELIVERED', 'Signed reviewer delivery accepted with content-addressed evidence.', now, scopeId))
  return status === 'READY_FOR_ASSURANCE'
    ? { ...delivered, events: [...delivered.events, event('JOB_READY_FOR_ASSURANCE', 'Every independent review scope is delivered; the job can now be purchased for network assurance issuance.', now)] }
    : delivered
}

export function cancelReviewJob(job: ReviewJob, now = new Date().toISOString()): ReviewJob {
  if (job.status === 'READY_FOR_ASSURANCE') throw new Error('A ready-for-assurance job cannot be cancelled; either issue or expire it explicitly.')
  if (job.status === 'CANCELLED') return job
  return revise(job, now, { status: 'CANCELLED' }, event('JOB_CANCELLED', 'Review job cancelled before a decision-grade assurance record was issued.', now))
}
