import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { keccak256, stringToHex } from 'viem'
import { createReviewPlan, type ReviewPlan } from '../src/domain/reviewPlan'
import type { DecisionPackage } from '../src/domain/types'
import { acceptReviewDelivery, stageReviewPlan, type ExternalEvidenceProvenance, type ReviewDelivery, type ReviewDispatch } from '../src/network/reviewNetwork'
import { createBlindReviewTask, type BlindReviewTask } from '../src/network/reviewTask'
import { verifyDeliveryAttestation, type SignedReviewDelivery } from './deliveryAttestation'
import { applyMatchedProviderCosts, normalizeReviewJobDispatch, reviewerWalletRegistry, type ReviewerRegistry } from './reviewerRegistry'
import { quoteReview, type ReviewQuote } from './reviewPricing'

export type ReviewJobStatus = 'AWAITING_MATCH' | 'AWAITING_DELIVERIES' | 'READY_FOR_ASSURANCE' | 'FAILED' | 'CANCELLED'
export type ReviewJobFundingStatus = 'UNFUNDED' | 'AUTHORIZED'
export type ProcurementStatus = 'UNSENT' | 'DISPATCHING' | 'REQUESTED' | 'FAILED' | 'EXHAUSTED'

export type ReviewProcurement = {
  scopeId: string
  status: ProcurementStatus
  idempotencyKey: string
  externalRequestId?: string
  /** Incremented before every external call, so a crash cannot hide a spend attempt. */
  attempts: number
  lastAttemptAt?: string
  nextAttemptAt?: string
  failure?: string
  payment?: { network: 'eip155:196'; asset: string; amountAtomic: string; transaction: string }
  includedQuota?: { sourceId: string; authentication: 'OKX_HMAC_SHA256' | 'PUBLIC_HTTPS' }
  evidence?: {
    observedAt: string
    requestHash: `0x${string}`
    responseHash: `0x${string}`
    /** Owner-visible bounded raw response retained for reproducible parsing. */
    responseBody: string
  }
}

export type X402Settlement = {
  network: 'eip155:196'
  asset: string
  amountAtomic: string
  transaction: string
}

export type ReviewJobEvent = {
  id: string
  occurredAt: string
  type: 'JOB_CREATED' | 'JOB_FUNDING_AUTHORIZED' | 'REVIEW_PROVIDER_REMATCHED' | 'REVIEW_REQUEST_DISPATCHING' | 'REVIEW_REQUESTED' | 'REVIEW_REQUEST_FAILED' | 'REVIEW_REQUEST_EXHAUSTED' | 'REVIEW_DELIVERED' | 'PAID_EVIDENCE_RECEIVED' | 'AUTHENTICATED_EVIDENCE_RECEIVED' | 'JOB_READY_FOR_ASSURANCE' | 'JOB_CANCELLED'
  scopeId?: string
  detail: string
}

export type ReviewJob = {
  schemaVersion: '0.1'
  id: string
  revision: number
  status: ReviewJobStatus
  fundingStatus: ReviewJobFundingStatus
  /** Recorded only after the x402 facilitator reports a successful settlement. */
  customerPayment?: X402Settlement
  decision: DecisionPackage
  plan: ReviewPlan
  quote: ReviewQuote
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

function jobStatus(dispatch: ReviewDispatch, procurements: ReviewProcurement[]): ReviewJobStatus {
  if (procurements.some((procurement) => procurement.status === 'EXHAUSTED')) return 'FAILED'
  if (dispatch.assignments.some((assignment) => assignment.status === 'AWAITING_MATCH')) return 'AWAITING_MATCH'
  return dispatch.status === 'DELIVERED' ? 'READY_FOR_ASSURANCE' : 'AWAITING_DELIVERIES'
}

function assertDecision(decision: DecisionPackage) {
  if (!/^DP-[A-Za-z0-9_-]{1,120}$/.test(decision.id)
    || !decision.title?.trim()
    || !Number.isFinite(decision.valueAtRiskUsd) || decision.valueAtRiskUsd <= 0
    || !Array.isArray(decision.claims) || decision.claims.length === 0 || decision.claims.length > 64
    || (decision.reviewProfile !== undefined && decision.reviewProfile !== 'GENERAL' && decision.reviewProfile !== 'PRETRADE_ONCHAIN')
    || (decision.reviewEvidenceContext?.tokenRiskTarget !== undefined && !/^token:[a-z0-9_-]+:0x[a-fA-F0-9]{40}$/.test(decision.reviewEvidenceContext.tokenRiskTarget))
    || new Set(decision.claims.map((claim) => claim.id)).size !== decision.claims.length
    || decision.claims.some((claim) => !claim.id.trim() || !claim.statement.trim() || !Number.isFinite(claim.materiality) || claim.materiality < 0 || claim.materiality > 1)) {
    throw new Error('Review job requires a valid, bounded Decision Package.')
  }
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function hasProviderReadableTokenTarget(decision: DecisionPackage) {
  const target = decision.reviewEvidenceContext?.tokenRiskTarget ?? decision.actionBinding?.target ?? ''
  return /^(?:token|contract):[a-z0-9_-]+:0x[a-fA-F0-9]{40}$/.test(target)
}

/**
 * A deterministic paid adapter must be able to form its request before the
 * buyer authorizes any spending. In particular, a router transaction does not
 * identify the token that CertiK should scan, so never defer this error until
 * after an unrelated liquidity provider has already been paid.
 */
function assertProviderInputCompatibility(decision: DecisionPackage, dispatch: ReviewDispatch, registry: ReviewerRegistry) {
  const tokenEvidenceAssignment = dispatch.assignments.find((assignment) => {
    const provider = assignment.reviewer ? registry[assignment.reviewer.id] : undefined
    return (assignment.scopeId === 'contract-token-risk' || assignment.scopeId === 'execution-liquidity')
      && (provider?.responseAdapter === 'CERTIK_TOKEN_SCAN_V1'
        || provider?.responseAdapter === 'OKX_TOKEN_LIQUIDITY_V1'
        || provider?.responseAdapter === 'GOPLUS_TOKEN_SECURITY_V1')
  })
  if (tokenEvidenceAssignment && !hasProviderReadableTokenTarget(decision)) {
    throw new Error('This pre-trade review needs reviewEvidenceContext.tokenRiskTarget formatted as token:<chain>:0x<contract-address> before external evidence procurement can be authorized.')
  }
}

export function createReviewJob(
  decision: DecisionPackage,
  registry: ReviewerRegistry,
  now = new Date().toISOString(),
  id = `rj_${randomUUID()}`,
  accessToken = `rjv_${randomBytes(32).toString('base64url')}`,
  pricing: { authorizationPriceUsd?: string; minimumGrossMarginFraction?: number } = {},
): ReviewJob {
  assertDecision(decision)
  const canonicalPlan = createReviewPlan(decision)
  const activeReviewers = Object.values(registry).filter((reviewer) => reviewer.status === 'ACTIVE')
  const initialDispatch = stageReviewPlan(canonicalPlan, activeReviewers)
  assertProviderInputCompatibility(decision, initialDispatch, registry)
  const plan = applyMatchedProviderCosts(canonicalPlan, initialDispatch, registry)
  const quote = quoteReview(plan, pricing.authorizationPriceUsd ?? '2.00', pricing.minimumGrossMarginFraction ?? 0.4)
  if (!quote.economicallyAuthorized) {
    throw new Error(`Full-review authorization price is uneconomic for this job; require at least ${quote.minimumAuthorizationPriceUsdt.toFixed(2)} USDT before bounded external procurement.`)
  }
  const dispatch = stageReviewPlan(plan, activeReviewers)
  const procurements = dispatch.assignments.filter((assignment) => assignment.reviewer).map((assignment) => ({
    scopeId: assignment.scopeId,
    status: 'UNSENT' as const,
    idempotencyKey: `${id}:${assignment.scopeId}`,
    attempts: 0,
  }))
  const status = jobStatus(dispatch, procurements)
  return {
    schemaVersion: '0.1',
    id,
    revision: 0,
    status,
    fundingStatus: 'UNFUNDED',
    decision,
    plan,
    quote,
    dispatch,
    procurements,
    events: [event('JOB_CREATED', status === 'AWAITING_MATCH' ? 'Created; compatible independent reviewers are still required.' : 'Created with independent reviewers matched from the server registry.', now)],
    createdAt: now,
    updatedAt: now,
    accessTokenHash: tokenHash(accessToken),
  }
}

export function createReviewJobWithAccess(
  decision: DecisionPackage,
  registry: ReviewerRegistry,
  now = new Date().toISOString(),
  pricing: { authorizationPriceUsd?: string; minimumGrossMarginFraction?: number } = {},
): CreatedReviewJob {
  const accessToken = `rjv_${randomBytes(32).toString('base64url')}`
  return { job: createReviewJob(decision, registry, now, `rj_${randomUUID()}`, accessToken, pricing), accessToken }
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

function revise(job: ReviewJob, now: string, patch: Partial<Pick<ReviewJob, 'status' | 'fundingStatus' | 'customerPayment' | 'dispatch' | 'procurements'>>, nextEvent: ReviewJobEvent): ReviewJob {
  return { ...job, ...patch, revision: job.revision + 1, updatedAt: now, events: [...job.events, nextEvent] }
}

/** A paid x402 authorization is required before the buyer worker may spend. */
function assertX402Settlement(payment: X402Settlement) {
  if (payment.network !== 'eip155:196' || !/^0x[a-fA-F0-9]{40}$/.test(payment.asset)
    || !/^[1-9][0-9]*$/.test(payment.amountAtomic) || !/^0x[0-9a-fA-F]{64}$/.test(payment.transaction)) {
    throw new Error('x402 settlement is malformed.')
  }
}

/**
 * Records authorization only after the facilitator settles the customer
 * payment. The worker treats this flag as its sole permission to spend.
 */
export function recordReviewJobFundingSettlement(job: ReviewJob, payment: X402Settlement, now = new Date().toISOString()): ReviewJob {
  if (job.status === 'CANCELLED' || job.status === 'FAILED') throw new Error('A terminal review job cannot be funded.')
  assertX402Settlement(payment)
  if (job.fundingStatus === 'AUTHORIZED') {
    if (job.customerPayment?.transaction !== payment.transaction) throw new Error('Review job is already funded by a different settled payment.')
    return job
  }
  return revise(job, now, { fundingStatus: 'AUTHORIZED', customerPayment: payment }, event('JOB_FUNDING_AUTHORIZED', `x402 customer authorization settled in transaction ${payment.transaction}; external procurement may now spend within the configured policy.`, now))
}

/** Test and offline helper. Production funding must call recordReviewJobFundingSettlement. */
export function authorizeReviewJobFunding(job: ReviewJob, now = new Date().toISOString()): ReviewJob {
  if (job.status === 'CANCELLED' || job.status === 'FAILED') throw new Error('A terminal review job cannot be funded.')
  if (job.fundingStatus === 'AUTHORIZED') return job
  return revise(job, now, { fundingStatus: 'AUTHORIZED' }, event('JOB_FUNDING_AUTHORIZED', 'Offline authorization recorded without an x402 settlement; this mode must not be used by the production payment route.', now))
}

export function markProcurementDispatching(job: ReviewJob, scopeId: string, now = new Date().toISOString()): ReviewJob {
  if (job.status !== 'AWAITING_DELIVERIES') throw new Error('Only matched jobs can dispatch reviewer procurement.')
  const procurement = job.procurements.find((item) => item.scopeId === scopeId)
  if (!procurement || procurement.status === 'REQUESTED') throw new Error('Review scope is not available for procurement dispatch.')
  const procurements = job.procurements.map((item) => item.scopeId === scopeId
    ? { ...item, status: 'DISPATCHING' as const, attempts: item.attempts + 1, lastAttemptAt: now, nextAttemptAt: undefined, failure: undefined }
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
    ? { ...item, status: 'REQUESTED' as const, externalRequestId, ...(payment ? { payment } : {}), lastAttemptAt: now, nextAttemptAt: undefined }
    : item)
  return revise(job, now, { procurements }, event('REVIEW_REQUESTED', `External reviewer accepted request ${externalRequestId}.`, now, scopeId))
}

export function markIncludedQuotaProcurementRequested(job: ReviewJob, scopeId: string, externalRequestId: string, sourceId: string, authentication: 'OKX_HMAC_SHA256' | 'PUBLIC_HTTPS' = 'OKX_HMAC_SHA256', now = new Date().toISOString()): ReviewJob {
  if (!externalRequestId.trim() || !sourceId.trim()) throw new Error('Authenticated evidence request identifiers are required.')
  const procurement = job.procurements.find((item) => item.scopeId === scopeId)
  if (!procurement || procurement.status !== 'DISPATCHING') throw new Error('Review scope was not claimed for procurement dispatch.')
  const procurements = job.procurements.map((item) => item.scopeId === scopeId
    ? { ...item, status: 'REQUESTED' as const, externalRequestId, includedQuota: { sourceId, authentication }, lastAttemptAt: now, nextAttemptAt: undefined }
    : item)
  return revise(job, now, { procurements }, event('REVIEW_REQUESTED', `Authenticated external evidence source accepted request ${externalRequestId} within included quota.`, now, scopeId))
}

export function markProcurementFailed(
  job: ReviewJob,
  scopeId: string,
  reason: string,
  options: { now?: string; maxAttempts?: number; retryAfterMs?: number } = {},
): ReviewJob {
  const now = options.now ?? new Date().toISOString()
  const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY
  const retryAfterMs = options.retryAfterMs ?? 0
  const procurement = job.procurements.find((item) => item.scopeId === scopeId)
  if (!procurement || procurement.status !== 'DISPATCHING') throw new Error('Review scope was not claimed for procurement dispatch.')
  const exhausted = procurement.attempts >= maxAttempts
  const nextAttemptAt = exhausted ? undefined : new Date(new Date(now).getTime() + retryAfterMs).toISOString()
  const procurements = job.procurements.map((item) => item.scopeId === scopeId
    ? { ...item, status: exhausted ? 'EXHAUSTED' as const : 'FAILED' as const, failure: reason.slice(0, 500), lastAttemptAt: now, ...(nextAttemptAt ? { nextAttemptAt } : {}) }
    : item)
  const status = jobStatus(job.dispatch, procurements)
  return revise(job, now, { procurements, status }, event(exhausted ? 'REVIEW_REQUEST_EXHAUSTED' : 'REVIEW_REQUEST_FAILED', exhausted ? `Procurement attempts exhausted: ${reason.slice(0, 450)}` : reason.slice(0, 500), now, scopeId))
}

export async function recordReviewDelivery(job: ReviewJob, scopeId: string, delivery: SignedReviewDelivery, registry: ReviewerRegistry, now = new Date().toISOString()): Promise<ReviewJob> {
  if (job.status !== 'AWAITING_DELIVERIES') throw new Error('This review job is not accepting deliveries.')
  const procurement = job.procurements.find((item) => item.scopeId === scopeId)
  if (!procurement || procurement.status !== 'REQUESTED') throw new Error('A review delivery is accepted only after its external procurement is recorded.')
  const assignment = job.dispatch.assignments.find((item) => item.scopeId === scopeId)
  if (!assignment?.reviewer || registry[assignment.reviewer.id]?.procurementProtocol === 'PAID_EVIDENCE_V1') {
    throw new Error('Paid evidence sources cannot be represented as reviewer-signed deliveries.')
  }
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
  const status = jobStatus(normalized, job.procurements)
  const delivered = revise(job, now, { dispatch: normalized, status }, event('REVIEW_DELIVERED', 'Signed reviewer delivery accepted with content-addressed evidence.', now, scopeId))
  return status === 'READY_FOR_ASSURANCE'
    ? { ...delivered, events: [...delivered.events, event('JOB_READY_FOR_ASSURANCE', 'Every independent review scope is delivered; the job can now be purchased for network assurance issuance.', now)] }
    : delivered
}

/** Stores a paid ordinary-A2MCP response as evidence, never as a reviewer signature. */
export function recordPaidEvidenceDelivery(
  job: ReviewJob,
  scopeId: string,
  delivery: ReviewDelivery,
  provenance: ExternalEvidenceProvenance,
  responseBody: string,
  registry: ReviewerRegistry,
  now = new Date().toISOString(),
): ReviewJob {
  if (job.status !== 'AWAITING_DELIVERIES') throw new Error('This review job is not accepting paid evidence.')
  const procurement = job.procurements.find((item) => item.scopeId === scopeId)
  const assignment = job.dispatch.assignments.find((item) => item.scopeId === scopeId)
  if (!procurement || procurement.status !== 'REQUESTED' || !assignment?.reviewer) {
    throw new Error('External evidence is accepted only after its procurement is recorded.')
  }
  const source = registry[assignment.reviewer.id]
  const supportedSource = source?.procurementProtocol === 'PAID_EVIDENCE_V1'
    || source?.procurementProtocol === 'AUTHENTICATED_API_EVIDENCE_V1'
    || source?.procurementProtocol === 'PUBLIC_API_EVIDENCE_V1'
  if (!source || !supportedSource || delivery.reviewerId !== source.id || !delivery.provenance) {
    throw new Error('Paid evidence provenance does not match the configured external evidence source.')
  }
  const paymentMatches = provenance.kind === 'X402_PAID_EVIDENCE_V1'
    && Boolean(procurement.payment && provenance.payment
      && provenance.payment.transaction === procurement.payment.transaction
      && provenance.payment.asset === procurement.payment.asset
      && provenance.payment.amountAtomic === procurement.payment.amountAtomic)
  const quotaMatches = provenance.kind === 'AUTHENTICATED_API_EVIDENCE_V1'
    && Boolean(procurement.includedQuota?.sourceId === source.id
      && provenance.authentication?.scheme === 'OKX_HMAC_SHA256'
      && provenance.authentication.includedQuota)
  const publicMatches = provenance.kind === 'PUBLIC_API_EVIDENCE_V1'
    && Boolean(procurement.includedQuota?.sourceId === source.id
      && procurement.includedQuota.authentication === 'PUBLIC_HTTPS'
      && provenance.transport?.scheme === 'PUBLIC_HTTPS'
      && provenance.transport.marginalCostUsd === 0)
  if (provenance.sourceId !== source.id || provenance.endpoint !== source.procurementEndpoint
    || provenance.requestHash !== delivery.provenance.requestHash || provenance.responseHash !== delivery.provenance.responseHash
    || (!paymentMatches && !quotaMatches && !publicMatches)) {
    throw new Error('Paid evidence provenance does not match the persisted settlement.')
  }
  if (Buffer.byteLength(responseBody, 'utf8') > 65_536) throw new Error('Paid evidence response exceeds the retained evidence limit.')
  if (keccak256(stringToHex(responseBody)) !== provenance.responseHash) {
    throw new Error('Paid evidence response hash does not match the retained response body.')
  }
  const dispatch = acceptReviewDelivery(job.plan, job.dispatch, scopeId, delivery)
  const normalized = normalizeReviewJobDispatch(job.decision, dispatch, registry)
  const status = jobStatus(normalized, job.procurements)
  const procurements = job.procurements.map((item) => item.scopeId === scopeId
    ? { ...item, evidence: { observedAt: provenance.observedAt, requestHash: provenance.requestHash, responseHash: provenance.responseHash, responseBody } }
    : item)
  const paid = provenance.kind === 'X402_PAID_EVIDENCE_V1'
  const delivered = revise(job, now, { dispatch: normalized, procurements, status }, event(
    paid ? 'PAID_EVIDENCE_RECEIVED' : 'AUTHENTICATED_EVIDENCE_RECEIVED',
    paid
      ? 'Paid external evidence was recorded with request, response, and settlement hashes; it is not reviewer-signed.'
      : 'Authenticated external evidence was recorded with immutable request and response hashes under included API quota; it is not reviewer-signed.',
    now,
    scopeId,
  ))
  return status === 'READY_FOR_ASSURANCE'
    ? { ...delivered, events: [...delivered.events, event('JOB_READY_FOR_ASSURANCE', 'Every review scope is complete; provenance-qualified assurance can now be issued.', now)] }
    : delivered
}

export function cancelReviewJob(job: ReviewJob, now = new Date().toISOString()): ReviewJob {
  if (job.status === 'READY_FOR_ASSURANCE') throw new Error('A ready-for-assurance job cannot be cancelled; either issue or expire it explicitly.')
  if (job.status === 'CANCELLED') return job
  return revise(job, now, { status: 'CANCELLED' }, event('JOB_CANCELLED', 'Review job cancelled before a decision-grade assurance record was issued.', now))
}

/**
 * Reopens a funded terminal job without charging the customer again. Failed
 * scopes are rebound to the best currently active compatible source while
 * delivered evidence remains immutable. A replacement may never exceed the
 * price already authorized for that scope.
 */
export function retryFailedReviewJob(job: ReviewJob, registry: ReviewerRegistry, now = new Date().toISOString()): ReviewJob {
  if ((job.status !== 'FAILED' && job.status !== 'AWAITING_DELIVERIES') || job.fundingStatus !== 'AUTHORIZED' || !job.customerPayment) {
    throw new Error('Only a settled, failed review job can retry procurement without another customer payment.')
  }
  const failedScopes = new Set(job.procurements.filter((item) => item.status === 'FAILED' || item.status === 'EXHAUSTED').map((item) => item.scopeId))
  if (!failedScopes.size) throw new Error('Failed review job has no retryable procurement scope.')
  const occupiedOwners = new Set(job.dispatch.assignments
    .filter((assignment) => assignment.status === 'DELIVERED' && assignment.reviewer)
    .map((assignment) => assignment.reviewer!.ownerId))
  const replacements = new Map<string, ReviewerRegistry[string]>()
  for (const scopeId of failedScopes) {
    const scope = job.plan.scopes.find((candidate) => candidate.id === scopeId)
    const previous = job.dispatch.assignments.find((assignment) => assignment.scopeId === scopeId)?.reviewer
    if (!scope) throw new Error('Retryable procurement does not belong to the canonical review plan.')
    const candidates = Object.values(registry).filter((candidate) => candidate.status === 'ACTIVE'
      && candidate.procurementEndpoint
      && candidate.capabilities.includes(scope.requiredCapability)
      && !occupiedOwners.has(candidate.ownerId)
      && (candidate.estimatedUnitCostUsdt ?? scope.estimatedFeeUsdt) <= scope.estimatedFeeUsdt)
      .sort((left, right) => (right.selectionPriority ?? 0) - (left.selectionPriority ?? 0)
        || Number(right.id !== previous?.id) - Number(left.id !== previous?.id))
    const replacement = candidates[0]
    if (!replacement) throw new Error(`No compatible source can retry ${scopeId} within the customer's authorized scope budget.`)
    replacements.set(scopeId, replacement)
    occupiedOwners.add(replacement.ownerId)
  }
  const dispatch = {
    ...job.dispatch,
    status: 'MATCHED' as const,
    assignments: job.dispatch.assignments.map((assignment) => {
      const replacement = replacements.get(assignment.scopeId)
      return replacement ? {
        ...assignment,
        status: 'MATCHED' as const,
        reviewer: {
          id: replacement.id,
          displayName: replacement.displayName,
          ownerId: replacement.ownerId,
          modelFamily: replacement.modelFamily,
          evidenceRoutes: replacement.evidenceRoutes,
        },
        delivery: undefined,
        reason: 'Rematched after an external provider failure without increasing the authorized scope budget.',
      } : assignment
    }),
  }
  const normalized = normalizeReviewJobDispatch(job.decision, dispatch, registry)
  const procurements = job.procurements.map((procurement) => replacements.has(procurement.scopeId) ? {
    scopeId: procurement.scopeId,
    status: 'UNSENT' as const,
    idempotencyKey: `${job.id}:${procurement.scopeId}:retry:${job.revision + 1}`,
    attempts: 0,
  } : procurement)
  const replacementSummary = [...replacements.entries()].map(([scopeId, provider]) => `${scopeId}→${provider.id}`).join(', ')
  return revise(job, now, { status: 'AWAITING_DELIVERIES', dispatch: normalized, procurements }, event('REVIEW_PROVIDER_REMATCHED', `Failed procurement reopened without another customer payment: ${replacementSummary}.`, now))
}
